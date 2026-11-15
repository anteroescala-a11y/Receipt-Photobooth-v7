/* Receipt Photobooth: kiosk flow, camera capture, settings and printing. */
(function () {
  const { imaging, compose, escpos, printer } = window.RPB;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const DEFAULTS = {
    connection: 'usb', paperWidth: 58, baud: 9600, chunkRows: 128, feedLines: 3, cut: true,
    dither: 'floyd', brightness: 0, contrast: 0, gamma: 1, sharpen: 30, autoLevels: true,
    title: 'PHOTOBOOTH', titleFont: 'Bebas Neue', subtitle: 'your event name here',
    footer: 'Thank you for coming!', showDate: true, receiptLines: true,
    cameraId: '', countdown: 3, mirror: true, sound: true,
    copiesMax: 3, resultIdle: 60, pin: '1234',
  };
  const STORE = 'rpb.settings.v1';
  const IDLE_SECONDS = 120;

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* private mode */ }
  }
  function nextOrderNo() {
    let n = 1;
    try { n = (parseInt(localStorage.getItem('rpb.order'), 10) || 0) + 1; localStorage.setItem('rpb.order', String(n)); } catch (e) { /* ignore */ }
    return n;
  }

  let S = loadSettings();
  const state = {
    screen: 'welcome', layout: 'strip3', shots: [], filter: 'normal', copies: 1,
    stream: null, seq: 0, running: false, bitmap: null, orderNo: 1, date: new Date(),
    idleAt: 0, retake: null,
  };

  /* ---------- helpers ---------- */
  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 7000 : 3200);
  }

  function show(name) {
    state.screen = name;
    $$('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === name));
    bumpIdle();
  }

  function bumpIdle() {
    const secs = state.screen === 'result' ? Number(S.resultIdle) || 60 : IDLE_SECONDS;
    state.idleAt = Date.now() + secs * 1000;
  }

  let audioCtx;
  function beep(freq, dur, type) {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      gain.connect(audioCtx.destination);
      if (type === 'noise') {
        const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        src.start(t);
      } else {
        const osc = audioCtx.createOscillator();
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(t);
        osc.stop(t + dur);
      }
    } catch (e) { /* audio is optional */ }
  }

  /* ---------- camera ---------- */
  const video = $('#video');

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    video.srcObject = null;
  }

  async function startCamera() {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot open a camera here. Open the app over https or localhost.');
    }
    const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    let stream;
    try {
      const v = S.cameraId ? Object.assign({ deviceId: { exact: S.cameraId } }, base) : Object.assign({ facingMode: 'user' }, base);
      stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    } catch (e) {
      if (!S.cameraId) throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
    }
    state.stream = stream;
    video.srcObject = stream;
    video.classList.toggle('mirror', !!S.mirror);
    await video.play();
    fillCameras();
  }

  async function fillCameras() {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('#cameraSel');
      sel.innerHTML = '<option value="">Default camera</option>';
      cams.forEach((c, i) => sel.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
      sel.value = cams.some((c) => c.deviceId === S.cameraId) ? S.cameraId : '';
    } catch (e) { /* ignore */ }
  }

  /* Crop the live frame to the slot's aspect ratio, matching what the viewfinder shows. */
  function grab() {
    const a = compose.LAYOUTS[state.layout].aspect;
    const vw = video.videoWidth, vh = video.videoHeight;
    let cw = vw, ch = vw / a;
    if (ch > vh) { ch = vh; cw = vh * a; }
    const scale = Math.min(1, 1200 / cw);
    const c = document.createElement('canvas');
    c.width = Math.round(cw * scale);
    c.height = Math.round(ch * scale);
    const ctx = c.getContext('2d');
    if (S.mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------- capture flow ---------- */
  function renderDots(current) {
    const n = compose.LAYOUTS[state.layout].count;
    $('#dots').innerHTML = Array.from({ length: n }, (_, i) =>
      `<i class="${i === current ? 'now' : state.shots[i] ? 'done' : ''}"></i>`).join('');
  }

  async function enterCapture(retakeIndex) {
    const L = compose.LAYOUTS[state.layout];
    state.retake = retakeIndex == null ? null : retakeIndex;
    state.seq++;
    state.running = false;
    const vf = $('#viewfinder');
    vf.style.aspectRatio = String(L.aspect);
    vf.style.setProperty('--ar', String(L.aspect));
    $('#camError').hidden = true;
    $('#frozen').hidden = true;
    $('#count').hidden = true;
    $('#shootBtn').hidden = false;
    $('#shootBtn').disabled = true;
    $('#captureLabel').textContent = state.retake == null ? 'Get ready' : `Retake photo ${state.retake + 1}`;
    renderDots(state.retake == null ? 0 : state.retake);
    show('capture');
    try {
      await startCamera();
      $('#shootBtn').disabled = false;
    } catch (e) {
      $('#camErrorText').textContent = cameraMessage(e);
      $('#camError').hidden = false;
      $('#shootBtn').hidden = true;
    }
  }

  function cameraMessage(e) {
    if (e && e.name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this page, then try again.';
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return 'No camera was found. Plug one in, then try again.';
    if (e && e.name === 'NotReadableError') return 'The camera is in use by another app. Close it, then try again.';
    return (e && e.message) || 'The camera could not be opened.';
  }

  async function runSequence() {
    const L = compose.LAYOUTS[state.layout];
    const indices = state.retake == null ? Array.from({ length: L.count }, (_, i) => i) : [state.retake];
    const tok = ++state.seq;
    state.running = true;
    $('#shootBtn').hidden = true;
    const count = $('#count'), frozen = $('#frozen'), flash = $('#flash');
    for (const i of indices) {
      frozen.hidden = true;
      $('#captureLabel').textContent = `Photo ${i + 1} of ${L.count}`;
      renderDots(i);
      const secs = Math.max(1, Number(S.countdown) || 3);
      for (let n = secs; n >= 1; n--) {
        if (tok !== state.seq) return;
        count.hidden = false;
        count.textContent = n;
        count.classList.remove('tick');
        void count.offsetWidth;
        count.classList.add('tick');
        beep(n === 1 ? 1320 : 880, 0.15);
        bumpIdle();
        await sleep(1000);
      }
      if (tok !== state.seq) return;
      count.hidden = true;
      const shot = grab();
      state.shots[i] = shot;
      beep(0, 0.12, 'noise');
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
      frozen.src = shot.toDataURL('image/jpeg', 0.8);
      frozen.hidden = false;
      renderDots(-1);
      await sleep(1100);
    }
    if (tok !== state.seq) return;
    state.running = false;
    stopCamera();
    enterResult();
  }

  function loadFiles(files) {
    const L = compose.LAYOUTS[state.layout];
    const list = [...files].slice(0, L.count);
    if (!list.length) return;
    Promise.all(list.map((f) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('That image could not be read.'));
      img.src = URL.createObjectURL(f);
    }))).then((imgs) => {
      if (state.retake != null) state.shots[state.retake] = imgs[0];
      else for (let i = 0; i < L.count; i++) state.shots[i] = imgs[i % imgs.length];
      enterResult();
    }).catch((e) => toast(e.message, true));
  }

  /* ---------- result ---------- */
  async function renderReceipt() {
    await compose.loadFonts(S);
    const { canvas, rects } = compose.build({
      paperWidth: S.paperWidth, layout: state.layout, photos: state.shots, s: S,
      orderNo: state.orderNo, date: state.date,
    });
    state.bitmap = compose.toBitmap(canvas, rects, S, state.filter);
    compose.paint(state.bitmap, $('#preview'));
  }

  function thumbUrl(src) {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const s = Math.min(src.width, src.height);
    c.getContext('2d').drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 160, 160);
    return c.toDataURL('image/jpeg', 0.7);
  }

  async function enterResult() {
    if (state.retake == null) { state.orderNo = nextOrderNo(); state.date = new Date(); state.copies = 1; }
    state.retake = null;
    $('#copies').textContent = state.copies;
    $('#thumbs').innerHTML = '';
    state.shots.forEach((shot, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', `Retake photo ${i + 1}`);
      b.innerHTML = `<img alt="" src="${thumbUrl(shot)}">`;
      b.onclick = () => enterCapture(i);
      $('#thumbs').append(b);
    });
    $$('#filters .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.f === state.filter)));
    show('result');
    try { await renderReceipt(); } catch (e) { toast('Could not build the receipt: ' + e.message, true); }
  }

  function goHome() {
    state.seq++;
    state.running = false;
    stopCamera();
    state.shots = [];
    state.filter = 'normal';
    state.bitmap = null;
    show('welcome');
  }

  /* ---------- printing ---------- */
  function bitmapDataUrl(bitmap) {
    return compose.paint(bitmap, document.createElement('canvas')).toDataURL('image/png');
  }

  function browserPrint(bitmap) {
    let style = $('#pageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'pageStyle'; document.head.append(style); }
    const mm = Number(S.paperWidth) === 80 ? 80 : 58;
    const hmm = Math.ceil((bitmap.h / bitmap.w) * mm) + 4;
    style.textContent = `@page { size: ${mm}mm ${hmm}mm; margin: 0; }`;
    const img = $('#printImg');
    img.onload = () => window.print();
    img.src = bitmapDataUrl(bitmap);
  }

  async function ensurePrinter() {
    if (printer.connected() && printer.type === S.connection) return;
    await printer.connect(S.connection, S);
    updatePrinterStatus();
  }

  async function printBitmap(bitmap, copies) {
    if (S.connection === 'browser') { browserPrint(bitmap); return; }
    await ensurePrinter();
    const data = escpos.encodeRaster(bitmap, { chunkRows: Number(S.chunkRows), feedLines: Number(S.feedLines), cut: !!S.cut });
    for (let i = 0; i < copies; i++) await printer.write(data);
  }

  function printError(e) {
    if (e && e.name === 'NotFoundError') return 'No printer was chosen.';
    return (e && e.message) || 'Printing failed.';
  }

  function updatePrinterStatus() {
    $('#printerStatus').textContent = S.connection === 'browser'
      ? 'Uses the printer picked in the browser print dialog.'
      : printer.connected() ? 'Connected: ' + printer.name : 'Not connected.';
    $('#connectBtn').disabled = S.connection === 'browser';
  }

  /* ---------- settings ---------- */
  function fillSettings() {
    $$('[data-k]').forEach((el) => {
      const v = S[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
      const out = el.closest('label') && el.closest('label').querySelector('output');
      if (out) out.textContent = v;
    });
    updatePrinterStatus();
  }

  function readSetting(el) {
    const k = el.dataset.k;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number' || el.type === 'range' || 'num' in el.dataset) {
      v = Number(el.value);
      if (!Number.isFinite(v)) v = DEFAULTS[k];
      if (el.min !== '' && el.min != null && el.type !== 'select-one') v = Math.max(Number(el.min), v);
      if (el.max !== '' && el.max != null && el.type !== 'select-one') v = Math.min(Number(el.max), v);
    } else v = el.value;
    if (k === 'pin') v = String(v).replace(/\D/g, '').slice(0, 4);
    S[k] = v;
    const out = el.closest('label') && el.closest('label').querySelector('output');
    if (out) out.textContent = v;
    saveSettings();
  }

  let testTimer;
  function testBitmap() {
    const { canvas, rects } = compose.build({
      paperWidth: S.paperWidth, layout: 'single', photos: [compose.testPhoto()], s: S, orderNo: 0, date: new Date(),
    });
    return compose.toBitmap(canvas, rects, S, 'normal');
  }
  function refreshTestPreview() {
    clearTimeout(testTimer);
    testTimer = setTimeout(async () => {
      await compose.loadFonts(S);
      compose.paint(testBitmap(), $('#testPreview'));
    }, 80);
  }

  function applyBranding() {
    $('#welcomeTitle').textContent = S.title || 'PHOTOBOOTH';
    $('#welcomeSub').textContent = S.subtitle || 'Your photos, printed like a receipt.';
  }

  function openSettings() {
    fillSettings();
    fillCameras();
    refreshTestPreview();
    $('#settingsDlg').showModal();
  }

  /* ---------- wiring ---------- */
  function init() {
    // Layout cards
    for (const [key, L] of Object.entries(compose.LAYOUTS)) {
      const b = document.createElement('button');
      b.className = 'layout-card';
      const cellW = L.cols === 2 ? 32 : 68;
      const cells = Array.from({ length: L.count }, () => `<i style="height:${Math.round(cellW / L.aspect)}px"></i>`).join('');
      b.innerHTML = `<span class="mini ${L.cols === 2 ? 'cols2' : ''}">${cells}</span>${L.label}<small>${L.count} photo${L.count > 1 ? 's' : ''}</small>`;
      b.onclick = () => { state.layout = key; state.shots = []; enterCapture(null); };
      $('#layouts').append(b);
    }
    // Filter chips
    for (const [key, f] of Object.entries(imaging.FILTERS)) {
      const c = document.createElement('button');
      c.className = 'chip';
      c.dataset.f = key;
      c.textContent = f.label;
      c.setAttribute('aria-pressed', 'false');
      c.onclick = () => {
        state.filter = key;
        $$('#filters .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
        renderReceipt();
      };
      $('#filters').append(c);
    }
    for (const [k, label] of Object.entries(imaging.DITHERS)) $('#ditherSel').add(new Option(label, k));
    for (const k of Object.keys(compose.TITLE_FONTS)) $('#fontSel').add(new Option(k, k));

    $('#startBtn').onclick = () => show('layout');
    $$('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go)));
    $('#shootBtn').onclick = () => { if (!state.running) runSequence(); };
    $('#captureCancel').onclick = () => {
      if (state.retake != null) { state.seq++; state.running = false; stopCamera(); enterResult(); }
      else goHome();
    };
    $('#camRetry').onclick = () => enterCapture(state.retake);
    $('#fileInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };

    $('#doneBtn').onclick = goHome;
    $('#copiesMinus').onclick = () => { state.copies = Math.max(1, state.copies - 1); $('#copies').textContent = state.copies; };
    $('#copiesPlus').onclick = () => { state.copies = Math.min(Number(S.copiesMax) || 1, state.copies + 1); $('#copies').textContent = state.copies; };
    $('#printBtn').onclick = async () => {
      if (!state.bitmap) return;
      const btn = $('#printBtn');
      btn.disabled = true;
      btn.textContent = 'Printing…';
      try {
        await printBitmap(state.bitmap, state.copies);
        if (S.connection !== 'browser') toast('Sent to the printer.');
      } catch (e) { toast(printError(e), true); }
      btn.disabled = false;
      btn.textContent = 'Print';
      bumpIdle();
    };
    $('#saveBtn').onclick = () => {
      if (!state.bitmap) return;
      const a = document.createElement('a');
      a.href = bitmapDataUrl(state.bitmap);
      a.download = `receipt-${String(state.orderNo).padStart(4, '0')}.png`;
      a.click();
    };

    // Settings + PIN
    $('#gear').onclick = () => {
      if (!S.pin) return openSettings();
      $('#pinInput').value = '';
      $('#pinErr').hidden = true;
      $('#pinDlg').showModal();
      $('#pinInput').focus();
    };
    $('#pinCancel').onclick = () => $('#pinDlg').close();
    $('#pinOk').onclick = (e) => {
      if ($('#pinInput').value !== S.pin) {
        e.preventDefault();
        $('#pinErr').hidden = false;
        $('#pinInput').value = '';
        return;
      }
      setTimeout(openSettings, 0);
    };
    $('#settingsClose').onclick = () => {
      $('#settingsDlg').close();
      applyBranding();
      video.classList.toggle('mirror', !!S.mirror);
      if (state.screen === 'result' && state.shots.length) renderReceipt();
    };
    $$('[data-k]').forEach((el) => {
      const handler = () => { readSetting(el); refreshTestPreview(); if (el.dataset.k === 'connection') updatePrinterStatus(); };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    $('#connectBtn').onclick = async () => {
      try { await printer.connect(S.connection, S); toast('Printer connected.'); }
      catch (e) { toast(printError(e), true); }
      updatePrinterStatus();
    };
    $('#testBtn').onclick = async () => {
      try {
        await compose.loadFonts(S);
        await printBitmap(testBitmap(), 1);
        if (S.connection !== 'browser') toast('Test page sent to the printer.');
      } catch (e) { toast(printError(e), true); }
      updatePrinterStatus();
    };
    $('#fsBtn').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => toast('Full screen is not available here.', true));
    };
    $('#resetBtn').onclick = () => { S = Object.assign({}, DEFAULTS); saveSettings(); fillSettings(); refreshTestPreview(); };

    // Idle return + screen wake lock
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, true));
    setInterval(() => {
      const left = Math.ceil((state.idleAt - Date.now()) / 1000);
      $('#idleNote').textContent = state.screen === 'result' && left <= 30 && left > 0 ? `Closing in ${left}s` : '';
      if (left > 0 || state.screen === 'welcome' || state.running) return;
      if ($('#settingsDlg').open || $('#pinDlg').open) return bumpIdle();
      goHome();
    }, 1000);
    let lock = null;
    const keepAwake = async () => {
      try { if (navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request('screen'); lock.onrelease = () => (lock = null); } }
      catch (e) { /* not critical */ }
    };
    document.addEventListener('pointerdown', keepAwake);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    applyBranding();
    bumpIdle();
    printer.restore(S.connection, S).then(updatePrinterStatus);
  }

  init();
})();
