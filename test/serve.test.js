// Tests for scripts/serve.py, the dependency-free static server used by the
// Docker image and by `npm run serve`.
//
// They run against a temporary fixture build, not dist/, so `npm test` works on
// a clean checkout. The whole file skips when no Python 3 interpreter is on the
// PATH (the application itself never needs Python).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import http from "node:http";

const SERVE = resolve(fileURLToPath(import.meta.url), "../../scripts/serve.py");

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && /Python 3\./.test(probe.stdout || ""))
      return candidate;
  }
  return null;
}

const python = findPython();
const skip = python
  ? false
  : "no Python 3 interpreter on PATH; skipping static server tests";

// Raw GET so the client does not normalize ".." away before sending it.
function rawRequest(port, { path, method = "GET", headers = {} }) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePromise(port));
    });
  });
}

async function startServer(
  directory,
  extraArgs = [],
  env = {},
  host = "127.0.0.1",
) {
  const port = await freePort();
  const child = spawn(
    python,
    [
      SERVE,
      "--host",
      host,
      "--port",
      String(port),
      "--dir",
      directory,
      ...extraArgs,
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } },
  );
  const log = [];
  child.stderr.on("data", (chunk) => log.push(chunk.toString()));
  child.stdout?.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200 || response.status === 503) break;
    } catch {}
    if (Date.now() > deadline)
      throw Error(`server never became ready on ${port}: ${log.join("")}`);
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return {
    port,
    base,
    process: child,
    log,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
    },
  };
}

// A miniature stand-in for `npm run build` output.
let fixture;
let empty;
let server;

before(async () => {
  if (!python) return;
  fixture = mkdtempSync(join(tmpdir(), "still-serve-"));
  empty = mkdtempSync(join(tmpdir(), "still-empty-"));
  mkdirSync(join(fixture, "assets"), { recursive: true });
  mkdirSync(join(fixture, "assets", "nested"), { recursive: true });
  writeFileSync(
    join(fixture, "index.html"),
    `<!doctype html><html><body>FIXTURE_SHELL<script type="module" src="/assets/index-abc123.js"></script></body></html>\n`,
  );
  writeFileSync(
    join(fixture, "assets", "index-abc123.js"),
    "export const fixture = 1;\n",
  );
  writeFileSync(
    join(fixture, "assets", "index-abc123.css"),
    "body{color:red}\n",
  );
  writeFileSync(
    join(fixture, "assets", "worker-def456.mjs"),
    "self.onmessage=null;\n",
  );
  writeFileSync(
    join(fixture, "sw.js"),
    "self.addEventListener('install',()=>{});\n",
  );
  writeFileSync(
    join(fixture, "favicon.svg"),
    "<svg xmlns='http://www.w3.org/2000/svg'/>\n",
  );
  writeFileSync(join(fixture, "jsqr-LICENSE.txt"), "Apache-2.0\n");
  server = await startServer(fixture, [
    "--allowed-hosts",
    "127.0.0.1,localhost",
  ]);
});

after(async () => {
  await server?.close();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  if (empty) rmSync(empty, { recursive: true, force: true });
});

