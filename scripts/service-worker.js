import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const assets = readdirSync("dist/assets").map((f) => "/assets/" + f);
const hash = createHash("sha256")
  .update(readFileSync("dist/index.html"))
  .digest("hex")
  .slice(0, 16);
writeFileSync(
  "dist/sw.js",
  `const CACHE='still-${hash}';
const ASSETS=${JSON.stringify(["/", "/index.html", "/favicon.svg", "/jsqr-LICENSE.txt", ...assets])};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('still-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;e.respondWith(caches.open(CACHE).then(c=>c.match(e.request,{ignoreVary:true})).then(hit=>hit||fetch(e.request)));});
`,
);
