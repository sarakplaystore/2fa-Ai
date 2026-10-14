// Run against `npm run preview -- --port 4173`.
// Uses a mocked PRF credential, not a real biometric device.
// Default: install Chromium with `npx playwright install chromium`.
// Optional packaged Chromium: npm install --no-save @sparticuz/chromium
// then run with USE_PACKAGED_CHROMIUM=1 (system shared libraries are required).
import { chromium as playwright } from "@playwright/test";
const chromium = process.env.USE_PACKAGED_CHROMIUM
  ? (await import("@sparticuz/chromium")).default
  : null;
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { readFile } from "node:fs/promises";
const browser = await playwright.launch(
  chromium
    ? {
        args: chromium.args.filter((a) => a !== "--disable-web-security"),
        executablePath: await chromium.executablePath(),
        headless: true,
      }
    : { headless: true },
);
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => {
  // Force the portable decoder path, independent of native browser support.
  Object.defineProperty(window, "BarcodeDetector", {
    value: undefined,
    configurable: true,
  });
  const credential = {
    rawId: new Uint8Array(32).fill(1).buffer,
    getClientExtensionResults: () => ({
      prf: { results: { first: new Uint8Array(32).fill(42).buffer } },
    }),
  };
  Object.defineProperty(navigator.credentials, "create", {
    value: async () => credential,
  });
  Object.defineProperty(navigator.credentials, "get", {
    value: async () => credential,
  });
});
await page.goto("http://localhost:4173");

await page.getByRole("button", { name: "Set up your private vault" }).click();
await page
  .getByRole("button", { name: "Register device & create vault" })
  .click();
await page.getByRole("button", { name: "Add account", exact: true }).click();
await page.getByLabel("Service name").fill("Example");
await page.getByLabel("Account name or email").fill("test@example.com");
await page.getByLabel("Secret setup key").fill("JBSWY3DPEHPK3PXP");
await page.getByRole("button", { name: "Save account", exact: true }).click();
await page.getByRole("heading", { name: "Example", exact: true }).waitFor();
assert.ok(
  !(await page.evaluate(() => localStorage.getItem("still.vault.v1"))).includes(
    "JBSWY3DPEHPK3PXP",
  ),
);
await page.getByRole("button", { name: "Reveal code", exact: true }).click();
assert.match(await page.locator(".code-value").textContent(), /^\d{3} \d{3}$/);
await page.getByLabel("Search accounts").fill("missing");
await page.getByText("No accounts match your search.").waitFor();
await page.getByLabel("Search accounts").fill("");
await page.getByRole("button", { name: "Export backup", exact: true }).click();
await page
  .getByLabel("Create a backup password")
  .fill("a secure backup phrase");
await page.getByLabel("Confirm password").fill("a secure backup phrase");
const downloadEvent = page.waitForEvent("download");
await page.getByRole("button", { name: "Download encrypted backup" }).click();
const download = await downloadEvent;
assert.ok(download.suggestedFilename().startsWith("still-backup-"));
const backup = await readFile(await download.path(), "utf8");
assert.ok(!backup.includes("JBSWY3DPEHPK3PXP"));
// Remove and restore from the downloaded backup: test the actual UI round trip.
await page.getByRole("button", { name: "Remove Example", exact: true }).click();
await page.getByRole("button", { name: "Remove account", exact: true }).click();
await page
  .getByRole("button", { name: "Import accounts", exact: true })
  .click();
await page.locator("#import-text").fill(backup);
await page.locator("#import-password").fill("wrong password");
await page.locator("#import-form button[type=submit]").click();
await page
  .getByText("Incorrect backup password or damaged backup.", { exact: true })
  .waitFor();
await page.locator("#import-password").fill("a secure backup phrase");
await page.locator("#import-form button[type=submit]").click();
await page.getByRole("heading", { name: "Example", exact: true }).waitFor();
await page.getByRole("button", { name: "Lock vault", exact: true }).click();
assert.equal(await page.locator(".code-value").count(), 0);
await page
  .getByRole("button", { name: "Unlock your vault", exact: true })
  .click();
await page.getByRole("button", { name: "Verify & unlock" }).click();
await page.getByRole("heading", { name: "Example", exact: true }).waitFor();
await page
  .getByRole("button", { name: "Import accounts", exact: true })
  .click();
await page
  .locator("#import-text")
  .fill(
    "otpauth://totp/Other:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Other",
  );
