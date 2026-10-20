#!/usr/bin/env python3
"""Sacrificial verification host fixture for the resolver-host harness.

This process is the *host realm*. parent_harness.py spawns it as PID 1 of a
dedicated PID namespace, so it holds no authority over the supervisor and the
supervisor cannot make it cooperate. The supervisor can only observe it from
the outside and can only end it by destroying the namespace.

Nothing in this file implements a Struct resolver protocol. The
supervisor/host channel is a deliberately generic probe channel: newline
markers on stdin and JSON acknowledgement files in the run directory. It
exists so that this fixture cannot collide with, or pre-empt, the separately
published resolver contract.

The fixture never touches the network, never resolves a filesystem locator,
and never reads ambient secrets. It only writes small JSON/timestamp files
inside the run directory it is given.
"""

import json
import os
import signal
import sys
import time

HEARTBEAT_INTERVAL_S = 0.05
SLEEP_INTERVAL_S = 0.05


def write_json(path, value):
    """Atomically publish a small JSON document."""
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True)
    os.replace(tmp, path)


def read_capability(name):
    """Read one capability bitmask of this process from /proc/self/status."""
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(name + ":"):
                    return int(line.split()[1], 16)
    except (OSError, ValueError):
        pass
    return None


def identity(role):
    """Identity of this process as seen from inside its own namespaces."""
    return {
        "role": role,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "pgid": os.getpgid(0),
        "sid": os.getsid(0),
        "pid_ns": os.readlink("/proc/self/ns/pid"),
        "user_ns": os.readlink("/proc/self/ns/user"),
        "uid": os.getuid(),
        "argv_role": role,
        "cap_eff": read_capability("CapEff"),
        "cap_prm": read_capability("CapPrm"),
        "cap_bnd": read_capability("CapBnd"),
    }


def host_path(rundir, token):
    return os.path.join(rundir, "host-%s.json" % token)


def cleanup_ack_path(rundir, token):
    return os.path.join(rundir, "cleanup-ack-%s.json" % token)


def join_ack_path(rundir, token):
    return os.path.join(rundir, "join-ack-%s.json" % token)


def descendant_path(rundir, token):
    return os.path.join(rundir, "descendant-%s.json" % token)


def heartbeat_path(rundir, token):
    return os.path.join(rundir, "heartbeat-%s.txt" % token)


def spawn_escaped_descendant(rundir, token):
    """Double-fork + setsid descendant that leaves the host's process group.

    The descendant ignores SIGTERM/SIGINT/SIGHUP, keeps a monotonically
    increasing heartbeat file so the supervisor can observe that it is alive,
    and holds the inherited lifetime file descriptor open so that the
    supervisor's end-of-file observation proves its death.
    """
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            pid2 = os.fork()
            if pid2 == 0:
                for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                    signal.signal(sig, signal.SIG_IGN)
                info = identity("escaped-descendant")
                info["daemonized"] = True
                info["double_forked"] = True
                info["setsid"] = True
                write_json(descendant_path(rundir, token), info)
                counter = 0
                while True:
                    try:
                        with open(heartbeat_path(rundir, token), "w", encoding="utf-8") as handle:
                            handle.write("%d\n" % counter)
                    except OSError:
                        pass
                    counter += 1
                    time.sleep(HEARTBEAT_INTERVAL_S)
            os._exit(0)
        except BaseException:
            os._exit(127)
    os.waitpid(pid, 0)


def ignore_termination():
    """Refuse every catchable termination request."""
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)


def read_marker():
    """Read one newline marker from stdin, or None on EOF."""
    line = sys.stdin.readline()
    if line == "":
        return None
    return line.strip()


def mode_cooperate(rundir, token):
    """Clean host: publish identity and exit successfully on its own."""
    write_json(host_path(rundir, token), identity("host"))
    return 0


def mode_hold(rundir, token):
    """Healthy host: acknowledges cleanup and settles the terminate/join."""
    write_json(host_path(rundir, token), identity("host"))
    while True:
        marker = read_marker()
        if marker is None:
            return 0
        if marker == "cleanup":
            write_json(cleanup_ack_path(rundir, token), {"acknowledged": "cleanup"})
        elif marker == "terminate":
            write_json(join_ack_path(rundir, token), {"acknowledged": "terminate"})
            return 0


def mode_never_settle_cleanup(rundir, token):
    """Cleanup never settles: the host never reads stdin and never acks."""
    ignore_termination()
    write_json(host_path(rundir, token), identity("host"))
    while True:
        time.sleep(SLEEP_INTERVAL_S)


def mode_never_settle_join(rundir, token):
    """Cleanup settles but the terminate/join never settles."""
    ignore_termination()
    write_json(host_path(rundir, token), identity("host"))
    while True:
        marker = read_marker()
        if marker is None:
            break
        if marker == "cleanup":
            write_json(cleanup_ack_path(rundir, token), {"acknowledged": "cleanup"})
        # "terminate" is deliberately never acknowledged and never exits.
    while True:
        time.sleep(SLEEP_INTERVAL_S)


def mode_daemon_escape(rundir, token):
    """Host that owns a daemonized descendant which escaped its process group."""
    ignore_termination()
    spawn_escaped_descendant(rundir, token)
    write_json(host_path(rundir, token), identity("host"))
    while True:
        time.sleep(SLEEP_INTERVAL_S)


MODES = {
    "cooperate": mode_cooperate,
    "hold": mode_hold,
    "never_settle_cleanup": mode_never_settle_cleanup,
    "never_settle_join": mode_never_settle_join,
    "daemon_escape": mode_daemon_escape,
}


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: host_fixture.py <mode> <rundir> <token>\n")
        return 64
    mode = sys.argv[1]
    rundir = sys.argv[2]
    token = sys.argv[3]
    handler = MODES.get(mode)
    if handler is None:
        sys.stderr.write("unknown mode: %s\n" % mode)
        return 64
    return handler(rundir, token)


if __name__ == "__main__":
    sys.exit(main())
