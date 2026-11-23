#!/usr/bin/env python3
"""Host one oMLX server for every user of this Mac: its launchd daemon and its keys.

One server, not one per user. Every oMLX server loads each model it serves into
its own memory, so three users running three servers hold three copies of a
model in the Mac's unified memory. A shared model folder would save the disk and
none of that memory. Instead the one server runs as a system LaunchDaemon owned
by the admin's account, and each user gets an API sub key for
http://127.0.0.1:8000/v1 (shared-model-host.html, in this folder).

Why the daemon is rendered here and not copied from Homebrew's plist: a
LaunchDaemon with no UserName runs as root, and root's oMLX reads
/var/root/.omlx/settings.json, which has no API key. oMLX accepts any request
on a loopback bind when no key is set (server.py, verify_api_key), and
`tailscale serve` forwards the tailnet to that loopback port. So the plist
names the user, sets HOME and OMLX_BASE_PATH to that user's settings, and
`plist` refuses to render one for settings that have no main key.

Subcommands:
  plist --label L        print the LaunchDaemon plist (run it as the admin, not root)
  wait --job TARGET      wait until that launchd job is what answers on the origin
  key-add NAME           mint a sub key for a person or device and print it, once
  key-list               the sub keys by name and fingerprint (never the key)
  key-rm NAME            delete the sub keys with that name

Sub keys are inference-only: oMLX refuses them for the admin API and the
dashboard. key-add and key-rm go through the running server's admin API with
the main key, so the server's own copy of the settings stays the only writer of
settings.json. The main key is read from settings.json and never printed.

Standard library only; runs on the system python3 (3.9).
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import pwd
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check import (  # noqa: E402  (shares the posture script's helpers)
    BASE,
    MIN_KEY_LENGTH,
    SETTINGS,
    _OPENER,
    fingerprint,
    launchd_pid,
    listener_pid,
    status_of,
)

HOMEBREW_KEG_PLIST = "/opt/homebrew/opt/omlx/sh.brew.omlx.plist"
DEFAULT_PROGRAM = ["/opt/homebrew/opt/omlx/bin/omlx", "serve"]
DEFAULT_LOG = "/opt/homebrew/var/log/omlx.log"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]{0,63}")


def die(text: str) -> None:
    print("host.py: " + text, file=sys.stderr)
    sys.exit(1)


def load_auth() -> dict:
    try:
        with open(SETTINGS, encoding="utf-8") as handle:
            return json.load(handle).get("auth") or {}
    except (OSError, ValueError) as error:
        die("cannot read %s: %s" % (SETTINGS, error))
    return {}


# ---------------------------------------------------------------- daemon


def render_plist(label: str) -> bytes:
    if os.geteuid() == 0:
        die("run this as the account that owns oMLX's settings, not as root")
    auth = load_auth()
    if not auth.get("api_key"):
        die("%s has no main API key; a daemon with these settings would answer "
            "without one. Set a key in the oMLX dashboard first." % SETTINGS)
    if auth.get("skip_api_key_verification") or auth.get("allow_unauthenticated_inference"):
        die("%s turns key checks off; refusing to make that server start at boot" % SETTINGS)

    user = pwd.getpwuid(os.getuid())
    # Homebrew's own service plist for the keg keeps the program path and PATH
    # in step with the formula; everything that decides who oMLX runs as is set here.
    try:
        with open(HOMEBREW_KEG_PLIST, "rb") as handle:
            keg = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException, ValueError):
        keg = {}
    env = dict(keg.get("EnvironmentVariables") or {})
    env.setdefault("PATH", "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin")
    env.update({
        "HOME": user.pw_dir,
        "USER": user.pw_name,
        "LOGNAME": user.pw_name,
        "OMLX_BASE_PATH": BASE,
        "OMLX_SUPERVISED": "launchd",
    })
    spec = {
        "Label": label,
        "UserName": user.pw_name,
        "ProgramArguments": keg.get("ProgramArguments") or DEFAULT_PROGRAM,
        "EnvironmentVariables": env,
        "WorkingDirectory": keg.get("WorkingDirectory") or "/opt/homebrew/var",
        "StandardOutPath": keg.get("StandardOutPath") or DEFAULT_LOG,
        "StandardErrorPath": keg.get("StandardErrorPath") or DEFAULT_LOG,
        "RunAtLoad": True,
        "KeepAlive": True,
    }
    return plistlib.dumps(spec)


def wait_for(job: str, origin: str, timeout: float) -> None:
    """Wait until `job` runs, listens on the origin, and the origin answers /health.

    Checking the pid, not only /health, keeps a server that is still shutting
    down from passing for the one that replaces it.
    """
    origin_addr = origin.split("://", 1)[-1]
    deadline = time.monotonic() + timeout
    pid = None
    while time.monotonic() < deadline:
        pid = launchd_pid(job)
        listening = pid is not None and listener_pid(origin_addr) == pid
        if listening and status_of(origin + "/health")[0] == 200:
            print("%s is up: pid %d answers on %s" % (job, pid, origin_addr))
            return
        time.sleep(2)
    die("%s did not come up on %s within %ds (last pid %s); see %s"
        % (job, origin_addr, timeout, pid, DEFAULT_LOG))


# ---------------------------------------------------------------- keys


def admin_call(method: str, url: str, main_key: str, payload: dict) -> tuple[int, str]:
    request = urllib.request.Request(
        url, method=method, data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + main_key, "Content-Type": "application/json"},
    )
    try:
        with _OPENER.open(request, timeout=15) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as error:
        return 0, str(getattr(error, "reason", error))


def detail(body: str) -> str:
    try:
        return str(json.loads(body).get("detail") or body)
    except (ValueError, AttributeError):
        return body[:200]


def key_add(origin: str, name: str) -> None:
    if not NAME.fullmatch(name):
        die("name %r: use letters, digits and . _ @ - (a user or device name)" % name)
    auth = load_auth()
    if any(entry.get("name") == name for entry in auth.get("sub_keys") or []):
        die("%s already has a sub key; `just key-rm %s` first to replace it" % (name, name))
    main_key = auth.get("api_key") or die("%s has no main API key" % SETTINGS)

    key = secrets.token_urlsafe(32)  # 43 characters, URL-safe ASCII, no whitespace
    assert len(key) >= MIN_KEY_LENGTH
    code, body = admin_call("POST", origin + "/admin/api/sub-keys", main_key,
                            {"key": key, "name": name})
    if code != 200:
        die("oMLX refused the new key (%d): %s" % (code, detail(body)))

    print("sub key for %s, fp=%s. It is not shown again; key-list shows fingerprints."
          % (name, fingerprint(key)))
    print()
    print("  export OMLX_KEY='%s'" % key)
    print()
    print("on this Mac      %s/v1" % origin)
    print("over the tailnet `just url` lists the URLs, for a device on the tailnet")


def key_list() -> None:
    entries = load_auth().get("sub_keys") or []
    if not entries:
        print("no sub keys (just key-add <name>)")
    for entry in entries:
        key = entry.get("key", "")
        print("%-20s fp=%s  %2d chars  %s" % (
            entry.get("name") or "(unnamed)", fingerprint(key), len(key),
            (entry.get("created_at") or "")[:19]))


def key_rm(origin: str, name: str) -> None:
    auth = load_auth()
    matches = [e for e in auth.get("sub_keys") or [] if e.get("name") == name]
    if not matches:
        die("no sub key is named %r (just key-list)" % name)
    main_key = auth.get("api_key") or die("%s has no main API key" % SETTINGS)
    for entry in matches:
        code, body = admin_call("DELETE", origin + "/admin/api/sub-keys", main_key,
                                {"key": entry.get("key", "")})
        if code != 200:
            die("oMLX refused to delete %s fp=%s (%d): %s"
                % (name, fingerprint(entry.get("key", "")), code, detail(body)))
        print("deleted sub key %s fp=%s" % (name, fingerprint(entry.get("key", ""))))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--origin", default="http://127.0.0.1:8000", help="where oMLX listens")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plist", help="print the LaunchDaemon plist")
    p.add_argument("--label", required=True)
    p = sub.add_parser("wait", help="wait for a launchd job to answer on the origin")
    p.add_argument("--job", required=True, help="system/<label> or gui/<uid>/<label>")
    p.add_argument("--timeout", type=float, default=180)
    p = sub.add_parser("key-add", help="mint a sub key and print it once")
    p.add_argument("name")
    sub.add_parser("key-list", help="sub keys by name and fingerprint")
    p = sub.add_parser("key-rm", help="delete the sub keys with this name")
    p.add_argument("name")
    args = parser.parse_args()

    if args.command == "plist":
        sys.stdout.buffer.write(render_plist(args.label))
    elif args.command == "wait":
        wait_for(args.job, args.origin, args.timeout)
    elif args.command == "key-add":
        key_add(args.origin, args.name)
    elif args.command == "key-list":
        key_list()
    elif args.command == "key-rm":
        key_rm(args.origin, args.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
