import { test } from "node:test";
import assert from "node:assert/strict";
import {
  totp,
  encode32,
  base32,
  validateAccount,
  parseImport,
  parseUri,
  encrypt,
  decrypt,
  passwordKey,
  biometricKey,
  bytes,
} from "../src/security.js";
const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
const vectors = {
  SHA1: [
    "94287082",
    "07081804",
    "14050471",
    "89005924",
    "69279037",
    "65353130",
  ],
  SHA256: [
    "46119246",
    "68084774",
    "67062674",
    "91819424",
    "90698825",
    "77737706",
  ],
  SHA512: [
    "90693936",
    "25091201",
    "99943326",
    "93441116",
    "38618901",
    "47863826",
  ],
};
for (const [algorithm, expected] of Object.entries(vectors))
  test(`RFC 6238 ${algorithm} test vectors`, async () => {
    const length = { SHA1: 20, SHA256: 32, SHA512: 64 }[algorithm];
    const secret = encode32(
      new TextEncoder().encode("1234567890".repeat(7).slice(0, length)),
    );
    for (let i = 0; i < times.length; i++)
      assert.equal(
        await totp(
          { secret, algorithm, digits: 8, period: 30 },
          times[i] * 1000,
        ),
        expected[i],
      );
  });
test("Base32 round trip", () => {
  const v = bytes(20);
  assert.deepEqual(base32(encode32(v)), v);
});
test("Rejects invalid and short keys", () => {
  assert.throws(() => base32("invalid018"));
  assert.throws(() => base32("ABC"));
});
test("Imports otpauth with custom parameters", () => {
  const a = parseUri(
    "otpauth://totp/Example:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60",
  );
  assert.equal(a.name, "me@example.com");
  assert.equal(a.algorithm, "SHA256");
  assert.equal(a.period, 60);
  assert.equal(a.digits, 8);
  assert.throws(() => parseUri("otpauth://hotp/name?secret=JBSWY3DPEHPK3PXP"));
});
test("Imports arrays and backup account envelopes", () => {
  const a = { name: "user", issuer: "Example", secret: "JBSWY3DPEHPK3PXP" };
  assert.equal(parseImport(JSON.stringify([a])).length, 1);
  assert.equal(
    parseImport(JSON.stringify({ accounts: [a] }))[0].issuer,
    "Example",
  );
  assert.throws(() => parseImport("{}"));
  assert.throws(() => validateAccount({ ...a, period: 0.5 }));
  assert.throws(() => validateAccount({ ...a, digits: 7 }));
});
test("AES encryption roundtrip and authentication", async () => {
  const salt = bytes(32),
    key = await biometricKey(bytes(32), salt);
  const data = { accounts: [{ secret: "not plaintext on disk" }] };
  const box = await encrypt(key, data);
  assert.deepEqual(await decrypt(key, box), data);
  assert.ok(!JSON.stringify(box).includes("plaintext"));
  const bad = await biometricKey(bytes(32), salt);
  await assert.rejects(() => decrypt(bad, box));
  box.ciphertext =
    (box.ciphertext[0] === "A" ? "B" : "A") + box.ciphertext.slice(1);
  await assert.rejects(() => decrypt(key, box));
});
test("Password backups require the correct password", async () => {
  const salt = bytes(32),
    key = await passwordKey("a long test password", salt);
  const box = await encrypt(key, { accounts: [] });
  assert.deepEqual(
    await decrypt(await passwordKey("a long test password", salt), box),
    { accounts: [] },
  );
  await assert.rejects(() =>
    passwordKey("incorrect password", salt).then((k) => decrypt(k, box)),
  );
});
test("Google migration imports TOTP and rejects multi-QR batches", () => {
  const enc = new TextEncoder();
  const field = (n, data) => [(n << 3) | 2, data.length, ...data];
  const account = [
    ...field(1, new Uint8Array(10).fill(1)),
    ...field(2, enc.encode("user@example.com")),
    ...field(3, enc.encode("Google")),
    32,
    1,
    40,
    1,
    48,
    2,
  ];
  const payload = Uint8Array.from([...field(1, account), 16, 1, 24, 1]);
  const uri =
    "otpauth-migration://offline?data=" +
    encodeURIComponent(Buffer.from(payload).toString("base64"));
  assert.equal(parseImport(uri)[0].issuer, "Google");
  payload[payload.length - 1] = 2;
  assert.throws(
    () =>
      parseImport(
        "otpauth-migration://offline?data=" +
          encodeURIComponent(Buffer.from(payload).toString("base64")),
      ),
    /multiple QR/,
  );
});

test("Rejects zero, boolean, HOTP, and malformed account settings", () => {
  const valid = { name: "test", secret: "JBSWY3DPEHPK3PXP" };
  for (const patch of [
    { period: 0 },
    { digits: 0 },
    { period: true },
    { digits: false },
    { secret: 1234 },
    { name: [] },
    { issuer: {} },
    { type: "hotp" },
    { counter: 0 },
  ]) {
    assert.throws(() => validateAccount({ ...valid, ...patch }));
  }
  assert.throws(() => parseImport("null"), /Expected a JSON array/);
  assert.throws(
    () => parseImport("otpauth-migration://offline"),
    /missing account data/,
  );
});

test("Large encrypted vault round trip does not exceed argument stack limits", async () => {
  const key = await biometricKey(bytes(32), bytes(32));
  const accounts = Array.from({ length: 1000 }, (_, i) =>
    validateAccount({
      name: `user${i}@example.com`,
      issuer: "Large vault test",
      secret: "JBSWY3DPEHPK3PXP",
    }),
  );
  const payload = { accounts };
  assert.ok(JSON.stringify(payload).length > 128 * 1024);
  const encrypted = await encrypt(key, payload);
  assert.deepEqual(await decrypt(key, encrypted), payload);
});

test("Validates encrypted payload and salt shapes before crypto operations", async () => {
  const key = await biometricKey(bytes(32), bytes(32));
  for (const payload of [
    null,
    {},
    { iv: 3, ciphertext: "abc" },
    { iv: "AA==", ciphertext: "AA==" },
  ]) {
    await assert.rejects(() => decrypt(key, payload), /Invalid encrypted data/);
  }
  await assert.rejects(
    () => passwordKey("password", new Uint8Array(1)),
    /Invalid backup salt/,
  );
});

test("Import limits apply to URI lists and JSON", () => {
  const uri = "otpauth://totp/user?secret=JBSWY3DPEHPK3PXP";
  assert.throws(() => parseImport(Array(1001).fill(uri).join("\n")), /1,000/);
  assert.throws(
    () => parseImport(JSON.stringify(Array(1001).fill({}))),
    /1,000/,
  );
  assert.throws(
    () => parseImport(" ".repeat(5 * 1024 * 1024 + 1)),
    /too large/,
  );
  assert.equal(parseImport(uri + "\n  \n" + uri).length, 2);
});
