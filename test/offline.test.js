// Everything the app needs to work offline: the web app manifest and its
// icons, the page's install metadata, and the behaviour of the generated
// service worker when it is actually driven by install/activate/fetch events.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { ICONS, check, readPng } from "../scripts/icons.mjs";
import { headersFor } from "../scripts/vercel-preview.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../public/manifest.webmanifest"));
const html = read("../index.html");
const config = JSON.parse(read("../vercel.json"));
const swScript = fileURLToPath(
  new URL("../scripts/service-worker.js", import.meta.url),
);

// Builds a fake dist/ with only the files a source tree can provide, then runs
// the generator the build runs.
function generateWorker(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "still-offline-"));
  const contents = {
    "dist/index.html": '<!doctype html><p>Still</p>',
    "dist/assets/index-a.js": "// app",
    "dist/assets/qr-worker-a.js": "// decoder",
    "dist/favicon.svg": "<svg/>",
    "dist/jsqr-LICENSE.txt": "Apache-2.0",
    "dist/manifest.webmanifest": JSON.stringify(manifest),
    ...Object.fromEntries(
      ICONS.map((icon) => [`dist/icons/${icon.file}`, "png"]),
    ),
    ...files,
  };
  for (const [path, body] of Object.entries(contents)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    // A test can leave a path out to build a trimmed dist/.
    if (body !== undefined) writeFileSync(join(dir, path), body);
  }
  execFileSync(process.execPath, [swScript], { cwd: dir, stdio: "pipe" });
  const source = readFileSync(join(dir, "dist/sw.js"), "utf8");
  return { source, cache: /const CACHE = "([^"]+)"/.exec(source)[1] };
}

// A ServiceWorkerGlobalScope small enough to run the generated worker: caches,
// network and event dispatch, with every cache write recorded so a test can
// prove that nothing outside the build's file list is ever stored.
function workerHarness(source, { origin = "https://still.example" } = {}) {
  const stores = new Map();
  const writes = [];
  const network = [];
  const listeners = new Map();
  let offline = false;
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const key = (request) =>
    typeof request === "string"
      ? new URL(request, origin).href
      : request.url;
  const cacheFor = (name) => ({
    async add(request) {
      writes.push({ cache: name, url: key(request), call: "add" });
      store(name).set(key(request), { url: key(request), body: "cached" });
    },
    async addAll(requests) {
      for (const request of requests) await cacheFor(name).add(request);
    },
    async match(request) {
      return store(name).get(key(request));
    },
    async put() {
      throw Error("the service worker must never write to the cache at runtime");
    },
  });
  const self = {
    location: { origin },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  const sandbox = {
    self,
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
    fetch: (request) => {
      network.push(key(request));
      return offline
        ? Promise.reject(Error("offline"))
        : Promise.resolve({ url: key(request), from: "network" });
    },
    URL,
    Promise,
  };
  runInContext(source, createContext(sandbox), { filename: "sw.js" });
  const dispatch = async (type, props = {}) => {
    const event = {
      ...props,
      waitUntil: (promise) => {
        event.waited = promise;
        return promise;
      },
      respondWith: (promise) => {
        event.responded = promise;
        return promise;
      },
    };
    listeners.get(type)(event);
    if (event.responded) event.response = await event.responded.catch((e) => e);
    if (event.waited) await event.waited;
    return event;
  };
  const request = (url, mode = "cors", method = "GET") => ({
    url: new URL(url, origin).href,
    mode,
    method,
  });
  return {
    stores,
    writes,
    network,
    dispatch,
    request,
    goOffline: () => (offline = true),
  };
}

test("the manifest describes an installable app that starts offline", () => {
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.id, "/");
  assert.ok(manifest.name.length > 1 && manifest.short_name.length > 1);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  // The page's theme-color has to agree with the manifest, or the installed
  // window and the browser chrome disagree about the app's colour.
  const theme = /<meta name="theme-color" content="([^"]+)"/.exec(html);
  assert.equal(theme[1], manifest.theme_color);
  // Installing must not introduce a third-party request: every icon and URL is
  // a path on this origin.
  for (const icon of manifest.icons)
    assert.match(
      icon.src,
      /^\/[^\s]*$/,
      `${icon.src} has to be a same-origin path`,
    );
  assert.ok(
    !JSON.stringify(manifest).match(/https?:|\.\./),
    "the manifest must not reference another origin or climb out of the scope",
  );
});

