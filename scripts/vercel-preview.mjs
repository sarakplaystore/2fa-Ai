// Local stand-in for Vercel's static serving, so the routing and response
// headers declared in vercel.json can be checked before deploying.
//
// It is an approximation for local use, not a reimplementation of Vercel's
// edge network: it reads the same `rewrites` and `headers` rules, serves the
// production build from disk, and otherwise does nothing. Vercel's own
// behaviour is authoritative.
//
// Usage: node scripts/vercel-preview.mjs [--port 4173] [--host 0.0.0.0]
//        [--strict] [dist]
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

// Vercel's `source` patterns are anchored to the whole pathname, so the same
// holds here. A pattern that is not valid as a regex is compared literally.
export function matchSource(source, pathname) {
  try {
    return new RegExp(`^(?:${source})$`).test(pathname);
  } catch {
    return source === pathname;
  }
}

// Vercel merges the headers of every matching rule and lets the last match win
// for a repeated key, which is why the rules in vercel.json are ordered from
// general to specific.
export function headersFor(config, pathname) {
  const merged = new Map();
  for (const rule of config.headers ?? [])
    if (matchSource(rule.source, pathname))
      for (const { key, value } of rule.headers ?? [])
        merged.set(key.toLowerCase(), { key, value, source: rule.source });
  return merged;
}

// Embedded previews (Arena and similar) render the app in a cross-origin
// iframe, which `frame-ancestors 'none'` and `X-Frame-Options: DENY` would
// leave blank. The deployment keeps both; this server drops them unless
// --strict asks for the exact deployed response.
export function relaxFraming(headers) {
  const relaxed = {};
  for (const [name, { key, value }] of headers) {
    if (name === "x-frame-options") continue;
    relaxed[key] =
      name === "content-security-policy"
        ? value.replace(/;\s*frame-ancestors[^;]*/i, "")
        : value;
  }
  return relaxed;
}

const plainHeaders = (headers) =>
  Object.fromEntries(
    [...headers.values()].map(({ key, value }) => [key, value]),
  );

// Filesystem first, then the first matching rewrite, exactly like Vercel.
// `fileFor` returns a path on disk or null.
export function resolveRequest(config, pathname, fileFor) {
  const direct = fileFor(pathname);
  if (direct) return { kind: "file", file: direct };
  for (const rule of config.rewrites ?? []) {
    if (!matchSource(rule.source, pathname)) continue;
    const file = fileFor(rule.destination);
    if (file) return { kind: "rewrite", file, rule };
  }
  return { kind: "not-found", file: null };
}

const USAGE = `Usage: node scripts/vercel-preview.mjs [dist] [--port 4173] [--host 0.0.0.0] [--strict]

Serves the production build with the routing and headers from vercel.json.
  --port, --host  where to listen (defaults: 4173 on all interfaces)
  --strict        send the deployment's exact headers, frame-ancestors included`;

const parseArgs = (argv) => {
  const options = { host: process.env.HOST ?? "0.0.0.0", root: "dist" };
  options.port = Number(process.env.PORT ?? 4173);
  options.strict = false;
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === "--port") options.port = Number(argv[++i]);
    else if (argv[i] === "--host") options.host = argv[++i];
    else if (argv[i] === "--strict") options.strict = true;
    else options.root = argv[i];
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw Error(`Invalid port: ${options.port}`);
  return options;
};

const start = (options) => {
  const root = resolve(options.root);
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));

  // Resolves a request path to a file inside the build output, rejecting
  // anything that escapes it.
  const fileFor = (pathname) => {
    if (pathname.includes("\0")) return null;
    const file = resolve(
      root,
      "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname),
    );
    if (file !== root && !file.startsWith(root + sep)) return null;
    try {
      const stats = statSync(file, { throwIfNoEntry: false });
      return stats?.isFile() ? file : null;
    } catch {
      return null;
    }
  };

  if (!fileFor("/"))
    throw Error(`${root}/index.html is missing. Run \`npm run build\` first.`);

  const server = createServer((request, response) => {
    const reject = (status, message) => {
      console.log(`${request.method} ${request.url} -> ${status}`);
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(message);
    };
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
    } catch {
      return reject(400, "400 BAD_REQUEST\n");
    }
    if (pathname.includes("\0")) return reject(400, "400 BAD_REQUEST\n");
    const result = resolveRequest(config, pathname, fileFor);
    const configured = headersFor(config, pathname);
    const headers = options.strict
      ? plainHeaders(configured)
      : relaxFraming(configured);
    if (result.kind === "not-found") {
      console.log(`${request.method} ${pathname} -> 404 (no rule matched)`);
      response.writeHead(404, {
        ...headers,
        "Content-Type": "text/plain; charset=utf-8",
      });
      return response.end("404 NOT_FOUND\n");
    }
    const body = statSync(result.file).size;
    console.log(
      `${request.method} ${pathname} -> 200 ${result.kind}${
        result.kind === "rewrite" ? ` ${result.rule.destination}` : ""
      }${headers["Cache-Control"] ? ` [${headers["Cache-Control"]}]` : ""}`,
    );
    response.writeHead(200, {
      ...headers,
      "Content-Type":
        TYPES[extname(result.file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body,
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(result.file).pipe(response);
  });

  server.listen(options.port, options.host, () => {
    console.log(`Serving ${root} on http://${options.host}:${options.port}`);
    if (!options.strict) {
      console.log("Anti-framing headers dropped so embedded previews render.");
      console.log("Pass --strict for the deployment's exact headers.");
    }
    console.log("Effective response headers (vercel.json rules):");
    for (const pathname of ["/", "/index.html", "/assets/app.js", "/sw.js"]) {
      const configured = headersFor(config, pathname);
      const headers = options.strict
        ? plainHeaders(configured)
        : relaxFraming(configured);
      console.log(
        `  ${pathname}\n${Object.entries(headers)
          .map(([key, value]) => `    ${key}: ${value}`)
          .join("\n")}`,
      );
    }
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) console.log(USAGE);
  else
    try {
      start(parseArgs(argv));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
