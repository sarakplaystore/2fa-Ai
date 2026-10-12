# Still — local-first authenticator

A responsive, private TOTP authenticator. No backend, analytics, remote fonts, account registration service, or application API calls. Account secrets are encrypted in this browser's local storage.

## Run

```sh
npm ci
npm run dev
```

Production / offline-capable build:

```sh
npm run build
npm run preview -- --port 4173
```

Open `http://localhost:4173` locally or deploy `dist/` to a **trusted HTTPS origin** (see [Deploy](#deploy)). The preview server is bound to all interfaces for Arena previews; for strictly local use, run `npm run preview -- --host 127.0.0.1 --port 4173` instead. Keep the address, hostname, and port unchanged: both local storage and credentials depend on the origin. Do not use the Vite development server for real secrets.

The first hosted visit downloads the app. The production service worker caches only static assets for later offline use. It does not cache vaults or export files. No service worker is installed during development. To avoid internet access altogether during use, install dependencies/build in advance, run the production app on localhost, and disconnect from the internet. Your browser or operating system may independently make requests; this app cannot control that.

## Deploy

The build output in `dist/` is the whole application: no backend, no database, no server-side state, and nothing that talks to a service. Any static host can serve it. This repository ships two supported ways to self-host it, both sending the security headers the app is designed around:

- a multi-stage **Docker** image whose runtime is a dependency-free Python static server;
- the same **Python** server directly, with no container, no virtualenv, and no packages to install.

`python3 -m http.server` and other generic file servers are not supported alternatives: they send no `frame-ancestors` or `nosniff` headers, cache `sw.js` for too long, and expose directory listings.

**Pick the origin before you deploy.** Scheme + host + port identify a vault: browser storage and the device credential are bound to that origin, and changing any part of it opens a new, empty vault. Export an encrypted backup first and keep the origin stable across upgrades and image rebuilds. WebAuthn also requires a **secure context** — `http://localhost` / `http://127.0.0.1`, or HTTPS. A plain `http://<lan-ip>:8080` page loads, but the browser refuses credential registration and unlock there.

### Docker

```sh
npm run docker:build     # docker build -t still-authenticator:local .
npm run docker:run       # docker run --rm --init -p 127.0.0.1:8080:8080 still-authenticator:local
```

Then open `http://localhost:8080`. Loopback publishing is deliberate: it keeps the origin a secure context and does not expose the app to your LAN. Publish `"8080:8080"` only behind TLS (below).

The image builds the app in `node:22-alpine` (`npm ci`, `npm test`, `npm run build`) and runs it from `python:3.13-alpine` as an unprivileged user (uid 10001) with only `dist/` and `scripts/serve.py` inside. The runtime installs no third-party packages and needs no writable paths. Override either base image with build args: `docker build --build-arg NODE_VERSION=22 --build-arg PYTHON_VERSION=3.13 -t still-authenticator:local .`

### Docker Compose

```sh
npm run docker:up        # docker compose up -d --build   -> http://localhost:8080
npm run docker:logs      # docker compose logs -f still
npm run docker:down      # docker compose down
```

`docker-compose.yml` adds container hardening: read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, `init`, a `/healthz` healthcheck, and loopback-only port publishing.

### HTTPS (Caddy profile)

For a real domain, or for local testing over TLS:

```sh
STILL_SITE_ADDRESS=auth.example.com npm run docker:https   # public domain, automatic Let's Encrypt
npm run docker:https                                       # defaults to https://localhost
docker compose exec caddy caddy trust                      # trust Caddy's local CA for localhost testing
```

The optional `caddy` service (compose profile `tls`) terminates TLS using `deploy/caddy/Caddyfile`, proxies to `still:8080`, compresses text assets, and adds HSTS for non-localhost hosts. A public domain needs DNS pointing at the host and inbound ports 80/443 for certificate issuance. Once TLS is real, also set `STILL_HSTS_MAX_AGE=31536000` on the `still` service so the app's own responses carry HSTS.

### Python, no Docker

Requires Python 3.9+; the standard library is the only dependency.

```sh
npm ci
npm run build
npm run serve          # python3 scripts/serve.py --host 127.0.0.1 --port 4173 --dir dist
```

On Windows use `python scripts/serve.py ...`. Bind to all interfaces with `npm run serve:lan` (or `--host 0.0.0.0`) only when you will reach it through HTTPS — otherwise WebAuthn will not work from another machine. The server handles `SIGTERM`/`SIGINT` for a clean shutdown, so it runs fine under systemd, Docker, or any supervisor:

```sh
python3 scripts/serve.py --host 0.0.0.0 --port 8080 --dir dist \
  --allowed-hosts auth.example.com --hsts-max-age 31536000
```

### Configuration

Every flag has an environment-variable equivalent, so the same settings work in Docker, Compose, and a shell. Copy `.env.example` to `.env` next to `docker-compose.yml` to keep them out of your shell history; `.env` is git-ignored.

| Environment           | Flag              | Default                                                       | Purpose                                                                                              |
| --------------------- | ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `HOST`                | `--host`          | `127.0.0.1` (`0.0.0.0` in the image)                          | Interface to bind.                                                                                   |
| `PORT`                | `--port`          | `8080`                                                        | TCP port.                                                                                            |
| `DIST_DIR`            | `--dir`           | `dist` (`/app/dist` in the image)                             | Directory holding `index.html`.                                                                      |
| `STILL_CSP`           | `--csp`           | `frame-ancestors 'none'; base-uri 'self'; form-action 'none'` | Header policy enforced _in addition to_ the page's meta CSP.                                         |
| `STILL_HSTS_MAX_AGE`  | `--hsts-max-age`  | `0` (off)                                                     | Sends `Strict-Transport-Security`. Enable only behind real HTTPS.                                    |
| `STILL_ALLOWED_HOSTS` | `--allowed-hosts` | empty (any host)                                              | Comma-separated `Host` allowlist; anything else gets `421`.                                          |
| `STILL_QUIET`         | `--quiet`         | off                                                           | Log only responses with status ≥ 400.                                                                |
| —                     | `--healthcheck`   | —                                                             | Probe a running instance's `/healthz`, exit `0` healthy / `1` not. Used by the Docker `HEALTHCHECK`. |

Responses always carry `Content-Security-Policy` (header policy), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Resource-Policy: same-origin`. Caching is split so upgrades take effect: `index.html` and `sw.js` are `no-cache, must-revalidate`; fingerprinted files under `/assets/` are `immutable` for one year; everything else revalidates after five minutes; errors are `no-store`. Directory listings are disabled and requests cannot escape the build directory.

`GET /healthz` returns `200 {"status":"ok"}` when `index.html` is present and `503 {"status":"missing-build"}` when the served directory is empty, which is what the container healthcheck and your load balancer should use. It discloses no paths or version details.

### Behind your own reverse proxy

Serve the app from the **root of an origin** — a path prefix such as `/2fa/` breaks absolute asset URLs, the service worker scope, and therefore the vault. Keep the upstream headers intact and do not add a second, conflicting CSP.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_hide_header Server;
    # Do not cache /sw.js at the edge; the app updates itself through it.
}
```

### Verify a deployment

```sh
curl -fsS http://localhost:8080/healthz
curl -fsSI http://localhost:8080/ | grep -iE 'content-security-policy|cache-control|x-frame|x-content'
docker compose exec still python /app/scripts/serve.py --healthcheck
UI_BASE_URL=http://localhost:8080 npm run test:ui   # browser smoke test against the deployed origin
```

If the vault looks empty after a redeploy, the origin changed (port, host, or scheme) — restore the encrypted backup on the new origin or go back to the old one. If registration or unlock fails, confirm the page is on `localhost` or HTTPS and that your browser and platform authenticator support the WebAuthn PRF extension (see [Device login requirements](#device-login-requirements)). A `503` from `/healthz` means the served directory has no build.

## Features

- TOTP: SHA-1, SHA-256, SHA-512; 6 or 8 digits; 15–120 second periods.
- Add setup keys manually, search accounts, reveal/hide and copy codes, remove accounts.
- Mandatory device-verified credential registration before creating a vault.
- AES-256-GCM vault encryption; key derived with WebAuthn PRF and HKDF-SHA256.
- Codes hidden by default; lock on hidden tab, window blur (except the import file picker/device prompt), Escape, or two minutes without keyboard/pointer activity.
- Import `otpauth://totp` links, JSON account arrays/envelopes, Still encrypted backups, and single-batch Google Authenticator `otpauth-migration` links.
- Portable local QR-image decoding using a bundled jsQR worker; no browser `BarcodeDetector` dependency, external decoder service, or live camera requirement. The worker is cached for offline use and stopped on dialog close. PNG, JPEG, and WebP files up to 5 MB are supported; use one clear QR code per image.
- Complete encrypted backups containing all secret keys and TOTP settings, protected by a separate password with PBKDF2-SHA256 (600,000 iterations) and AES-256-GCM.
- Mobile-responsive interface, keyboard-accessible dialogs, security explanations, and destructive-action confirmations.

## Device login requirements

**This is not custom face recognition.** WebAuthn delegates user verification to the device. A compatible device can use face recognition, fingerprint, or a device PIN. A website cannot mandate face-only verification or register biometric templates; set up your face in the operating system first.

The browser **and** platform authenticator must support the **WebAuthn PRF extension**, and the site must be a secure context (HTTPS or localhost). Unsupported credentials fail closed; there is no plaintext or password-only vault fallback. Registration may create a device credential even if PRF subsequently proves unsupported; remove unused credentials in your OS credential settings. Passkey providers can sync credentials independently of this app. This app does not guarantee a hardware-bound, unsynced credential.

Cross-origin embedded previews may block WebAuthn. Open the preview in a standalone tab. Physical biometric verification and vendor compatibility must be tested on the target hardware; automated tests mock the credential boundary and are not proof of hardware support.

## Import format

```json
{
  "accounts": [
    {
      "issuer": "Example",
      "name": "you@example.com",
      "secret": "JBSWY3DPEHPK3PXP",
      "algorithm": "SHA1",
      "digits": 6,
      "period": 30
    }
  ]
}
```

This example is a public demonstration key: **never use it for a real service**. JSON import files and setup URIs contain plaintext secrets. Still exports only encrypted backups, not Google migration QR codes or plaintext exports. Google multi-QR exports and HOTP are rejected with an explanation. Export smaller, single-QR batches from Google to import. Matching name + canonicalized secret pairs are deduplicated. Importing does not delete existing accounts. A vault supports up to 1,000 accounts. Imports reject invalid settings, oversized inputs, and HOTP records rather than silently treating them as TOTP.

## Security boundaries

- Experimental implementation, **not independently security-audited**. Review and test before trusting important accounts to it; retain service recovery codes and another trusted authenticator.
- Browser storage can be cleared or evicted. Export a backup after changing accounts. There is no recovery server. Loss of browser data, credential, or origin may require backup restoration to a new vault.
- Encrypted backups require their password. Store them offline with a strong unique password, kept separately.
- A compromised device, malicious extension, injected script, malicious future deployment, or someone able to use your device PIN can defeat these protections. A trusted hosting origin and browser are essential.
- Copying a code leaves it on the system clipboard; clipboard contents are not automatically erased. Codes may remain usable through their current TOTP interval even after vault locking.
- JavaScript cannot guarantee forensic zeroization of memory. Locking drops live references and removes secrets/codes from the UI, not from every possible memory snapshot.
- Browser storage contains only encrypted account data plus credential ID/salt/version/IV metadata. The AES key is nonextractable and not persisted. Vault storage size/account count may still be observable.
- No software can guarantee protection against mind reading. The privacy controls here address physical observation and unauthorized digital access.
- The self-hosted server is a static file server. It holds no vault, no secrets, and no codes, makes no outbound connections, and has nothing to breach beyond the public build; your access logs record requested paths, never TOTP material, because the app sends none over the network.

For deployment, use HTTPS and restrictive security headers including `frame-ancestors` on a trusted production host (omitted from this embedded Arena preview). The HTML includes a restrictive CSP against third-party assets, inline scripts, framing child pages, and form submissions. The server described in [Deploy](#deploy) adds what a meta tag cannot express (`frame-ancestors`, `base-uri`, `form-action`) plus nosniff, referrer, permissions, and cross-origin policies; a reverse proxy must pass them through rather than replace them. Whoever controls the host, the image, or the origin can serve your browser different code, and the app has no update channel to detect that: deploy on infrastructure you trust and review what an upgrade changed.

## Tests

```sh
npm test
npm run build
```

Tests cover all RFC 6238 SHA-1/SHA-256/SHA-512 vectors, Base32 validation, import parsing, Google migration parsing, encryption integrity, password backup round trips, malformed encrypted payloads, import limits, and a 1,000-account encryption round trip.

`npm test` also exercises `scripts/serve.py`, the server used by the Docker image and `npm run serve`, against a temporary fixture build: security headers, per-file-class cache policy, JavaScript MIME types for `.js`/`.mjs`, conditional requests and keep-alive, disabled directory listings, path-traversal rejection, the `Host` allowlist, both `/healthz` states, and the `--healthcheck` exit codes. Those tests need Python 3.9+ on the PATH and skip themselves with a notice when it is missing, so the suite still passes on machines without Python. The Docker build runs the same suite, and a failing test fails the image build.

Optional browser smoke test (start the production preview first):

```sh
npx playwright install chromium
npm run test:ui
```

It covers mocked device setup, adding/revealing/searching accounts, encrypted export and restore, wrong-password rejection, locking/unlocking, import, navigation, mobile overflow, offline reload, offline QR-image decoding without BarcodeDetector, and unrelated-QR rejection. No mock credentials are included in the application bundle.

Point the smoke test at a deployed origin instead of the preview server with `UI_BASE_URL` — a useful last check before trusting a container:

```sh
npm run docker:up
UI_BASE_URL=http://localhost:8080 npm run test:ui
```

## Bundled dependencies

The production QR decoder is [jsQR](https://github.com/cozmo/jsQR), licensed under Apache-2.0. Its code is bundled locally at build time, never fetched from a CDN. `qrcode` is a development-only dependency used to generate QR fixtures for browser tests.

Self-hosting adds no runtime packages. `scripts/serve.py` is Python standard library only, and the Docker runtime stage contains nothing but the built assets and that one script; `node:22-alpine` is used for the build stage and discarded, `python:3.13-alpine` runs the server. The optional TLS profile pulls the upstream `caddy:2-alpine` image.
