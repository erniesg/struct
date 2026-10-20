#!/usr/bin/env python3
"""Untrusted executor body for the real resolver conformance binding.

This process is the *host realm*. The parent OS host supervisor creates a
dedicated user namespace and PID namespace for it, so this body is PID 1 of
its own PID namespace and holds no authority over the supervisor. The
supervisor can only observe it from the outside and can only end it by
destroying the namespace.

The body speaks a deliberately narrow line protocol over four FIFOs:

  * ``body_in``  -- commands from the parent (start, cleanup, terminate).
  * ``body_out`` -- events back to the parent (ready, result, chunk,
    stream-end, cleanup-ack, terminal, lifecycle).
  * ``rev_in``   -- the synchronous revocation channel from the parent.
  * ``rev_out``  -- the synchronous revocation receipt back to the parent.

The body opens only the two read sides. The two write sides are inherited
descriptors that the parent OS host supervisor opened before this realm
existed and then closed its own copy of, so the parent observes a genuine
end-of-file exactly when the realm and every descendant are gone.

The revocation channel is separate from the event channel on purpose. The
published resolver contract makes ``revokeAndQuarantine()`` a synchronous
call, so the parent has to be able to complete one request/response round
trip without waiting on the event loop.

This body implements **no** transport. It never opens a socket, never resolves
a filesystem locator, never contacts a store, and never reads a credential.
The bytes it serves come from a small in-memory table that is keyed by the
content address, so the conformance cases exercise the protocol and the
containment rules without ever granting transport authority. The transport
receipt it publishes is therefore an explicitly synthetic
``content-addressed`` projection and is never evidence of real I/O.

Every mode below is a fixture. The ``conformant`` mode is the only one that
behaves; the remaining modes break exactly one invariant each so that the
package driver has to reject them against a real OS host.
"""

import base64
import hashlib
import json
import os
import select
import signal
import sys
import time

POLL_TIMEOUT_S = 0.05
WRITE_TIMEOUT_S = 5.0
HEARTBEAT_INTERVAL_S = 0.05


# --------------------------------------------------------------- fixture table

# The conformance payloads are tiny and fixed. They live here so that the
# parent and the body agree on the content address without either side
# shipping bytes over the wire.
FIXTURE_ASSETS = (
    {
        "id": "asset-conformance-primary",
        "mediaType": "application/octet-stream",
        "bytes": b"struct-resolver-real-conformance-asset-primary",
        "chunkSize": 8,
    },
    {
        "id": "asset-conformance-secondary",
        "mediaType": "application/octet-stream",
        "bytes": b"struct-resolver-real-conformance-asset-secondary",
        "chunkSize": 5,
    },
)


def fixture_table():
    """Content-addressed fixture table. No I/O is involved in building it."""
    table = {}
    for entry in FIXTURE_ASSETS:
        digest = hashlib.sha256(entry["bytes"]).hexdigest()
        table[digest] = {
            "id": entry["id"],
            "mediaType": entry["mediaType"],
            "byteLength": len(entry["bytes"]),
            "bytes": entry["bytes"],
            "chunkSize": entry["chunkSize"],
        }
    return table


def fixture_manifest():
    """Public description of the fixture table, safe to hand to the parent."""
    manifest = []
    for entry in FIXTURE_ASSETS:
        manifest.append({
            "id": entry["id"],
            "mediaType": entry["mediaType"],
            "sha256": hashlib.sha256(entry["bytes"]).hexdigest(),
            "byteLength": len(entry["bytes"]),
            "chunkSize": entry["chunkSize"],
        })
    return manifest


# ----------------------------------------------------------------- utilities

def read_capabilities():
    """Capability bitmasks of this process, read from /proc/self/status."""
    out = {}
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(("CapEff:", "CapPrm:", "CapBnd:", "CapInh:", "CapAmb:")):
                    key, value = line.split()
                    out[key.rstrip(":")] = int(value, 16)
    except (OSError, ValueError):
        pass
    return out


def open_reader(path):
    """Open the read side of a FIFO. Never blocks, even with no writer."""
    return os.open(path, os.O_RDONLY | os.O_NONBLOCK)


def write_line(fd, value):
    """Write one NDJSON record, retrying while the FIFO buffer is full."""
    data = (json.dumps(value, sort_keys=True) + "\n").encode("utf-8")
    offset = 0
    deadline = time.monotonic() + WRITE_TIMEOUT_S
    while offset < len(data):
        try:
            offset += os.write(fd, data[offset:])
        except BlockingIOError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.005)
        except OSError:
            return


