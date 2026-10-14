// Generates the app icons used by the web app manifest and by iOS' home
// screen. Nothing is downloaded and no image library is used: the mark from
// public/favicon.svg is rasterised here and written as PNG with Node's zlib.
// Output is deterministic, so the committed files can be checked byte for byte
// with `node scripts/icons.mjs --check` (what the offline tests run).
//
//   npm run icons            rewrite public/icons
//   npm run icons -- --check verify the committed files without writing
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const ICON_DIR = join(ROOT, "public", "icons");

// Brand colours, taken from public/favicon.svg.
const BRAND = [115, 96, 213];
const WHITE = [255, 255, 255];

// The mark: three round-capped bars on a 48-unit grid, exactly the path in
// favicon.svg ("M16 15v18m8-24v30m8-24v18", stroke-width 4, round caps).
const BARS = [
  [16, 15, 33],
  [24, 9, 39],
  [32, 15, 33],
];
const BAR_RADIUS = 2;
const MARK_BOX = 48;
const APP_RADIUS = 14;
// 4x4 samples per pixel: enough to make the curves and the round caps smooth
// without a blur pass.
const SAMPLES = 4;

// Every icon the app ships. `bleed` fills the whole canvas (maskable icons and
// the iOS touch icon, which the platform masks itself); `art` scales the mark
// about the centre so it stays inside a maskable icon's safe zone.
export const ICONS = [
  { file: "icon-192.png", size: 192, bleed: false, art: 1 },
  { file: "icon-512.png", size: 512, bleed: false, art: 1 },
  { file: "icon-maskable-192.png", size: 192, bleed: true, art: 0.72 },
  { file: "icon-maskable-512.png", size: 512, bleed: true, art: 0.72 },
  { file: "apple-touch-icon.png", size: 180, bleed: true, art: 0.78 },
];

const insideRounded = (x, y, size, radius) => {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius <= 0;
};

// In viewBox units, so the mark keeps the favicon's proportions at any size.
const insideCapsule = (x, y, [cx, top, bottom]) => {
  const t = Math.max(0, Math.min(1, (y - top) / (bottom - top)));
  return Math.hypot(x - cx, y - (top + t * (bottom - top))) <= BAR_RADIUS;
};

// Rasterises one icon and returns non-premultiplied RGBA pixels.
export function rasterise({ size, bleed, art }) {
  const pixels = new Uint8Array(size * size * 4);
  const center = size / 2;
  const radius = bleed ? 0 : (APP_RADIUS / MARK_BOX) * size;
  // Canvas pixels per viewBox unit. `art` shrinks the mark about the centre so
  // a maskable icon can be cropped to a circle without cutting the mark.
  const scale = (size / MARK_BOX) * art;
  const step = 1 / SAMPLES;
  const offset = step / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let background = 0;
      let ink = 0;
      for (let sy = 0; sy < SAMPLES; sy++)
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + offset + sx * step;
          const py = y + offset + sy * step;
          if (!bleed && !insideRounded(px, py, size, radius)) continue;
          background++;
          const markX = MARK_BOX / 2 + (px - center) / scale;
          const markY = MARK_BOX / 2 + (py - center) / scale;
          if (BARS.some((bar) => insideCapsule(markX, markY, bar))) ink++;
        }
      const total = SAMPLES * SAMPLES;
      const alpha = background / total;
      if (!alpha) continue;
      const inkRatio = ink / total;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++)
        pixels[i + c] = Math.round(
          BRAND[c] * (1 - inkRatio) + WHITE[c] * inkRatio,
        );
      pixels[i + 3] = Math.round(alpha * 255);
    }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer)
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

// PNG rows, each prefixed with filter type 0 (None): no predictors, so the
// whole image is just the pixels and stays reproducible across zlib versions.
export function scanlines(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  return raw;
}

export function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines(pixels, size), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const renderIcon = (icon) => {
  const pixels = rasterise(icon);
  return { pixels, png: encodePng(pixels, icon.size) };
};

// Reads back a committed icon far enough to check it: size, colour type and the
// unfiltered pixel rows.
export function readPng(file) {
  const data = readFileSync(file);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => data[i] === byte))
    throw Error(`${file} is not a PNG file.`);
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR")
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
      };
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (!header) throw Error(`${file} has no IHDR chunk.`);
  return { ...header, raw: inflateSync(Buffer.concat(idat)) };
}

const write = () => {
  mkdirSync(ICON_DIR, { recursive: true });
  for (const icon of ICONS)
    writeFileSync(join(ICON_DIR, icon.file), renderIcon(icon).png);
  console.log(
    `Wrote ${ICONS.length} icons to public/icons: ${ICONS.map((i) => i.file).join(", ")}`,
  );
};

// Regenerates every icon in memory and compares it with the committed file.
// Differences are reported instead of thrown so the tests can show all of them.
export const check = () => {
  const problems = [];
  for (const icon of ICONS) {
    const file = join(ICON_DIR, icon.file);
    const expected = scanlines(rasterise(icon), icon.size);
    let actual;
    try {
      actual = readPng(file);
    } catch (error) {
      problems.push(`${icon.file}: ${error.message}`);
      continue;
    }
    if (actual.width !== icon.size || actual.height !== icon.size)
      problems.push(
        `${icon.file}: is ${actual.width}x${actual.height}, expected ${icon.size}x${icon.size}`,
      );
    else if (actual.colorType !== 6 || actual.depth !== 8)
      problems.push(`${icon.file}: expected 8-bit RGBA pixels`);
    else if (actual.raw.length !== expected.length)
      problems.push(`${icon.file}: pixel data has the wrong length`);
    else if (!actual.raw.equals(expected))
      problems.push(
        `${icon.file}: pixels differ from scripts/icons.mjs — run \`npm run icons\``,
      );
  }
  return problems;
};

const main = (argv) => {
  if (argv.includes("--check")) {
    const problems = check();
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else console.log(`Icons match scripts/icons.mjs (${ICONS.length} files).`);
    return;
  }
  write();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
