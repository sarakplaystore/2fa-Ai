package com.sarakplaystore.still;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** An offline-only shell for the bundled web UI. No server, no INTERNET permission. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final String KEY_ALIAS = "still.device.wrap.v1";
    private static final int IMPORT_FILE = 1;
    private static final int EXPORT_FILE = 2;

    private WebView web;
    private ValueCallback<Uri[]> upload;
    private boolean authenticating;
    private String pendingBackup; // Already password-encrypted JSON, never plaintext accounts.
    private int pendingBackupId;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        WebView.setWebContentsDebuggingEnabled(false);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(246, 247, 249));
        web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // Stores only the AES-GCM encrypted vault.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // For the user-selected import file only.
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        web.setWebViewClient(new LocalAssets());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                        FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null);
                upload = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                    "application/json", "text/plain", "image/png", "image/jpeg", "image/webp"
                });
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(intent, IMPORT_FILE);
                    return true;
                } catch (Exception e) {
                    upload = null;
                    callback.onReceiveValue(null);
                    return true;
                }
            }
        });
        // The interface is visible to all frames in a WebView. CSP prohibits
        // frames and scripts from other origins; Java separately checks the
        // main-frame origin and never loads a remote URL or resource.
        web.addJavascriptInterface(new DeviceBridge(), "StillAndroid");
        setContentView(web);
        web.loadUrl(HOME);
    }

    private static boolean local(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
            && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private boolean trustedPage() {
        String url = web.getUrl(); // Only called on the main/UI thread.
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return local(uri) && ("/index.html".equals(uri.getPath()) || "/".equals(uri.getPath()));
    }

    private static String assetPath(Uri uri) {
        String path = uri.getPath();
        if (path == null || "/".equals(path)) path = "/index.html";
        if (path.length() > 200 || uri.getQuery() != null || !path.matches("/[A-Za-z0-9_./-]+"))
            return null;
        for (String part : path.substring(1).split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return null;
        }
        return "www" + path;
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".txt")) return "text/plain";
        return null;
    }

    private static WebResourceResponse emptyResponse(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason,
            new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private final class LocalAssets extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            // No external browser hand-off, intent://, content:// or arbitrary
            // same-origin navigations. Only the bundled entry point can load.
            return !local(uri) || !("/index.html".equals(uri.getPath()) || "/".equals(uri.getPath()));
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!local(request.getUrl()) || !"GET".equals(request.getMethod()))
                return emptyResponse(403, "Forbidden");
            String path = assetPath(request.getUrl());
            String type = path == null ? null : mime(path);
            if (type == null) return emptyResponse(404, "Not Found");
            try {
                InputStream bytes = getAssets().open(path);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                headers.put("X-Content-Type-Options", "nosniff");
                headers.put("Referrer-Policy", "no-referrer");
                if (type.equals("text/html")) {
                    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; "
                        + "worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                        + "connect-src 'self'; manifest-src 'self'; font-src 'self'; object-src 'none'; "
                        + "base-uri 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'");
                }
                return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, bytes);
            } catch (IOException e) {
                return emptyResponse(404, "Not Found");
            }
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel(); // Never bypass TLS errors, even if accidentally navigating away.
        }
    }

    private void reply(int id, String value, String error) {
        if (!trustedPage()) return; // Never deliver key material to a different document.
        String js = "window.__stillAndroidResult(" + id + ", "
            + (value == null ? "null" : JSONObject.quote(value)) + ", "
            + (error == null ? "null" : JSONObject.quote(error)) + ");";
        web.evaluateJavascript(js, null);
    }

    private SharedPreferences preferences() {
        return getSharedPreferences("device_key_v1", MODE_PRIVATE);
    }

    private void verify(int id, boolean create) {
        if (!trustedPage()) return;
        if (authenticating) { reply(id, null, "Device verification is already in progress."); return; }
        try {
            BiometricManager manager = getSystemService(BiometricManager.class);
            int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            if (manager == null || manager.canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
                reply(id, null, "Set up a strong biometric or device PIN in Android settings first.");
                return;
            }
            SharedPreferences prefs = preferences();
            boolean hasIv = prefs.contains("iv"), hasWrapped = prefs.contains("wrapped");
            if (hasIv != hasWrapped) throw new IllegalStateException("Incomplete key record");
            if (!create && !hasWrapped) {
                reply(id, null, "Device key missing. Restore an encrypted backup after clearing app storage.");
                return;
            }
            boolean newSecret = create && !hasWrapped;
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            SecretKey key;
            if (newSecret) {
                // An earlier cancelled enrollment may have left a key but no wrapped seed.
                if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(true)
                    .setUserAuthenticationParameters(0,
                        KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
                    .build());
                key = generator.generateKey();
            } else {
                key = (SecretKey) store.getKey(KEY_ALIAS, null);
                if (key == null) throw new IllegalStateException("Device key lost");
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            if (newSecret) cipher.init(Cipher.ENCRYPT_MODE, key);
            else cipher.init(Cipher.DECRYPT_MODE, key,
                new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.DEFAULT)));

            authenticating = true;
            BiometricPrompt prompt = new BiometricPrompt.Builder(this)
                .setTitle(newSecret ? "Protect your Still vault" : "Unlock your Still vault")
                .setSubtitle("Verify with your device to access your codes")
                .setAllowedAuthenticators(authenticators)
                .build();
            prompt.authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(),
                getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        authenticating = false;
                        byte[] secret = null;
                        try {
                            BiometricPrompt.CryptoObject object = result.getCryptoObject();
                            if (object == null || object.getCipher() == null)
                                throw new IllegalStateException("No authenticated cipher");
                            Cipher verified = object.getCipher();
                            if (newSecret) {
                                secret = new byte[32];
                                new SecureRandom().nextBytes(secret);
                                byte[] wrapped = verified.doFinal(secret);
                                boolean saved = prefs.edit()
                                    .putString("iv", Base64.encodeToString(verified.getIV(), Base64.NO_WRAP))
                                    .putString("wrapped", Base64.encodeToString(wrapped, Base64.NO_WRAP))
                                    .commit();
                                if (!saved) throw new IOException("Could not persist wrapped device key");
                            } else {
                                secret = verified.doFinal(Base64.decode(prefs.getString("wrapped", ""), Base64.DEFAULT));
                            }
                            if (secret.length != 32) throw new IllegalStateException("Invalid device key");
                            reply(id, Base64.encodeToString(secret, Base64.NO_WRAP), null);
                        } catch (Exception e) {
                            reply(id, null, "Device key unavailable. Restore an encrypted backup if it was lost.");
                        } finally {
                            if (secret != null) Arrays.fill(secret, (byte) 0);
                        }
                    }
                    @Override public void onAuthenticationError(int code, CharSequence message) {
                        authenticating = false;
                        reply(id, null, "Device verification canceled or unavailable.");
                    }
                });
        } catch (Exception e) {
            authenticating = false;
            reply(id, null, "Device key unavailable. Check your screen lock or restore an encrypted backup.");
        }
    }

    /** Calls are dispatched to the UI thread before touching WebView or starting system UI. */
    public final class DeviceBridge {
        @JavascriptInterface public void authenticate(int id, boolean create) {
            runOnUiThread(() -> verify(id, create));
        }

        @JavascriptInterface public void saveBackup(int id, String filename, String encryptedJson) {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                if (pendingBackup != null) { reply(id, null, "A backup is already being saved."); return; }
                try {
                    if (filename == null || !filename.matches("still-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.json")
                        || encryptedJson == null || encryptedJson.length() > 7 * 1024 * 1024)
                        throw new IllegalArgumentException("Invalid backup");
                    JSONObject data = new JSONObject(encryptedJson);
                    if (!"still-encrypted-backup".equals(data.optString("format"))
                        || data.optInt("version") != 1 || !data.has("ciphertext"))
                        throw new IllegalArgumentException("Unencrypted backup");
                    pendingBackup = encryptedJson;
                    pendingBackupId = id;
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    intent.putExtra(Intent.EXTRA_TITLE, filename);
                    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    startActivityForResult(intent, EXPORT_FILE);
                } catch (Exception e) {
                    pendingBackup = null;
                    reply(id, null, "Could not open the document picker for this encrypted backup.");
                }
            });
        }

        @JavascriptInterface public void copyCode(int id, String code) {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                if (code == null || !code.matches("[0-9]{6}([0-9]{2})?")) {
                    reply(id, null, "Invalid verification code.");
                    return;
                }
                try {
                    ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                    if (clipboard == null) throw new IllegalStateException("No clipboard");
                    clipboard.setPrimaryClip(ClipData.newPlainText("Still code", code));
                    reply(id, "ok", null);
                } catch (Exception e) {
                    reply(id, null, "Clipboard unavailable. Reveal the code instead.");
                }
            });
        }

        @JavascriptInterface public void clearKey(int id) {
            runOnUiThread(() -> {
                if (!trustedPage() || authenticating) return;
                try {
                    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
                    store.load(null);
                    if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
                    if (!preferences().edit().clear().commit()) throw new IOException("Could not clear preferences");
                    reply(id, "ok", null);
                } catch (Exception e) {
                    reply(id, null, "Could not remove device key. Vault unchanged; keep your backup.");
                }
            });
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == IMPORT_FILE) {
            if (upload != null) {
                upload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                upload = null;
            }
        } else if (requestCode == EXPORT_FILE) {
            String encrypted = pendingBackup;
            int id = pendingBackupId;
            pendingBackup = null;
            pendingBackupId = 0;
            if (encrypted == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                reply(id, null, "Backup canceled. No file was saved.");
                return;
            }
            try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "w")) {
                if (out == null) throw new IOException("Unable to write document");
                out.write(encrypted.getBytes(StandardCharsets.UTF_8));
                out.flush();
                reply(id, "ok", null);
            } catch (Exception e) {
                reply(id, null, "Unable to save backup. Choose another location and try again.");
            }
        }
    }

    @Override protected void onPause() {
        if (web != null) web.evaluateJavascript("document.dispatchEvent(new Event('still-app-paused'))", null);
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (upload != null) { upload.onReceiveValue(null); upload = null; }
        if (web != null) {
            web.removeJavascriptInterface("StillAndroid");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
