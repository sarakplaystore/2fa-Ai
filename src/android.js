import { unb64 } from "./security.js";

// The website does not instantiate this bridge. An APK missing the native
// interface fails closed rather than falling back to a weaker unlock method.
export function createAndroidBridge(native, host, timeoutMs = 130000) {
  let sequence = 0;
  const pending = new Map();

  Object.defineProperty(host, "__stillAndroidResult", {
    value(id, value, message) {
      const request = pending.get(id);
      if (!request) return; // Late reply after timeout or an obsolete page.
      pending.delete(id);
      clearTimeout(request.timer);
      if (message) request.reject(Error(message));
      else request.resolve(value);
    },
  });

  function call(method, ...args) {
    if (typeof native?.[method] !== "function")
      return Promise.reject(Error("Android device verification is unavailable."));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Android request timed out. Please try again."));
      }, timeoutMs);
      pending.set(id, { timer, resolve, reject });
      try {
        native[method](id, ...args);
      } catch (e) {
        host.__stillAndroidResult(id, null, e.message || "Android request failed.");
      }
    });
  }

  return {
    async authenticate(creating) {
      const encoded = await call("authenticate", creating);
      if (typeof encoded !== "string") throw Error("Invalid device response.");
      const secret = unb64(encoded);
      if (secret.length !== 32) throw Error("Invalid device key.");
      return secret;
    },
    async saveBackup(filename, encryptedJson) {
      await call("saveBackup", filename, encryptedJson);
    },
    async copyCode(code) {
      if (!/^\d{6}(?:\d{2})?$/.test(code))
        throw Error("Invalid verification code.");
      await call("copyCode", code);
    },
    async clearKey() {
      await call("clearKey");
    },
  };
}
