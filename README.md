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

Open `http://localhost:4173` locally or deploy `dist/` to a **trusted HTTPS origin** (see [Deploy on Vercel](#deploy-on-vercel)). The preview server is bound to all interfaces for Arena previews; for strictly local use, run `npm run preview -- --host 127.0.0.1 --port 4173` instead. Keep the address, hostname, and port unchanged: both local storage and credentials depend on the origin. Do not use the Vite development server for real secrets.

The first hosted visit downloads the app. The production service worker caches only static assets for later offline use. It does not cache vaults or export files. No service worker is installed during development. To avoid internet access altogether during use, install dependencies/build in advance, run the production app on localhost, and disconnect from the internet. Your browser or operating system may independently make requests; this app cannot control that.

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsarakplaystore%2F2fa-Ai)

The repository deploys as-is: no backend, no serverless functions, no environment variables, no build settings to change. Import it in Vercel, or use the button above, and deploy.

`vercel.json` pins what the app depends on:

- **Build**: framework `vite`, install `npm ci`, build `npm run build`, output `dist`. Node.js comes from `engines.node` (`>=22.12`, so Vercel picks its newest supported LTS, currently 24.x).
- **Security headers** on every response: `Content-Security-Policy` (the page's `<meta>` policy plus `frame-ancestors 'none'`, which a meta tag cannot express), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy` (camera, microphone, geolocation, USB and the rest denied; WebAuthn allowed for this origin only) and `X-Robots-Tag: noindex`. They apply to custom domains too.
- **Caching**: hashed files under `/assets/` are `immutable` for a year; `/`, `/index.html` and `/sw.js` are always revalidated, so a new deployment reaches the browser on the next visit. The generated service worker names its cache after the build and deletes older caches, and `public/robots.txt` keeps the app out of search indexes.
- **Routing**: one catch-all rewrite to `/index.html`, excluding Vercel's reserved `/_vercel/*` namespace. Unknown paths return the app shell instead of a 404.

Origin rules matter more here than on a normal site:

- Browser storage and the WebAuthn credential are bound to the exact origin. Preview deployments, `*.vercel.app` addresses and custom domains are separate origins, so **create the vault only on the address you intend to keep**. Moving later means restoring an encrypted backup and registering the device again.
- Anything else that changes the origin — a new domain, an http-to-https or `www` redirect, a reverse proxy serving the app under a path prefix — has the same effect. The build uses absolute `/` paths, so serve it from the root of its host.
- `vercel.app` subdomains are on the public suffix list, so a credential created on one deployment is never shared with another. Set the production domain before you rely on it.
- Deployment Protection (Project Settings → Deployment Protection) protects preview and per-deployment URLs by default for projects created after November 2023; the production domain stays public, as it should. If the project predates that change, check the setting before testing real accounts on a preview URL.

Two deliberate trade-offs:

- **No analytics or preview toolbar.** `index.html` carries no analytics or Speed Insights script tags, and a static build cannot have them injected afterwards, so those dashboard toggles collect nothing on their own. The Vercel Toolbar is injected into preview deployments from `vercel.live` and is blocked by `script-src 'self'`; that is intended. Enabling either means editing `index.html` and loosening the policy, which breaks the no-third-party-request promise.
- **`Strict-Transport-Security` includes subdomains** of the host you deploy on. Remove `includeSubDomains` from `vercel.json` if that host has subdomains you need over plain HTTP.

Check the deployment's routing and headers locally before deploying, then confirm the real response after:

```sh
npm run build
npm run preview:vercel                      # serves dist/ with the vercel.json rules
npm run preview:vercel -- --strict          # the deployment's exact headers, including frame-ancestors
curl -sSI https://your-app.vercel.app | grep -iE 'content-security|strict-transport|cache-control|frame'
```

`scripts/vercel-preview.mjs` applies the `rewrites` and `headers` rules from `vercel.json` to the files in `dist/`. It is a checking tool, not a reimplementation of Vercel's edge network. It binds to all interfaces for Arena previews and drops `frame-ancestors` and `X-Frame-Options` by default so an embedded preview can render; `--strict` reproduces the deployment byte for byte. Add `-- --host 127.0.0.1` for loopback only.

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

For deployment, use HTTPS and restrictive security headers including `frame-ancestors` on a trusted production host (omitted from this embedded Arena preview; `vercel.json` ships them for Vercel). The HTML includes a restrictive CSP against third-party assets, inline scripts, framing child pages, and form submissions.

## Tests

```sh
npm test
npm run build
```

Tests cover all RFC 6238 SHA-1/SHA-256/SHA-512 vectors, Base32 validation, import parsing, Google migration parsing, encryption integrity, password backup round trips, malformed encrypted payloads, import limits, and a 1,000-account encryption round trip. The deployment is covered too: the `vercel.json` build wiring against `package.json` and the Vite config, the SPA fallback and its `/_vercel/*` exclusion, the served header set against the page's CSP, cache policy per path, and the service worker's cache invalidation on a new build.

Optional browser smoke test (start the production preview first):

```sh
npx playwright install chromium
npm run test:ui
```

It covers mocked device setup, adding/revealing/searching accounts, encrypted export and restore, wrong-password rejection, locking/unlocking, import, navigation, mobile overflow, offline reload, offline QR-image decoding without BarcodeDetector, and unrelated-QR rejection. No mock credentials are included in the application bundle.

## Bundled dependencies

The production QR decoder is [jsQR](https://github.com/cozmo/jsQR), licensed under Apache-2.0. Its code is bundled locally at build time, never fetched from a CDN. `qrcode` is a development-only dependency used to generate QR fixtures for browser tests.
