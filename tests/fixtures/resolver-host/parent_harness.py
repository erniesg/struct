#!/usr/bin/env python3
"""Parent-side supervisor for the sacrificial resolver verification host.

This supervisor runs OUTSIDE the host realm. It owns every process it
creates, it owns the execution identity namespace, and it is the only party
allowed to decide that a host is dead. The host itself never reports its own
death and never gets to influence the outcome.

Containment mechanism (Linux, unprivileged, no sudo, no provisioning):

  * a dedicated PID namespace is created for every host via
    ``unshare(CLONE_NEWUSER | CLONE_NEWPID)`` plus a correctly written
    ``uid_map``/``gid_map``. The host becomes PID 1 of that namespace, so a
    descendant that escapes the host's process group and session with
    ``setsid()`` + double-fork still cannot leave the namespace;
  * ``pidfd_open``/``pidfd_send_signal`` are used for every signal so that
    signalling is race free with respect to PID reuse;
  * ``PR_SET_CHILD_SUBREAPER`` is enabled so orphaned descendants are
    re-parented to this supervisor and can be waited for;
  * a per-host lifetime pipe is held open by the host and by every descendant
    that inherits the descriptor. End-of-file on that pipe is a kernel-level
    proof that every holder is dead, not a self-reported status;
  * process-group termination alone is never treated as sufficient.

This harness implements no Struct resolver protocol. The supervisor/host
channel is a generic marker/acknowledgement probe channel so that this
fixture cannot conflict with the separately published resolver contract.
"""

import ctypes
import errno
import json
import os
import resource
import select
import signal
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(BASE, "host_fixture.py")

CLONE_NEWUSER = 0x10000000
CLONE_NEWPID = 0x20000000
PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
PR_CAPBSET_DROP = 24
CAP_LAST_CAP = 40
LINUX_CAPABILITY_VERSION_3 = 0x20080522

CASE_BUDGET_S = 10.0
CHILD_CPU_LIMIT_S = 5
CHILD_AS_LIMIT_BYTES = 512 * 1024 * 1024
CHILD_FSIZE_LIMIT_BYTES = 1024 * 1024

CLEANUP_BUDGET_MS = 500
JOIN_BUDGET_MS = 500
TERM_GRACE_S = 0.3
DEATH_PROOF_TIMEOUT_S = 3.0
SPAWN_TIMEOUT_S = 3.0
HEARTBEAT_STOP_WINDOW_S = 1.2
HEARTBEAT_STOP_STABLE_SAMPLES = 4

libc = ctypes.CDLL(None, use_errno=True)


# ---------------------------------------------------------------- OS helpers

def write_json(path, value):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True)
    os.replace(tmp, path)


