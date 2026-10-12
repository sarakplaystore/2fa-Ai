// All image processing happens locally. A short-lived worker avoids blocking
// the UI/auto-lock timer while parsing an untrusted image.
export async function readQrImage(file, signal) {
  signal?.throwIfAborted();
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw Error("Choose a PNG, JPEG, or WebP QR image.");
  if (file.size > 5 * 1024 * 1024)
    throw Error("Please choose an image smaller than 5 MB.");
  const bitmap = await createImageBitmap(file);
  let canvas;
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > 32_000_000)
      throw Error(
        "This image is too large. Crop it to the QR code and try again.",
      );
    const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./qr-worker.js", import.meta.url), {
        type: "module",
      });
      const finish = (err, text) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        err ? reject(err) : resolve(text);
      };
      const abort = () =>
        finish(new DOMException("QR import canceled.", "AbortError"));
      const timer = setTimeout(
        () =>
          finish(
            Error(
              "QR decoding timed out. Crop the image to the QR code and try again.",
            ),
          ),
        15000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = () =>
        finish(
          Error("Could not read this image. Paste the setup link instead."),
        );
      worker.onmessage = ({ data }) =>
        data.error ? finish(Error(data.error)) : finish(null, data.text);
      worker.postMessage(
        { pixels: image.data.buffer, width: image.width, height: image.height },
        [image.data.buffer],
      );
    });
    signal?.throwIfAborted();
    if (!result)
      throw Error(
        "No QR code found. Use a clear image containing one QR code.",
      );
    if (
      !result.startsWith("otpauth://") &&
      !result.startsWith("otpauth-migration://")
    )
      throw Error(
        "This QR code is not an authenticator setup or Google export code.",
      );
    return result;
  } finally {
    bitmap.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