test("serves the app shell with security headers", { skip }, async () => {
  const response = await fetch(`${server.base}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /FIXTURE_SHELL/);
  const headers = response.headers;
  assert.match(headers.get("content-type") || "", /^text\/html/);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(headers.get("permissions-policy") || "", /camera=\(\)/);
  // frame-ancestors cannot be set by a meta tag, so the server must send it.
  assert.match(
    headers.get("content-security-policy") || "",
    /frame-ancestors 'none'/,
  );
  assert.match(
    headers.get("content-security-policy") || "",
    /form-action 'none'/,
  );
  // HSTS stays off unless the operator asks for it (localhost/HTTP testing).
  assert.equal(headers.get("strict-transport-security"), null);
  // No interpreter banner leaks.
  assert.doesNotMatch(headers.get("server") || "", /Python/i);
});

test("serves /index.html identically to /", { skip }, async () => {
  const response = await fetch(`${server.base}/index.html`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /FIXTURE_SHELL/);
});

test(
  "types and caches content-hashed assets as immutable",
  { skip },
  async () => {
    const js = await fetch(`${server.base}/assets/index-abc123.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("content-type"), "text/javascript");
    assert.equal(
      js.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.match(await js.text(), /export const fixture/);

    const css = await fetch(`${server.base}/assets/index-abc123.css`);
    assert.equal(css.headers.get("content-type"), "text/css");
    assert.equal(
      css.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );

    // .mjs is unknown to the stdlib MIME table; a wrong type would block a worker.
    const mjs = await fetch(`${server.base}/assets/worker-def456.mjs`);
    assert.equal(mjs.headers.get("content-type"), "text/javascript");

    const svg = await fetch(`${server.base}/favicon.svg`);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    // Unhashed files stay short-lived so a redeploy replaces them.
    assert.match(svg.headers.get("cache-control") || "", /must-revalidate/);
    assert.doesNotMatch(svg.headers.get("cache-control") || "", /immutable/);
  },
);

test("revalidates the shell and the service worker", { skip }, async () => {
  for (const path of ["/", "/index.html", "/sw.js"]) {
    const response = await fetch(`${server.base}${path}`);
    assert.equal(
      response.headers.get("cache-control"),
      "no-cache, must-revalidate",
      `unexpected cache policy for ${path}`,
    );
  }
  const sw = await fetch(`${server.base}/sw.js`);
  assert.equal(sw.headers.get("content-type"), "text/javascript");
});

test(
  "answers a conditional request with 304 and keeps the connection alive",
  {
    skip,
  },
  async () => {
    const first = await rawRequest(server.port, { path: "/index.html" });
    assert.equal(first.status, 200);
    const lastModified = first.headers["last-modified"];
    assert.ok(lastModified, "expected a Last-Modified header");
    const second = await rawRequest(server.port, {
      path: "/index.html",
      headers: { "If-Modified-Since": lastModified },
    });
    assert.equal(second.status, 304);
    assert.equal(second.body, "");
  },
);

test("answers /healthz from memory", { skip }, async () => {
  const response = await fetch(`${server.base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  // The probe must not disclose the deployment path.
  assert.doesNotMatch(JSON.stringify(payload), /tmp|still-serve/);
});

test(
  "reports 503 when the served directory has no build",
  { skip },
  async () => {
    const broken = await startServer(empty);
    try {
      const response = await fetch(`${broken.base}/healthz`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).status, "missing-build");
    } finally {
      await broken.close();
    }
  },
);

test("never serves files outside the build directory", { skip }, async () => {
  const attempts = [
    "/../../../etc/passwd",
    "/..%2f..%2f..%2fetc%2fpasswd",
    "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/assets/../../../../etc/passwd",
    "/assets/..%2f..%2f..%2fetc%2fpasswd",
  ];
  for (const path of attempts) {
    const response = await rawRequest(server.port, { path });
    assert.ok(
      [301, 400, 404].includes(response.status),
      `expected ${path} to be rejected, got ${response.status}`,
    );
    assert.doesNotMatch(response.body, /root:.*:0:0:/);
  }
});

test("hides directory listings", { skip }, async () => {
  for (const path of ["/assets/", "/assets/nested/"]) {
    const response = await fetch(`${server.base}${path}`);
    assert.equal(response.status, 404, `expected ${path} to 404`);
    assert.doesNotMatch(await response.text(), /index-abc123\.js/);
  }
});

test("rejects a Host outside --allowed-hosts", { skip }, async () => {
  const rejected = await rawRequest(server.port, {
    path: "/",
    headers: { Host: "evil.example" },
  });
  assert.equal(rejected.status, 421);

  const allowed = await rawRequest(server.port, {
    path: "/",
    headers: { Host: "localhost" },
  });
  assert.equal(allowed.status, 200);

  const healthRejected = await rawRequest(server.port, {
    path: "/healthz",
    headers: { Host: "evil.example" },
  });
  assert.equal(healthRejected.status, 421);
});

test("allows GET, HEAD, and OPTIONS only", { skip }, async () => {
  const options = await rawRequest(server.port, {
    path: "/",
    method: "OPTIONS",
  });
  assert.equal(options.status, 204);
  assert.match(options.headers.allow || "", /GET/);

  const head = await rawRequest(server.port, { path: "/", method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.ok(Number(head.headers["content-length"]) > 0);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await rawRequest(server.port, { path: "/", method });
    assert.equal(response.status, 405, `expected ${method} to be refused`);
  }
});

test("404s unknown paths without caching them", { skip }, async () => {
  const response = await fetch(`${server.base}/definitely-missing.js`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-security-policy") || "",
    /frame-ancestors/,
  );
});

test("sends HSTS only when configured", { skip }, async () => {
  const hsts = await startServer(fixture, ["--hsts-max-age", "31536000"]);
  try {
    const response = await fetch(`${hsts.base}/`);
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  } finally {
    await hsts.close();
  }
});

test("honours a custom --csp header policy", { skip }, async () => {
  const custom = await startServer(fixture, [
    "--csp",
    "frame-ancestors 'none'",
  ]);
  try {
    const response = await fetch(`${custom.base}/`);
    assert.equal(
      response.headers.get("content-security-policy"),
      "frame-ancestors 'none'",
    );
  } finally {
    await custom.close();
  }
});

test(
  "--healthcheck probes a running server for container healthchecks",
  {
    skip,
  },
  () => {
    const healthy = spawnSync(
      python,
      [
        SERVE,
        "--host",
        "127.0.0.1",
        "--port",
        String(server.port),
        "--healthcheck",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(healthy.status, 0, healthy.stderr);

    const dead = spawnSync(
      python,
      [SERVE, "--host", "127.0.0.1", "--port", "1", "--healthcheck"],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(dead.status, 1);
  },
);

test("reads configuration from environment variables", { skip }, async () => {
  const configured = await startServer(fixture, [], {
    STILL_CSP: "frame-ancestors 'none'",
    STILL_HSTS_MAX_AGE: "600",
    STILL_ALLOWED_HOSTS: "127.0.0.1, env.example",
    STILL_QUIET: "1",
  });
  try {
    const response = await fetch(`${configured.base}/`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-security-policy"),
      "frame-ancestors 'none'",
    );
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=600; includeSubDomains",
    );
    const rejected = await rawRequest(configured.port, {
      path: "/",
      headers: { Host: "other.example" },
    });
    assert.equal(rejected.status, 421);
    // A falsy-looking value must not enable quiet mode by accident.
    const noisy = await startServer(fixture, [], { STILL_QUIET: "0" });
    try {
      await fetch(`${noisy.base}/index.html`);
      await new Promise((wait) => setTimeout(wait, 200));
      assert.match(noisy.log.join(""), /index\.html/);
    } finally {
      await noisy.close();
    }
  } finally {
    await configured.close();
  }
});

test(
  "accepts --host all as an alias for every interface",
  { skip },
  async () => {
    const wide = await startServer(fixture, [], {}, "all");
    try {
      const response = await fetch(`${wide.base}/healthz`);
      assert.equal(response.status, 200);
    } finally {
      await wide.close();
    }
  },
);

test(
  "--quiet suppresses successful requests but keeps errors",
  {
    skip,
  },
  async () => {
    const quiet = await startServer(fixture, ["--quiet"]);
    try {
      const ok = await fetch(`${quiet.base}/index.html`);
      assert.equal(ok.status, 200);
      const missing = await fetch(`${quiet.base}/absent.js`);
      assert.equal(missing.status, 404);
      await new Promise((wait) => setTimeout(wait, 200));
      const log = quiet.log.join("");
      assert.doesNotMatch(log, /index\.html/, "quiet mode logged a 200");
      assert.match(log, /absent\.js/, "quiet mode dropped a 404");
    } finally {
      await quiet.close();
    }
  },
);

test("refuses to start for a missing build directory", { skip }, () => {
  const result = spawnSync(
    python,
    [
      SERVE,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--dir",
      join(fixture, "nope"),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Directory not found/);
});