def read_json(path, timeout_s=3.0):
    """Poll for a JSON file and return its value, or None."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            time.sleep(0.01)
    return None


def read_int(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return int(handle.read().strip() or "-1")
    except (OSError, ValueError):
        return -1


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int32)]


def drop_all_capabilities():
    """Remove every capability from the host realm before it runs.

    The bounding set is emptied with PR_CAPBSET_DROP and the effective,
    permitted, inheritable, and ambient sets are cleared with capset(). The
    host realm therefore holds no Linux capability at all: it is a plain
    unprivileged process that can only use the authority it was given.
    """
    for cap in range(CAP_LAST_CAP + 1):
        libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)
    payload = (ctypes.c_uint32 * 8)(0, 0, 0, 0, 0, 0, 0, 0)
    header = CapHeader(LINUX_CAPABILITY_VERSION_3, 0)
    return libc.capset(ctypes.byref(header), ctypes.byref(payload)) == 0


def read_capabilities(who="self"):
    """Capability bitmasks of a process, read from /proc/<pid>/status."""
    out = {}
    try:
        with open("/proc/%s/status" % who, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(("CapEff:", "CapPrm:", "CapBnd:", "CapInh:", "CapAmb:")):
                    key, value = line.split()
                    out[key.rstrip(":")] = int(value, 16)
    except OSError:
        pass
    return out


def prctl_subreaper(enable):
    """Set or read PR_SET_CHILD_SUBREAPER. Returns (ok, value)."""
    if enable:
        rc = libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
        if rc != 0:
            return False, None
    buf = ctypes.c_int(0)
    if libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.byref(buf), 0, 0, 0) != 0:
        return False, None
    return True, buf.value


def pid_alive(pid):
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def pidfd_signal(pid, sig):
    """Signal a PID through a pidfd (no PID-reuse window)."""
    if pid is None:
        return {"pid": pid, "result": "no-pid"}
    try:
        fd = os.pidfd_open(pid, 0)
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return {"pid": pid, "signal": signal.Signals(sig).name, "result": "already-dead"}
        return {
            "pid": pid,
            "signal": signal.Signals(sig).name,
            "result": "pidfd_open:%s" % errno.errorcode.get(exc.errno, exc.errno),
        }
    try:
        signal.pidfd_send_signal(fd, sig)
        return {"pid": pid, "signal": signal.Signals(sig).name, "result": "sent"}
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return {"pid": pid, "signal": signal.Signals(sig).name, "result": "already-dead"}
        return {
            "pid": pid,
            "signal": signal.Signals(sig).name,
            "result": "pidfd_send:%s" % errno.errorcode.get(exc.errno, exc.errno),
        }
    finally:
        os.close(fd)


def ns_link(pid):
    try:
        return os.readlink("/proc/%d/ns/pid" % pid)
    except OSError:
        return None


def proc_stat_fields(pid):
    """Outer-view (ppid, pgid, sid) of a PID. Reads only /proc/<pid>/stat."""
    if pid is None:
        return None
    try:
        with open("/proc/%d/stat" % pid, "rb") as handle:
            raw = handle.read().decode("utf-8", "replace")
    except OSError:
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    fields = raw[close + 2:].split()
    if len(fields) < 4:
        return None
    try:
        return {"ppid": int(fields[1]), "pgid": int(fields[2]), "sid": int(fields[3])}
    except ValueError:
        return None


def proc_parent_map():
    """Parent map from /proc. Reads only /proc/<pid>/stat (no argv, no env)."""
    parents = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open("/proc/%d/stat" % pid, "rb") as handle:
                raw = handle.read().decode("utf-8", "replace")
        except OSError:
            continue
        close = raw.rfind(")")
        if close < 0:
            continue
        fields = raw[close + 2:].split()
        if len(fields) < 2:
            continue
        try:
            parents[pid] = int(fields[1])
        except ValueError:
            continue
    return parents


def descendant_closure(parents, root):
    children = {}
    for pid, ppid in parents.items():
        children.setdefault(ppid, []).append(pid)
    seen = set()
    stack = list(children.get(root, ()))
    while stack:
        pid = stack.pop()
        if pid == root or pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, ()))
    return seen


def ns_outer_members(ns_id):
    """Outer-visible PIDs that live in the given PID namespace."""
    if not ns_id:
        return []
    members = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if ns_link(pid) == ns_id:
            members.append(pid)
    return sorted(members)


def fail_stop_receipt(execution_id, host_reaped, descendant_count, waited_ms,
                      method="pid-namespace"):
    """Projection of the published StructResolverFailStopReceipt shape.

    The published resolver contract
    (/home/ubuntu/.local/state/struct-migration/20261020-continuation/resolver-contract.json)
    pins that receipt as
    Readonly<{ protocolVersion; executionId; hostTerminated; descendantsDead;
    capacityRetired; evidence: { hostReaped; descendantCount; waitedMs;
    method: 'process-group' | 'cgroup' | 'pid-namespace' } }>.
    This projection is harness evidence for the coordinator's wiring. It is
    not a package export and it does not change the pinned surface.
    """
    return {
        "protocolVersion": "1.0.0",
        "executionId": execution_id,
        "hostTerminated": True,
        "descendantsDead": descendant_count == 0,
        "capacityRetired": True,
        "evidence": {
            "hostReaped": bool(host_reaped),
            "descendantCount": descendant_count,
            "waitedMs": waited_ms,
            "method": method,
        },
    }


def execution_descendant_count(handle):
    """Live descendants of one execution, counted from outside its namespace.

    The outer-visible members of an execution's PID namespace are exactly the
    namespace init plus every in-namespace descendant that still has an outer
    PID. After a fail-stop that list must be empty.
    """
    return len(ns_outer_members(handle.get("pid_ns")))


def wait_census_empty(handle, timeout_s=DEATH_PROOF_TIMEOUT_S):
    """Wait, bounded, for one execution's namespace census to drain.

    The census is sampled from outside the execution's PID namespace, so a
    member that has already been killed but has not finished draining is
    still visible in /proc. A single sample can therefore report a member of
    a namespace that is already tearing down, and a receipt projected from
    that sample would claim ``descendantsDead: false`` for an execution the
    parent has in fact already failed-stopped.

    After a fail-stop the namespace must drain, so the parent samples the
    census until it is empty instead of sampling it once. The wait is
    bounded by the same death-proof deadline the rest of the termination
    path already uses, so it introduces no new timeout constant, no new
    authority, and it can never become an unbounded wait.

    The wait is fail-closed: a member that is still alive at the bound is
    reported, never hidden. The last observed member list is returned
    unchanged so the caller can project a truthful receipt.
    """
    deadline = time.monotonic() + timeout_s
    members = ns_outer_members(handle.get("pid_ns"))
    while members and time.monotonic() < deadline:
        time.sleep(0.01)
        members = ns_outer_members(handle.get("pid_ns"))
    return members


def wait_execution_descendant_count(handle, timeout_s=DEATH_PROOF_TIMEOUT_S):
    """Last observed descendant count of one execution, after a bounded drain.

    The count is the last census the parent actually observed, so a member
    that outlives the bound is still counted and the receipt stays
    fail-closed.
    """
    return len(wait_census_empty(handle, timeout_s))


def realm_capabilities(identity_value):
    """Capability bitmasks the host realm actually holds."""
    if not identity_value:
        return {}
    return {
        "cap_eff": identity_value.get("cap_eff"),
        "cap_prm": identity_value.get("cap_prm"),
        "cap_bnd": identity_value.get("cap_bnd"),
    }


def realm_is_unprivileged(identity_value):
    """True when the host realm holds no Linux capability at all."""
    caps = realm_capabilities(identity_value)
    return len(caps) == 3 and all(value == 0 for value in caps.values())


def status_text(status):
    if status is None:
        return "unknown"
    if os.WIFSIGNALED(status):
        return "signal:%d" % os.WTERMSIG(status)
    if os.WIFEXITED(status):
        return "exit:%d" % os.WEXITSTATUS(status)
    return "raw:%d" % status


def status_detail(status):
    if status is None:
        return {"status": "unknown"}
    if os.WIFSIGNALED(status):
        return {"status": "signal:%d" % os.WTERMSIG(status), "term_signal": os.WTERMSIG(status)}
    if os.WIFEXITED(status):
        return {"status": "exit:%d" % os.WEXITSTATUS(status), "exit_code": os.WEXITSTATUS(status)}
    return {"status": "raw:%d" % status}


def child_limits():
    resource.setrlimit(resource.RLIMIT_CPU, (CHILD_CPU_LIMIT_S, CHILD_CPU_LIMIT_S + 1))
    resource.setrlimit(resource.RLIMIT_AS, (CHILD_AS_LIMIT_BYTES, CHILD_AS_LIMIT_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (CHILD_FSIZE_LIMIT_BYTES, CHILD_FSIZE_LIMIT_BYTES))


# ---------------------------------------------------------- capacity ledger

class CapacityLedger:
    """Parent-owned execution identity and admission capacity.

    The supervisor, not the host, owns the execution identity space. A slot is
    either free, held by one execution, or permanently retired. A retired slot
    is never handed out again, so an implicated capacity can never be reused.
    """

    def __init__(self, capacity):
        self.capacity = capacity
        self.slots = [
            {"index": index, "state": "free", "execution_id": None, "retired_reason": None}
            for index in range(capacity)
        ]
        self.tombstones = {}
        self.counter = 0
        self.events = []

    def new_execution_id(self):
        """Mint a parent-owned, lifetime-unique execution identifier."""
        self.counter += 1
        return "exec-%04d-%s" % (self.counter, os.urandom(4).hex())

    def reserve(self, execution_id):
        """Admit an execution or reject it before any authority is granted."""
        if execution_id in self.tombstones:
            self._reject(execution_id, "EXECUTION_ID_RETIRED")
            return False, "EXECUTION_ID_RETIRED", None
        for slot in self.slots:
            if slot["state"] == "held" and slot["execution_id"] == execution_id:
                self._reject(execution_id, "EXECUTION_ID_DUPLICATE")
                return False, "EXECUTION_ID_DUPLICATE", None
        for slot in self.slots:
            if slot["state"] == "free":
                slot["state"] = "held"
                slot["execution_id"] = execution_id
                self.events.append({
                    "event": "admitted",
                    "execution_id": execution_id,
                    "slot": slot["index"],
                })
                return True, "ADMITTED", slot["index"]
        if all(slot["state"] == "retired" for slot in self.slots):
            self._reject(execution_id, "CAPACITY_RETIRED")
            return False, "CAPACITY_RETIRED", None
        self._reject(execution_id, "CAPACITY_EXHAUSTED")
        return False, "CAPACITY_EXHAUSTED", None

    def release_healthy(self, execution_id):
        """Retire the identifier and return the slot to the pool."""
        for slot in self.slots:
            if slot["state"] == "held" and slot["execution_id"] == execution_id:
                slot["state"] = "free"
                slot["execution_id"] = None
                self.tombstones[execution_id] = "TERMINAL_COMPLETED"
                self.events.append({
                    "event": "released",
                    "execution_id": execution_id,
                    "slot": slot["index"],
                })
                return True, slot["index"]
        return False, None

    def retire(self, execution_id, reason):
        """Permanently retire the implicated slot and tombstone the identifier."""
        for slot in self.slots:
            if slot["state"] == "held" and slot["execution_id"] == execution_id:
                slot["state"] = "retired"
                slot["retired_reason"] = reason
                self.tombstones[execution_id] = reason
                self.events.append({
                    "event": "retired",
                    "execution_id": execution_id,
                    "slot": slot["index"],
                    "reason": reason,
                })
                return True, slot["index"]
        return False, None

    def _reject(self, execution_id, reason):
        self.events.append({"event": "rejected", "execution_id": execution_id, "reason": reason})

    def state(self):
        return {
            "capacity": self.capacity,
            "slots": [dict(slot) for slot in self.slots],
            "tombstones": dict(self.tombstones),
            "free_slots": sum(1 for slot in self.slots if slot["state"] == "free"),
            "retired_slots": sum(1 for slot in self.slots if slot["state"] == "retired"),
        }


# ---------------------------------------------------------------- supervisor

class Supervisor:
    """Owns every process the harness creates. Never leaves a child behind."""

    def __init__(self, rundir):
        self.rundir = rundir
        self.hosts = []
        self.launchers = []
        self.subreaper_ok, self.subreaper_value = prctl_subreaper(True)
        self.subreaper = bool(self.subreaper_ok and self.subreaper_value == 1)
        self.pidfd_ok = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")

    # -- spawning -------------------------------------------------------

    def spawn_host(self, mode, token):
        """Spawn one host inside a dedicated PID namespace.

        Returns a handle dict. ``spawn_ok`` is False with a ``blocker``
        description when the namespace could not be created; the caller must
        report that as an explicit capability blocker, never as a pass.
        """
        marker_r, marker_w = os.pipe()
        life_r, life_w = os.pipe()
        launch_path = os.path.join(self.rundir, "launch-%s.json" % token)
        status_path = os.path.join(self.rundir, "host-status-%s.json" % token)

        launcher = os.fork()
        if launcher == 0:
            try:
                os.close(marker_w)
                os.close(life_r)
                os.setpgid(0, 0)
                uid = os.getuid()
                gid = os.getgid()
                if libc.unshare(CLONE_NEWUSER | CLONE_NEWPID) != 0:
                    err = ctypes.get_errno()
                    write_json(launch_path, {
                        "ok": False,
                        "stage": "unshare",
                        "errno": err,
                        "errno_name": errno.errorcode.get(err, err),
                    })
                    os._exit(40)
                try:
                    with open("/proc/self/setgroups", "w", encoding="utf-8") as handle:
                        handle.write("deny")
                except OSError:
                    pass
                try:
                    with open("/proc/self/uid_map", "w", encoding="utf-8") as handle:
                        handle.write("0 %d 1" % uid)
                    with open("/proc/self/gid_map", "w", encoding="utf-8") as handle:
                        handle.write("0 %d 1" % gid)
                except OSError as exc:
                    write_json(launch_path, {"ok": False, "stage": "id_map", "error": str(exc)})
                    os._exit(41)
                # The namespace is set up; strip every capability before the
                # host realm exists so that it holds no authority of its own.
                capabilities_dropped = drop_all_capabilities()
                child = os.fork()
                if child == 0:
                    try:
                        os.dup2(marker_r, 0)
                        os.dup2(life_w, 3)
                        os.close(marker_r)
                        os.close(life_w)
                        devnull = os.open(os.devnull, os.O_RDWR)
                        os.dup2(devnull, 1)
                        os.dup2(devnull, 2)
                        if devnull > 2:
                            os.close(devnull)
                        child_limits()
                        drop_all_capabilities()
                        os.execv(sys.executable, [sys.executable, HOST, mode, self.rundir, token])
                    except BaseException:
                        os._exit(42)
                os.close(marker_r)
                os.close(life_w)
                write_json(launch_path, {
                    "ok": True,
                    "host_outer_pid": child,
                    "launcher_pid": os.getpid(),
                    "pid_ns": ns_link(child),
                    "capabilities_dropped": capabilities_dropped,
                    "launcher_capabilities": read_capabilities(),
                })
                _, wait_status = os.waitpid(child, 0)
                write_json(status_path, dict(status_detail(wait_status), wait_status=wait_status))
                os._exit(0)
            except BaseException as exc:
                try:
                    write_json(launch_path, {"ok": False, "stage": "launcher_exception", "error": repr(exc)})
                except OSError:
                    pass
                os._exit(43)

        os.close(marker_r)
        os.close(life_w)
        self.launchers.append(launcher)
        handle = {
            "mode": mode,
            "token": token,
            "launcher_pid": launcher,
            "host_outer_pid": None,
            "pid_ns": None,
            "marker_w": marker_w,
            "life_r": life_r,
            "launch_path": launch_path,
            "status_path": status_path,
            "spawn_ok": False,
            "blocker": None,
        }
        self.hosts.append(handle)

        launch = read_json(launch_path, timeout_s=SPAWN_TIMEOUT_S)
        if launch is None:
            handle["blocker"] = "namespace_launcher_produced_no_record"
        elif not launch.get("ok"):
            handle["blocker"] = "namespace_unavailable:%s:%s" % (
                launch.get("stage"),
                launch.get("errno_name") or launch.get("error"),
            )
        else:
            handle["spawn_ok"] = True
            handle["host_outer_pid"] = launch.get("host_outer_pid")
            handle["pid_ns"] = launch.get("pid_ns")
            handle["launcher_record"] = launch
        return handle

    # -- generic marker channel ----------------------------------------

    def send_marker(self, handle, marker):
        try:
            os.write(handle["marker_w"], ("%s\n" % marker).encode("utf-8"))
            return True
        except OSError:
            return False

    def wait_file(self, path, timeout_s):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if os.path.exists(path):
                return True
            time.sleep(0.01)
        return False

    # -- termination and death proof -----------------------------------

    def terminate(self, handle):
        """Stop the namespace init from the outside, escalating if needed."""
        sequence = []
        host_pid = handle["host_outer_pid"]
        sequence.append(pidfd_signal(host_pid, signal.SIGTERM))
        deadline = time.monotonic() + TERM_GRACE_S
        while time.monotonic() < deadline:
            if not pid_alive(host_pid):
                break
            time.sleep(0.02)
        alive_after_term = pid_alive(host_pid)
        sequence.append(pidfd_signal(host_pid, signal.SIGKILL))
        return {
            "signals": sequence,
            "host_alive_after_sigterm": alive_after_term,
            "escalated_to_sigkill": alive_after_term,
        }

    def wait_lifetime_eof(self, handle, timeout_s=DEATH_PROOF_TIMEOUT_S):
        """True when every process holding the lifetime descriptor is dead."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                ready, _, _ = select.select([handle["life_r"]], [], [], 0.05)
            except OSError:
                return True
            if ready:
                try:
                    data = os.read(handle["life_r"], 1)
                except OSError:
                    return True
                if data == b"":
                    return True
        return False

    def reap_launcher(self, handle, timeout_s=DEATH_PROOF_TIMEOUT_S):
        """Wait for the launcher and read the host's wait status."""
        deadline = time.monotonic() + timeout_s
        status = None
        reaped = False
        while time.monotonic() < deadline:
            try:
                wpid, wait_status = os.waitpid(handle["launcher_pid"], os.WNOHANG)
            except ChildProcessError:
                reaped = True
                break
            if wpid == handle["launcher_pid"]:
                status = wait_status
                reaped = True
                break
            time.sleep(0.01)
        host_status = read_json(handle["status_path"], timeout_s=0.5) or {}
        return {
            "launcher_reaped": reaped,
            "launcher_status": status_text(status) if status is not None else None,
            "host_status": host_status.get("status"),
            "host_exit_code": host_status.get("exit_code"),
            "host_term_signal": host_status.get("term_signal"),
        }

    def heartbeat_advances(self, path, within_s=1.0):
        first = read_int(path)
        deadline = time.monotonic() + within_s
        while time.monotonic() < deadline:
            time.sleep(0.05)
            current = read_int(path)
            if current > first:
                return True, first, current
        return False, first, read_int(path)

    def heartbeat_stopped(self, path, within_s=HEARTBEAT_STOP_WINDOW_S):
        previous = read_int(path)
        stable = 0
        deadline = time.monotonic() + within_s
        while time.monotonic() < deadline:
            time.sleep(0.1)
            current = read_int(path)
            if current == previous:
                stable += 1
                if stable >= HEARTBEAT_STOP_STABLE_SAMPLES:
                    return True, previous, current
            else:
                stable = 0
                previous = current
        return False, previous, read_int(path)

    def live_descendant_census(self):
        """Outer-visible PIDs that descend from this supervisor right now."""
        parents = proc_parent_map()
        return sorted(descendant_closure(parents, os.getpid()))

    def prove_zero_residual(self, handles=()):
        """Parent-side proof that nothing this harness created is still alive."""
        deadline = time.monotonic() + 2.0
        last = None
        while time.monotonic() < deadline:
            parents = proc_parent_map()
            live_descendants = sorted(descendant_closure(parents, os.getpid()))
            tracked = []
            for handle in handles:
                for pid in (handle.get("host_outer_pid"), handle.get("launcher_pid")):
                    if pid is not None and pid_alive(pid):
                        tracked.append(pid)
            last = {
                "live_descendants_of_supervisor": live_descendants,
                "live_tracked_pids": sorted(set(tracked)),
            }
            if not live_descendants and not tracked:
                return {"clean": True, **last}
            time.sleep(0.05)
        return {"clean": False, **last}

    def final_cleanup(self):
        """Guaranteed cleanup: kill only our own children, then prove it."""
        parents = proc_parent_map()
        own = descendant_closure(parents, os.getpid())
        own = {pid for pid in own if pid != os.getpid()}
        for handle in self.hosts:
            for pid in (handle.get("host_outer_pid"), handle.get("launcher_pid")):
                if pid is not None:
                    own.add(pid)
        for pid in sorted(own):
            if pid_alive(pid):
                pidfd_signal(pid, signal.SIGKILL)
        # Reap every child, including adopted descendants, until none is left.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                wpid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if wpid == 0:
                time.sleep(0.02)
                continue
        for handle in self.hosts:
            try:
                os.close(handle["marker_w"])
            except OSError:
                pass
            try:
                os.close(handle["life_r"])
            except OSError:
                pass
        return self.prove_zero_residual(self.hosts)


