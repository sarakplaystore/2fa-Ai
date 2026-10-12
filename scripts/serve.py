#!/usr/bin/env python3
"""Serve the production build of the Still authenticator.

Standard library only: no third-party packages, no network access, no
analytics. The server exists to host `dist/` from a stable origin so the
vault (browser local storage) and its device credential keep working.

Typical use:

    npm run build
    python3 scripts/serve.py --host 127.0.0.1 --port 4173

Docker:

    docker build -t still-authenticator:local .
    docker run --rm -p 127.0.0.1:8080:8080 still-authenticator:local

Notes
-----
* WebAuthn needs a secure context: `http://localhost` / `http://127.0.0.1`,
  or HTTPS. A plain `http://<lan-ip>:8080` origin can load the page but the
  browser will refuse credential creation and unlock. Put the server behind a
  TLS-terminating reverse proxy (see docker-compose.yml, profile `tls`) for
  any non-localhost origin.
* `python3 -m http.server` is not a substitute: it sends no security headers,
  no cache policy for the service worker, and lists directories.
* The origin (scheme, host, port) is part of the vault's identity. Changing it
  starts a new, empty vault; export an encrypted backup first.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import threading
import urllib.error
import urllib.request
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from posixpath import normpath
from urllib.parse import unquote, urlsplit

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080
DEFAULT_DIR = "dist"
HEALTH_PATHS = frozenset({"/healthz", "/health", "/ready"})
IMMUTABLE_MAX_AGE = 31_536_000  # 1 year, for content-hashed /assets/* files.
UNHASHED_MAX_AGE = 300

# The page carries its own restrictive CSP in a <meta> tag. A header policy is
# enforced *in addition* to the meta policy, so this one only states what a
# meta tag cannot express (framing, base URI, form targets). Override with
# --csp / STILL_CSP if you deploy under a reverse proxy that needs more.
DEFAULT_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'none'"

# MIME types the stdlib table gets wrong or does not know. A module script
# served as application/octet-stream is blocked by the browser, so .mjs/.js
# must be explicit.
EXTRA_MIME = {
    ".css": "text/css",
    ".htm": "text/html",
    ".html": "text/html",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".map": "application/json",
    ".mjs": "text/javascript",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# Responses that never carry a body, so keep-alive needs no Content-Length.
_BODYLESS = frozenset({204, 304})


def _is_error_status(code) -> bool:
    """True for statuses worth logging when --quiet is on."""
    try:
        return int(code) >= 400
    except (TypeError, ValueError):
        return False


def cache_control_for(path: str) -> str:
    """Caching policy: revalidate the shell and worker, pin hashed assets."""
    if path in ("/", "/index.html", "/sw.js"):
        # Must be revalidated so a redeploy replaces the app shell and the
        # service worker updates instead of being cached indefinitely.
        return "no-cache, must-revalidate"
    if path.startswith("/assets/"):
        # Vite fingerprints these names; a changed file gets a new URL.
        return f"public, max-age={IMMUTABLE_MAX_AGE}, immutable"
    return f"public, max-age={UNHASHED_MAX_AGE}, must-revalidate"


class Config:
    """Runtime options shared by every request handler."""

    def __init__(
        self,
        directory: Path,
        csp: str,
        hsts_max_age: int = 0,
        allowed_hosts: tuple[str, ...] = (),
        quiet: bool = False,
    ) -> None:
        self.directory = directory
        self.csp = csp
        self.hsts_max_age = hsts_max_age
        self.allowed_hosts = allowed_hosts
        self.quiet = quiet
        self.headers = self._build_headers()

    def _build_headers(self) -> tuple[tuple[str, str], ...]:
        """Headers sent on every response, including errors.

        The page carries the asset-level CSP in a meta tag; browsers enforce a
        header policy *in addition to* it, so this one only states what a meta
        tag cannot express, plus the standard hardening set.
        """
        headers = [
            ("Content-Security-Policy", self.csp),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            (
                "Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=(), "
                "usb=(), browsing-topics=()",
            ),
            ("Cross-Origin-Opener-Policy", "same-origin"),
            ("Cross-Origin-Resource-Policy", "same-origin"),
        ]
        if self.hsts_max_age > 0:
            headers.append(
                (
                    "Strict-Transport-Security",
                    f"max-age={self.hsts_max_age}; includeSubDomains",
                )
            )
        return tuple(headers)


class Handler(SimpleHTTPRequestHandler):
    """Static handler with security headers, caching rules, and no listings."""

    server_version = "StillStatic/1.0"
    sys_version = ""  # Do not advertise the Python version.
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------
    def __init__(self, *args, config: Config, **kwargs) -> None:
        self.config = config
        self._status = 0
        self._has_content_length = False
        self._has_cache_control = False
        super().__init__(*args, directory=str(config.directory), **kwargs)

    @property
    def request_path(self) -> str:
        try:
            return normpath(unquote(urlsplit(self.path).path)) or "/"
        except Exception:  # pragma: no cover - defensive
            return "/"

    def send_response_only(self, code, message=None) -> None:  # noqa: N803
        self._status = int(code)
        self._has_content_length = False
        self._has_cache_control = False
        super().send_response_only(code, message)

    def send_header(self, keyword, value) -> None:
        lowered = keyword.lower()
        if lowered == "content-length":
            self._has_content_length = True
        elif lowered == "cache-control":
            self._has_cache_control = True
        super().send_header(keyword, value)

    def end_headers(self) -> None:
        if not self._has_cache_control:
            policy = (
                "no-store"
                if self._status >= 400
                else cache_control_for(self.request_path)
            )
            self.send_header("Cache-Control", policy)
        if not self._has_content_length and self._status not in _BODYLESS:
            # Keep-alive would stall without a length; close instead.
            self.send_header("Connection", "close")
            self.close_connection = True
        for name, value in self.config.headers:
            self.send_header(name, value)
        super().end_headers()

    def guess_type(self, path) -> str:
        override = EXTRA_MIME.get(Path(path).suffix.lower())
        return override or super().guess_type(path)

    def translate_path(self, path) -> str:
        """Resolve the URL inside the build directory, or point at a 404."""
        candidate = Path(super().translate_path(path))
        root = Path(self.config.directory).resolve()
        resolved = candidate.resolve()
        if resolved != root and root not in resolved.parents:
            return str(root / "__outside_root__")  # Never exists -> 404.
        return str(resolved)

    def list_directory(self, path):  # noqa: ARG002 - signature is fixed.
        """Directory browsing would leak the build layout; answer 404."""
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None

    def log_request(self, code="-", size="-") -> None:
        """--quiet suppresses successful requests, never problems.

        log_request() runs before send_response_only(), so the gate uses the
        code it is handed rather than self._status.
        """
        if self.config.quiet and not _is_error_status(code):
            return
        super().log_request(code, size)

    # -- routes -----------------------------------------------------------
    def _reject_wrong_host(self) -> bool:
        allowed = self.config.allowed_hosts
        if not allowed:
            return False
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
        if host in allowed:
            return False
        self.send_error(
            HTTPStatus.MISDIRECTED_REQUEST,
            "This origin is not served by this host.",
        )
        return True

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _handle_health(self) -> None:
        """Liveness probe. Deliberately leaks no paths or build details."""
        if (self.config.directory / "index.html").is_file():
            self._send_json(HTTPStatus.OK, {"status": "ok"})
        else:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "status": "missing-build",
                    "hint": "no index.html in the served directory",
                },
            )

    def _method_not_allowed(self) -> None:
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Only GET, HEAD, OPTIONS.")

    def _dispatch(self) -> None:
        """Route the request: Host check, health probe, then static files."""
        if self._reject_wrong_host():
            return
        if self.request_path in HEALTH_PATHS:
            self._handle_health()
            return
        file = self.send_head()
        if file is None:
            return  # Headers (200 redirect/304/404) already sent.
        try:
            if self.command != "HEAD":
                self.copyfile(file, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True  # Client aborted the download.
        finally:
            file.close()

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        if self._reject_wrong_host():
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = do_PUT = do_PATCH = do_DELETE = _method_not_allowed


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # Large enough for a burst of asset requests from one page load.
    request_queue_size = 64

    def __init__(self, address, handler, *, ipv6: bool = False) -> None:
        if ipv6:
            self.address_family = socket.AF_INET6
        super().__init__(address, handler)

    def handle_error(self, request, client_address) -> None:
        kind = sys.exc_info()[0]
        if kind in (BrokenPipeError, ConnectionResetError, TimeoutError):
            return  # Clients abort asset downloads all the time.
        super().handle_error(request, client_address)


def _host_parser(value: str) -> str:
    """Accept the friendly spellings of "every interface"."""
    return (
        "0.0.0.0" if str(value).strip().lower() in ("*", "all") else str(value).strip()
    )


def env_default(name: str, fallback):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return fallback
    return raw


def env_int(name: str, fallback: int) -> int:
    raw = env_default(name, fallback)
    try:
        return int(raw)
    except (TypeError, ValueError):
        sys.exit(f"{name} must be an integer, got {raw!r}")


def env_flag(name: str) -> bool:
    return str(env_default(name, "")).strip().lower() in ("1", "true", "yes", "on")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="serve.py",
        description="Serve the Still authenticator production build (dist/).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default=_host_parser(env_default("HOST", DEFAULT_HOST)),
        help="Interface to bind. Use 0.0.0.0 inside a container; keep "
        "127.0.0.1 for strictly local use.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=env_int("PORT", DEFAULT_PORT),
        help="TCP port to listen on.",
    )
    parser.add_argument(
        "--dir",
        default=env_default("DIST_DIR", DEFAULT_DIR),
        help="Directory holding the built app (contains index.html).",
    )
    parser.add_argument(
        "--csp",
        default=env_default("STILL_CSP", DEFAULT_CSP),
        help="Extra Content-Security-Policy header, applied in addition to the "
        "page's meta CSP.",
    )
    parser.add_argument(
        "--hsts-max-age",
        type=int,
        default=env_int("STILL_HSTS_MAX_AGE", 0),
        help="Send Strict-Transport-Security with this max-age. Only enable "
        "behind real HTTPS: HSTS on a plain-HTTP origin is ignored by "
        "browsers but a mistake on a shared domain is sticky.",
    )
    parser.add_argument(
        "--allowed-hosts",
        default=env_default("STILL_ALLOWED_HOSTS", ""),
        help="Comma-separated Host header allowlist (DNS-rebinding "
        "hardening). Empty disables the check.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        default=env_flag("STILL_QUIET"),
        help="Log only warnings and errors (status >= 400).",
    )
    parser.add_argument(
        "--healthcheck",
        action="store_true",
        help="Do not serve: probe a running instance's /healthz and exit 0 "
        "when healthy, 1 otherwise. Used by the Docker HEALTHCHECK.",
    )
    return parser


def _probe(host: str, port: int, timeout: float = 5.0) -> int:
    probe_host = {
        "0.0.0.0": "127.0.0.1",
        "::": "::1",
        "*": "127.0.0.1",
    }.get(host, host)
    literal = f"[{probe_host}]" if ":" in probe_host else probe_host
    url = f"http://{literal}:{port}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0


def run_healthcheck(host: str, port: int) -> int:
    status = _probe(host, port)
    if status == HTTPStatus.OK:
        print(f"healthy: /healthz returned {status}")
        return 0
    print(
        f"unhealthy: /healthz on {host}:{port} returned {status or 'no response'}",
        file=sys.stderr,
    )
    return 1


def serve(config: Config, host: str, port: int) -> None:
    handler = partial(Handler, config=config)
    ipv6 = ":" in host
    bind_host = "::" if host in ("::", "*") else host
    try:
        httpd = Server((bind_host, port), handler, ipv6=ipv6)
    except OSError as error:
        sys.exit(f"Cannot bind {bind_host}:{port} - {error}")

    bound_host, bound_port = httpd.server_address[0], httpd.server_address[1]
    index = config.directory / "index.html"
    if not index.is_file():
        print(
            f"warning: no index.html in {config.directory}. Run `npm run build` "
            "first; /healthz reports 503 until the build exists.",
            file=sys.stderr,
        )

    stop = threading.Event()

    def request_stop(signum, _frame):
        print(f"\nReceived signal {signum}, shutting down.", file=sys.stderr)
        stop.set()

    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(signum, request_stop)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            pass

    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.2})
    thread.start()

    reachable = "localhost" if bound_host in ("0.0.0.0", "::") else bound_host
    print(f"Serving {config.directory} on http://{reachable}:{bound_port}")
    print(f"  bound to {bound_host}:{bound_port}  CSP header: {config.csp}")
    if config.hsts_max_age > 0:
        print(f"  HSTS max-age={config.hsts_max_age}")
    if config.allowed_hosts:
        print(f"  Host allowlist: {', '.join(config.allowed_hosts)}")
    if bound_host in ("0.0.0.0", "::") and config.hsts_max_age == 0:
        print(
            "  WebAuthn needs a secure context: reach this app via "
            f"http://localhost:{bound_port} or an HTTPS origin. A plain "
            "http://<ip> origin will load but cannot register or unlock a vault."
        )
    print("  Press Ctrl+C to stop.")
    # Without this the banner sits in a block buffer when stdout is a pipe or a
    # file, which is exactly how Docker and systemd capture it.
    sys.stdout.flush()

    try:
        stop.wait()
    finally:
        httpd.shutdown()
        thread.join(timeout=5)
        httpd.server_close()
        print("Stopped.", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    host = _host_parser(args.host)
    if args.healthcheck:
        return run_healthcheck(host, args.port)

    directory = Path(args.dir).expanduser()
    if not directory.is_dir():
        sys.exit(f"Directory not found: {directory}")
    allowed_hosts = tuple(
        entry.strip().lower()
        for entry in args.allowed_hosts.split(",")
        if entry.strip()
    )
    config = Config(
        directory=directory.resolve(),
        csp=args.csp.strip() or DEFAULT_CSP,
        hsts_max_age=max(0, args.hsts_max_age),
        allowed_hosts=allowed_hosts,
        quiet=args.quiet,
    )
    serve(config, host, args.port)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:  # pragma: no cover
        raise SystemExit(130)
