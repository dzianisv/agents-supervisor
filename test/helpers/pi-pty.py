#!/usr/bin/env python3
"""Stdlib PTY: actual pinned CLI, actual lone Escape byte, no SDK abort shortcut."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

os.umask(0o077)
with open(sys.argv[1], encoding="utf8") as f:
    spec = json.load(f)
root = spec["root"]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execve(spec["command"], [spec["command"]] + spec["args"], spec["env"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
start = time.monotonic()
escape_sent = False
status = None
try:
    with open(os.path.join(root, "pty.raw"), "wb") as output:
        while time.monotonic() - start < 20:
            if spec.get("expectEscape", True) and os.path.exists(os.path.join(root, "audit-start")) and not escape_sent:
                if "productionOracle" in spec:
                    # Optional production-only oracle. The P1 marker assertions
                    # below remain unchanged for every existing invocation.
                    oracle = spec["productionOracle"]
                    with open(oracle["statePath"], encoding="utf8") as state_file:
                        state = json.load(state_file)
                    assert state.get("goal", {}).get("id") == oracle["goalId"], "Production goal changed during audit"
                    assert state["goal"]["status"] == "active", "Production goal retired during audit"
                    assert os.path.exists(oracle["projectPath"]), "Production project goal unlinked during audit"
                    achievement_path = oracle["achievementPath"]
                    assert not os.path.exists(achievement_path) or os.path.getsize(achievement_path) == 0, "Production achievement logged during audit"
                else:
                    assert os.path.exists(os.path.join(root, "project-goal")), "Retired during audit"
                    assert not os.path.exists(os.path.join(root, "achievement.jsonl")), "Achievement during audit"
                assert not os.path.exists(os.path.join(root, "audit-returned")), "Missed audit window"
                os.write(fd, b"\x1b")
                escape_sent = True
                with open(os.path.join(root, "pty-input.json"), "w") as f:
                    json.dump({"sent": "Escape", "byte": 27, "duringAudit": True}, f)
            ready, _, _ = select.select([fd], [], [], 0.02)
            if ready:
                try:
                    data = os.read(fd, 65536)
                    if data:
                        output.write(data)
                        output.flush()
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            got, value = os.waitpid(pid, os.WNOHANG)
            if got:
                status = value
                break
        assert status is not None, "Native TUI timeout"
        assert escape_sent == spec.get("expectEscape", True), "Zero Escape cases: audit never started"
        assert os.waitstatus_to_exitcode(status) == 0, "TUI failed; inspect pty.raw"
    print(json.dumps({"escapeSent": escape_sent, "exitCode": os.waitstatus_to_exitcode(status)}))
finally:
    if status is None:
        # Only our fork's session/process group; never inspect or kill ambient processes.
        try:
            os.killpg(pid, signal.SIGTERM)
            time.sleep(0.2)
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(fd)