# --------------------------------------------------------------------- cases

def base_case(supervisor, ledger, name, question):
    execution_id = ledger.new_execution_id()
    admitted, reason, slot = ledger.reserve(execution_id)
    record = {
        "case": name,
        "question": question,
        "execution_id": execution_id,
        "admitted": admitted,
        "admission_reason": reason,
        "slot": slot,
        "blocker": None,
    }
    return record, execution_id, slot


def case_clean_host(supervisor, ledger, token):
    """A host that cooperates is reaped and leaves nothing behind."""
    record, execution_id, slot = base_case(
        supervisor, ledger, "clean_host",
        "Can the parent reap a cooperating host and prove zero residual state?",
    )
    handle = supervisor.spawn_host("cooperate", token)
    record["host"] = {
        "mode": "cooperate",
        "outer_pid": handle["host_outer_pid"],
        "pid_ns": handle["pid_ns"],
    }
    if not handle["spawn_ok"]:
        record["blocker"] = handle["blocker"]
        record["pass"] = False
        return record
    host_identity = read_json(os.path.join(supervisor.rundir, "host-%s.json" % token), 3.0)
    record["host"]["identity"] = host_identity
    record["host"]["realm_capabilities"] = realm_capabilities(host_identity)
    record["host"]["realm_is_unprivileged"] = realm_is_unprivileged(host_identity)
    eof = supervisor.wait_lifetime_eof(handle)
    reap = supervisor.reap_launcher(handle)
    record["proof"] = {
        "lifetime_pipe_eof": eof,
        "host_status": reap["host_status"],
        "host_exit_code": reap["host_exit_code"],
        "launcher_reaped": reap["launcher_reaped"],
        "launcher_status": reap["launcher_status"],
    }
    residual = supervisor.prove_zero_residual([handle])
    record["residual"] = residual
    ledger.release_healthy(execution_id)
    record["ledger_after"] = ledger.state()
    record["pass"] = bool(
        eof
        and reap["launcher_reaped"]
        and reap["host_status"] == "exit:0"
        and residual["clean"]
        and record["host"]["realm_is_unprivileged"]
    )
    return record


