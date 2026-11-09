"""L0-1 See-through guard. The bundle runner starts it as: python -I -B guard.py <config.json>.

Why Python: the controls below must act inside the See-through Python process. Node.js cannot do that.
The guard adds a PEP 578 audit hook before any See-through module is imported, then runs inference_psd.py with runpy.
The hook stops (PermissionError) and records:
- network calls (socket connect, bind, sendto, name lookup, urllib requests),
- new processes (subprocess, os.system, exec, spawn, fork),
- pickle class lookups (pickle-based model files),
- file writes, renames, deletions, links and mode changes outside the allowed write roots.
It records reads below the Hugging Face cache, so the runner can check which configuration files were used.
Every record goes to the log file as one JSON line. The runner treats any denial as FAIL, also when the
See-through code catches the exception.

The guard runs as the unprivileged run user. Its configuration and this file belong to root and the run user cannot change them.
Two kinds of target: "see-through" (a script inside the See-through checkout) and "qualify" (qualify.py next to this file).

Limits: an audit hook does not see native code (for example C, C++ or Rust libraries, ctypes calls, CUDA drivers).
It is a detection and containment layer for Python code (defense in depth), not a sandbox. The process can change its own
guard log, so the log is evidence of what the guard saw, not proof of what the process did.
"""

import json
import os
import runpy
import sys

FORMAT = "aigg.l0-seethrough-guard/0.2"
KINDS = ("see-through", "qualify")
FORBIDDEN_ARGS = ("--tblr_split", "--group_offload", "--vae_ckpt", "--unet_ckpt")
NETWORK_EVENTS = {
    "socket.connect",
    "socket.bind",
    "socket.sendto",
    "socket.sendmsg",
    "socket.getaddrinfo",
    "socket.gethostbyname",
    "socket.gethostbyaddr",
    "socket.getnameinfo",
    "urllib.Request",
}
PROCESS_EVENTS = {
    "subprocess.Popen",
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawn",
    "os.fork",
    "os.forkpty",
    "os.startfile",
    "pty.spawn",
}
PATH_CHANGE_EVENTS = {
    "os.remove",
    "os.rmdir",
    "os.mkdir",
    "os.chmod",
    "os.chown",
    "os.symlink",
    "os.link",
    "os.truncate",
    "os.utime",
    "shutil.rmtree",
    "shutil.copyfile",
    "shutil.move",
}
TWO_PATH_EVENTS = {"os.rename"}
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC


def fail(message):
    sys.stderr.write("E_GUARD_CONFIG: " + message + "\n")
    sys.exit(2)


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict) or config.get("format") != FORMAT:
        fail("The configuration format is not " + FORMAT + ".")
    if config.get("kind") not in KINDS:
        fail("The configuration kind must be see-through or qualify.")
    for key in ("seeThroughRoot", "script", "hfCache", "log"):
        if not isinstance(config.get(key), str) or not os.path.isabs(config[key]):
            fail("The configuration value " + key + " must be an absolute path.")
    roots = config.get("writeRoots")
    if not isinstance(roots, list) or not roots or not all(isinstance(r, str) and os.path.isabs(r) for r in roots):
        fail("writeRoots must be a list of absolute paths.")
    argv = config.get("argv")
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        fail("argv must be a list of strings.")
    for arg in argv:
        if arg.split("=", 1)[0] in FORBIDDEN_ARGS:
            fail("The argument " + arg + " is forbidden.")
    return config


def main():
    if sys.version_info[:2] != (3, 12):
        fail("Python 3.12 is necessary.")
    if not sys.flags.isolated or not sys.flags.dont_write_bytecode:
        fail("Start the guard with python -I -B.")
    if len(sys.argv) != 2:
        fail("Usage: python -I -B guard.py <config.json>")
    config = load_config(sys.argv[1])
    real = os.path.realpath
    st_root = real(config["seeThroughRoot"])
    script = real(config["script"])
    if config["kind"] == "qualify":
        if script != os.path.join(os.path.dirname(real(__file__)), "qualify.py"):
            fail("The qualify script must be qualify.py next to guard.py.")
    elif script != st_root and not script.startswith(st_root + os.sep):
        fail("The script is not inside the See-through checkout.")
    write_roots = tuple(real(r) for r in config["writeRoots"])
    hf_cache = real(config["hfCache"])
    log_fd = os.open(config["log"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)
    counter = {"denied": 0}

    def record(kind, event, detail):
        line = json.dumps({"kind": kind, "event": event, "detail": detail}, ensure_ascii=True)
        os.write(log_fd, (line + "\n").encode("ascii"))

    def as_path(value):
        if isinstance(value, int):
            return None
        try:
            value = os.fsdecode(os.fspath(value))
        except TypeError:
            return None
        return real(value)

    def inside(path, roots):
        return any(path == root or path.startswith(root + os.sep) for root in roots)

    def deny(event, detail):
        counter["denied"] += 1
        record("deny", event, detail)
        raise PermissionError("L0-1 guard: " + event + " is not allowed")

    def check_write(event, value):
        path = as_path(value)
        if path is None:
            return
        if path == "/dev/null" or inside(path, write_roots):
            return
        deny(event, path)

    def hook(event, args):
        if event in NETWORK_EVENTS:
            deny(event, repr(args)[:200])
        if event in PROCESS_EVENTS:
            deny(event, repr(args[0])[:200] if args else "")
        if event == "pickle.find_class":
            deny(event, repr(args)[:200])
        if event == "open":
            path, mode, flags = args
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & WRITE_FLAGS)
            if writing:
                check_write(event, path)
                return
            target = as_path(path)
            if target is not None and inside(target, (hf_cache,)):
                record("read", event, target)
            return
        if event in PATH_CHANGE_EVENTS and args:
            check_write(event, args[0])
            if event in ("shutil.copyfile", "shutil.move") and len(args) > 1:
                check_write(event, args[1])
        if event in TWO_PATH_EVENTS and len(args) > 1:
            check_write(event, args[0])
            check_write(event, args[1])

    sys.path.insert(0, os.path.join(st_root, "common"))
    os.chdir(st_root)
    record("start", "guard", {"python": sys.version.split()[0], "argv": config["argv"]})
    sys.addaudithook(hook)
    sys.argv = [script] + list(config["argv"])
    status = 0
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as error:
        status = error.code if isinstance(error.code, int) else 1
    finally:
        record("end", "guard", {"denied": counter["denied"]})
    if counter["denied"] and status == 0:
        status = 3
    sys.exit(status)


if __name__ == "__main__":
    main()
