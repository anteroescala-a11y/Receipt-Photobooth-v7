/* Image pipeline for thermal printing: grayscale -> filter -> levels -> tone -> sharpen -> 1-bit dither.
   All working buffers are Float32Array with values 0 (black) .. 1 (white). */
(function () {
  const RPB = (window.RPB = window.RPB || {});

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function toGray(imageData) {
    const d = imageData.data;
    const out = new Float32Array(imageData.width * imageData.height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;
    }
    return out;
  }

  /* Separable box blur with a running sum, edges clamped. */
  function boxBlur(src, w, h, r) {
    r = Math.max(1, Math.round(r));
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  /* Stretch the histogram between the 1st and 99th percentile. */
  function autoLevels(g) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[(clamp01(g[i]) * 255) | 0]++;
    const cut = g.length * 0.01;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < cut) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < cut) hi--;
    if (hi - lo < 40) return g;
    const a = lo / 255, span = (hi - lo) / 255;
    for (let i = 0; i < g.length; i++) g[i] = clamp01((g[i] - a) / span);
    return g;
  }

  /* brightness, contrast: -50..50; gamma: 0.5..2 (above 1 lightens midtones). */
  function tone(g, brightness, contrast, gamma) {
    const b = brightness / 100;
    const c = 1 + contrast / 50;
    const inv = 1 / (gamma || 1);
    for (let i = 0; i < g.length; i++) {
      g[i] = Math.pow(clamp01((g[i] - 0.5) * c + 0.5 + b), inv);
    }
    return g;
  }

  function sharpen(g, w, h, amount) {
    if (amount <= 0) return g;
    const blur = boxBlur(g, w, h, 1);
    const k = (amount / 100) * 1.5;
    for (let i = 0; i < g.length; i++) g[i] = clamp01(g[i] + k * (g[i] - blur[i]));
    return g;
  }

  const FILTERS = {
    normal: { label: 'Original', apply: (g) => g },
    bold: {
      label: 'Bold',
      apply: (g) => tone(g, -4, 22, 1),
    },
    soft: {
      label: 'Soft',
      apply: (g) => tone(g, 8, -10, 1.15),
    },
    sketch: {
      label: 'Sketch',
      // Pencil sketch: colour-dodge the image with a blurred negative of itself.
      apply: (g, w, h) => {
        const neg = new Float32Array(g.length);
        for (let i = 0; i < g.length; i++) neg[i] = 1 - g[i];
        const blur = boxBlur(neg, w, h, Math.max(2, w / 70));
        for (let i = 0; i < g.length; i++) {
          const v = Math.min(1, g[i] / (1 - blur[i] + 0.001));
          g[i] = v * v * v;
        }
        return g;
      },
    },
  };

  const BAYER8 = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];

  const DITHERS = {
    floyd: 'Floyd–Steinberg (smooth)',
    atkinson: 'Atkinson (crisp, clean highlights)',
    bayer: 'Ordered (halftone pattern)',
    threshold: 'Threshold (pure black / white)',
  };

  /* Returns Uint8Array, 1 = black dot. Consumes g. */
  function dither(g, w, h, method) {
    const bits = new Uint8Array(w * h);
    if (method === 'threshold') {
      for (let i = 0; i < g.length; i++) bits[i] = g[i] < 0.5 ? 1 : 0;
      return bits;
    }
    if (method === 'bayer') {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const t = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
          bits[y * w + x] = g[y * w + x] < t ? 1 : 0;
        }
      return bits;
    }
    const atk = method === 'atkinson';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = g[i];
        const nv = old < 0.5 ? 0 : 1;
        bits[i] = nv ? 0 : 1;
        const err = old - nv;
        if (atk) {
          const e = err / 8;
          if (x + 1 < w) g[i + 1] += e;
          if (x + 2 < w) g[i + 2] += e;
          if (y + 1 < h) {
            if (x > 0) g[i + w - 1] += e;
            g[i + w] += e;
            if (x + 1 < w) g[i + w + 1] += e;
          }
          if (y + 2 < h) g[i + 2 * w] += e;
        } else {
          if (x + 1 < w) g[i + 1] += (err * 7) / 16;
          if (y + 1 < h) {
            if (x > 0) g[i + w - 1] += (err * 3) / 16;
            g[i + w] += (err * 5) / 16;
            if (x + 1 < w) g[i + w + 1] += err / 16;
          }
        }
      }
    }
    return bits;
  }

  /* Full photo pipeline on a gray buffer. s = settings, filter = key of FILTERS. */
  function processPhoto(g, w, h, s, filter) {
    if (s.autoLevels) autoLevels(g);
    (FILTERS[filter] || FILTERS.normal).apply(g, w, h);
    tone(g, s.brightness, s.contrast, s.gamma);
    sharpen(g, w, h, s.sharpen);
    return dither(g, w, h, filter === 'sketch' && s.dither !== 'threshold' ? 'atkinson' : s.dither);
  }

  RPB.imaging = { toGray, boxBlur, autoLevels, tone, sharpen, dither, processPhoto, FILTERS, DITHERS };
})();