def _never_settling_case(supervisor, ledger, token, name, mode, question):
    record, execution_id, slot = base_case(supervisor, ledger, name, question)
    handle = supervisor.spawn_host(mode, token)
    record["host"] = {
        "mode": mode,
        "outer_pid": handle["host_outer_pid"],
        "pid_ns": handle["pid_ns"],
    }
    if not handle["spawn_ok"]:
        record["blocker"] = handle["blocker"]
        record["pass"] = False
        return record

    host_identity = read_json(os.path.join(supervisor.rundir, "host-%s.json" % token), 3.0)
    record["host"]["identity"] = host_identity
    record["host"]["realm_capabilities"] = realm_capabilities(host_identity)
    record["host"]["realm_is_unprivileged"] = realm_is_unprivileged(host_identity)

    cleanup_path = os.path.join(supervisor.rundir, "cleanup-ack-%s.json" % token)
    join_path = os.path.join(supervisor.rundir, "join-ack-%s.json" % token)

    supervisor.send_marker(handle, "cleanup")
    cleanup_settled = supervisor.wait_file(cleanup_path, CLEANUP_BUDGET_MS / 1000.0)
    join_settled = supervisor.wait_file(join_path, JOIN_BUDGET_MS / 1000.0)

    fail_stop_started = time.monotonic()
    termination = supervisor.terminate(handle)
    eof = supervisor.wait_lifetime_eof(handle)
    reap = supervisor.reap_launcher(handle)
    residual = supervisor.prove_zero_residual([handle])
    descendant_count = wait_execution_descendant_count(handle)
    waited_ms = int(round((time.monotonic() - fail_stop_started) * 1000))

    record["settlement"] = {
        "cleanup_ack_requested": True,
        "cleanup_settled": cleanup_settled,
        "cleanup_budget_ms": CLEANUP_BUDGET_MS,
        "join_settled": join_settled,
        "join_budget_ms": JOIN_BUDGET_MS,
    }
    record["termination"] = termination
    record["proof"] = {
        "lifetime_pipe_eof": eof,
        "host_status": reap["host_status"],
        "host_term_signal": reap["host_term_signal"],
        "launcher_reaped": reap["launcher_reaped"],
        "launcher_status": reap["launcher_status"],
    }
    record["residual"] = residual
    record["fail_stop_receipt"] = fail_stop_receipt(
        execution_id,
        reap["launcher_reaped"],
        descendant_count,
        waited_ms,
    )

    retired, retired_slot = ledger.retire(execution_id, "FAIL_STOP_%s" % name.upper())
    record["capacity_retirement"] = {
        "retired": retired,
        "retired_slot": retired_slot,
        "slot_is_permanently_retired": bool(
            retired_slot is not None
            and ledger.slots[retired_slot]["state"] == "retired"
        ),
        "reason": ledger.slots[retired_slot]["retired_reason"] if retired_slot is not None else None,
    }
    record["ledger_after"] = ledger.state()

    expected_cleanup = mode == "never_settle_join"
    record["pass"] = bool(
        cleanup_settled == expected_cleanup
        and not join_settled
        and termination["escalated_to_sigkill"]
        and eof
        and reap["launcher_reaped"]
        and residual["clean"]
        and record["capacity_retirement"]["slot_is_permanently_retired"]
        and record["host"]["realm_is_unprivileged"]
    )
    return record


