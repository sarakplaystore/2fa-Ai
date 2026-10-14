import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAndroidBridge } from "../src/android.js";
import { b64 } from "../src/security.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const native = () => {
  const host = {};
  const calls = [];
  const methods = Object.fromEntries(
    ["authenticate", "saveBackup", "copyCode", "clearKey"].map((method) => [
      method,
      (...args) => calls.push([method, ...args]),
    ]),
  );
  return { bridge: createAndroidBridge(methods, host, 150), host, calls };
};

test("Android unlock waits for a verified 32-byte device response", async () => {
  const { bridge, host, calls } = native();
  const pending = bridge.authenticate(true);
  assert.deepEqual(calls, [["authenticate", 1, true]]);
  host.__stillAndroidResult(1, b64(new Uint8Array(32).fill(42)), null);
  assert.deepEqual(await pending, new Uint8Array(32).fill(42));
  const reopen = bridge.authenticate(false);
  assert.deepEqual(calls[1], ["authenticate", 2, false]);
  host.__stillAndroidResult(2, b64(new Uint8Array(16)), null);
  await assert.rejects(reopen, /Invalid device key/);
});

test("missing, canceled, and timed-out Android authentication fail closed", async () => {
  const missing = createAndroidBridge(undefined, {});
  await assert.rejects(missing.authenticate(true), /unavailable/);
  const { bridge, host } = native();
  const attempt = bridge.authenticate(false);
  host.__stillAndroidResult(1, null, "Device verification canceled or unavailable.");
  await assert.rejects(attempt, /canceled/);
  const timedOut = createAndroidBridge({ authenticate() {} }, {}, 5);
  await assert.rejects(timedOut.authenticate(false), /timed out/);
});

test("backup, clipboard, and reset calls require an Android acknowledgment", async () => {
  const { bridge, host, calls } = native();
  const saved = bridge.saveBackup("still-backup-2026-10-14.json", '{"format":"still-encrypted-backup"}');
  assert.equal(calls[0][0], "saveBackup");
  host.__stillAndroidResult(1, null, "Backup canceled. No file was saved.");
  await assert.rejects(saved, /canceled/);
  await assert.rejects(bridge.copyCode("KEY=123456"), /Invalid verification code/);
  const copy = bridge.copyCode("12345678");
  assert.deepEqual(calls[1], ["copyCode", 2, "12345678"]);
  host.__stillAndroidResult(2, "ok", null);
  await copy;
  const reset = bridge.clearKey();
  assert.deepEqual(calls[2], ["clearKey", 3]);
  host.__stillAndroidResult(3, "ok", null);
  await reset;
});

test("APK web bundle contains local assets and native unlock, not WebAuthn or a service worker", () => {
  execFileSync(process.execPath, ["scripts/build-android.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
  const output = join(root, "android/app/src/main/assets/www");
  const html = readFileSync(join(output, "index.html"), "utf8");
  const assets = readdirSync(join(output, "assets"));
  const script = readFileSync(join(output, "assets", assets.find((f) => /^index-.*\.js$/.test(f))), "utf8");
  for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g))
    assert.ok(assets.includes(asset[1].slice("/assets/".length)), `Missing: ${asset[1]}`);
  assert.match(script, /android-keystore-v1/);
  assert.match(script, /StillAndroid/);
  assert.doesNotMatch(script, /PublicKeyCredential|\/sw\.js|serviceWorker\.register/);
  assert.ok(!readdirSync(output).includes("sw.js"));
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android:allowBackup="false"/);
  assert.deepEqual(
    [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]),
    ["android.permission.USE_BIOMETRIC"],
  );
  const java = read("android/app/src/main/java/com/sarakplaystore/still/MainActivity.java");
  assert.match(java, /setUserAuthenticationParameters\(0,/);
  assert.match(java, /setUserAuthenticationRequired\(true\)/);
  assert.match(java, /shouldInterceptRequest/);
  assert.match(java, /handler\.cancel\(\)/);
  assert.match(java, /FLAG_SECURE/);
});