await page.locator("#import-form button[type=submit]").click();
await page.getByRole("heading", { name: "Other", exact: true }).waitFor();
await page.keyboard.press("Escape");
assert.equal(await page.locator(".code-value").count(), 0);
await page
  .getByRole("button", { name: "Security & privacy", exact: true })
  .click();
await page
  .getByRole("heading", { name: "Security & privacy", exact: true })
  .waitFor();
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole("button", { name: "Authenticator", exact: false }).click();

assert.ok(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
);
await page.waitForFunction(() => navigator.serviceWorker.controller);
await page.context().setOffline(true);
await page.reload();
await page
  .getByRole("heading", { name: "Your authenticator", exact: true })
  .waitFor();
// The bundled worker and decoder must also be available without a connection.
await page
  .getByRole("button", { name: "Unlock your vault", exact: true })
  .click();
await page.getByRole("button", { name: "Verify & unlock" }).click();
await page.getByRole("heading", { name: "Example", exact: true }).waitFor();
await page
  .getByRole("button", { name: "Import accounts", exact: true })
  .click();
const uri =
  "otpauth://totp/OfflineQR:user?secret=JBSWY3DPEHPK3PXP&issuer=OfflineQR";
const qr = await QRCode.toBuffer(uri, { width: 512, margin: 4 });
await page
  .locator("#import-file")
  .setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: qr });
await page.waitForFunction(
  (expected) => document.querySelector("#import-text")?.value === expected,
  uri,
);
await page.locator("#import-form button[type=submit]").click();
await page.getByRole("heading", { name: "OfflineQR", exact: true }).waitFor();
await page
  .getByRole("button", { name: "Import accounts", exact: true })
  .click();
const unrelated = await QRCode.toBuffer("https://example.com", { width: 256 });
await page
  .locator("#import-file")
  .setInputFiles({
    name: "unrelated.png",
    mimeType: "image/png",
    buffer: unrelated,
  });
await page
  .getByText(
    "This QR code is not an authenticator setup or Google export code.",
    { exact: true },
  )
  .waitFor();
assert.equal(await page.locator("#import-text").inputValue(), "");
await page.keyboard.press("Escape");
// Installed-app support: the manifest is served and parsed by the browser, and
// the offline copy holds the app's own files — no vault, code or export data.
const metadata = await page.evaluate(async () => {
  const manifest = await fetch("/manifest.webmanifest").then((r) => r.json());
  const names = await caches.keys();
  const cache = await caches.open(names.find((n) => n.startsWith("still-")));
  return {
    name: manifest.name,
    display: manifest.display,
    start: manifest.start_url,
    icons: manifest.icons.length,
    cached: (await cache.keys()).map((request) => new URL(request.url).pathname),
    controlled: !!navigator.serviceWorker.controller,
  };
});
assert.ok(metadata.controlled, "the offline service worker should be controlling");
assert.equal(metadata.display, "standalone");
assert.equal(metadata.start, "/");
assert.equal(metadata.icons, 4);
for (const file of [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-maskable-512.png",
])
  assert.ok(metadata.cached.includes(file), `${file} is not available offline`);
assert.ok(
  metadata.cached.some((path) => path.includes("qr-worker")),
  "the QR decoder must work offline too",
);
assert.ok(
  !metadata.cached.some((path) => /backup|vault|export|\.json$/i.test(path)),
  "the offline copy must not hold vault or export data",
);
// A deep link is not a cached URL: the worker has to answer with the app shell
// instead of the browser's offline error page.
await page.goto("http://localhost:4173/accounts/example");
await page
  .getByRole("heading", { name: "Your authenticator", exact: true })
  .waitFor();
await page.context().setOffline(false);
// Back online at the same narrow width, the settings page confirms the offline
// copy is ready and the new install/offline rows still fit.
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page
  .getByText("Ready — cached on this device", { exact: true })
  .waitFor();
await page
  .getByText("Use your browser’s install or “Add to Home Screen” option", {
    exact: true,
  })
  .or(page.getByRole("button", { name: "Install Still" }))
  .waitFor();
assert.ok(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  "the settings page must not overflow on mobile",
);
await page.getByRole("button", { name: "Authenticator", exact: false }).click();
assert.deepEqual(errors, []);
console.log(
  "UI smoke passed: setup (mocked credential), add, reveal, search, encrypted backup restore/wrong-password rejection, lock/unlock, import, Escape lock, navigation, responsive layout, offline reload, offline QR decoding, unrelated-QR rejection, installable manifest, offline cache contents and offline deep links.",
);
await browser.close();
