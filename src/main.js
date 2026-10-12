import { readQrImage } from "./qr.js";
import "./style.css";
import {
  bytes,
  b64,
  unb64,
  biometricKey,
  encrypt,
  decrypt,
  passwordKey,
  validateAccount,
  totp,
  parseImport,
} from "./security.js";
const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M8 12l3 3 5-6",
  lock: "M6 10h12v11H6z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3",
  plus: "M12 5v14 M5 12h14",
  arrow: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  export: "M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  face: "M8 3H4v4 M16 3h4v4 M20 17v4h-4 M8 21H4v-4 M8 9v2 M16 9v2 M9 16q3 3 6 0 M12 9v5h-1",
  clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  info: "M12 11v6 M12 7v1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  close: "m6 6 12 12 M6 18 18 6",
  copy: "M8 8h12v13H8z M16 8V3H3v13h5",
  gear: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  trash: "M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  offline: "M3 3l18 18 M2 8q9-8 20 0 M5 12q3-3 7-3 M8 16q4-4 8 0 M12 20h.01",
  file: "M14 2H5v20h14V7z M14 2v6h5",
  key: "M14 7a5 5 0 1 1-4-4 M10 10l-7 7v4h4v-3h3l3-3",
};
const icon = (n, c = "") =>
  `<svg class="icon ${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n] || paths.shield}"/></svg>`;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const STORAGE = "still.vault.v1";
let vault = null,
  key = null,
  accounts = [],
  page = "accounts",
  search = "",
  revealed = new Set(),
  idleTimer,
  codeEpoch = 0;
