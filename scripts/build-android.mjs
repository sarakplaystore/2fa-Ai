// Build the same UI, but with an Android Keystore device adapter instead of
// browser WebAuthn. Do not ship a service worker in a packaged, offline APK.
import { build } from "vite";
import { readFileSync } from "node:fs";

process.env.VITE_ANDROID = "1";
const outDir = "android/app/src/main/assets/www";
await build({ build: { outDir, emptyOutDir: true } });
const html = readFileSync(`${outDir}/index.html`, "utf8");
if (!html.includes('/assets/') || html.includes('/src/main.js'))
  throw Error('Android app assets were not built correctly.');
console.log(`Bundled offline Android web assets in ${outDir}`);