def case_never_settling_cleanup(supervisor, ledger, token):
    """Cleanup never settles: the parent must fail-stop and retire the slot."""
    return _never_settling_case(
        supervisor, ledger, token, "never_settling_cleanup", "never_settle_cleanup",
        "When cleanup never settles, can the parent fail-stop the host, prove it dead, "
        "and permanently retire the implicated capacity?",
    )


def case_never_settling_join(supervisor, ledger, token):
    """Cleanup settles but the join never settles."""
    return _never_settling_case(
        supervisor, ledger, token, "never_settling_join", "never_settle_join",
        "When the terminate/join never settles, can the parent fail-stop the host, "
        "prove it dead, and permanently retire the implicated capacity?",
    )


def case_daemonized_escaped_descendant(supervisor, ledger, token):
    """A setsid/double-fork descendant cannot escape the dedicated namespace."""
    record, execution_id, slot = base_case(
        supervisor, ledger, "daemonized_escaped_descendant",
        "Can a daemonized descendant escape the host's process group and session but not "
        "the dedicated PID namespace, and can the parent prove every descendant dead?",
    )
    handle = supervisor.spawn_host("daemon_escape", token)
    record["host"] = {
        "mode": "daemon_escape",
        "outer_pid": handle["host_outer_pid"],
        "pid_ns": handle["pid_ns"],
    }
    if not handle["spawn_ok"]:
        record["blocker"] = handle["blocker"]
        record["pass"] = False
        return record

    host_identity = read_json(os.path.join(supervisor.rundir, "host-%s.json" % token), 3.0)
    descendant = read_json(os.path.join(supervisor.rundir, "descendant-%s.json" % token), 3.0)
    heartbeat_path = os.path.join(supervisor.rundir, "heartbeat-%s.txt" % token)
    record["host"]["identity"] = host_identity
    record["host"]["realm_capabilities"] = realm_capabilities(host_identity)
    record["host"]["realm_is_unprivileged"] = realm_is_unprivileged(host_identity)
    record["descendant"] = descendant
    if descendant is None or host_identity is None:
        record["blocker"] = "fixture_identity_missing"
        record["pass"] = False
        return record

    advanced, hb_before, hb_after = supervisor.heartbeat_advances(heartbeat_path)
    members_while_alive = ns_outer_members(handle["pid_ns"])
    other_members = [pid for pid in members_while_alive if pid != handle["host_outer_pid"]]
    descendant_outer_pid = other_members[0] if len(other_members) == 1 else None
    host_outer_stat = proc_stat_fields(handle["host_outer_pid"])
    descendant_outer_stat = proc_stat_fields(descendant_outer_pid)

    escaped_group = descendant.get("pgid") != host_identity.get("pgid")
    escaped_session = descendant.get("sid") != host_identity.get("sid")
    same_namespace = descendant.get("pid_ns") == handle["pid_ns"] == host_identity.get("pid_ns")
    # Outer view: the descendant is a real, outer-visible process, but it sits in
    # a different outer process group and session than the host.
    escaped_group_outer = bool(
        host_outer_stat and descendant_outer_stat
        and descendant_outer_stat["pgid"] != host_outer_stat["pgid"]
    )
    escaped_session_outer = bool(
        host_outer_stat and descendant_outer_stat
        and descendant_outer_stat["sid"] != host_outer_stat["sid"]
    )
    descendant_inside_namespace = descendant_outer_pid is not None
    namespace_local_pid = descendant.get("pid") not in members_while_alive

    fail_stop_started = time.monotonic()
    termination = supervisor.terminate(handle)
    eof = supervisor.wait_lifetime_eof(handle)
    stopped, hb_pre_stop, hb_final = supervisor.heartbeat_stopped(heartbeat_path)
    reap = supervisor.reap_launcher(handle)
    residual = supervisor.prove_zero_residual([handle])
    members_after_death = wait_census_empty(handle)
    descendant_count = len(members_after_death)
    waited_ms = int(round((time.monotonic() - fail_stop_started) * 1000))

    record["descendant"]["realm_capabilities"] = realm_capabilities(descendant)
    record["descendant"]["realm_is_unprivileged"] = realm_is_unprivileged(descendant)
    record["escape"] = {
        "host_pgid": host_identity.get("pgid"),
        "host_sid": host_identity.get("sid"),
        "descendant_pgid": descendant.get("pgid"),
        "descendant_sid": descendant.get("sid"),
        "escaped_process_group": escaped_group,
        "escaped_session": escaped_session,
        "descendant_pid_ns": descendant.get("pid_ns"),
        "host_pid_ns_reported": host_identity.get("pid_ns"),
        "pid_ns_observed_by_parent": handle["pid_ns"],
        "descendant_still_inside_namespace": same_namespace,
        "descendant_outer_pid": descendant_outer_pid,
        "descendant_outer_pid_inside_namespace": descendant_inside_namespace,
        "descendant_namespace_local_pid": namespace_local_pid,
        "host_outer_stat": host_outer_stat,
        "descendant_outer_stat": descendant_outer_stat,
        "escaped_process_group_outer_view": escaped_group_outer,
        "escaped_session_outer_view": escaped_session_outer,
        "ns_members_outer_visible_while_alive": members_while_alive,
        "ns_members_outer_visible_after_death": members_after_death,
        "process_group_termination_alone_is_sufficient": False,
        "process_group_note": (
            "the descendant left the host's process group and session in the outer "
            "view as well as the inner view; the parent signals only the namespace "
            "init, so the descendant dies from namespace destruction and not from "
            "process-group termination"
        ),
    }
    record["heartbeat"] = {
        "advanced_while_descendant_alive": advanced,
        "before": hb_before,
        "after": hb_after,
        "stopped_after_namespace_init_kill": stopped,
        "value_before_stop_check": hb_pre_stop,
        "final_value": hb_final,
    }
    record["termination"] = termination
    record["proof"] = {
        "lifetime_pipe_eof": eof,
        "host_status": reap["host_status"],
        "host_term_signal": reap["host_term_signal"],
        "launcher_reaped": reap["launcher_reaped"],
        "launcher_status": reap["launcher_status"],
    }
    record["residual"] = residual
    record["fail_stop_receipt"] = fail_stop_receipt(
        execution_id,
        reap["launcher_reaped"],
        descendant_count,
        waited_ms,
    )

    retired, retired_slot = ledger.retire(execution_id, "FAIL_STOP_DAEMONIZED_ESCAPED_DESCENDANT")
    record["capacity_retirement"] = {
        "retired": retired,
        "retired_slot": retired_slot,
        "slot_is_permanently_retired": bool(
            retired_slot is not None and ledger.slots[retired_slot]["state"] == "retired"
        ),
    }
    record["ledger_after"] = ledger.state()

    record["pass"] = bool(
        advanced
        and escaped_group
        and escaped_session
        and escaped_group_outer
        and escaped_session_outer
        and same_namespace
        and descendant_inside_namespace
        and namespace_local_pid
        and stopped
        and eof
        and reap["launcher_reaped"]
        and residual["clean"]
        and not members_after_death
        and record["capacity_retirement"]["slot_is_permanently_retired"]
        and record["host"]["realm_is_unprivileged"]
        and record["descendant"]["realm_is_unprivileged"]
    )
    return record