test("the manifest ships any and maskable icons at the sizes browsers ask for", () => {
  const declared = (purpose) =>
    manifest.icons
      .filter((icon) => icon.purpose === purpose)
      .map((icon) => icon.sizes);
  assert.deepEqual(declared("any").sort(), ["192x192", "512x512"]);
  assert.deepEqual(declared("maskable").sort(), ["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    const file = join(root, "public", icon.src);
    assert.ok(existsSync(file), `${icon.src} is missing from public/`);
    const png = readPng(file);
    assert.equal(
      `${png.width}x${png.height}`,
      icon.sizes,
      `${icon.src} does not match the size the manifest declares`,
    );
    assert.equal(png.colorType, 6, `${icon.src} should be RGBA`);
  }
  // The maskable art is inset into the safe zone and the background bleeds to
  // the edge, so a circle, squircle or rounded-square mask never cuts the mark.
  const pixel = (png, x, y) => {
    const start = y * (png.width * 4 + 1) + 1 + x * 4;
    return [...png.raw.subarray(start, start + 4)];
  };
  for (const name of ["icon-maskable-512.png", "icon-maskable-192.png"]) {
    const png = readPng(join(root, "public/icons", name));
    const [r, g, b, alpha] = pixel(png, 0, 0);
    assert.equal(alpha, 255, `${name} must not have transparent corners`);
    assert.deepEqual([r, g, b], [115, 96, 213], `${name} should bleed its brand colour`);
  }
  // The regular icon keeps the favicon's rounded square.
  const standard = readPng(join(root, "public/icons/icon-512.png"));
  assert.equal(pixel(standard, 0, 0)[3], 0, "icon-512.png should be rounded");
  assert.deepEqual(pixel(standard, 256, 256).slice(0, 3), [255, 255, 255]);
});

test("every icon in public/icons is declared, and the 180px iOS icon exists", () => {
  const files = readdirSync(join(root, "public/icons")).sort();
  assert.deepEqual(
    files,
    [...manifest.icons.map((icon) => icon.src.replace("/icons/", "")), "apple-touch-icon.png"].sort(),
  );
  const apple = readPng(join(root, "public/icons/apple-touch-icon.png"));
  // iOS wants an opaque 180x180 image and applies its own mask.
  assert.equal(apple.width, 180);
  assert.equal(apple.height, 180);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
});

test("the committed icons are exactly what scripts/icons.mjs generates", () => {
  assert.deepEqual(check(), []);
  assert.equal(ICONS.length, 5);
});

test("the page links the manifest and allows it under both policies", () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  for (const meta of [
    "mobile-web-app-capable",
    "apple-mobile-web-app-capable",
    "apple-mobile-web-app-title",
  ])
    assert.match(html, new RegExp(`<meta name="${meta}"`));
  const metaPolicy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
    html,
  )[1];
  const header = config.headers
    .find((rule) => rule.source === "/(.*)")
    .headers.find((h) => h.key === "Content-Security-Policy").value;
  for (const policy of [metaPolicy, header])
    assert.match(
      policy,
      /manifest-src 'self'/,
      "the manifest is a same-origin file and must be allowed to load",
    );
});

test("the manifest and icons are revalidated or cached deliberately", () => {
  const cacheFor = (pathname) =>
    headersFor(config, pathname).get("cache-control")?.value;
  // A new deployment has to reach the browser: the manifest names the app.
  assert.match(cacheFor("/manifest.webmanifest"), /max-age=0, must-revalidate/);
  // Icons are unhashed, so they get a short cache rather than a year.
  assert.match(cacheFor("/icons/icon-192.png"), /max-age=86400/);
  assert.ok(!/immutable/.test(cacheFor("/icons/icon-192.png")));
});

test("the generated worker precaches the whole offline app", async () => {
  const { source, cache } = generateWorker();
  const worker = workerHarness(source);
  await worker.dispatch("install");
  assert.deepEqual([...worker.stores.keys()], [cache]);
  const files = [...worker.stores.get(cache).keys()].map((url) =>
    url.replace("https://still.example", ""),
  );
  for (const needed of [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/favicon.svg",
    "/jsqr-LICENSE.txt",
    "/icons/icon-192.png",
    "/icons/icon-maskable-512.png",
    "/assets/index-a.js",
    "/assets/qr-worker-a.js",
  ])
    assert.ok(files.includes(needed), `${needed} is not cached for offline use`);
  assert.ok(!files.some((file) => file.endsWith("sw.js")), "/sw.js is not app data");
  assert.match(cache, /^still-[0-9a-f]{16}$/);
});