try {
  vault = JSON.parse(localStorage.getItem(STORAGE) || "null");
} catch {}
const unlocked = () => !!key;
const app = document.querySelector("#app");
function render() {
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="#" aria-label="Still home"><span class="brand-mark"><i></i><i></i><i></i></span>still<span class="brand-dot">.</span></a><div class="workspace"><span class="workspace-icon">${icon("lock")}</span><div>Personal vault<small>ON THIS DEVICE</small></div><span class="status-dot"></span></div><div class="nav-label">WORKSPACE</div><nav><button data-page="accounts" class="${page === "accounts" ? "active" : ""}">${icon("grid")}Authenticator<span class="nav-count">${unlocked() ? accounts.length : "—"}</span></button><button data-action="import">${icon("arrow")}Import accounts</button><button data-action="export">${icon("export")}Export backup</button><div class="nav-divider"></div><button data-page="security" class="${page === "security" ? "active" : ""}">${icon("shield")}Security & privacy</button><button data-page="settings" class="${page === "settings" ? "active" : ""}">${icon("gear")}Settings</button></nav><div class="sidebar-bottom"><div class="local-note"><span class="local-icon">${icon("offline")}</span><strong>Offline. By design.</strong><p>No accounts. No cloud.<br>Just you and your keys.</p><button data-page="security">Our privacy promise ${icon("chevron")}</button></div><div class="version"><span class="tiny-mark">|||</span> STILL AUTHENTICATOR <span>v1.0</span></div></div></aside><div class="shell"><header><div class="breadcrumb">Personal vault ${icon("chevron")} <span>${page === "accounts" ? "Authenticator" : page === "security" ? "Security & privacy" : "Settings"}</span></div><div class="header-right"><span class="local-pill"><span></span> Local only</span><button class="lock-button" data-action="${unlocked() ? "lock" : "unlock"}">${icon("lock")} ${unlocked() ? "Lock vault" : "Vault locked"}</button><span class="avatar">${icon("shield")}</span></div></header><main>${page === "accounts" ? accountsPage() : page === "security" ? securityPage() : settingsPage()}</main><footer><span>${icon("shield")} Your secrets never leave this device unless you export them.</span><span>Made for peace of mind <span class="footer-dot">✦</span></span></footer></div><div id="toast" role="status"></div><dialog id="modal"></dialog>`;
  bind();
  if (unlocked()) updateCodes();
}
function accountsPage() {
  return `<div class="page-heading"><div><div class="eyebrow">A LITTLE MORE PEACE OF MIND</div><h1>Your authenticator</h1><p>A safe, quiet home for your two-factor codes.</p></div><button class="button primary" data-action="add">${icon("plus")} Add account</button></div>${!unlocked() ? `<section class="welcome"><div class="welcome-copy"><span class="mini-label">${icon("shield")} PRIVATE BY DEFAULT</span><h2>Your codes.<br>Only yours<span>.</span></h2><p>All your accounts, protected on your device.<br>No syncing. No tracking. No looking over your shoulder.</p><button class="button primary" data-action="unlock">${icon("face")} ${vault ? "Unlock your vault" : "Set up your private vault"} ${icon("chevron")}</button><small>${icon("lock")} ${vault ? "Verify with your device to access your codes." : "Protected with your device’s built-in verification."}</small></div><div class="vault-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-dot dot-one"></div><div class="art-dot dot-two"></div><div class="floating-pill">${icon("check")} Stays on your device</div><div class="vault-graphic"><div class="vault-inner">${icon("face")}</div><span class="vault-light"></span><div class="vault-lines"><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="floating-lock">${icon("lock")}</div><div class="art-caption">A PRIVATE SPACE, JUST FOR YOU</div></div></section>` : `<section class="unlocked-banner"><span class="banner-icon">${icon("shield")}</span><div><strong>Your vault is unlocked</strong><p>Codes stay hidden until you reveal them. Your vault locks when you leave this tab.</p></div><span class="verified">${icon("check")} Device verified</span></section>`}<section class="accounts-section"><div class="section-heading"><h3>Your accounts <span>${unlocked() ? accounts.length : 0}</span></h3><div class="account-tools"><div class="search-box">${icon("search")}<input id="search" placeholder="Search accounts…" value="${esc(search)}" aria-label="Search accounts" ${!unlocked() ? "disabled" : ""}></div><button class="icon-button" data-action="privacy" title="Hide all codes" aria-label="Hide all codes">${icon("eye")}</button></div></div><div id="account-list">${accountList()}</div></section><div class="feature-grid"><div>${icon("face")}<h4>Your device. Your identity.</h4><p>Unlock with your device’s secure<br>biometric or PIN verification.</p></div><div>${icon("offline")}<h4>100% local storage</h4><p>Encrypted on this browser.<br>No servers holding your secrets.</p></div><div>${icon("arrow")}<h4>Bring your accounts along</h4><p>Import existing accounts and keep<br>an encrypted backup in your hands.</p></div></div><div class="bottom-tip">${icon("info")} <span>A little tip: keep an encrypted backup somewhere safe. Local means we can’t recover your vault.</span><button data-action="help">Learn more ${icon("chevron")}</button></div>`;
}
function accountList() {
  if (!unlocked() || !accounts.length)
    return `<div class="empty-state"><div class="empty-icon">${icon(vault && !unlocked() ? "lock" : "grid")}<span>+</span></div><h3>${vault && !unlocked() ? "Your accounts are safely tucked away" : "A fresh start for your security"}</h3><p>${vault && !unlocked() ? "Unlock your vault to see your accounts and verification codes." : "Add your first account to keep your sign-ins a little safer."}</p><div><button class="button secondary" data-action="${vault && !unlocked() ? "unlock" : "add"}">${icon(vault && !unlocked() ? "face" : "plus")} ${vault && !unlocked() ? "Unlock vault" : "Add your first account"}</button>${!vault || unlocked() ? '<span class="or">or</span><button class="text-button" data-action="import">Import existing accounts →</button>' : ""}</div><span class="compatibility">Works with services that support authenticator apps</span></div>`;
  const filtered = accounts.filter((a) =>
    (a.name + " " + a.issuer).toLowerCase().includes(search.toLowerCase()),
  );
  if (!filtered.length)
    return '<div class="no-results">No accounts match your search.</div>';
  return `<div class="code-grid">${filtered.map((a) => `<article class="account-card"><div class="account-card-head"><span class="service-icon" style="--service-hue:${[...a.issuer].reduce((n, c) => n + c.charCodeAt(0), 0) % 360}">${esc(a.issuer.slice(0, 1).toUpperCase())}</span><div><h4>${esc(a.issuer)}</h4><p>${esc(a.name)}</p></div><button class="icon-button delete-account" data-id="${a.id}" title="Remove account" aria-label="Remove ${esc(a.issuer)}">${icon("trash")}</button></div><div class="code-line"><button class="code-value" data-reveal="${a.id}" aria-label="Reveal or hide code for ${esc(a.issuer)}">••• •••</button><button class="icon-button copy-code" data-id="${a.id}" title="Copy code" aria-label="Copy ${esc(a.issuer)} code">${icon("copy")}</button></div><div class="code-meta"><span>${icon("clock")} <span data-timer="${a.id}"></span></span><button class="text-button" data-reveal="${a.id}">${revealed.has(a.id) ? "Hide code" : "Reveal code"}</button></div><div class="time-bar"><i data-bar="${a.id}"></i></div></article>`).join("")}</div>`;
}
function securityPage() {
  return `<div class="page-heading"><div><div class="eyebrow">NOTHING TO HIDE. EVERYTHING TO PROTECT.</div><h1>Security & privacy</h1><p>Your keys belong to you. Here’s how we keep it that way.</p></div>${icon("shield", "heading-icon")}</div><div class="info-grid">${[
    [
      "lock",
      "Encrypted at rest",
      "Your vault is encrypted using AES-256-GCM. The key comes from your device credential using WebAuthn PRF and HKDF. We never store a plaintext vault key.",
    ],
    [
      "face",
      "Device verification, not face storage",
      "Still never takes a face photo. Your operating system verifies you with its available biometrics or PIN. We cannot enforce face-only authentication, and some passkey providers may sync credentials.",
    ],
    [
      "offline",
      "No application network requests",
      "No analytics, remote APIs, external fonts, or cloud account. Production assets are cached for offline use after the first visit. Opening this hosted site initially still requires a network connection.",
    ],
    [
      "eye",
      "Protection from nearby eyes",
      "Codes are hidden by default. The vault locks when the tab is hidden, the window loses focus, or after two minutes of inactivity. Press Escape to lock instantly.",
    ],
    [
      "export",
      "Backups you control",
      "Exports are password-encrypted with AES-256-GCM and PBKDF2-SHA256 (600,000 iterations). Keep a backup and its password somewhere safe. There is no recovery service.",
    ],
    [
      "info",
      "Know the boundaries",
      "A compromised device, malicious browser extension, or someone with your device PIN may still access your data. Software cannot protect against mind reading; these controls address observable digital risks.",
    ],
  ]
    .map(
      ([i, t, p]) =>
        `<section class="info-card">${icon(i)}<h3>${t}</h3><p>${p}</p></section>`,
    )
    .join("")}</div>`;
}
function settingsPage() {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR SPACE, YOUR RULES</div><h1>Vault settings</h1><p>Simple defaults. Strong protection.</p></div></div><section class="settings-card"><h3>Privacy defaults</h3><div class="setting-row"><div><strong>Hide verification codes</strong><p>Reveal individual codes only when you need them.</p></div><span class="setting-value">Always on ${icon("check")}</span></div><div class="setting-row"><div><strong>Lock when you leave</strong><p>Moving to another tab or window locks your vault.</p></div><span class="setting-value">Always on ${icon("check")}</span></div><div class="setting-row"><div><strong>Inactivity lock</strong><p>Automatically clear the unlocked vault from memory.</p></div><span class="setting-value">2 minutes</span></div><div class="setting-row"><div><strong>Encrypted backup</strong><p>Back up before clearing browser data or moving devices.</p></div><button class="button secondary" data-action="export">${icon("export")} Export</button></div></section><section class="settings-card danger-zone"><h3>Delete local vault</h3><p>This permanently removes this browser’s encrypted vault. Your device credential is managed separately in your device settings.</p><button class="button danger" data-action="reset">Delete vault from this browser</button></section>`;
}
function bind() {
  document.querySelectorAll("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page;
        render();
      }),
  );
  document
    .querySelectorAll("[data-action]")
    .forEach((b) => (b.onclick = () => action(b.dataset.action)));
  const s = document.querySelector("#search");
  if (s)
    s.oninput = () => {
      search = s.value;
      document.querySelector("#account-list").innerHTML = accountList();
      bindCards();
      updateCodes();
    };
  bindCards();
}
function bindCards() {
  document.querySelectorAll("[data-reveal]").forEach(
    (b) =>
      (b.onclick = () => {
        const id = b.dataset.reveal;
        revealed.has(id) ? revealed.delete(id) : revealed.add(id);
        document.querySelector("#account-list").innerHTML = accountList();
        bindCards();
        updateCodes();
      }),
  );
  document.querySelectorAll(".copy-code").forEach(
    (b) =>
      (b.onclick = async () => {
        const epoch = codeEpoch,
          a = accounts.find((a) => a.id === b.dataset.id);
        try {
          const code = await totp(a);
          if (epoch !== codeEpoch || !key) return;
          await navigator.clipboard.writeText(code);
          toast("Code copied. Your clipboard is not automatically cleared.");
        } catch {
          toast("Copy unavailable. Reveal the code instead.");
        }
      }),
  );
  document
    .querySelectorAll(".delete-account")
    .forEach((b) => (b.onclick = () => deleteAccount(b.dataset.id)));
}
function toast(t) {
  const e = document.querySelector("#toast");
  e.textContent = t;
  e.classList.add("visible");
  setTimeout(() => e.classList.remove("visible"), 4500);
}
function modal(title, body) {
  const d = document.querySelector("#modal");
  d.innerHTML = `<div class="modal-top"><h2>${title}</h2><button class="icon-button" id="close-modal" aria-label="Close">${icon("close")}</button></div>${body}<p id="form-error" class="form-error" role="alert"></p>`;
  d.showModal();
  document.querySelector("#close-modal").onclick = () => d.close();
  d.onclick = (e) => {
    if (e.target === d) d.close();
  };
  return d;
}
function error(e) {
  const target = document.querySelector("#form-error");
  if (target) target.textContent = e.message || String(e);
  else toast(e.message || String(e));
}
function action(a) {
  if (a === "lock") return lock();
  if (a === "unlock") return unlockDialog();
  if (a === "help")
    return modal(
      "A backup is your safety net",
      `<p class="modal-description">Your vault is tied to this browser origin and your device credential. Clearing browser data, losing the credential, or changing the site address can make it inaccessible.</p><div class="callout">After adding accounts, export an encrypted backup. Keep it on a trusted offline drive. You’ll need your backup password to restore it to a new vault.</div><p class="modal-description">Never share setup keys, QR codes, or backup passwords. If a device is lost, use recovery codes from each service.</p>`,
    );
  if (a === "privacy") {
    revealed.clear();
    render();
    toast("All verification codes are hidden.");
    return;
  }
  if (!unlocked()) return unlockDialog(a);
  if (a === "add") addDialog();
  if (a === "import") importDialog();
  if (a === "export") exportDialog();
  if (a === "reset") resetDialog();
}
function unlockDialog(next) {
  if (unlocked()) return;
  modal(
    vault ? "Welcome back" : "A private vault starts here",
    `<div class="modal-emblem">${icon("face")}</div><p class="modal-description">${vault ? "Verify with the device credential you used to create this vault." : "Register your device’s secure credential. Your face or fingerprint stays with your operating system, never with Still."}</p><div class="callout"><strong>A note about compatibility</strong><br>This requires a secure browser and an authenticator with WebAuthn PRF support. Your device may offer a fingerprint or PIN instead of face verification. There is no less-secure fallback.</div><button id="verify" class="button primary full">${icon("face")} ${vault ? "Verify & unlock" : "Register device & create vault"}</button><p class="fine-print">Keep this site address unchanged. Credentials are bound to this origin. If verification is blocked inside a preview, open the app in its own browser tab.</p>`,
  );
  document.querySelector("#verify").onclick = async () => {
    const b = document.querySelector("#verify");
    b.disabled = true;
    b.textContent = "Waiting for your device…";
    try {
      await authenticate();
      if (document.hidden) {
        lock();
        return;
      }
      document.querySelector("#modal").close();
      render();
      resetIdle();
      if (next) action(next);
    } catch (e) {
      error(
        e.name === "NotAllowedError"
          ? Error(
              "Verification was canceled or is unavailable. Try a supported device and browser.",
            )
          : e,
      );
      b.disabled = false;
      b.textContent = vault ? "Try unlocking again" : "Try registration again";
    }
  };
}
let verifying = false,
  selectingFile = false;
