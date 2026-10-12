// Run against `npm run preview -- --port 4173`.
// Point it at any production build with UI_BASE_URL, e.g. the Docker image or
// scripts/serve.py: `UI_BASE_URL=http://localhost:8080 npm run test:ui`.
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
// The origin the smoke test drives. WebAuthn and the vault are origin-bound, so
// this must be a secure context (localhost or HTTPS) - the same rule a real
// deployment follows.
const baseUrl = process.env.UI_BASE_URL || "http://localhost:4173";
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
await page.goto(baseUrl);

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
assert.deepEqual(errors, []);
console.log(
  "UI smoke passed: setup (mocked credential), add, reveal, search, encrypted backup restore/wrong-password rejection, lock/unlock, import, Escape lock, navigation, responsive layout, offline reload, offline QR decoding and unrelated-QR rejection.",
);
await browser.close();
