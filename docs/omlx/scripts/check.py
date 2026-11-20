#!/usr/bin/env python3
"""Prove that oMLX is hosted on the tailnet the way cf-tunnel.html says it is.

oMLX binds 127.0.0.1 and trusts loopback peers: they are exempt from its
wrong-key lockout, and with skip_api_key_verification on they need no key at
all (oMLX 0.8.0, server.py and admin/auth.py). `tailscale serve` forwards
tailnet devices to it over loopback, so every one of them is a loopback peer.
That is acceptable only while three things hold, and this script checks them
by behaviour rather than by trusting a settings file:

  1. the origin still refuses a request that carries no key
  2. the serve config forwards the tailnet port to the origin and nothing else
  3. Funnel is off, so nothing is reachable from the public internet

The forward is plain TCP on purpose. As an HTTP proxy tailscaled answers only
for this Mac's tailnet name and gives 404 to a request addressed to its tailnet
IP; the IP is what a device falls back to when its MagicDNS is not resolving.
Both forms of the URL are requested here.

These run on the Mac that hosts oMLX. They cannot tell you whether another
device resolves the name; on that device, compare the name with the IP.

One line per check. Exit 1 on any FAIL, 0 otherwise (warnings do not fail).
Standard library only; runs on the system python3 (3.9).

Usage:
  scripts/check.py                    every check
  scripts/check.py --origin-only      the origin checks alone (what `just up` gates on)
  OMLX_CHECK_KEY=<sub key> scripts/check.py
                                      also lists the models through the tailnet URL

The key is read from the environment, never from argv, and is never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

SETTINGS = os.path.expanduser("~/.omlx/settings.json")
MIN_KEY_LENGTH = 32  # oMLX itself only asks for 4 characters

# A system proxy must not sit between this script and loopback or the tailnet.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

failures = 0


def report(level: str, area: str, text: str) -> None:
    global failures
    if level == "FAIL":
        failures += 1
    print("%-4s %-8s %s" % (level, area, text))


def status_of(url: str, key: str | None = None) -> tuple[int, bytes]:
    """HTTP status and body for a GET; 0 when the connection itself fails."""
    request = urllib.request.Request(url)
    if key:
        request.add_header("Authorization", "Bearer " + key)
    try:
        with _OPENER.open(request, timeout=8) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except (urllib.error.URLError, OSError) as error:
        return 0, str(getattr(error, "reason", error)).encode()


def run(*command: str) -> tuple[int, str]:
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, str(error)
    return done.returncode, done.stdout if done.returncode == 0 else done.stderr


def fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:8]


def check_origin(origin: str, port: str) -> None:
    # Behaviour first: this is the check that matters, whatever the settings say.
    code, _ = status_of(origin + "/v1/models")
    if code == 401:
        report("ok", "origin", "a request with no key is refused (401)")
    elif code == 0:
        report("FAIL", "origin", "oMLX is not answering on %s" % origin)
        return
    else:
        report("FAIL", "origin", "a request with no key got %d, not 401: oMLX is open to "
               "every device that can reach it. Do not serve it." % code)

    code, _ = status_of(origin + "/health")
    report("ok" if code == 200 else "FAIL", "origin", "/health answers %d" % code)

    # lsof without sudo lists this user's processes, which is where oMLX runs.
    rc, out = run("lsof", "-nP", "-iTCP:" + port, "-sTCP:LISTEN")
    binds = sorted({line.split()[8] for line in out.splitlines()[1:] if len(line.split()) > 8})
    public = [b for b in binds if not b.startswith(("127.0.0.1:", "[::1]:", "localhost:"))]
    if rc != 0 or not binds:
        report("warn", "origin", "could not read the listener on port %s with lsof" % port)
    elif public:
        report("FAIL", "origin", "oMLX also listens on %s; this setup assumes loopback only"
               % ", ".join(public))
    else:
        report("ok", "origin", "listens on loopback only (%s)" % ", ".join(binds))

    # The settings explain a failure above; they are not the proof.
    try:
        with open(SETTINGS, encoding="utf-8") as handle:
            auth = json.load(handle).get("auth", {})
    except (OSError, ValueError) as error:
        report("warn", "settings", "cannot read %s: %s" % (SETTINGS, error))
        return
    for flag in ("skip_api_key_verification", "allow_unauthenticated_inference"):
        if auth.get(flag):
            report("FAIL", "settings", "auth.%s is on" % flag)
        else:
            report("ok", "settings", "auth.%s is off" % flag)
    if not auth.get("api_key"):
        report("FAIL", "settings", "no main API key is set")
    sub_keys = auth.get("sub_keys") or []
    if not sub_keys:
        report("warn", "keys", "no sub keys yet: remote devices would have to use the main "
               "key, which is also the admin credential")
    for entry in sub_keys:
        key = entry.get("key", "")
        name = entry.get("name") or "(unnamed)"
        level = "ok" if len(key) >= MIN_KEY_LENGTH else "warn"
        report(level, "keys", "sub key %s fp=%s is %d characters%s" % (
            name, fingerprint(key), len(key),
            "" if level == "ok" else " (want %d or more)" % MIN_KEY_LENGTH))


def check_serve(origin: str, port: str) -> list[str]:
    """Check the serve config; return the tailnet base URLs a client could use."""
    rc, out = run("tailscale", "status", "--json")
    if rc != 0:
        report("FAIL", "tailnet", "tailscale status failed: %s" % out.strip())
        return []
    status = json.loads(out)
    if status.get("BackendState") != "Running":
        report("FAIL", "tailnet", "Tailscale is %s, not Running" % status.get("BackendState"))
        return []
    me = status.get("Self") or {}
    name = me.get("DNSName", "").rstrip(".")
    address = (me.get("TailscaleIPs") or [""])[0]
    report("ok", "tailnet", "this Mac is %s (%s)" % (name, address))

    rc, out = run("tailscale", "serve", "status", "--json")
    if rc != 0:
        report("FAIL", "serve", "tailscale serve status failed: %s" % out.strip())
        return []
    config = json.loads(out or "{}")

    if config.get("AllowFunnel"):
        report("FAIL", "serve", "Funnel is on for %s: that is public internet access"
               % ", ".join(sorted(config["AllowFunnel"])))
    else:
        report("ok", "serve", "Funnel is off: tailnet devices only")

    listener = (config.get("TCP") or {}).get(port)
    if not listener:
        report("FAIL", "serve", "nothing is served on tailnet port %s (run: just up)" % port)
        return []

    extra = sorted(set(config.get("TCP") or {}) - {port})
    if extra:
        report("warn", "serve", "other tailnet ports are also served: %s" % ", ".join(extra))

    origin_addr = origin.split("://", 1)[-1]
    by_name = "http://%s:%s" % (name, port)
    by_ip = "http://%s:%s" % (address, port)

    # The intended config: a plain TCP forward, which answers for the tailnet
    # name and for the tailnet IP alike.
    if listener.get("TCPForward"):
        if listener["TCPForward"] == origin_addr:
            report("ok", "serve", "tailnet port %s is a TCP forward to %s" % (port, origin_addr))
            return [by_name, by_ip]
        report("FAIL", "serve", "tailnet port %s forwards to %s, expected %s"
               % (port, listener["TCPForward"], origin_addr))
        return []

    # An HTTP(S) proxy works by name only: tailscaled matches the Host header
    # and answers 404 for a request addressed to the tailnet IP.
    scheme = "https" if listener.get("HTTPS") else "http"
    handlers = ((config.get("Web") or {}).get("%s:%s" % (name, port)) or {}).get("Handlers") or {}
    targets = {path: (h.get("Proxy") or "?") for path, h in handlers.items()}
    if targets == {"/": origin}:
        report("warn", "serve", "%s proxy on port %s: reachable by name only, the tailnet IP "
               "answers 404 (just down in that mode, then just up)" % (scheme, port))
        return ["%s://%s:%s" % (scheme, name, port)]
    report("FAIL", "serve", "port %s serves %s, expected a forward to %s"
           % (port, targets or "nothing", origin_addr))
    return []


def check_tailnet_urls(bases: list[str]) -> None:
    for base in bases:
        code, body = status_of(base + "/v1/models")
        if code == 401:
            report("ok", "url", "%s/v1/models refuses a request with no key (401)" % base)
        else:
            report("FAIL", "url", "%s/v1/models with no key got %d %s"
                   % (base, code, body[:80].decode("utf-8", "replace") if code == 0 else ""))
    if not bases:
        return
    base = bases[0]

    key = os.environ.get("OMLX_CHECK_KEY")
    if not key:
        report("warn", "url", "OMLX_CHECK_KEY is not set: skipped the request with a key")
        return
    code, body = status_of(base + "/v1/models", key)
    if code != 200:
        report("FAIL", "url", "key fp=%s got %d from %s/v1/models" % (fingerprint(key), code, base))
        return
    try:
        models = [m.get("id", "?") for m in json.loads(body).get("data", [])]
    except ValueError:
        models = []
    report("ok", "url", "key fp=%s lists %d models: %s"
           % (fingerprint(key), len(models), ", ".join(models) or "(none)"))


def check_power() -> None:
    rc, out = run("pmset", "-g")
    for line in out.splitlines() if rc == 0 else []:
        fields = line.split()
        if fields[:1] == ["sleep"] and len(fields) > 1:
            if fields[1] == "0":
                report("ok", "power", "system sleep is off")
            else:
                report("warn", "power", "system sleep is %s min, held off only by assertions; "
                       "when the Mac sleeps the tailnet URL stops answering" % fields[1])
            return


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--origin", default="http://127.0.0.1:8000", help="where oMLX listens")
    parser.add_argument("--port", default="8000", help="the tailnet-side port")
    parser.add_argument("--origin-only", action="store_true", help="skip the tailnet checks")
    args = parser.parse_args()

    check_origin(args.origin, args.origin.rsplit(":", 1)[-1])
    if not args.origin_only:
        check_tailnet_urls(check_serve(args.origin, args.port))
        check_power()

    print()
    print("%d failed" % failures if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