def read_lines(fd, buffer):
    """Read whatever is available and return the complete lines it contains."""
    try:
        chunk = os.read(fd, 65536)
    except BlockingIOError:
        return buffer, []
    except OSError:
        return buffer, []
    if not chunk:
        return buffer, []
    buffer += chunk.decode("utf-8", "replace")
    lines = []
    while "\n" in buffer:
        line, buffer = buffer.split("\n", 1)
        if line.strip():
            lines.append(line)
    return buffer, lines


# ----------------------------------------------------------------- behaviour

class Body:
    """The fixture behaviour of one execution."""

    def __init__(self, mode):
        self.mode = mode
        self.table = fixture_table()
        self.stats = {
            "starts": 0,
            "revokes": 0,
            "cleanups": 0,
            "terminates": 0,
            "start_after_revoke": False,
            "start_after_cleanup": False,
            "start_after_terminate": False,
            "bytes_streamed": 0,
            "chunks_streamed": 0,
        }
        self.revoked = False
        self.cleaned = False
        self.terminated = False
        self.execution_id = None

    # -- per-mode switches ------------------------------------------------

    @property
    def acknowledges_cleanup(self):
        return self.mode not in ("never_settle_cleanup",)

    @property
    def acknowledges_terminate(self):
        return self.mode not in ("never_settle_cleanup", "never_settle_join", "daemon_escape")

    @property
    def revokes_foreign_id(self):
        return self.mode == "nonconforming_revocation_id"

    @property
    def terminates_foreign_id(self):
        return self.mode == "nonconforming_terminal_id"

    @property
    def terminates_wrong_state(self):
        return self.mode == "nonconforming_terminal_state"

    @property
    def aliases_transport_receipt(self):
        return self.mode == "nonconforming_transport_alias"

    @property
    def streams_unconstrained(self):
        return self.mode == "nonconforming_unconstrained_stream"

    # -- receipts ---------------------------------------------------------

    def revocation_receipt(self, execution_id):
        bound = "foreign-execution-id" if self.revokes_foreign_id else execution_id
        return {
            "executionId": bound,
            "capabilitiesRevoked": True,
            "quarantined": True,
        }

    def terminal_receipt(self, execution_id):
        bound = "foreign-execution-id" if self.terminates_foreign_id else execution_id
        state = "terminated" if self.terminates_wrong_state else "completed"
        return {"executionId": bound, "state": state}

    def transport_receipt(self, request):
        policy = request.get("policy") or {}
        transport = policy.get("transport") or {}
        digest = request.get("expectedPolicySha256") or ""
        if self.aliases_transport_receipt:
            # A receipt that echoes a foreign policy digest: the package has to
            # reject it instead of accepting an unbound transport projection.
            digest = "b" * 64
        return {
            "kind": transport.get("kind", "content-addressed"),
            "policySha256": digest,
            "storeId": transport.get("storeId", "nontransport-fixture"),
        }


def spawn_escaped_descendant():
    """Double-fork and setsid descendant that leaves the host's process group.

    The descendant ignores every catchable termination request and keeps the
    inherited lifetime descriptor open, so the parent's end-of-file
    observation is a kernel-level proof that it died with the namespace.
    """
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            inner = os.fork()
            if inner == 0:
                for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                    signal.signal(sig, signal.SIG_IGN)
                while True:
                    time.sleep(HEARTBEAT_INTERVAL_S)
            os._exit(0)
        except BaseException:
            os._exit(127)
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass


def ignore_termination():
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)