def case_aggregate_pressure(supervisor, ledger, token):
    """Admission cap, aggregate pressure, and permanent capacity retirement."""
    record = {
        "case": "aggregate_pressure_capacity_retirement",
        "question": (
            "Under aggregate pressure, does the parent reject over-capacity and "
            "retired-identity reuse before spawning anything, and never return an "
            "implicated slot to the pool?"
        ),
        "blocker": None,
    }
    capacity = 2
    steps = []

    id_a = ledger.new_execution_id()
    ok_a, reason_a, slot_a = ledger.reserve(id_a)
    handle_a = supervisor.spawn_host("never_settle_cleanup", "%s-A" % token)
    if not handle_a["spawn_ok"]:
        record["blocker"] = handle_a["blocker"]
        record["pass"] = False
        return record

    host_a_identity = read_json(os.path.join(supervisor.rundir, "host-%s-A.json" % token), 3.0)
    record["host_realm"] = {
        "capabilities": realm_capabilities(host_a_identity),
        "is_unprivileged": realm_is_unprivileged(host_a_identity),
    }

    id_b = ledger.new_execution_id()
    ok_b, reason_b, slot_b = ledger.reserve(id_b)
    handle_b = supervisor.spawn_host("hold", "%s-B" % token)
    if not handle_b["spawn_ok"]:
        record["blocker"] = handle_b["blocker"]
        record["pass"] = False
        return record

    hosts_before = len(supervisor.hosts)
    census_before = supervisor.live_descendant_census()
    id_c = ledger.new_execution_id()
    ok_c, reason_c, slot_c = ledger.reserve(id_c)
    hosts_after = len(supervisor.hosts)
    census_after = supervisor.live_descendant_census()
    steps.append({
        "step": "over_capacity_reserve",
        "execution_id": id_c,
        "admitted": ok_c,
        "reason": reason_c,
        "hosts_spawned_before": hosts_before,
        "hosts_spawned_after": hosts_after,
        "live_descendant_census_before": census_before,
        "live_descendant_census_after": census_after,
        "no_process_spawned_on_reject": hosts_after == hosts_before and census_after == census_before,
    })

    # Fail-stop A: never-settling cleanup, hard kill, parent-proven death.
    supervisor.send_marker(handle_a, "cleanup")
    cleanup_settled_a = supervisor.wait_file(
        os.path.join(supervisor.rundir, "cleanup-ack-%s-A.json" % token), CLEANUP_BUDGET_MS / 1000.0
    )
    fail_stop_a_started = time.monotonic()
    termination_a = supervisor.terminate(handle_a)
    eof_a = supervisor.wait_lifetime_eof(handle_a)
    reap_a = supervisor.reap_launcher(handle_a)
    descendant_count_a = wait_execution_descendant_count(handle_a)
    # The receipt's waitedMs is the fail-stop wait: terminate, death proof,
    # launcher reap and the bounded census drain. It is measured before the
    # residual proof, which is a separate observation and, while another
    # execution of this case is still alive by design, cannot become clean.
    waited_a_ms = int(round((time.monotonic() - fail_stop_a_started) * 1000))
    residual_a = supervisor.prove_zero_residual([handle_a])
    retired_a, retired_slot_a = ledger.retire(id_a, "FAIL_STOP_AGGREGATE_PRESSURE")
    steps.append({
        "step": "fail_stop_execution_a",
        "execution_id": id_a,
        "cleanup_settled": cleanup_settled_a,
        "escalated_to_sigkill": termination_a["escalated_to_sigkill"],
        "lifetime_pipe_eof": eof_a,
        "host_status": reap_a["host_status"],
        "launcher_reaped": reap_a["launcher_reaped"],
        "slot_retired": retired_a,
        "retired_slot": retired_slot_a,
        "fail_stop_receipt": fail_stop_receipt(
            id_a, reap_a["launcher_reaped"], descendant_count_a, waited_a_ms
        ),
    })

    ok_reuse, reason_reuse, slot_reuse = ledger.reserve(id_a)
    steps.append({
        "step": "retired_identity_reuse",
        "execution_id": id_a,
        "admitted": ok_reuse,
        "reason": reason_reuse,
    })

    id_d = ledger.new_execution_id()
    ok_d, reason_d, slot_d = ledger.reserve(id_d)
    steps.append({
        "step": "fresh_identity_after_retirement",
        "execution_id": id_d,
        "admitted": ok_d,
        "reason": reason_d,
        "slot": slot_d,
        "retired_slot_was_not_reused": slot_d != retired_slot_a,
    })

    # B terminates healthily: the identifier is tombstoned, the slot returns.
    supervisor.send_marker(handle_b, "cleanup")
    cleanup_settled_b = supervisor.wait_file(
        os.path.join(supervisor.rundir, "cleanup-ack-%s-B.json" % token), CLEANUP_BUDGET_MS / 1000.0
    )
    supervisor.send_marker(handle_b, "terminate")
    join_settled_b = supervisor.wait_file(
        os.path.join(supervisor.rundir, "join-ack-%s-B.json" % token), JOIN_BUDGET_MS / 1000.0
    )
    eof_b = supervisor.wait_lifetime_eof(handle_b)
    reap_b = supervisor.reap_launcher(handle_b)
    released_b, released_slot_b = ledger.release_healthy(id_b)
    steps.append({
        "step": "healthy_release_execution_b",
        "execution_id": id_b,
        "cleanup_settled": cleanup_settled_b,
        "join_settled": join_settled_b,
        "lifetime_pipe_eof": eof_b,
        "host_status": reap_b["host_status"],
        "launcher_reaped": reap_b["launcher_reaped"],
        "slot_released": released_b,
        "released_slot": released_slot_b,
    })

    id_e = ledger.new_execution_id()
    ok_e, reason_e, slot_e = ledger.reserve(id_e)
    handle_e = supervisor.spawn_host("hold", "%s-E" % token)
    spawn_ok_e = handle_e["spawn_ok"]
    steps.append({
        "step": "admit_execution_e_after_release",
        "execution_id": id_e,
        "admitted": ok_e,
        "reason": reason_e,
        "slot": slot_e,
        "spawned": spawn_ok_e,
        "retired_slot_was_not_reused": slot_e != retired_slot_a,
    })

    id_f = ledger.new_execution_id()
    ok_f, reason_f, slot_f = ledger.reserve(id_f)
    steps.append({
        "step": "over_capacity_after_one_slot_retired",
        "execution_id": id_f,
        "admitted": ok_f,
        "reason": reason_f,
    })

    if spawn_ok_e:
        supervisor.send_marker(handle_e, "cleanup")
        supervisor.wait_file(
            os.path.join(supervisor.rundir, "cleanup-ack-%s-E.json" % token), CLEANUP_BUDGET_MS / 1000.0
        )
        fail_stop_e_started = time.monotonic()
        termination_e = supervisor.terminate(handle_e)
        eof_e = supervisor.wait_lifetime_eof(handle_e)
        reap_e = supervisor.reap_launcher(handle_e)
        descendant_count_e = wait_execution_descendant_count(handle_e)
        waited_e_ms = int(round((time.monotonic() - fail_stop_e_started) * 1000))
        residual_e = supervisor.prove_zero_residual([handle_e])
        retired_e, retired_slot_e = ledger.retire(id_e, "FAIL_STOP_AGGREGATE_PRESSURE_SECOND")
        receipt_e = fail_stop_receipt(
            id_e, reap_e["launcher_reaped"], descendant_count_e, waited_e_ms
        )
    else:
        # Execution E was never spawned, so there is no execution to fail-stop
        # and no fail-stop to project. The published receipt shape pins
        # hostTerminated and capacityRetired to true, so a receipt here would
        # claim a termination and a capacity retirement that never happened.
        # Sampling the census of a namespace that was never created would
        # claim a death proof for an execution that never existed, so no
        # census is sampled here either. The case fails on the evidence
        # recorded above rather than on a fabricated receipt.
        termination_e = {"escalated_to_sigkill": False}
        eof_e = False
        reap_e = {"host_status": None, "launcher_reaped": False}
        descendant_count_e = None
        retired_e, retired_slot_e = False, None
        receipt_e = None
    steps.append({
        "step": "fail_stop_execution_e",
        "execution_id": id_e,
        "escalated_to_sigkill": termination_e.get("escalated_to_sigkill"),
        "lifetime_pipe_eof": eof_e,
        "host_status": reap_e["host_status"],
        "launcher_reaped": reap_e["launcher_reaped"],
        "slot_retired": retired_e,
        "retired_slot": retired_slot_e,
        "fail_stop_receipt": receipt_e,
    })

    id_g = ledger.new_execution_id()
    ok_g, reason_g, slot_g = ledger.reserve(id_g)
    steps.append({
        "step": "reserve_after_all_capacity_retired",
        "execution_id": id_g,
        "admitted": ok_g,
        "reason": reason_g,
    })

    residual = supervisor.prove_zero_residual([handle_a, handle_b, handle_e])
    record["steps"] = steps
    record["ledger_after"] = ledger.state()
    record["residual"] = residual
    record["pass"] = bool(
        ok_a and slot_a == 0
        and ok_b and slot_b == 1
        and not ok_c and reason_c == "CAPACITY_EXHAUSTED"
        and steps[0]["no_process_spawned_on_reject"]
        and not cleanup_settled_a
        and termination_a["escalated_to_sigkill"]
        and eof_a and reap_a["launcher_reaped"]
        and retired_a and ledger.slots[retired_slot_a]["state"] == "retired"
        and not ok_reuse and reason_reuse == "EXECUTION_ID_RETIRED"
        and not ok_d and reason_d == "CAPACITY_EXHAUSTED"
        and cleanup_settled_b and join_settled_b and eof_b and reap_b["launcher_reaped"]
        and released_b
        and ok_e and slot_e == 1
        and not ok_f and reason_f == "CAPACITY_EXHAUSTED"
        and eof_e and reap_e["launcher_reaped"]
        and retired_e and ledger.slots[retired_slot_e]["state"] == "retired"
        and not ok_g and reason_g == "CAPACITY_RETIRED"
        and residual["clean"]
        and record["host_realm"]["is_unprivileged"]
    )
    return record