test("a new build takes over and drops the previous cache", async () => {
  const { source, cache } = generateWorker();
  const worker = workerHarness(source);
  worker.stores.set("still-0000000000000000", new Map());
  worker.stores.set("other-app-123", new Map());
  await worker.dispatch("install");
  await worker.dispatch("activate");
  assert.ok(!worker.stores.has("still-0000000000000000"), "the old build must go");
  assert.ok(worker.stores.has(cache), "the current build stays");
  assert.ok(
    worker.stores.has("other-app-123"),
    "caches belonging to something else on the origin must be left alone",
  );
});

test("offline navigations are served the app, cached or not", async () => {
  const { source, cache } = generateWorker();
  const worker = workerHarness(source);
  await worker.dispatch("install");
  worker.goOffline();

  const home = await worker.dispatch("fetch", {
    request: worker.request("/", "navigate"),
  });
  assert.equal(home.response.from, undefined);
  assert.equal(home.response.url, "https://still.example/");

  // A deep link or bookmark is not in the cache: the shell answers instead, so
  // the installed app opens on any URL it was given rather than an error page.
  const deep = await worker.dispatch("fetch", {
    request: worker.request("/accounts/example?tab=backup", "navigate"),
  });
  assert.equal(deep.response.url, "https://still.example/index.html");
  assert.ok(
    worker.stores.get(cache).has("https://still.example/index.html"),
    "the app shell stays cached for the next navigation",
  );
});

test("offline requests for the app's files are answered from the cache", async () => {
  const { source } = generateWorker();
  const worker = workerHarness(source);
  await worker.dispatch("install");
  worker.goOffline();
  for (const asset of [
    "/assets/qr-worker-a.js",
    "/assets/index-a.js",
    "/manifest.webmanifest",
    "/icons/apple-touch-icon.png",
  ]) {
    const event = await worker.dispatch("fetch", {
      request: worker.request(asset),
    });
    assert.equal(event.response.url, `https://still.example${asset}`);
    assert.equal(event.response.from, undefined, `${asset} should come from the cache`);
  }
});

test("an uncached request falls through to the network and is never stored", async () => {
  const { source } = generateWorker();
  const worker = workerHarness(source);
  await worker.dispatch("install");
  const writesAfterInstall = worker.writes.length;
  // What a response body that may not be cached looks like: a backup export, a
  // vault read, or a request the app makes while unlocked.
  const response = await worker.dispatch("fetch", {
    request: worker.request("/still-backup-2026-10-14.json"),
  });
  assert.equal(response.response.from, "network");
  assert.deepEqual(worker.network, ["https://still.example/still-backup-2026-10-14.json"]);
  assert.equal(
    worker.writes.length,
    writesAfterInstall,
    "the fetch handler must not write anything into the cache",
  );
  // The worker has no runtime cache write of any kind: the offline copy is the
  // build's file list and nothing else can enter it.
  assert.ok(!/\.put\(|cache\.add\(|addAll\(\[/.test(source));
});

test("requests that are not this origin's files are left alone", async () => {
  const { source } = generateWorker();
  const worker = workerHarness(source);
  await worker.dispatch("install");
  const before = worker.network.length;
  for (const request of [
    { url: "https://elsewhere.example/app.js", mode: "no-cors", method: "GET" },
    { url: "https://still.example/api/accounts", mode: "cors", method: "POST" },
  ]) {
    const event = await worker.dispatch("fetch", { request });
    assert.equal(event.response, undefined, `${request.method} ${request.url} was intercepted`);
  }
  assert.equal(worker.network.length, before, "the worker made a request of its own");
});

test("a build without icons or a manifest still produces a working worker", async () => {
  // The Vite build copies public/, but a trimmed build must not break the
  // generator or the offline copy of the app shell.
  const { source, cache } = generateWorker({
    "dist/icons/icon-192.png": undefined,
    "dist/manifest.webmanifest": undefined,
  });
  const worker = workerHarness(source);
  await worker.dispatch("install");
  const files = [...worker.stores.get(cache).keys()].map((url) =>
    url.replace("https://still.example", ""),
  );
  assert.ok(files.includes("/index.html"));
  assert.ok(files.includes("/assets/index-a.js"));
  assert.ok(!files.some((file) => file.includes("manifest")));
});
