#!/usr/bin/env python3
"""Parent-owned OS host supervisor for the real resolver conformance binding.

This supervisor runs OUTSIDE the host realm. It is the direct OS ancestor of
every sacrificial executor body it creates, it owns the host slot registry,
and it is the only party allowed to decide that a host is dead.

It reuses the proven OS primitives of the reviewed sacrificial host harness
(``parent_harness.py``): the dedicated ``unshare(CLONE_NEWUSER | CLONE_NEWPID)``
realm, the complete capability drop, ``pidfd_open``/``pidfd_send_signal``
signalling, ``PR_SET_CHILD_SUBREAPER`` adoption, the per-host lifetime pipe
whose end-of-file is a kernel-level proof of death, and the outer-visible PID
namespace census.

The control channel is a narrow line protocol on stdin/stdout. There is no
ambient command API: the supervisor understands exactly five verbs, each of
which is bound to one host slot it owns.

  * ``spawn``     -- create one host realm for one execution identifier.
  * ``failstop``  -- hard kill the host realm and prove every descendant dead.
  * ``status``    -- report the observed host status.
  * ``shutdown``  -- kill everything this supervisor created and prove it.

The supervisor never kills a process it did not create.
"""

import ctypes
import errno
import json
import os
import select
import signal
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import parent_harness as ph  # noqa: E402 - the reviewed OS primitives
import real_host_body  # noqa: E402 - the shared fixture table

BODY = os.path.join(BASE, "real_host_body.py")

CLONE_NEWUSER = 0x10000000
CLONE_NEWPID = 0x20000000

# Fixed descriptor numbers the executor body inherits for its two output
# channels. The supervisor pins them here so the body never has to open a
# FIFO for writing, which would race with the parent opening the reader end.
BODY_OUT_FD = 20
REV_OUT_FD = 21

SPAWN_TIMEOUT_S = 8.0
TERM_GRACE_S = 0.3
DEATH_PROOF_TIMEOUT_S = 5.0
REAP_TIMEOUT_S = 5.0
REPORT_POLL_S = 0.05

libc = ctypes.CDLL(None, use_errno=True)


class Host:
    """One host slot owned by this supervisor."""

    def __init__(self, execution_id, mode, fifos):
        self.execution_id = execution_id
        self.mode = mode
        self.fifos = fifos
        self.launcher_pid = None
        self.host_outer_pid = None
        self.pid_ns = None
        self.launch_detail = None
        self.host_status = None
        self.life_r = None
        self.spawn_ok = False
        self.blocker = None