async function authenticate() {
  if (!window.isSecureContext || !window.PublicKeyCredential)
    throw Error(
      "Secure device verification is unavailable in this browser. Use HTTPS and a supported browser.",
    );
  verifying = true;
  try {
    let record = vault;
    let credential;
    if (!record) {
      const salt = bytes(32);
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: bytes(32),
          rp: { name: "Still Authenticator" },
          user: {
            id: bytes(32),
            name: "still-local-vault",
            displayName: "Still private vault",
          },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            userVerification: "required",
          },
          extensions: { prf: { eval: { first: salt } } },
          timeout: 120000,
        },
      });
      if (!credential) throw Error("No credential was created.");
      record = {
        version: 1,
        credentialId: b64(credential.rawId),
        salt: b64(salt),
      };
    }
    let prf = credential?.getClientExtensionResults()?.prf?.results?.first;
    if (!prf) {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: bytes(32),
          allowCredentials: [
            { id: unb64(record.credentialId), type: "public-key" },
          ],
          userVerification: "required",
          extensions: { prf: { eval: { first: unb64(record.salt) } } },
          timeout: 120000,
        },
      });
      prf = assertion?.getClientExtensionResults()?.prf?.results?.first;
    }
    if (!prf)
      throw Error(
        "This device credential does not support PRF encryption. No vault was unlocked or created. Use a PRF-capable browser and authenticator.",
      );
    const candidate = await biometricKey(prf, unb64(record.salt));
    let data = vault ? await decrypt(candidate, record.sealed) : [];
    if (!Array.isArray(data)) throw Error("Invalid vault.");
    data = data.map(validateAccount);
    if (!vault) {
      record.sealed = await encrypt(candidate, []);
      localStorage.setItem(STORAGE, JSON.stringify(record));
    }
    vault = record;
    key = candidate;
    accounts = data;
    codeEpoch++;
  } finally {
    verifying = false;
  }
}
async function save(next) {
  if (next.length > 1000)
    throw Error("This vault supports up to 1,000 accounts. Nothing was saved.");
  const activeKey = key,
    epoch = codeEpoch;
  if (!activeKey) throw Error("Vault is locked.");
  const sealed = await encrypt(activeKey, next);
  if (epoch !== codeEpoch || !key)
    throw Error("Vault locked before saving. Please unlock and try again.");
  const record = { ...vault, sealed };
  localStorage.setItem(STORAGE, JSON.stringify(record));
  vault = record;
  accounts = next;
}
function lock() {
  if (!key) return;
  selectingFile = false;
  key = null;
  accounts = [];
  revealed.clear();
  search = "";
  codeEpoch++;
  clearTimeout(idleTimer);
  document.querySelector("#modal")?.close();
  render();
}
function resetIdle() {
  clearTimeout(idleTimer);
  if (key) idleTimer = setTimeout(lock, 120000);
}
function addDialog() {
  modal(
    "Add an account",
    `<p class="modal-description">Use the setup key from the service’s two-factor authentication settings.</p><form id="add-form"><label>Service name<input name="issuer" placeholder="e.g. Google" required maxlength="100"></label><label>Account name or email<input name="name" placeholder="you@example.com" required maxlength="200"></label><label>Secret setup key<input name="secret" placeholder="Enter your Base32 key" required autocomplete="off" spellcheck="false"></label><details><summary>Advanced settings</summary><div class="form-columns"><label>Algorithm<select name="algorithm"><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label><label>Digits<select name="digits"><option>6</option><option>8</option></select></label><label>Period (seconds)<input type="number" name="period" value="30" min="15" max="120"></label></div></details><button class="button primary full" type="submit">${icon("plus")} Save account</button></form><button class="text-button modal-link" id="use-import">Have a QR code or setup link? Import instead →</button>`,
  );
  document.querySelector("#use-import").onclick = () => {
    document.querySelector("#modal").close();
    importDialog();
  };
  document.querySelector("#add-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button[type=submit]");
    b.disabled = true;
    try {
      const a = validateAccount(Object.fromEntries(new FormData(e.target)));
      if (accounts.some((x) => x.secret === a.secret && x.name === a.name))
        throw Error("This account is already in your vault.");
      await save([...accounts, a]);
      document.querySelector("#modal").close();
      render();
      toast("Account added to your private vault.");
    } catch (e) {
      error(e);
      b.disabled = false;
    }
  };
}
function importDialog() {
  modal(
    "Bring your accounts along",
    `<p class="modal-description">Import a Still encrypted backup, JSON accounts, an otpauth setup link, or a Google Authenticator export link. Everything is processed on this device.</p><form id="import-form"><label class="file-drop">${icon("file")}<strong>Choose a backup or QR image</strong><span>JSON, text, PNG, or JPEG · up to 5 MB</span><input id="import-file" type="file" accept=".json,.txt,image/png,image/jpeg,image/webp"></label><label>Or paste setup links / JSON<textarea id="import-text" rows="4" placeholder="otpauth://totp/…" spellcheck="false"></textarea></label><label>Backup password <span class="optional">(encrypted backups only)</span><input id="import-password" type="password" autocomplete="off"></label><button class="button primary full" type="submit">${icon("arrow")} Import accounts</button></form><p class="fine-print">Google multi-QR batches and HOTP are not supported. For Google, export a smaller group in a single QR. QR images are decoded on this device. Use one clear QR code per image; nothing is uploaded.</p>`,
  );
  const dialog = document.querySelector("#modal");
  const input = document.querySelector("#import-file");
  const textInput = document.querySelector("#import-text");
  const submit = document.querySelector("#import-form button[type=submit]");
  let reading;
  dialog.addEventListener("close", () => reading?.abort(), { once: true });
  input.onclick = () => {
    selectingFile = true;
  };
  input.oncancel = () => {
    selectingFile = false;
  };
  input.onchange = async (e) => {
    selectingFile = false;
    reading?.abort();
    const controller = (reading = new AbortController());
    const epoch = codeEpoch;
    submit.disabled = true;
    try {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024)
        throw Error("Please choose a file smaller than 5 MB.");
      document.querySelector("#form-error").textContent = "";
      const text = f.type.startsWith("image/")
        ? await readQrImage(f, controller.signal)
        : await f.text();
      if (
        controller.signal.aborted ||
        epoch !== codeEpoch ||
        !dialog.open ||
        !textInput.isConnected
      )
        return;
      textInput.value = text;
      toast(
        f.type.startsWith("image/")
          ? "QR code read locally. Select Import accounts to save."
          : "File loaded. Select Import accounts to save.",
      );
    } catch (e) {
      if (!controller.signal.aborted && epoch === codeEpoch && dialog.open)
        error(e);
    } finally {
      if (reading === controller) submit.disabled = false;
    }
  };
  document.querySelector("#import-form").onsubmit = async (e) => {
    e.preventDefault();
    const epoch = codeEpoch;
    const b = e.target.querySelector("button[type=submit]");
    b.disabled = true;
    try {
      let text = document.querySelector("#import-text").value;
      if (text.length > 5 * 1024 * 1024) throw Error("Import is too large.");
      let data;
      try {
        data = JSON.parse(text);
      } catch {}
      if (data?.format === "still-encrypted-backup") {
        if (data.version !== 1 || data.kdf !== "PBKDF2-SHA256-600000")
          throw Error("Unsupported backup format.");
        const pw = document.querySelector("#import-password").value;
        const k = await passwordKey(pw, unb64(data.salt));
        try {
          text = JSON.stringify(await decrypt(k, data));
        } catch {
          throw Error("Incorrect backup password or damaged backup.");
        }
      }
      if (epoch !== codeEpoch || !key || !dialog.open) return;
      const imported = parseImport(text);
      const unique = imported.filter(
        (a, i) =>
          !accounts.some((x) => x.secret === a.secret && x.name === a.name) &&
          !imported
            .slice(0, i)
            .some((x) => x.secret === a.secret && x.name === a.name),
      );
      if (!unique.length)
        throw Error("No new accounts found. Your vault is unchanged.");
      await save([...accounts, ...unique]);
      document.querySelector("#modal").close();
      render();
      toast(
        `${unique.length} account${unique.length === 1 ? "" : "s"} imported. Duplicates skipped.`,
      );
    } catch (e) {
      error(e);
      b.disabled = false;
    }
  };
}
function exportDialog() {
  modal(
    "An encrypted backup. All yours.",
    `<p class="modal-description">Export all ${accounts.length} accounts, including their secret keys and code settings. Your backup is encrypted before it becomes a file.</p><form id="export-form"><label>Create a backup password<input name="password" type="password" minlength="12" required autocomplete="new-password" placeholder="At least 12 characters"></label><label>Confirm password<input name="confirm" type="password" required autocomplete="new-password"></label><div class="callout">Use a long, unique password and store it separately from the backup. There is no way to recover a forgotten backup password.</div><button class="button primary full" type="submit">${icon("export")} Download encrypted backup</button></form>`,
  );
  document.querySelector("#export-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    const epoch = codeEpoch;
    try {
      const f = new FormData(e.target);
      if (f.get("password") !== f.get("confirm"))
        throw Error("The passwords don’t match.");
      const salt = bytes(32),
        k = await passwordKey(f.get("password"), salt);
      if (epoch !== codeEpoch || !key) return;
      const sealed = await encrypt(k, { accounts });
      if (epoch !== codeEpoch || !key) return;
      const data = {
        format: "still-encrypted-backup",
        version: 1,
        kdf: "PBKDF2-SHA256-600000",
        salt: b64(salt),
        ...sealed,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `still-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.querySelector("#modal").close();
      toast("Encrypted backup downloaded. Keep it somewhere safe.");
    } catch (e) {
      error(e);
      b.disabled = false;
    }
  };
}
function deleteAccount(id) {
  const a = accounts.find((x) => x.id === id);
  modal(
    "Remove this account?",
    `<p class="modal-description">Remove <strong>${esc(a.issuer)} · ${esc(a.name)}</strong> from this vault? This does not disable two-factor authentication at the service. Keep its recovery codes or another authenticator.</p><button id="confirm-delete" class="button danger full">Remove account</button>`,
  );
  document.querySelector("#confirm-delete").onclick = async () => {
    try {
      await save(accounts.filter((x) => x.id !== id));
      document.querySelector("#modal").close();
      render();
      toast("Account removed.");
    } catch (e) {
      error(e);
    }
  };
}
function resetDialog() {
  modal(
    "Delete this local vault?",
    `<p class="modal-description">This cannot be undone. Export a backup first. Type DELETE to confirm.</p><form id="reset-form"><label>Confirmation<input name="confirmation" required autocomplete="off" pattern="DELETE"></label><button class="button danger full">Permanently delete vault</button></form>`,
  );
  document.querySelector("#reset-form").onsubmit = (e) => {
    e.preventDefault();
    if (new FormData(e.target).get("confirmation") !== "DELETE") return;
    localStorage.removeItem(STORAGE);
    vault = null;
    lock();
    toast("Local vault deleted.");
  };
}
async function updateCodes() {
  if (!key || page !== "accounts") return;
  const epoch = codeEpoch;
  for (const a of accounts) {
    const el = document.querySelector(`.code-value[data-reveal="${a.id}"]`);
    if (!el) continue;
    const left = a.period - (Math.floor(Date.now() / 1000) % a.period);
    document.querySelector(`[data-timer="${a.id}"]`).textContent =
      `${left}s remaining`;
    document.querySelector(`[data-bar="${a.id}"]`).style.width =
      `${(left / a.period) * 100}%`;
    if (revealed.has(a.id)) {
      const code = await totp(a);
      if (epoch !== codeEpoch) return;
      el.textContent =
        code.slice(0, code.length / 2) + " " + code.slice(code.length / 2);
    } else el.textContent = a.digits === 8 ? "•••• ••••" : "••• •••";
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && !verifying) lock();
});
window.addEventListener("blur", () => {
  if (!verifying && !selectingFile) lock();
});
window.addEventListener("focus", () => {
  setTimeout(() => {
    selectingFile = false;
  }, 500);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") lock();
  resetIdle();
});
document.addEventListener("pointerdown", resetIdle);
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE) {
    lock();
    try {
      vault = JSON.parse(e.newValue);
    } catch {
      vault = null;
    }
    render();
  }
});
setInterval(() => updateCodes().catch(() => lock()), 1000);
render();
if (import.meta.env.PROD && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
