import jsQR from "jsqr";
self.onmessage = ({ data }) => {
  try {
    const pixels = new Uint8ClampedArray(data.pixels);
    const result = jsQR(pixels, data.width, data.height, {
      inversionAttempts: "attemptBoth",
    });
    pixels.fill(0);
    self.postMessage({ text: result?.data || null });
  } catch {
    self.postMessage({ error: "Could not decode this QR image." });
  }
};