def main(argv):
    if len(argv) < 5:
        sys.stderr.write(
            "usage: real_host_body.py <mode> <body_in> <rev_in> <body_out_fd> <rev_out_fd>\n"
        )
        return 64
    mode = argv[0]
    body_in_path, rev_in_path = argv[1], argv[2]
    body_out = int(argv[3])
    rev_out = int(argv[4])

    body = Body(mode)
    if mode in ("never_settle_cleanup", "never_settle_join", "daemon_escape"):
        ignore_termination()

    body_in = open_reader(body_in_path)
    rev_in = open_reader(rev_in_path)
    # The two output channels are inherited descriptors that the parent OS
    # supervisor opened before this realm existed. The body never opens a FIFO
    # for writing, so it can never race with the parent opening the reader.
    if body_out < 0 or rev_out < 0:
        sys.stderr.write("the inherited output channels are missing\n")
        return 64

    if mode == "daemon_escape":
        spawn_escaped_descendant()

    write_line(body_out, {
        "event": "ready",
        "mode": mode,
        "pid": os.getpid(),
        "pidNs": os.readlink("/proc/self/ns/pid"),
        "userNs": os.readlink("/proc/self/ns/user"),
        "uid": os.getuid(),
        "capabilities": read_capabilities(),
        "assets": fixture_manifest(),
        "transportAuthority": "none",
    })

    buffer = ""
    rev_buffer = ""
    while True:
        try:
            readable, _, _ = select.select([body_in, rev_in], [], [], POLL_TIMEOUT_S)
        except (OSError, ValueError):
            break

        for fd in readable:
            if fd == rev_in:
                rev_buffer, lines = read_lines(rev_in, rev_buffer)
                for line in lines:
                    try:
                        command = json.loads(line)
                    except ValueError:
                        continue
                    if command.get("op") != "revoke":
                        continue
                    body.stats["revokes"] += 1
                    body.revoked = True
                    execution_id = command.get("executionId") or body.execution_id or ""
                    write_line(rev_out, {
                        "event": "revocation",
                        "executionId": execution_id,
                        "receipt": body.revocation_receipt(execution_id),
                    })
                continue

            buffer, lines = read_lines(body_in, buffer)
            for line in lines:
                try:
                    command = json.loads(line)
                except ValueError:
                    continue
                op = command.get("op")
                if op == "start":
                    body.stats["starts"] += 1
                    if body.revoked:
                        body.stats["start_after_revoke"] = True
                    if body.cleaned:
                        body.stats["start_after_cleanup"] = True
                    if body.terminated:
                        body.stats["start_after_terminate"] = True
                    body.execution_id = command.get("executionId")
                    request = command.get("request") or {}
                    expected = request.get("expected") or {}
                    digest = expected.get("sha256")
                    entry = body.table.get(digest)
                    if entry is None:
                        write_line(body_out, {
                            "event": "start-error",
                            "executionId": body.execution_id,
                            "reason": "unknown-content-address",
                        })
                        continue
                    write_line(body_out, {
                        "event": "result",
                        "executionId": body.execution_id,
                        "result": {
                            "protocolVersion": "1.0.0",
                            "resourceId": "sha256:" + digest,
                            "transportReceipt": body.transport_receipt(request),
                            "declaredByteLength": entry["byteLength"],
                        },
                    })
                    payload = entry["bytes"]
                    if body.streams_unconstrained:
                        payload = payload + payload
                    size = entry["chunkSize"]
                    index = 0
                    for offset in range(0, len(payload), size):
                        chunk = payload[offset:offset + size]
                        body.stats["bytes_streamed"] += len(chunk)
                        body.stats["chunks_streamed"] += 1
                        write_line(body_out, {
                            "event": "chunk",
                            "executionId": body.execution_id,
                            "index": index,
                            "bytesBase64": base64.b64encode(chunk).decode("ascii"),
                        })
                        index += 1
                    write_line(body_out, {
                        "event": "stream-end",
                        "executionId": body.execution_id,
                    })
                elif op == "cleanup":
                    body.stats["cleanups"] += 1
                    body.cleaned = True
                    if body.acknowledges_cleanup:
                        write_line(body_out, {
                            "event": "cleanup-ack",
                            "executionId": command.get("executionId"),
                        })
                elif op == "terminate":
                    body.stats["terminates"] += 1
                    body.terminated = True
                    execution_id = command.get("executionId") or body.execution_id or ""
                    if body.acknowledges_terminate:
                        write_line(body_out, {
                            "event": "terminal",
                            "executionId": execution_id,
                            "receipt": body.terminal_receipt(execution_id),
                        })
                        write_line(body_out, {
                            "event": "lifecycle",
                            "executionId": execution_id,
                            "mode": body.mode,
                            "stats": body.stats,
                        })
                        return 0
                elif op == "shutdown":
                    return 0
                write_line(body_out, {
                    "event": "lifecycle",
                    "executionId": body.execution_id,
                    "mode": body.mode,
                    "stats": body.stats,
                })

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