CASES = {
    "clean_host": case_clean_host,
    "never_settling_cleanup": case_never_settling_cleanup,
    "never_settling_join": case_never_settling_join,
    "daemonized_escaped_descendant": case_daemonized_escaped_descendant,
    "aggregate_pressure_capacity_retirement": case_aggregate_pressure,
}


# ---------------------------------------------------------------------- main

def probe_capabilities(supervisor):
    """Read-only capability discovery. No sudo, no provisioning, no mutation."""
    caps = {
        "pidfd": {
            "pidfd_open": hasattr(os, "pidfd_open"),
            "pidfd_send_signal": hasattr(signal, "pidfd_send_signal"),
            "waitid_P_PIDFD": hasattr(os, "P_PIDFD"),
        },
        "prctl_subreaper": {
            "prctl_available": supervisor.subreaper_ok,
            "current_value": supervisor.subreaper_value,
            "enabled_for_this_run": supervisor.subreaper,
        },
        "pid_namespace": {
            "mechanism": "unshare(CLONE_NEWUSER|CLONE_NEWPID) with uid_map/gid_map",
            "self_ns": ns_link(os.getpid()),
        },
        "cgroup2": {"used": False, "note": "cgroup delegation is unavailable on this host and is not used"},
    }
    try:
        with open("/proc/sys/kernel/unprivileged_userns_clone", "r", encoding="utf-8") as handle:
            caps["pid_namespace"]["unprivileged_userns_clone"] = handle.read().strip()
    except OSError:
        caps["pid_namespace"]["unprivileged_userns_clone"] = None
    return caps


