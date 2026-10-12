export const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export function b64(b) {
  const data = new Uint8Array(b);
  let text = "";
  for (let i = 0; i < data.length; i += 8192)
    text += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(text);
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function base32(s) {
  s = s.toUpperCase().replace(/[\s=-]/g, "");
  if (s.length > 1024 || !/^[A-Z2-7]+$/.test(s))
    throw Error(
      "Enter a valid Base32 secret key (letters A–Z and numbers 2–7).",
    );
  let bits = 0,
    value = 0,
    out = [];
  for (const c of s) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length < 10)
    throw Error("Secret keys must contain at least 80 bits.");
  return new Uint8Array(out);
}
export function encode32(data) {
  let b = 0,
    v = 0,
    s = "";
  for (const x of data) {
    v = (v << 8) | x;
    b += 8;
    while (b >= 5) {
      s += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(v >>> (b - 5)) & 31];
      b -= 5;
    }
  }
  if (b) s += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(v << (5 - b)) & 31];
  return s;
}
export function validateAccount(a) {
  if (!a || typeof a !== "object" || Array.isArray(a))
    throw Error("Invalid account.");
  for (const field of ["secret", "issuer", "name", "account"]) {
    if (a[field] != null && typeof a[field] !== "string")
      throw Error(`Account ${field} must be text.`);
  }
  if (a.type != null && String(a.type).toLowerCase() !== "totp")
    throw Error("Only time-based (TOTP) accounts are supported.");
  if (a.counter != null)
    throw Error("Counter-based (HOTP) accounts are not supported.");
  const secret = String(a.secret || "")
    .toUpperCase()
    .replace(/[\s=-]/g, "");
  const canonicalSecret = encode32(base32(secret));
  const algorithm = String(a.algorithm || "SHA1")
    .toUpperCase()
    .replaceAll("-", "");
  if (!["SHA1", "SHA256", "SHA512"].includes(algorithm))
    throw Error("Unsupported code algorithm.");
  const digits = Number(a.digits ?? 6),
    period = Number(a.period ?? 30);
  if (typeof a.digits === "boolean" || typeof a.period === "boolean")
    throw Error("Invalid numeric account settings.");
  if (
    ![6, 8].includes(digits) ||
    !Number.isInteger(period) ||
    period < 15 ||
    period > 120
  )
    throw Error("Use 6 or 8 digits and a period between 15 and 120 seconds.");
  const issuer = String(a.issuer || "Account")
      .trim()
      .slice(0, 100),
    name = String(a.name || a.account || "")
      .trim()
      .slice(0, 200);
  if (!name) throw Error("An account name or email is required.");
  return {
    id: crypto.randomUUID(),
    issuer,
    name,
    secret: canonicalSecret,
    algorithm,
    digits,
    period,
  };
}
export async function totp(a, time = Date.now()) {
  const counter = BigInt(Math.floor(time / 1000 / a.period));
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, counter);
  const k = await crypto.subtle.importKey(
    "raw",
    base32(a.secret),
    { name: "HMAC", hash: a.algorithm.replace("SHA", "SHA-") },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
  const o = mac.at(-1) & 15;
  const n =
    ((mac[o] & 127) << 24) |
    (mac[o + 1] << 16) |
    (mac[o + 2] << 8) |
    mac[o + 3];
  return String(n % 10 ** a.digits).padStart(a.digits, "0");
}
export async function encrypt(key, data) {
  const iv = bytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return { iv: b64(iv), ciphertext: b64(ciphertext) };
}
export async function decrypt(key, data) {
  if (
    !data ||
    typeof data.iv !== "string" ||
    typeof data.ciphertext !== "string" ||
    data.ciphertext.length > 7 * 1024 * 1024
  )
    throw Error("Invalid encrypted data.");
  const iv = unb64(data.iv),
    ciphertext = unb64(data.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16)
    throw Error("Invalid encrypted data.");
  const result = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(result));
}
export async function biometricKey(output, salt) {
  const material = await crypto.subtle.importKey("raw", output, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("still-vault-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function passwordKey(password, salt) {
  if (!(salt instanceof Uint8Array) || salt.length !== 32)
    throw Error("Invalid backup salt.");
  const m = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
    m,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export function parseUri(text) {
  const u = new URL(text.trim());
  if (u.protocol !== "otpauth:" || u.hostname !== "totp")
    throw Error("Only time-based otpauth://totp accounts are supported.");
  const label = decodeURIComponent(u.pathname.slice(1));
  const [prefix, ...rest] = label.split(":");
  return validateAccount({
    issuer: u.searchParams.get("issuer") || (rest.length ? prefix : "Account"),
    name: rest.length ? rest.join(":") : prefix,
    secret: u.searchParams.get("secret"),
    algorithm: u.searchParams.get("algorithm"),
    digits: u.searchParams.get("digits"),
    period: u.searchParams.get("period"),
  });
}
function protobuf(data) {
  let i = 0,
    fields = [];
  const varint = () => {
    let n = 0,
      s = 0;
    while (i < data.length && s < 35) {
      const b = data[i++];
      n += (b & 127) * 2 ** s;
      if (!(b & 128)) return n;
      s += 7;
    }
    throw Error("Invalid Google export.");
  };
  while (i < data.length) {
    const tag = varint(),
      type = tag & 7;
    let value;
    if (type === 0) value = varint();
    else if (type === 2) {
      const len = varint();
      if (i + len > data.length) throw Error("Truncated Google export.");
      value = data.slice(i, i + len);
      i += len;
    } else throw Error("Unsupported Google export.");
    fields.push([tag >>> 3, value]);
  }
  return fields;
}
export function parseMigration(text) {
  const u = new URL(text);
  if (u.protocol !== "otpauth-migration:")
    throw Error("Invalid migration URI.");
  const payload = u.searchParams.get("data");
  if (!payload) throw Error("Google export is missing account data.");
  const fields = protobuf(unb64(payload.replaceAll(" ", "+")));
  const batch = fields.find((f) => f[0] === 3)?.[1] || 1;
  if (batch > 1)
    throw Error(
      "This Google export contains multiple QR codes. Export accounts in one smaller batch at a time.",
    );
  if (fields.filter((f) => f[0] === 1).length > 1000)
    throw Error("Import up to 1,000 accounts at a time.");
  const decode = (x) => new TextDecoder().decode(x || new Uint8Array());
  return fields
    .filter((f) => f[0] === 1)
    .map(([, x]) => {
      const p = new Map(protobuf(x));
      if (p.get(6) !== 2)
        throw Error("Counter-based (HOTP) accounts are not supported.");
      const alg = { 1: "SHA1", 2: "SHA256", 3: "SHA512" }[p.get(4)];
      const digits = { 1: 6, 2: 8 }[p.get(5)];
      if (!alg || !digits) throw Error("Unsupported Google account settings.");
      if (!(p.get(1) instanceof Uint8Array))
        throw Error("Google export is missing a secret key.");
      return validateAccount({
        secret: encode32(p.get(1)),
        name: decode(p.get(2)),
        issuer: decode(p.get(3)),
        algorithm: alg,
        digits,
      });
    });
}
export function parseImport(text) {
  if (typeof text !== "string" || text.length > 5 * 1024 * 1024)
    throw Error("Import is too large or invalid.");
  text = text.trim();
  if (text.startsWith("otpauth-migration:")) return parseMigration(text);
  if (text.startsWith("otpauth:")) {
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length > 1000)
      throw Error("Import up to 1,000 accounts at a time.");
    return lines.map(parseUri);
  }
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.accounts;
  if (!Array.isArray(list) || list.length > 1000)
    throw Error("Expected a JSON array of accounts (up to 1,000).");
  return list.map(validateAccount);
}
