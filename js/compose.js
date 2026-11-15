/* Lays out the receipt at printer-dot resolution and converts it to a 1-bit bitmap. */
(function () {
  const RPB = (window.RPB = window.RPB || {});

  // aspect = slot width / height
  const LAYOUTS = {
    single: { label: 'Single', count: 1, cols: 1, aspect: 1 },
    strip3: { label: 'Strip of 3', count: 3, cols: 1, aspect: 4 / 3 },
    strip4: { label: 'Strip of 4', count: 4, cols: 1, aspect: 4 / 3 },
    grid4: { label: 'Grid of 4', count: 4, cols: 2, aspect: 1 },
  };

  const TITLE_FONTS = {
    'Bebas Neue': '"Bebas Neue", Impact, sans-serif',
    'Archivo Black': '"Archivo Black", "Arial Black", sans-serif',
    Pacifico: 'Pacifico, "Brush Script MT", cursive',
    'Playfair Display': '"Playfair Display", Georgia, serif',
    'Space Mono': '"Space Mono", "Courier New", monospace',
  };
  const MONO = '"Space Mono", "Courier New", monospace';

  const dotsFor = (mm) => (Number(mm) === 80 ? 576 : 384);

  async function loadFonts(s) {
    if (!document.fonts || !document.fonts.load) return;
    const want = [`400 20px ${TITLE_FONTS[s.titleFont] || MONO}`, `400 20px ${MONO}`, `700 20px ${MONO}`];
    const all = Promise.all(want.map((f) => document.fonts.load(f).catch(() => null)));
    await Promise.race([all, new Promise((r) => setTimeout(r, 2500))]);
  }

  function drawCover(ctx, img, x, y, w, h) {
    const iw = img.width, ih = img.height;
    const a = w / h;
    let sw = iw, sh = iw / a;
    if (sh > ih) { sh = ih; sw = ih * a; }
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }

  function wrap(ctx, text, maxW) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? line + ' ' + word : word;
        if (line && ctx.measureText(t).width > maxW) { lines.push(line); line = word; }
        else line = t;
      }
      lines.push(line);
    }
    return lines;
  }

  /* opts: { paperWidth, layout, photos: [canvas|img], s: settings, orderNo, date }
     returns { canvas, rects: [{x,y,w,h}] } */
  function build(opts) {
    const s = opts.s;
    const W = dotsFor(opts.paperWidth);
    const L = LAYOUTS[opts.layout] || LAYOUTS.strip3;
    const m = Math.round(W * 0.05);
    const gap = Math.round(W * 0.03);
    const inner = W - 2 * m;
    const body = Math.round(W * 0.05);

    const work = document.createElement('canvas');
    work.width = W;
    work.height = W * 10;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, work.height);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    let y = m;

    const rule = () => {
      y += gap;
      const dash = Math.max(4, Math.round(W / 64));
      for (let x = m; x < W - m; x += dash * 2) ctx.fillRect(x, y, dash, 2);
      y += 2 + gap;
    };
    const center = (text, font, size, lh) => {
      ctx.font = `${font}`.replace('SIZE', size);
      ctx.textAlign = 'center';
      for (const line of wrap(ctx, text, inner)) {
        ctx.fillText(line, W / 2, y);
        y += Math.round(size * (lh || 1.25));
      }
    };
    const pair = (left, right, bold) => {
      ctx.font = `${bold ? 700 : 400} ${body}px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillText(left, m, y);
      ctx.textAlign = 'right';
      ctx.fillText(right, W - m, y);
      y += Math.round(body * 1.4);
    };

    // Header
    if (s.title) {
      const fam = TITLE_FONTS[s.titleFont] || MONO;
      let size = Math.round(W * 0.17);
      ctx.font = `400 ${size}px ${fam}`;
      const tw = ctx.measureText(s.title).width;
      if (tw > inner) size = Math.max(14, Math.floor((size * inner) / tw));
      ctx.font = `400 ${size}px ${fam}`;
      ctx.textAlign = 'center';
      ctx.fillText(s.title, W / 2, y);
      y += Math.round(size * 1.12);
    }
    if (s.subtitle) center(s.subtitle, `400 SIZEpx ${MONO}`, Math.round(W * 0.052));

    const d = opts.date || new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const order = '#' + String(opts.orderNo || 1).padStart(4, '0');

    rule();
    if (s.receiptLines) pair('ORDER ' + order, s.showDate ? dateStr : '');
    else if (s.showDate) center(dateStr, `400 SIZEpx ${MONO}`, body);
    if (s.receiptLines || s.showDate) y += gap;

    // Photos
    const rects = [];
    const slotW = Math.floor((inner - (L.cols - 1) * gap) / L.cols);
    const slotH = Math.round(slotW / L.aspect);
    for (let i = 0; i < L.count; i++) {
      const col = i % L.cols;
      const x = m + col * (slotW + gap);
      if (col === 0 && i > 0) y += slotH + gap;
      const r = { x, y, w: slotW, h: slotH };
      rects.push(r);
      const img = opts.photos[i];
      if (img) drawCover(ctx, img, r.x, r.y, r.w, r.h);
      else { ctx.fillStyle = '#bbb'; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.fillStyle = '#000'; }
    }
    y += slotH;

    rule();
    if (s.receiptLines) {
      pair(`${L.count} x MEMORIES`, 'PRICELESS');
      pair('TOTAL', 'PRICELESS', true);
      y += gap;
    }
    if (s.footer) center(s.footer, `400 SIZEpx ${MONO}`, body, 1.35);

    if (s.receiptLines) {
      // Decorative barcode, deterministic per order number.
      y += gap;
      let seed = (opts.orderNo || 1) * 2654435761 >>> 0;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const bh = Math.round(W * 0.11);
      const unit = Math.max(2, Math.round(W / 190));
      let x = m + Math.round(inner * 0.1);
      const end = W - m - Math.round(inner * 0.1);
      let ink = true;
      while (x < end) {
        const bw = unit * (1 + Math.floor(rnd() * 3));
        if (ink) ctx.fillRect(x, y, Math.min(bw, end - x), bh);
        x += bw;
        ink = !ink;
      }
      y += bh + Math.round(gap / 2);
      center(order, `400 SIZEpx ${MONO}`, Math.round(body * 0.85));
    }
    y += m;

    const out = document.createElement('canvas');
    out.width = W;
    out.height = y;
    out.getContext('2d').drawImage(work, 0, 0);
    return { canvas: out, rects };
  }

  /* Text and rules are thresholded for crisp edges; photo slots go through the dither pipeline. */
  function toBitmap(canvas, rects, s, filter) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const g = RPB.imaging.toGray(ctx.getImageData(0, 0, w, h));
    const bits = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) bits[i] = g[i] < 0.55 ? 1 : 0;
    for (const r of rects) {
      const sub = new Float32Array(r.w * r.h);
      for (let yy = 0; yy < r.h; yy++)
        sub.set(g.subarray((r.y + yy) * w + r.x, (r.y + yy) * w + r.x + r.w), yy * r.w);
      const pb = RPB.imaging.processPhoto(sub, r.w, r.h, s, filter);
      for (let yy = 0; yy < r.h; yy++)
        bits.set(pb.subarray(yy * r.w, (yy + 1) * r.w), (r.y + yy) * w + r.x);
    }
    return { bits, w, h };
  }

  function paint(bitmap, canvas) {
    canvas.width = bitmap.w;
    canvas.height = bitmap.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(bitmap.w, bitmap.h);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < bitmap.bits.length; i++) px[i] = bitmap.bits[i] ? 0xff1a1a1a : 0xffffffff;
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* Synthetic photo for test prints: tonal ramp, soft sphere and fine lines. */
  function testPhoto() {
    const c = document.createElement('canvas');
    c.width = c.height = 600;
    const x = c.getContext('2d');
    const lin = x.createLinearGradient(0, 0, 600, 0);
    lin.addColorStop(0, '#000');
    lin.addColorStop(1, '#fff');
    x.fillStyle = lin;
    x.fillRect(0, 0, 600, 600);
    const rad = x.createRadialGradient(260, 250, 10, 300, 300, 230);
    rad.addColorStop(0, '#fff');
    rad.addColorStop(1, '#111');
    x.fillStyle = rad;
    x.beginPath();
    x.arc(300, 300, 220, 0, Math.PI * 2);
    x.fill();
    for (let i = 0; i < 16; i++) {
      x.fillStyle = `rgb(${i * 17},${i * 17},${i * 17})`;
      x.fillRect(i * 37.5, 540, 37.5, 60);
    }
    x.fillStyle = '#fff';
    for (let i = 0; i < 12; i++) x.fillRect(20 + i * 6, 20, 1 + (i % 3), 70);
    return c;
  }

  RPB.compose = { LAYOUTS, TITLE_FONTS, dotsFor, loadFonts, build, toBitmap, paint, testPhoto };
})();