def main(argv):
    rundir = None
    out_path = None
    requested = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--rundir" and index + 1 < len(argv):
            rundir = argv[index + 1]
            index += 2
        elif arg == "--out" and index + 1 < len(argv):
            out_path = argv[index + 1]
            index += 2
        elif arg == "--case" and index + 1 < len(argv):
            requested.append(argv[index + 1])
            index += 2
        else:
            sys.stderr.write("unknown argument: %s\n" % arg)
            return 64
    if rundir is None:
        sys.stderr.write("--rundir is required\n")
        return 64
    os.makedirs(rundir, exist_ok=True)

    selected = requested or list(CASES)
    unknown = [name for name in selected if name not in CASES]
    if unknown:
        sys.stderr.write("unknown case(s): %s\n" % ",".join(unknown))
        return 64

    supervisor = Supervisor(rundir)
    token_base = "rh-%d-%s" % (os.getpid(), os.urandom(3).hex())

    cases = []
    ledgers = []
    for name in selected:
        started = time.time()
        begin = time.monotonic()
        # Each case owns a fresh admission ledger: capacity retirement is a
        # per-supervisor-lifetime fact and must not leak between cases.
        ledger = CapacityLedger(capacity=2)
        ledgers.append(ledger)
        try:
            record = CASES[name](supervisor, ledger, "%s-%s" % (token_base, name))
        except Exception as exc:  # noqa: BLE001 - the harness must never crash silently
            record = {
                "case": name,
                "pass": False,
                "error": "%s: %s" % (type(exc).__name__, exc),
                "blocker": None,
            }
        record["started_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
        record["wall_s"] = round(time.monotonic() - begin, 3)
        record["within_budget"] = record["wall_s"] < CASE_BUDGET_S
        if not record["within_budget"]:
            record["pass"] = False
        cases.append(record)

    final = supervisor.final_cleanup()
    capabilities = probe_capabilities(supervisor)
    namespace_blockers = [
        case.get("blocker") for case in cases if case.get("blocker")
    ]

    result = {
        "kind": "struct-resolver-sacrificial-host-harness",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rundir": rundir,
        "host": {
            "kernel": os.uname().release,
            "machine": os.uname().machine,
            "uid": os.getuid(),
            "python": sys.version.split()[0],
            "pid": os.getpid(),
        },
        "not_claimed": [
            "not a security approval",
            "not a Struct implementation",
            "not S-03 or S-04 completion",
            "no resolver, network, or filesystem transport behaviour is exercised",
            "the parent/host channel is a generic probe channel, not the resolver contract",
            "a descendant that creates a nested user+PID namespace is not covered by the containment claim",
        ],
        "capabilities": capabilities,
        "capability_blockers": namespace_blockers,
        "cases": cases,
        "final_cleanup": {
            "zero_residual": bool(final.get("clean")),
            "live_descendants": final.get("live_descendants_of_supervisor", []),
            "live_tracked_pids": final.get("live_tracked_pids", []),
        },
        "summary": {
            "cases": len(cases),
            "passed": sum(1 for case in cases if case.get("pass")),
            "failed": sum(1 for case in cases if not case.get("pass")),
            "all_passed": all(case.get("pass") for case in cases),
            "zero_residual_after_run": bool(final.get("clean")),
            "capacity_ledger": ledgers[-1].state() if ledgers else None,
        },
        "ledger_events": [event for ledger in ledgers for event in ledger.events],
    }

    text = json.dumps(result, indent=2)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.write("\n")
    sys.stdout.write(text)
    sys.stdout.write("\n")
    return 0 if result["summary"]["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
