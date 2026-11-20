/* LWH Offline Receiving - capture BOL info, BOL photos and scanned units; send to the office via Apps Script. */
(function () {
  'use strict';
  const APP_VERSION = '1.2.0';
  const CFG = window.LWH_CONFIG;
  const FIELDS = CFG.unitFields;
  // Unit table shows the unique field (VIN) first so it's visible on a phone without scrolling
  const TFIELDS = FIELDS.filter((f) => f.unique).concat(FIELDS.filter((f) => !f.unique));
  const $ = (id) => document.getElementById(id);

  // ---------- small helpers ----------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const norm = (s) => String(s || '').trim().toUpperCase();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ---------- VIN ----------
  const VIN_VAL = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  function vinCheck(v) {
    let sum = 0;
    for (let i = 0; i < 17; i++) { const c = v[i]; sum += (/\d/.test(c) ? +c : VIN_VAL[c]) * VIN_W[i]; }
    const r = sum % 11;
    return (r === 10 ? 'X' : String(r)) === v[8];
  }
  // 10th character = model year. Codes repeat every 30 years; take the latest year not past next year.
  const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  function vinYear(v) {
    const i = YEAR_CODES.indexOf((v || '')[9]);
    if (i < 0) return '';
    const max = new Date().getFullYear() + 1;
    let y = 1980 + i;
    while (y + 30 <= max) y += 30;
    return String(y);
  }

  // ---------- settings ----------
  const SKEY = 'lwhrcv-settings';
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { settings = {}; }
  const saveSettingsLocal = () => localStorage.setItem(SKEY, JSON.stringify(settings));
  // The built-in server (config.js) is used unless a device has its own link saved under Advanced.
  const SRV = CFG.server || {};
  const srvUrl = () => settings.url || SRV.url || '';
  const srvKey = () => settings.key || SRV.key || '';
  const configured = () => !!(srvUrl() && srvKey());

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('lwh-receiving', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('receipts', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('receipts', mode);
      const st = t.objectStore('receipts');
      const out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage aborted'));
    });
  }
  const dbAll = () => tx('readonly', (s) => s.getAll());
  const dbPut = (r) => tx('readwrite', (s) => s.put(r));
  const dbDel = (id) => tx('readwrite', (s) => s.delete(id));

  let receipts = [];
  let current = null;
  let editingHead = false;

  // Any change after "Send" was pressed (but before it went through) puts the receipt back in progress,
  // so a half-finished receipt never auto-sends.
  function edited() { if (current && (current.status === 'queued' || current.status === 'failed')) current.status = 'draft'; }
  async function persist(r) {
    r.updatedAt = new Date().toISOString();
    try { await dbPut(r); } catch (e) {
      alert('Could not save on this device (storage may be full). Send or delete older receipts. ' + (e && e.message ? e.message : ''));
      throw e;
    }
    updateQueuePill();
  }

  // ---------- elements ----------
  const views = { home: $('viewHome'), form: $('viewForm'), receipt: $('viewReceipt') };
  function show(name) {
    Object.entries(views).forEach(([k, v]) => { v.hidden = k !== name; });
    $('backBtn').hidden = name === 'home';
    window.scrollTo(0, 0);
  }

  // ---------- feedback ----------
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = ok ? 'sine' : 'square';
      o.frequency.value = ok ? 1250 : 220;
      g.gain.value = 0.12;
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (ok ? 0.09 : 0.35));
    } catch (e) { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [120, 60, 120]);
  }
  function flash(ok) {
    const b = $('scanBox');
    b.classList.remove('flash-ok', 'flash-err'); void b.offsetWidth;
    b.classList.add(ok ? 'flash-ok' : 'flash-err');
  }
  function scanMsg(text, kind) {
    const m = $('scanMsg');
    m.textContent = text;
    m.className = 'scan-msg' + (kind ? ' ' + kind : '');
  }

  // ---------- HOME ----------
  const STATUS_LABEL = { draft: 'In progress', queued: 'Waiting for signal', sending: 'Sending', failed: 'Not sent', sent: 'Sent' };
  function renderHome() {
    current = null;
    show('home');
    $('setupWarn').hidden = configured();
    $('sName').value = settings.name || '';
    $('sSite').value = settings.site || '';
    $('sUrl').value = settings.url || '';
    $('sKey').value = settings.key || '';
    const list = $('receiptList');
    const sorted = receipts.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (!sorted.length) {
      list.innerHTML = '<div class="empty">No receipts yet. Tap <strong>Start new receipt</strong> when a trailer is ready to unload.</div>';
    } else {
      list.innerHTML = sorted.map((r) => {
        const st = r.status || 'draft';
        return '<button class="load-item ' + (st === 'sent' ? 'sent' : '') + '" data-id="' + esc(r.id) + '">' +
          '<div><div class="li-title">BOL ' + esc(r.bol) +
          '<span class="li-status ' + esc(st) + '">' + esc(STATUS_LABEL[st] || st) + '</span></div>' +
          '<div class="li-sub">' + esc(r.customer) + (r.carrier ? ' | ' + esc(r.carrier) : '') + ' | ' + esc(fmtDate(r.createdAt)) +
          (r.serverRef ? ' | ' + esc(r.serverRef) : '') + '</div></div>' +
          '<div class="li-count"><strong>' + r.units.length + '</strong>units, ' + r.photos.length + ' photos</div>' +
          '</button>';
      }).join('');
    }
    storageInfo();
  }
  async function storageInfo() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        $('storageInfo').textContent = 'Device storage used by this app: ' + (e.usage / 1048576).toFixed(1) + ' MB';
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- HEADER FORM ----------
  const HEAD = [['fBol', 'bol'], ['fCustomer', 'customer'], ['fCarrier', 'carrier'], ['fTrailer', 'trailer'],
    ['fPo', 'po'], ['fSeal', 'seal'], ['fExpected', 'expected'], ['fNotes', 'notes']];
  function openForm(edit) {
    editingHead = !!edit;
    $('formTitle').textContent = edit ? 'Edit BOL info' : 'New receipt';
    $('formMsg').textContent = '';
    HEAD.forEach(([id, k]) => { $(id).value = edit && current ? (current[k] == null ? '' : current[k]) : ''; });
    if (!edit && settings.lastCustomer) $('fCustomer').value = settings.lastCustomer;
    show('form');
    $('fBol').focus();
  }
  async function submitForm(ev) {
    ev.preventDefault();
    const v = {};
    HEAD.forEach(([id, k]) => { v[k] = $(id).value.trim(); });
    v.bol = v.bol.toUpperCase();
    if (!v.bol) { $('formMsg').textContent = 'Enter the BOL number.'; $('fBol').focus(); return; }
    if (!v.customer) { $('formMsg').textContent = 'Enter the customer.'; $('fCustomer').focus(); return; }
    if (v.expected && !/^\d{1,5}$/.test(v.expected)) { $('formMsg').textContent = 'Units on BOL must be a whole number.'; $('fExpected').focus(); return; }
    const dup = receipts.find((r) => norm(r.bol) === v.bol && (!editingHead || r.id !== current.id));
    if (dup && !confirm('BOL ' + v.bol + ' is already on this device (' + (STATUS_LABEL[dup.status] || '') + '). Start another receipt for it anyway?')) return;
    if (editingHead && current) {
      Object.assign(current, v);
      edited();
    } else {
      current = {
        id: uid(), ...v, status: 'draft', units: [], photos: [],
        receivedBy: settings.name || '', site: settings.site || '',
        createdAt: new Date().toISOString()
      };
      receipts.push(current);
    }
    settings.lastCustomer = v.customer; saveSettingsLocal();
    await persist(current);
    openReceipt(current);
  }

  // ---------- RECEIPT VIEW ----------
  const locked = () => current && (current.status === 'sent' || current.status === 'sending');
  function openReceipt(r) {
    current = r;
    show('receipt');
    renderReceipt();
    resetUnitForm(true);
    if (!locked()) focusNext(-1);
  }
  function renderReceipt() {
    const r = current;
    $('hBol').textContent = r.bol;
    $('hCustomer').textContent = r.customer;
    $('hCarrier').textContent = [r.carrier, r.trailer].filter(Boolean).join(' / ') || '-';
    $('hPo').textContent = [r.po, r.seal].filter(Boolean).join(' / ') || '-';
    $('sUnits').textContent = r.units.length;
    $('sUnitsLbl').textContent = r.expected ? 'of ' + r.expected + ' units' : 'units';
    $('sPhotos').textContent = r.photos.length;
    const lk = locked();
    $('lockedBanner').hidden = r.status !== 'sent';
    $('editHeadBtn').hidden = lk;
    $('photoCard').querySelector('.photo-btns').hidden = lk;
    $('scanBox').hidden = lk;
    renderPhotos(); renderUnits(); renderSend();
  }

  // ---------- PHOTOS ----------
  function renderPhotos() {
    const lk = locked();
    $('photoGrid').innerHTML = current.photos.map((p, i) =>
      '<div class="photo"><img src="' + p.dataUrl + '" alt="' + esc(p.kind) + ' photo ' + (i + 1) + '">' +
      '<span class="ph-tag">' + (p.kind === 'Label' ? 'Unit #' + esc(p.unitN) : esc(p.kind) + ' ' + (i + 1)) + '</span>' +
      (lk ? '' : '<button class="ph-del" data-id="' + esc(p.id) + '" aria-label="Remove photo">Remove</button>') + '</div>').join('') ||
      '<div class="empty" style="grid-column:1/-1">No photos yet.</div>';
  }
  function compress(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = CFG.photo.maxSide;
        let w = img.naturalWidth, h = img.naturalHeight;
        const s = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * s); h = Math.round(h * s);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        res({ dataUrl: c.toDataURL('image/jpeg', CFG.photo.quality), w, h });
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }
  async function addPhoto(input, kind) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || !current || locked()) return;
    if (current.photos.length >= CFG.photo.maxPerReceipt) { alert('This receipt already has ' + CFG.photo.maxPerReceipt + ' photos.'); return; }
    try {
      const p = await compress(file);
      current.photos.push({ id: uid(), kind, ...p, takenAt: new Date().toISOString() });
      edited();
      await persist(current);
      renderReceipt();
      beep(true);
    } catch (e) { alert(e.message || 'Could not add the photo.'); }
  }

  // Label photo for the unit being scanned; attached when the unit saves
  let pendingPhoto = null;
  function renderPending() {
    const box = $('unitPhotoState'); if (!box) return;
    box.innerHTML = pendingPhoto ? '<img src="' + pendingPhoto.dataUrl + '" alt="Label photo for this unit"> Label photo ready, saves with this unit. <button type="button" id="dropPending" class="btn btn-small">Retake / remove</button>' : '';
    $('unitPhotoBtnLbl').textContent = pendingPhoto ? 'Retake label photo' : 'Take label photo (optional)';
  }
  async function takeUnitPhoto(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || !current || locked()) return;
    try { pendingPhoto = await compress(file); renderPending(); beep(true); } catch (e) { alert(e.message || 'Could not add the photo.'); }
    const next = FIELDS.findIndex((f, j) => inFlow(j) && !inp(j).value.trim());
    if (next >= 0) inp(next).focus();
  }

  // ---------- UNIT FORM ----------
  function buildUnitFields() {
    $('unitFields').innerHTML = FIELDS.map((f, i) =>
      '<div class="scan-field" data-i="' + i + '">' +
      '<label for="u_' + f.key + '">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') +
      (f.auto === 'vinYear' ? ' <span class="meta">(fills in from the VIN)</span>' : '') + '</label>' +
      '<div class="in-row"><input id="u_' + f.key + '" class="scan-in" data-i="' + i + '" autocomplete="off" spellcheck="false" ' +
      (f.type === 'number' || f.type === 'year' ? 'inputmode="decimal" ' : f.type === 'date' ? 'inputmode="numeric" placeholder="2026-05-14" ' : 'autocapitalize="characters" ') +
      'enterkeyhint="next">' +
      (f.camera ? '<button type="button" class="cam-btn" data-target="u_' + f.key + '">Camera</button>' : '') + '</div>' +
      (f.keep ? '<label class="keep"><input type="checkbox" id="k_' + f.key + '"' + (f.keepDefault ? ' checked' : '') + '> Keep for next unit</label>' : '') +
      '</div>').join('');
    $('unitHead').innerHTML = '<tr><th>#</th>' + TFIELDS.map((f) => '<th' + (f.hideSm ? ' class="hide-sm"' : '') + '>' + esc(f.label) + '</th>').join('') +
      (CFG.unitPhoto ? '<th>Photo</th>' : '') + '<th class="hide-sm">Time</th><th></th></tr>';
    $('unitPhotoRow').hidden = !CFG.unitPhoto;
    FIELDS.forEach((f, i) => {
      const el = $('u_' + f.key);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onFieldEnter(i); } });
      el.addEventListener('focus', () => markActive(i));
    });
  }
  const inp = (i) => $('u_' + FIELDS[i].key);
  const kept = (i) => { const k = $('k_' + FIELDS[i].key); return !!(k && k.checked); };
  function markActive(i) {
    document.querySelectorAll('#unitFields .scan-field').forEach((d) => {
      const j = +d.dataset.i;
      d.classList.toggle('active', j === i);
      d.classList.toggle('done', j !== i && !!inp(j).value.trim());
    });
  }
  function cleanValue(f, raw) {
    let v = String(raw || '').replace(/[\r\n\t]/g, '').trim();
    (f.strip || []).forEach((p) => { if (p && v.toUpperCase().startsWith(p.toUpperCase()) && v.length > p.length) v = v.slice(p.length); });
    if (f.type !== 'number' && f.type !== 'year' && f.key !== 'notes') v = v.toUpperCase();
    if (f.type === 'vin') {
      v = v.replace(/[\s-]/g, '');
      if (v.length === 18 && v[0] === 'I') v = v.slice(1); // some VIN barcodes carry a leading "I"
    }
    if (f.type === 'date' && v) {
      let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
      if (m) v = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
      else if ((m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
        const yy = m[3].length === 2 ? '20' + m[3] : m[3];
        v = yy + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
      } else if ((m = v.match(/^(\d{4})(\d{2})(\d{2})$/))) v = m[1] + '-' + m[2] + '-' + m[3];
    }
    return v;
  }
  function checkField(f, v) {
    if (!v) return f.required ? f.label + ' is required.' : null;
    if (f.type === 'number') {
      const n = Number(v.replace(/,/g, ''));
      if (!isFinite(n)) return f.label + ' must be a number. Was a different label scanned?';
      if (f.min != null && n < f.min || f.max != null && n > f.max) return f.label + ' must be between ' + f.min + ' and ' + f.max + '.';
    }
    if (f.type === 'vin') {
      if (v.length !== 17) return 'VIN must be 17 characters (this one has ' + v.length + '). Was a different barcode scanned?';
      if (/[IOQ]/.test(v)) return 'VIN cannot contain the letters I, O or Q. Check for a typo (1 vs I, 0 vs O).';
      if (!/^[A-Z0-9]{17}$/.test(v)) return 'VIN can only have letters and numbers.';
      if (CFG.vinCheckDigit && !vinCheck(v)) return 'VIN ' + v + ' fails the check digit: one character is wrong. Rescan or check the label.';
    }
    if (f.type === 'date') {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m && new Date(+m[1], +m[2] - 1, +m[3]);
      if (!d || d.getMonth() !== +m[2] - 1 || +m[1] < 2000 || +m[1] > 2040) return f.label + ' should look like 2026-05-14.';
    }
    if (f.type === 'year') {
      if (!/^\d{4}$/.test(v)) return f.label + ' must be a 4-digit year.';
      const n = +v; if (n < f.min || n > f.max) return f.label + ' must be between ' + f.min + ' and ' + f.max + '.';
    }
    return null;
  }
  function inFlow(i) { const f = FIELDS[i]; return f.key !== 'notes' && f.flow !== false && !f.auto; }
  function fillAuto() {
    FIELDS.forEach((f, j) => {
      if (f.auto !== 'vinYear') return;
      const vf = FIELDS.findIndex((x) => x.type === 'vin');
      const y = vf >= 0 ? vinYear(inp(vf).value) : '';
      if (y) inp(j).value = y;
    });
  }
  // Move to the next field that still needs a value; returns false when nothing is left.
  function focusNext(from) {
    for (let j = from + 1; j < FIELDS.length; j++) {
      if (inFlow(j) && !inp(j).value.trim()) { inp(j).focus(); return true; }
    }
    for (let j = 0; j <= from; j++) {
      if (inFlow(j) && FIELDS[j].required && !inp(j).value.trim()) { inp(j).focus(); return true; }
    }
    return false;
  }
  function onFieldEnter(i) {
    const el = inp(i);
    const raw = el.value;
    const combo = CFG.parseCombinedScan ? CFG.parseCombinedScan(raw.trim()) : null;
    if (combo && typeof combo === 'object') {
      FIELDS.forEach((f, j) => { if (combo[f.key] != null) inp(j).value = cleanValue(f, combo[f.key]); });
    } else {
      el.value = cleanValue(FIELDS[i], raw);
    }
    const err = checkField(FIELDS[i], el.value);
    if (err) { scanMsg(err, 'err'); beep(false); flash(false); el.select(); return; }
    if (FIELDS[i].unique && el.value) {
      const d = findDup(FIELDS[i].key, el.value);
      if (d) { scanMsg(d, 'err'); beep(false); flash(false); el.select(); return; }
    }
    if (FIELDS[i].type === 'vin') fillAuto();
    if (!focusNext(i)) saveUnit();
    else scanMsg(FIELDS[i].label + ': ' + (el.value || '(blank)') +
      (FIELDS[i].type === 'vin' && vinYear(el.value) ? ' (model year ' + vinYear(el.value) + ')' : ''), '');
  }
  function findDup(key, value) {
    const k = norm(value);
    const hit = current.units.find((u) => norm(u[key]) === k);
    if (hit) return 'Duplicate: ' + value + ' is already unit #' + hit.n + ' on this receipt.';
    for (const r of receipts) {
      if (r.id === current.id) continue;
      const u = r.units.find((x) => norm(x[key]) === k);
      if (u) return 'Duplicate: ' + value + ' was already received on BOL ' + r.bol + ' (' + fmtDate(u.scannedAt) + ').';
    }
    return null;
  }
  async function saveUnit() {
    if (!current || locked()) return;
    const u = { id: uid(), scannedAt: new Date().toISOString() };
    fillAuto();
    for (let i = 0; i < FIELDS.length; i++) {
      const f = FIELDS[i];
      const v = cleanValue(f, inp(i).value);
      inp(i).value = v;
      const err = checkField(f, v);
      if (err) { scanMsg(err, 'err'); beep(false); flash(false); inp(i).focus(); inp(i).select(); return; }
      if (f.unique && v) { const d = findDup(f.key, v); if (d) { scanMsg(d, 'err'); beep(false); flash(false); inp(i).focus(); inp(i).select(); return; } }
      u[f.key] = f.type === 'number' && v ? String(Number(v.replace(/,/g, ''))) : v;
    }
    u.n = current.units.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    current.units.push(u);
    if (pendingPhoto) {
      const vk = (FIELDS.find((f) => f.type === 'vin') || FIELDS.find((f) => f.unique) || FIELDS[0]).key;
      current.photos.push({ id: uid(), kind: 'Label', unitId: u.id, unitN: u.n, ref: u[vk] || '', ...pendingPhoto, takenAt: u.scannedAt });
      u.photo = true;
      pendingPhoto = null;
    }
    edited();
    await persist(current);
    lastSavedId = u.id;
    renderReceipt();
    resetUnitForm(false);
    const idKey = (FIELDS.find((f) => f.unique) || FIELDS[0]).key;
    const over = current.expected && current.units.length > +current.expected ? ' More units than the BOL shows (' + current.expected + ').' : '';
    scanMsg('Saved unit #' + u.n + ': ' + (u[idKey] || '') + '.' + over + ' Scan the next unit.', over ? 'err' : 'ok');
    beep(!over); flash(!over);
    focusNext(-1);
  }
  function resetUnitForm(full) {
    pendingPhoto = null; renderPending();
    FIELDS.forEach((f, i) => { if (full || !kept(i)) inp(i).value = ''; });
    if (full) scanMsg(current && current.units.length ? 'Ready for the next unit.' : 'Ready for the first unit.', '');
    markActive(-1);
  }

  let lastSavedId = null;
  function renderUnits() {
    const r = current, lk = locked();
    $('unitCountLbl').textContent = '(' + r.units.length + (r.expected ? ' of ' + r.expected : '') + ')';
    const rows = r.units.slice().sort((a, b) => b.n - a.n);
    $('unitBody').innerHTML = rows.length ? rows.map((u) =>
      '<tr class="' + (u.id === lastSavedId ? 'fresh' : '') + '"><td>' + u.n + '</td>' +
      TFIELDS.map((f) => '<td' + (f.hideSm ? ' class="hide-sm"' : '') + '>' + esc(u[f.key]) + '</td>').join('') +
      (CFG.unitPhoto ? '<td>' + (u.photo ? 'Yes' : '-') + '</td>' : '') +
      '<td class="hide-sm">' + esc(fmtTime(u.scannedAt)) + '</td>' +
      '<td>' + (lk ? '' : '<button class="del-btn" data-id="' + esc(u.id) + '">Remove</button>') + '</td></tr>').join('')
      : '<tr><td colspan="' + (FIELDS.length + 4) + '" class="meta">No units scanned yet.</td></tr>';
  }

  // ---------- SEND ----------
  function checks() {
    const r = current;
    const bolPhotos = r.photos.filter((p) => p.kind === 'BOL').length;
    const out = [
      [!!r.bol, 'BOL number: ' + (r.bol || 'missing')],
      [bolPhotos > 0, bolPhotos ? bolPhotos + ' BOL photo' + (bolPhotos > 1 ? 's' : '') : 'No BOL photo yet'],
      [r.units.length > 0, r.units.length + ' unit' + (r.units.length === 1 ? '' : 's') + ' scanned' +
        (CFG.unitPhoto && r.units.length ? ' (' + r.units.filter((u) => u.photo).length + ' with label photo)' : '')],
    ];
    if (r.expected) out.push([+r.expected === r.units.length, 'BOL shows ' + r.expected + ', scanned ' + r.units.length]);
    out.push([configured(), configured() ? 'Server link is set' : 'Server link not set (Settings on the home screen)']);
    return out;
  }
  function renderSend() {
    const r = current;
    $('checklist').innerHTML = checks().map(([ok, t]) => '<li class="' + (ok ? '' : 'no') + '">' + esc(t) + '</li>').join('');
    const st = r.status;
    $('sendBtn').hidden = st === 'sent';
    $('sendBtn').textContent = st === 'failed' || st === 'queued' ? 'Try sending again' : 'Send to office';
    let html = '';
    if (st === 'sent') {
      html = '<div class="sent-box"><strong>Sent ' + esc(fmtDate(r.sentAt)) + '</strong>' +
        (r.serverRef ? '<br>Office reference: <strong>' + esc(r.serverRef) + '</strong>' : '') +
        (r.emailedTo ? '<br>Emailed to: ' + esc(r.emailedTo) : '') + '</div>';
    } else if (st === 'queued') {
      html = '<div class="fail-box">No signal when you sent this. It is saved and will send automatically when the device has signal.</div>';
    } else if (st === 'failed') {
      html = '<div class="fail-box">Not sent: ' + esc(r.lastError || 'unknown error') + '</div>';
    }
    $('sendResult').innerHTML = html;
    $('deleteBtn').hidden = st === 'sending';
  }
  async function onSend() {
    const r = current;
    if (!configured()) { alert('Set the server link and access key under Settings on the home screen first.'); return; }
    if (!r.photos.some((p) => p.kind === 'BOL') && !confirm('There is no BOL photo. Send anyway?')) return;
    if (!r.units.length && !confirm('No units are scanned. Send just the BOL info and photos?')) return;
    if (r.expected && +r.expected !== r.units.length &&
      !confirm('The BOL shows ' + r.expected + ' units and ' + r.units.length + (r.units.length === 1 ? ' is' : ' are') + ' scanned. Send anyway? (Add a note in the BOL info if this is a known short or over.)')) return;
    await sendReceipt(r, true);
    if (current === r) renderReceipt();
  }

  function payload(r) {
    return JSON.stringify({
      action: 'submit', key: srvKey(), appVersion: APP_VERSION,
      fields: FIELDS.map((f) => ({ key: f.key, label: f.label })),
      receipt: {
        id: r.id, bol: r.bol, customer: r.customer, carrier: r.carrier, trailer: r.trailer, po: r.po, seal: r.seal,
        expected: r.expected, notes: r.notes, receivedBy: r.receivedBy || settings.name || '', site: r.site || settings.site || '',
        createdAt: r.createdAt, sentAt: new Date().toISOString(),
        units: r.units.map((u) => { const o = { n: u.n, scannedAt: u.scannedAt }; FIELDS.forEach((f) => { o[f.key] = u[f.key] || ''; }); return o; })
      },
      photos: r.photos.map((p, i) => ({
        name: p.kind === 'Label'
          ? 'Unit' + String(p.unitN).padStart(3, '0') + '-' + String(p.ref || '').replace(/[^A-Za-z0-9-]/g, '') + '-label.jpg'
          : 'BOL-' + r.bol.replace(/[^A-Za-z0-9-]/g, '') + '-' + p.kind + '-' + (r.photos.slice(0, i + 1).filter((x) => x.kind === p.kind).length) + '.jpg',
        kind: p.kind, mime: 'image/jpeg', data: p.dataUrl.split(',')[1]
      }))
    });
  }
  async function post(body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 120000);
    try {
      const res = await fetch(srvUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, signal: ctl.signal, redirect: 'follow' });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch (e) { throw Object.assign(new Error('The server sent back something unexpected. Check the server link and that the web app is deployed for "Anyone".'), { server: true }); }
      if (!j.ok) throw Object.assign(new Error(j.error || 'Server refused the receipt.'), { server: true });
      return j;
    } finally { clearTimeout(t); }
  }
  let busyTimer = null;
  function busy(on, text) {
    $('busy').hidden = !on;
    clearInterval(busyTimer);
    if (on) {
      $('busyText').textContent = text || 'Sending to office...';
      let w = 5; $('busyBar').style.width = w + '%';
      busyTimer = setInterval(() => { w = Math.min(92, w + (95 - w) * 0.08); $('busyBar').style.width = w + '%'; }, 400);
    }
  }
  let sendingNow = false;
  async function sendReceipt(r, interactive) {
    if (sendingNow) { if (interactive) alert('A receipt is sending right now. Try again in a moment.'); return; }
    if (!navigator.onLine) {
      r.status = 'queued'; await persist(r);
      if (interactive) { beep(false); alert('No signal right now. The receipt is saved and will send automatically when the device has signal.'); }
      return;
    }
    sendingNow = true;
    const prev = r.status;
    r.status = 'sending'; await persist(r);
    if (interactive) busy(true, 'Sending BOL ' + r.bol + ' to the office...');
    try {
      const j = await post(payload(r));
      r.status = 'sent'; r.sentAt = new Date().toISOString(); r.serverRef = j.receiptNo || ''; r.emailedTo = j.emailedTo || ''; r.lastError = '';
      await persist(r);
      if (interactive) { busy(false); beep(true); }
    } catch (e) {
      const network = !e.server;
      r.status = network ? 'queued' : 'failed';
      r.lastError = network ? 'No connection to the server (' + (e.name === 'AbortError' ? 'timed out' : 'network') + ').' : e.message;
      if (prev === 'failed' && network) r.status = 'queued';
      await persist(r);
      if (interactive) { busy(false); beep(false); }
    } finally { sendingNow = false; }
  }
  async function sendWaiting(manual) {
    if (!configured() || !navigator.onLine) { if (manual) setSettingsMsg(configured() ? 'No signal right now.' : 'Save the server link and key first.', true); return; }
    const waiting = receipts.filter((r) => r.status === 'queued' || (manual && r.status === 'failed'));
    if (manual && !waiting.length) { setSettingsMsg('Nothing waiting to send.'); return; }
    for (const r of waiting) await sendReceipt(r, false);
    if (manual) {
      const sent = waiting.filter((r) => r.status === 'sent').length;
      setSettingsMsg(sent + ' of ' + waiting.length + ' sent.', sent !== waiting.length);
    }
    if (current) renderReceipt(); else if (!views.home.hidden) renderHome();
  }
  function updateQueuePill() {
    const n = receipts.filter((r) => r.status === 'queued' || r.status === 'failed').length;
    $('queuePill').hidden = !n;
    $('queuePill').textContent = n + ' to send';
  }

  // ---------- CSV ----------
  function csvCell(v) { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function downloadCsv(r) {
    const head = ['BOL', 'Customer', 'Carrier', 'Trailer', 'PO', 'Line'].concat(FIELDS.map((f) => f.label)).concat(['Scanned at']);
    const lines = [head.map(csvCell).join(',')].concat(r.units.slice().sort((a, b) => a.n - b.n).map((u) =>
      [r.bol, r.customer, r.carrier, r.trailer, r.po, u.n].concat(FIELDS.map((f) => u[f.key])).concat([new Date(u.scannedAt).toLocaleString()]).map(csvCell).join(',')));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'BOL-' + r.bol + '-units.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- camera ----------
  let cam = null, camTarget = null;
  async function openCamera(targetId) {
    if (typeof Html5Qrcode === 'undefined') return alert('Camera scanning is not available on this device.');
    camTarget = targetId;
    const lbl = document.querySelector('label[for="' + targetId + '"]');
    $('camTitle').textContent = 'Scan ' + (targetId === 'fBol' ? 'BOL number' : (lbl ? lbl.textContent.replace('*', '').trim() : ''));
    $('camHint').textContent = 'Hold the barcode flat and fill the box.';
    $('camOverlay').hidden = false;
    const F = Html5QrcodeSupportedFormats;
    cam = new Html5Qrcode('camReader', {
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.QR_CODE, F.DATA_MATRIX, F.PDF_417, F.EAN_13, F.UPC_A, F.ITF],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false
    });
    try {
      await cam.start({ facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h, w) * 0.5) }) },
        onCamResult, () => {});
    } catch (e) {
      $('camHint').textContent = 'Could not start the camera. Allow camera access in the browser settings, or type the value.';
    }
  }
  async function closeCamera() {
    if (cam) { try { await cam.stop(); } catch (e) { /* not running */ } try { cam.clear(); } catch (e) { /* ignore */ } cam = null; }
    $('camOverlay').hidden = true;
  }
  async function onCamResult(text) {
    const t = camTarget;
    await closeCamera();
    const el = $(t);
    el.value = text;
    if (t === 'fBol') { el.value = text.trim().toUpperCase(); $('fCustomer').focus(); return; }
    const i = +el.dataset.i;
    onFieldEnter(i);
  }

  // ---------- header clock + weather ----------
  const WX = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
    95: 'Storms', 96: 'Storms, hail', 99: 'Storms, hail' };
  function tick() { $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  async function weather() {
    try {
      const w = CFG.weather;
      const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.lat + '&longitude=' + w.lon +
        '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&forecast_days=1';
      const j = await (await fetch(u)).json();
      $('wxNow').textContent = Math.round(j.current.temperature_2m) + '°F ' + (WX[j.current.weather_code] || '');
      const rain = j.daily.precipitation_probability_max && j.daily.precipitation_probability_max[0];
      $('wxDay').textContent = 'H ' + Math.round(j.daily.temperature_2m_max[0]) + ' / L ' + Math.round(j.daily.temperature_2m_min[0]) + (rain ? ' | ' + rain + '% rain' : '');
    } catch (e) { /* weather is optional */ }
  }

  // ---------- network ----------
  function net() {
    const on = navigator.onLine;
    $('netPill').textContent = on ? 'Online' : 'No signal';
    $('netPill').className = 'pill ' + (on ? 'pill-ok' : 'pill-bad');
    if (on) sendWaiting(false);
  }

  function setSettingsMsg(t, err) { const m = $('settingsMsg'); m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); }

  // ---------- events ----------
  $('backBtn').addEventListener('click', () => { closeCamera(); renderHome(); });
  $('newBtn').addEventListener('click', () => openForm(false));
  $('headForm').addEventListener('submit', submitForm);
  $('formCancel').addEventListener('click', () => { editingHead && current ? openReceipt(current) : renderHome(); });
  // Enter in a header field moves to the next one (scanner suffix)
  HEAD.forEach(([id], i) => {
    if (id === 'fNotes') return;
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = HEAD[i + 1];
      if (next && next[0] !== 'fNotes') $(next[0]).focus(); else $('headForm').requestSubmit();
    });
  });
  $('receiptList').addEventListener('click', (e) => {
    const b = e.target.closest('.load-item'); if (!b) return;
    const r = receipts.find((x) => x.id === b.dataset.id); if (r) openReceipt(r);
  });
  $('editHeadBtn').addEventListener('click', () => openForm(true));
  $('photoBol').addEventListener('change', (e) => addPhoto(e.target, 'BOL'));
  $('photoOther').addEventListener('change', (e) => addPhoto(e.target, 'Other'));
  $('photoUnit').addEventListener('change', (e) => takeUnitPhoto(e.target));
  $('unitPhotoState').addEventListener('click', (e) => { if (e.target.id === 'dropPending') { pendingPhoto = null; renderPending(); } });
  $('photoGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('.ph-del'); if (!b || locked()) return;
    if (!confirm('Remove this photo?')) return;
    const gone = current.photos.find((p) => p.id === b.dataset.id);
    current.photos = current.photos.filter((p) => p.id !== b.dataset.id);
    if (gone && gone.unitId) { const u = current.units.find((x) => x.id === gone.unitId); if (u) u.photo = false; }
    edited();
    await persist(current); renderReceipt();
  });
  $('saveUnitBtn').addEventListener('click', saveUnit);
  $('clearUnitBtn').addEventListener('click', () => { resetUnitForm(true); focusNext(-1); });
  $('unitBody').addEventListener('click', async (e) => {
    const b = e.target.closest('.del-btn'); if (!b || locked()) return;
    const u = current.units.find((x) => x.id === b.dataset.id); if (!u) return;
    if (!confirm('Remove unit #' + u.n + (u.photo ? ' and its label photo' : '') + '?')) return;
    current.units = current.units.filter((x) => x.id !== u.id);
    current.photos = current.photos.filter((p) => p.unitId !== u.id);
    edited();
    await persist(current); renderReceipt();
    scanMsg('Removed unit #' + u.n + '.', '');
  });
  $('csvBtn').addEventListener('click', () => downloadCsv(current));
  $('sendBtn').addEventListener('click', onSend);
  $('deleteBtn').addEventListener('click', async () => {
    const r = current;
    const msg = r.status === 'sent' ? 'Remove BOL ' + r.bol + ' from this device? (The office copy is not affected.)'
      : 'Delete BOL ' + r.bol + '? It has NOT been sent. ' + r.units.length + ' units and ' + r.photos.length + ' photos will be lost.';
    if (!confirm(msg)) return;
    if (r.status !== 'sent' && (prompt('Type DELETE to confirm.') || '').trim().toUpperCase() !== 'DELETE') return;
    await dbDel(r.id);
    receipts = receipts.filter((x) => x.id !== r.id);
    updateQueuePill(); renderHome();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.cam-btn'); if (!b) return;
    e.preventDefault(); openCamera(b.dataset.target);
  });
  $('camClose').addEventListener('click', closeCamera);

  $('saveSettingsBtn').addEventListener('click', () => {
    settings.name = $('sName').value.trim();
    settings.site = $('sSite').value.trim();
    settings.url = $('sUrl').value.trim();
    settings.key = $('sKey').value.trim();
    if (settings.url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(settings.url)) {
      setSettingsMsg('That link does not look like an Apps Script web app link (it should end in /exec). Saved anyway.', true);
    } else setSettingsMsg('Settings saved.');
    saveSettingsLocal();
    $('setupWarn').hidden = configured();
  });
  $('testBtn').addEventListener('click', async () => {
    $('saveSettingsBtn').click();
    if (!configured()) { setSettingsMsg('Enter the server link and access key first.', true); return; }
    setSettingsMsg('Testing...');
    try {
      const j = await post(JSON.stringify({ action: 'ping', key: srvKey() }));
      setSettingsMsg('Connected. Receipts will email: ' + (j.emailTo || '(not set on server)'));
    } catch (e) { setSettingsMsg('Test failed: ' + e.message, true); }
  });
  $('sendAllBtn').addEventListener('click', () => sendWaiting(true));
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); if (navigator.onLine) sendWaiting(false); } });

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) $('updateBar').hidden = false;
        });
      });
    }).catch(() => {});
    $('reloadBtn').addEventListener('click', () => location.reload());
  }

  // ---------- start ----------
  async function start() {
    $('verLbl').textContent = 'v' + APP_VERSION;
    buildUnitFields();
    try { receipts = await dbAll(); } catch (e) { receipts = []; alert('Device storage is not available. Receipts cannot be saved in this browser mode (private browsing?).'); }
    // A receipt stuck in "sending" (app closed mid-send) goes back to the queue; the server ignores duplicates.
    for (const r of receipts) if (r.status === 'sending') { r.status = 'queued'; await persist(r); }
    // Tidy up old sent receipts
    const cutoff = Date.now() - CFG.keepSentDays * 86400000;
    for (const r of receipts.filter((x) => x.status === 'sent' && Date.parse(x.sentAt) < cutoff)) await dbDel(r.id);
    receipts = receipts.filter((x) => !(x.status === 'sent' && Date.parse(x.sentAt) < cutoff));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    updateQueuePill();
    renderHome();
    tick(); setInterval(tick, 15000);
    weather(); setInterval(weather, 30 * 60000);
    net();
    setInterval(() => { if (navigator.onLine) sendWaiting(false); }, 60000);
  }
  start();
})();