class Supervisor:
    """Owns every process and every descriptor this binding creates."""

    def __init__(self, rundir):
        self.rundir = rundir
        os.makedirs(rundir, exist_ok=True)
        self.hosts = {}
        self.subreaper_ok, self.subreaper_value = ph.prctl_subreaper(True)
        self.subreaper = bool(self.subreaper_ok and self.subreaper_value == 1)
        self.pidfd_ok = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
        self.report_r, self.report_w = os.pipe()
        self.report_buffer = ""

    # -- fifo plumbing ----------------------------------------------------

    def _fifo_paths(self, execution_id):
        token = "rc-%s" % execution_id
        return {
            "bodyIn": os.path.join(self.rundir, "body-in-%s.fifo" % token),
            "bodyOut": os.path.join(self.rundir, "body-out-%s.fifo" % token),
            "revIn": os.path.join(self.rundir, "rev-in-%s.fifo" % token),
            "revOut": os.path.join(self.rundir, "rev-out-%s.fifo" % token),
        }

    def _make_fifos(self, paths):
        for path in paths.values():
            if os.path.exists(path):
                os.unlink(path)
            os.mkfifo(path, 0o600)

    @staticmethod
    def _pin(fd, target):
        """Move a descriptor to a fixed number so it survives the exec."""
        if fd != target:
            os.dup2(fd, target)
            os.close(fd)
        os.set_inheritable(target, True)
        return target

    def _open_channel_writer(self, path, target):
        """Open the write side of a FIFO before the parent opens the reader.

        The descriptor is opened read/write so that the open never fails with
        ENXIO. The supervisor closes its own copy right after the fork, so the
        only remaining writer is the host realm and the parent observes a
        genuine end-of-file exactly when the realm and every descendant are
        gone.
        """
        fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        return self._pin(fd, target)

    # -- launcher reporting ------------------------------------------------

    def _report(self, value):
        try:
            os.write(self.report_w, (json.dumps(value, sort_keys=True) + "\n").encode("utf-8"))
        except OSError:
            pass

    def _drain_reports(self, timeout_s=0.0):
        """Absorb every launcher report that is currently available."""
        deadline = time.monotonic() + max(timeout_s, 0.0)
        while True:
            try:
                readable, _, _ = select.select([self.report_r], [], [], REPORT_POLL_S)
            except (OSError, ValueError):
                break
            if not readable:
                if time.monotonic() >= deadline:
                    break
                continue
            try:
                chunk = os.read(self.report_r, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.report_buffer += chunk.decode("utf-8", "replace")
            while "\n" in self.report_buffer:
                line, self.report_buffer = self.report_buffer.split("\n", 1)
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                self._absorb(value)
            if time.monotonic() >= deadline:
                break

    def _absorb(self, value):
        host = self.hosts.get(value.get("executionId"))
        if host is None:
            return
        event = value.get("event")
        if event == "spawned":
            host.host_outer_pid = value.get("host_outer_pid")
            host.pid_ns = value.get("pid_ns")
        elif event == "host-status":
            host.host_status = value.get("status")
            host.launch_detail = value.get("detail")
        elif event == "spawn-error":
            host.blocker = "namespace-unavailable:%s:%s" % (
                value.get("stage"),
                value.get("errno_name") or value.get("error"),
            )

    def _await_report(self, host, event, timeout_s):
        """Wait for one specific launcher report for one host."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._drain_reports(0.05)
            if event == "spawned":
                if host.host_outer_pid is not None:
                    return {"event": "spawned"}
                if host.blocker is not None:
                    return {"event": "spawn-error"}
            elif event == "host-status":
                if host.host_status is not None:
                    return {"event": "host-status"}
            time.sleep(0.005)
        return None

    # -- spawning ---------------------------------------------------------

    def spawn(self, execution_id, mode):
        """Create one host realm for one execution identifier."""
        if execution_id in self.hosts:
            return {"ok": False, "blocker": "execution-already-spawned"}
        paths = self._fifo_paths(execution_id)
        self._make_fifos(paths)
        host = Host(execution_id, mode, paths)
        self.hosts[execution_id] = host

        life_r, life_w = os.pipe()
        host.life_r = life_r
        # The write ends are opened before the launcher exists, so the parent
        # never observes a spurious end-of-file on an empty channel.
        self._open_channel_writer(paths["bodyOut"], BODY_OUT_FD)
        self._open_channel_writer(paths["revOut"], REV_OUT_FD)

        launcher = os.fork()
        if launcher == 0:
            try:
                os.close(life_r)
                os.close(self.report_r)
                os.setpgid(0, 0)
                uid = os.getuid()
                gid = os.getgid()
                if libc.unshare(CLONE_NEWUSER | CLONE_NEWPID) != 0:
                    err = ctypes.get_errno()
                    self._report({
                        "executionId": execution_id,
                        "event": "spawn-error",
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
                    self._report({
                        "executionId": execution_id,
                        "event": "spawn-error",
                        "stage": "id_map",
                        "error": str(exc),
                    })
                    os._exit(41)
                capabilities_dropped = ph.drop_all_capabilities()
                child = os.fork()
                if child == 0:
                    try:
                        os.dup2(life_w, 3)
                        if life_w != 3:
                            os.close(life_w)
                        ph.child_limits()
                        ph.drop_all_capabilities()
                        os.execv(
                            sys.executable,
                            [
                                sys.executable, BODY, mode,
                                paths["bodyIn"], paths["revIn"],
                                str(BODY_OUT_FD), str(REV_OUT_FD),
                            ],
                        )
                    except BaseException:
                        os._exit(42)
                os.close(life_w)
                self._report({
                    "executionId": execution_id,
                    "event": "spawned",
                    "host_outer_pid": child,
                    "launcher_pid": os.getpid(),
                    "pid_ns": ph.ns_link(child),
                    "capabilities_dropped": capabilities_dropped,
                    "launcher_capabilities": ph.read_capabilities(),
                })
                _, wait_status = os.waitpid(child, 0)
                self._report({
                    "executionId": execution_id,
                    "event": "host-status",
                    "status": ph.status_text(wait_status),
                    "detail": ph.status_detail(wait_status),
                })
                os._exit(0)
            except BaseException as exc:
                try:
                    self._report({
                        "executionId": execution_id,
                        "event": "spawn-error",
                        "stage": "launcher-exception",
                        "error": repr(exc),
                    })
                except OSError:
                    pass
                os._exit(43)

        os.close(life_w)
        host.launcher_pid = launcher
        # The supervisor keeps no writer copy: the only remaining writer is the
        # host realm, so the parent's end-of-file is a real death signal.
        for target in (BODY_OUT_FD, REV_OUT_FD):
            try:
                os.close(target)
            except OSError:
                pass

        report = self._await_report(host, "spawned", SPAWN_TIMEOUT_S)
        if report is None:
            host.blocker = "namespace-launcher-produced-no-record"
            return {"ok": False, "blocker": host.blocker, "fifos": paths}
        if host.blocker is not None:
            return {"ok": False, "blocker": host.blocker, "fifos": paths}

        host.spawn_ok = True
        return {
            "ok": True,
            "fifos": paths,
            "hostOuterPid": host.host_outer_pid,
            "launcherPid": host.launcher_pid,
            "pidNs": host.pid_ns,
            "pidfd": self.pidfd_ok,
            "subreaper": self.subreaper,
        }

    # -- termination and death proof --------------------------------------

    def wait_lifetime_eof(self, host, timeout_s=DEATH_PROOF_TIMEOUT_S):
        """True when every process holding the lifetime descriptor is dead."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                ready, _, _ = select.select([host.life_r], [], [], 0.05)
            except OSError:
                return True
            if ready:
                try:
                    data = os.read(host.life_r, 1)
                except OSError:
                    return True
                if data == b"":
                    return True
        return False

    def reap_launcher(self, host, timeout_s=REAP_TIMEOUT_S):
        """Wait for the launcher and collect the host status it observed."""
        deadline = time.monotonic() + timeout_s
        reaped = False
        while time.monotonic() < deadline:
            self._drain_reports(0.02)
            if host.host_status is not None:
                break
            try:
                wpid, _ = os.waitpid(host.launcher_pid, os.WNOHANG)
            except ChildProcessError:
                reaped = True
                break
            if wpid == host.launcher_pid:
                reaped = True
            time.sleep(0.01)
        self._drain_reports(0.05)
        return {
            "launcher_reaped": reaped or host.host_status is not None,
            "host_status": host.host_status,
            "host_detail": host.launch_detail,
        }

    def namespace_members(self, host):
        """Outer-visible PIDs that live in the host's PID namespace."""
        return ph.ns_outer_members(host.pid_ns)

    def fail_stop(self, execution_id):
        """Hard kill the host realm and prove every descendant dead."""
        host = self.hosts.get(execution_id)
        if host is None:
            return {"ok": False, "blocker": "unknown-execution"}
        if not host.spawn_ok:
            return {"ok": False, "blocker": host.blocker or "host-not-spawned"}

        started = time.monotonic()
        members_before = self.namespace_members(host)
        signals = []
        signals.append(ph.pidfd_signal(host.host_outer_pid, signal.SIGTERM))
        deadline = time.monotonic() + TERM_GRACE_S
        while time.monotonic() < deadline:
            if not ph.pid_alive(host.host_outer_pid):
                break
            time.sleep(0.02)
        alive_after_term = ph.pid_alive(host.host_outer_pid)
        signals.append(ph.pidfd_signal(host.host_outer_pid, signal.SIGKILL))

        eof = self.wait_lifetime_eof(host)
        reap = self.reap_launcher(host)
        members_after = self.namespace_members(host)
        waited_ms = int(round((time.monotonic() - started) * 1000))

        descendant_count = len(members_after)
        host_reaped = bool(reap["launcher_reaped"] and host.host_status is not None)
        receipt = ph.fail_stop_receipt(
            execution_id, host_reaped, descendant_count, waited_ms, method="pid-namespace"
        )
        return {
            "ok": True,
            "receipt": receipt,
            "proof": {
                "signals": signals,
                "host_alive_after_sigterm": alive_after_term,
                "escalated_to_sigkill": alive_after_term,
                "lifetime_pipe_eof": eof,
                "host_status": host.host_status,
                "host_detail": reap["host_detail"],
                "launcher_reaped": reap["launcher_reaped"],
                "ns_members_outer_visible_before_kill": members_before,
                "ns_members_outer_visible_after_death": members_after,
                "descendant_count": descendant_count,
                "waited_ms": waited_ms,
                "method": "pid-namespace",
            },
        }

    # -- status and cleanup ------------------------------------------------

    def status(self, execution_id):
        host = self.hosts.get(execution_id)
        if host is None:
            return {"ok": False, "blocker": "unknown-execution"}
        self._drain_reports(0.02)
        return {
            "ok": True,
            "host_status": host.host_status,
            "host_outer_pid": host.host_outer_pid,
            "pid_ns": host.pid_ns,
            "ns_members": self.namespace_members(host),
            "alive": ph.pid_alive(host.host_outer_pid),
        }

    def final_cleanup(self):
        """Kill only what this supervisor created, then prove it is gone."""
        for host in self.hosts.values():
            for pid in (host.host_outer_pid, host.launcher_pid):
                if pid is not None:
                    ph.pidfd_signal(pid, signal.SIGKILL)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                wpid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if wpid == 0:
                time.sleep(0.02)
                continue
        for host in self.hosts.values():
            if host.life_r is not None:
                try:
                    os.close(host.life_r)
                except OSError:
                    pass
                host.life_r = None
        try:
            os.close(self.report_r)
            os.close(self.report_w)
        except OSError:
            pass
        parents = ph.proc_parent_map()
        live = sorted(ph.descendant_closure(parents, os.getpid()))
        live = [pid for pid in live if pid != os.getpid()]
        for host in self.hosts.values():
            for pid in (host.host_outer_pid, host.launcher_pid):
                if pid is not None and ph.pid_alive(pid):
                    live.append(pid)
        return {"clean": not live, "live": sorted(set(live))}


# ---------------------------------------------------------------------- main

def main(argv):
    rundir = None
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--rundir" and index + 1 < len(argv):
            rundir = argv[index + 1]
            index += 2
        else:
            sys.stderr.write("unknown argument: %s\n" % arg)
            return 64
    if rundir is None:
        sys.stderr.write("--rundir is required\n")
        return 64

    supervisor = Supervisor(rundir)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except ValueError:
            continue
        op = command.get("op")
        request_id = command.get("id")
        execution_id = command.get("executionId")

        if op == "spawn":
            response = supervisor.spawn(execution_id, command.get("mode") or "conformant")
        elif op == "manifest":
            response = {"ok": True, "assets": real_host_body.fixture_manifest()}
        elif op == "failstop":
            response = supervisor.fail_stop(execution_id)
        elif op == "status":
            response = supervisor.status(execution_id)
        elif op == "shutdown":
            final = supervisor.final_cleanup()
            response = {"ok": True, "final_cleanup": final}
            response["id"] = request_id
            sys.stdout.write(json.dumps(response, sort_keys=True) + "\n")
            sys.stdout.flush()
            return 0 if final.get("clean") else 1
        else:
            response = {"ok": False, "blocker": "unknown-op"}

        response["id"] = request_id
        sys.stdout.write(json.dumps(response, sort_keys=True) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
