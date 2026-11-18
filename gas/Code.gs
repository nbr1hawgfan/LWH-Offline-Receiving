/**
 * LWH Offline Receiving - Apps Script backend.
 *
 * Receives a receipt from the PWA (BOL info + scanned units + BOL photos), then:
 *   1. logs it to a Google Sheet (Receipts + Units tabs),
 *   2. saves the photos to a Drive folder per receipt,
 *   3. emails the office a summary with the photos and a units CSV attached.
 *
 * Setup (once):
 *   - Paste this file into a new Apps Script project (script.google.com), save.
 *   - Run setup() once and approve the permissions. Check View > Logs (Execution log) for the
 *     access key, sheet link and folder link it created.
 *   - Project Settings > Script Properties: set OFFICE_EMAILS (comma separated) to the office address(es).
 *   - Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
 *     Copy the /exec URL into the app's Settings along with the ACCESS_KEY.
 *   - After changing this code: Deploy > Manage deployments > edit > Version: New version (keeps the same URL).
 *
 * Script Properties used:
 *   ACCESS_KEY     shared key the app must send (setup() creates one)
 *   OFFICE_EMAILS  who receives receipts, comma separated
 *   CC_EMAILS      optional CC list
 *   SHEET_ID       log spreadsheet (setup() creates one)
 *   FOLDER_ID      root Drive folder for photos (setup() creates one)
 */

const RECEIPT_HEADERS = ['Logged at', 'Receipt no', 'Receipt ID', 'Site', 'BOL', 'Customer', 'Carrier', 'Trailer',
  'PO / reference', 'Seal', 'Units on BOL', 'Units scanned', 'Photos', 'Received by', 'Notes',
  'Started on device', 'Sent from device', 'Photo folder', 'Emailed to', 'App version', 'Entered in WMS'];
const UNIT_BASE_HEADERS = ['Logged at', 'Receipt no', 'BOL', 'Customer', 'Line'];
const MAX_ATTACH_BYTES = 18 * 1024 * 1024; // stay under Gmail's 25 MB limit after encoding

function props_() { return PropertiesService.getScriptProperties(); }

function setup() {
  const p = props_();
  if (!p.getProperty('ACCESS_KEY')) {
    p.setProperty('ACCESS_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 16).toUpperCase());
  }
  if (!p.getProperty('OFFICE_EMAILS')) {
    p.setProperty('OFFICE_EMAILS', Session.getEffectiveUser().getEmail());
  }
  if (!p.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('LWH Offline Receiving Log');
    p.setProperty('SHEET_ID', ss.getId());
  }
  if (!p.getProperty('FOLDER_ID')) {
    const f = DriveApp.createFolder('LWH Offline Receiving Photos');
    p.setProperty('FOLDER_ID', f.getId());
  }
  const ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  receiptsSheet_(ss); unitsSheet_(ss);
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  Logger.log('ACCESS_KEY (enter in the app): ' + p.getProperty('ACCESS_KEY'));
  Logger.log('OFFICE_EMAILS: ' + p.getProperty('OFFICE_EMAILS'));
  Logger.log('Log sheet: ' + ss.getUrl());
  Logger.log('Photo folder: ' + DriveApp.getFolderById(p.getProperty('FOLDER_ID')).getUrl());
  // Trigger the Gmail permission prompt now rather than on the first real receipt.
  Logger.log('Email quota remaining today: ' + MailApp.getRemainingDailyQuota());
}

function doGet() {
  return json_({ ok: true, app: 'LWH Offline Receiving', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const p = props_();
    if (!body.key || body.key !== p.getProperty('ACCESS_KEY')) return json_({ ok: false, error: 'Access key is not correct. Check Settings in the app.' });

    if (body.action === 'ping') return json_({ ok: true, emailTo: p.getProperty('OFFICE_EMAILS') || '' });
    if (body.action === 'submit') return json_(submit_(body));
    return json_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'Server error: ' + (err && err.message || err) });
  }
}

function submit_(body) {
  const r = body.receipt || {};
  if (!r.id || !r.bol) return { ok: false, error: 'Receipt is missing its BOL number.' };
  const fields = Array.isArray(body.fields) ? body.fields : [];
  const units = Array.isArray(r.units) ? r.units : [];
  const photos = Array.isArray(body.photos) ? body.photos : [];
  const p = props_();

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let ss, rs, receiptNo, folder, dupRow = 0;
  try {
    ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
    rs = receiptsSheet_(ss);

    // Same receipt sent twice (retry after a dropped signal): don't log or email it again.
    const last = rs.getLastRow();
    if (last > 1) {
      const ids = rs.getRange(2, 3, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (ids[i][0] === r.id) {
          const row = rs.getRange(i + 2, 1, 1, RECEIPT_HEADERS.length).getValues()[0];
          if (String(row[18]).indexOf('FAILED') !== 0 && row[18] !== 'Sending') return { ok: true, duplicate: true, receiptNo: row[1], emailedTo: row[18] };
          // Logged earlier but the email failed or never finished: try the email again.
          dupRow = i + 2; receiptNo = row[1];
          folder = DriveApp.getFolderById(String(row[17]).split('/folders/')[1].split(/[?#]/)[0]);
          break;
        }
      }
    }

    if (!dupRow) {
      const tz = Session.getScriptTimeZone();
      const now = new Date();
      const seq = Math.max(0, rs.getLastRow() - 1) + 1;
      receiptNo = 'RCV-' + Utilities.formatDate(now, tz, 'yyMMdd') + '-' + ('000' + seq).slice(-4);

      // Photos to Drive
      const root = DriveApp.getFolderById(p.getProperty('FOLDER_ID'));
      folder = root.createFolder(Utilities.formatDate(now, tz, 'yyyy-MM-dd') + ' BOL ' + safe_(r.bol) + ' ' + safe_(r.customer) + ' (' + receiptNo + ')');
      photos.forEach(function (ph, i) {
        const blob = Utilities.newBlob(Utilities.base64Decode(ph.data), ph.mime || 'image/jpeg', ph.name || ('photo-' + (i + 1) + '.jpg'));
        folder.createFile(blob);
      });

      const csv = unitsCsv_(r, fields, units);
      const csvBlob = Utilities.newBlob(csv, 'text/csv', 'BOL-' + safe_(r.bol) + '-units.csv');
      folder.createFile(csvBlob);

      rs.appendRow([now, receiptNo, r.id, r.site || '', r.bol, r.customer || '', r.carrier || '', r.trailer || '',
        r.po || '', r.seal || '', r.expected ? Number(r.expected) : '', units.length, photos.length, r.receivedBy || '', r.notes || '',
        r.createdAt ? new Date(r.createdAt) : '', r.sentAt ? new Date(r.sentAt) : '', folder.getUrl(), 'Sending', body.appVersion || '', false]);
      rs.getRange(rs.getLastRow(), RECEIPT_HEADERS.length).insertCheckboxes();

      writeUnits_(ss, now, receiptNo, r, fields, units);
      SpreadsheetApp.flush();
      dupRow = rs.getLastRow();
    }
  } finally {
    lock.releaseLock();
  }

  // Email (outside the lock). If it fails the receipt is still logged; a retry from the app resends the email.
  const to = props_().getProperty('OFFICE_EMAILS') || Session.getEffectiveUser().getEmail();
  try {
    sendEmail_(r, fields, units, photos, receiptNo, folder, ss);
    rs.getRange(dupRow, 19).setValue(to);
  } catch (err) {
    rs.getRange(dupRow, 19).setValue('FAILED: ' + (err && err.message || err));
    return { ok: false, error: 'Saved to the log as ' + receiptNo + ', but the email did not send (' + (err && err.message || err) + '). Tap Try sending again.' };
  }
  return { ok: true, receiptNo: receiptNo, emailedTo: to };
}

function sendEmail_(r, fields, units, photos, receiptNo, folder, ss) {
  const p = props_();
  const to = p.getProperty('OFFICE_EMAILS') || Session.getEffectiveUser().getEmail();
  const cc = p.getProperty('CC_EMAILS') || '';
  const csvBlob = Utilities.newBlob(unitsCsv_(r, fields, units), 'text/csv', 'BOL-' + safe_(r.bol) + '-units.csv');

  let attach = [csvBlob], total = csvBlob.getBytes().length, skipped = 0;
  photos.forEach(function (ph, i) {
    const b = Utilities.newBlob(Utilities.base64Decode(ph.data), ph.mime || 'image/jpeg', ph.name || ('photo-' + (i + 1) + '.jpg'));
    const n = b.getBytes().length;
    if (total + n <= MAX_ATTACH_BYTES) { attach.push(b); total += n; } else skipped++;
  });

  const subject = 'Received: BOL ' + r.bol + ' | ' + (r.customer || '') + ' | ' + units.length + ' unit' + (units.length === 1 ? '' : 's') +
    (r.site ? ' | ' + r.site : '') + ' | ' + receiptNo;
  MailApp.sendEmail({
    to: to, cc: cc, subject: subject, name: 'LWH Receiving',
    htmlBody: emailHtml_(r, fields, units, photos.length, skipped, receiptNo, folder.getUrl(), ss.getUrl()),
    body: plainText_(r, fields, units, receiptNo, folder.getUrl()),
    attachments: attach
  });
}

// ---------- email ----------
function emailHtml_(r, fields, units, photoCount, skipped, receiptNo, folderUrl, sheetUrl) {
  const tz = Session.getScriptTimeZone();
  const cell = 'padding:8px 10px;border:1px solid #bdbdbd;font-family:Arial,sans-serif;font-size:16px;color:#000000;';
  const th = 'padding:8px 10px;border:1px solid #000000;background:#000000;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;text-align:left;';
  const kv = function (k, v) {
    return '<tr><td style="' + cell + 'background:#f3f3f3;font-weight:bold;width:190px;">' + h_(k) + '</td><td style="' + cell + '">' + h_(v || '-') + '</td></tr>';
  };
  const expected = r.expected ? Number(r.expected) : null;
  const mismatch = expected != null && expected !== units.length;

  let html = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:900px;">' +
    '<tr><td style="background:#C41230;padding:16px 18px;border-bottom:5px solid #000000;font-family:Arial,sans-serif;color:#ffffff;">' +
    '<span style="font-size:26px;font-weight:bold;letter-spacing:1px;">LWH</span>' +
    '<span style="font-size:20px;"> &nbsp;Trailer Received</span></td></tr>' +
    '<tr><td style="padding:16px 0 6px;font-family:Arial,sans-serif;font-size:18px;">' +
    '<b>BOL ' + h_(r.bol) + '</b> for <b>' + h_(r.customer) + '</b>: ' + units.length + ' unit' + (units.length === 1 ? '' : 's') + ' scanned, ' +
    photoCount + ' photo' + (photoCount === 1 ? '' : 's') + '. Please enter into the WMS.</td></tr>';
  if (mismatch) {
    html += '<tr><td style="padding:10px 14px;background:#ffe3e7;border:2px solid #b3001b;font-family:Arial,sans-serif;font-size:17px;color:#b3001b;font-weight:bold;">' +
      'Count check: BOL shows ' + expected + ' units, ' + units.length + ' were scanned.</td></tr>';
  }
  html += '<tr><td style="padding-top:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
    kv('Office reference', receiptNo) + kv('BOL number', r.bol) + kv('Customer', r.customer) + kv('Carrier', r.carrier) +
    kv('Trailer', r.trailer) + kv('PO / reference', r.po) + kv('Seal', r.seal) +
    kv('Units on BOL', expected != null ? String(expected) : '') + kv('Units scanned', String(units.length)) +
    kv('Received by', r.receivedBy) + kv('Site', r.site) +
    kv('Started', r.createdAt ? Utilities.formatDate(new Date(r.createdAt), tz, 'MMM d, yyyy h:mm a') : '') +
    kv('Sent', r.sentAt ? Utilities.formatDate(new Date(r.sentAt), tz, 'MMM d, yyyy h:mm a') : '') +
    kv('Notes', r.notes) + '</table></td></tr>';

  html += '<tr><td style="padding:18px 0 6px;font-family:Arial,sans-serif;font-size:19px;font-weight:bold;border-bottom:3px solid #000000;">Units</td></tr>';
  if (units.length) {
    html += '<tr><td style="padding-top:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
      '<tr><th style="' + th + '">#</th>' + fields.map(function (f) { return '<th style="' + th + '">' + h_(f.label) + '</th>'; }).join('') + '</tr>';
    units.slice().sort(function (a, b) { return a.n - b.n; }).forEach(function (u, i) {
      const bg = i % 2 ? '#f7f7f7' : '#ffffff';
      html += '<tr><td style="' + cell + 'background:' + bg + ';">' + u.n + '</td>' +
        fields.map(function (f) { return '<td style="' + cell + 'background:' + bg + ';">' + h_(u[f.key]) + '</td>'; }).join('') + '</tr>';
    });
    html += '</table></td></tr>';
  } else {
    html += '<tr><td style="padding:8px 0;font-family:Arial,sans-serif;font-size:16px;">No units were scanned. Use the BOL photos.</td></tr>';
  }

  html += '<tr><td style="padding:16px 0;font-family:Arial,sans-serif;font-size:16px;line-height:1.6;">' +
    'Attached: BOL photos and a units CSV.' + (skipped ? ' <b>' + skipped + ' photo(s) were too large to attach; they are in the folder below.</b>' : '') + '<br>' +
    '<a href="' + folderUrl + '" style="color:#C41230;font-weight:bold;">Open photo folder</a> &nbsp;|&nbsp; ' +
    '<a href="' + sheetUrl + '" style="color:#C41230;font-weight:bold;">Open receiving log</a></td></tr>' +
    '<tr><td style="padding:10px 0;border-top:3px solid #000000;font-family:Arial,sans-serif;font-size:13px;color:#5d5d5d;">Sent by LWH Offline Receiving.</td></tr></table>';
  return html;
}

function plainText_(r, fields, units, receiptNo, folderUrl) {
  const lines = ['LWH Trailer Received - ' + receiptNo, 'BOL: ' + r.bol, 'Customer: ' + (r.customer || ''), 'Carrier: ' + (r.carrier || ''),
    'Trailer: ' + (r.trailer || ''), 'Units on BOL: ' + (r.expected || ''), 'Units scanned: ' + units.length, 'Received by: ' + (r.receivedBy || ''),
    'Notes: ' + (r.notes || ''), '', 'Units:'];
  units.forEach(function (u) { lines.push(u.n + '. ' + fields.map(function (f) { return f.label + ': ' + (u[f.key] || ''); }).join(' | ')); });
  lines.push('', 'Photos: ' + folderUrl);
  return lines.join('\n');
}

// ---------- sheets ----------
function receiptsSheet_(ss) {
  let sh = ss.getSheetByName('Receipts');
  if (!sh) {
    sh = ss.insertSheet('Receipts', 0);
    sh.getRange(1, 1, 1, RECEIPT_HEADERS.length).setValues([RECEIPT_HEADERS]).setFontWeight('bold').setBackground('#000000').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('m/d/yyyy h:mm am/pm');
    sh.getRange('P:Q').setNumberFormat('m/d/yyyy h:mm am/pm');
  }
  return sh;
}
function unitsSheet_(ss) {
  let sh = ss.getSheetByName('Units');
  if (!sh) {
    sh = ss.insertSheet('Units');
    sh.getRange(1, 1, 1, UNIT_BASE_HEADERS.length).setValues([UNIT_BASE_HEADERS]).setFontWeight('bold').setBackground('#000000').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('m/d/yyyy h:mm am/pm');
  }
  return sh;
}
// Unit columns follow the app's field list. New fields add a column; nothing existing moves.
function writeUnits_(ss, now, receiptNo, r, fields, units) {
  if (!units.length) return;
  const sh = unitsSheet_(ss);
  let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const want = fields.map(function (f) { return f.label; }).concat(['Scanned at']);
  want.forEach(function (lbl) {
    if (headers.indexOf(lbl) === -1) {
      sh.getRange(1, headers.length + 1).setValue(lbl).setFontWeight('bold').setBackground('#000000').setFontColor('#ffffff');
      headers.push(lbl);
    }
  });
  const rows = units.slice().sort(function (a, b) { return a.n - b.n; }).map(function (u) {
    const row = new Array(headers.length).fill('');
    row[0] = now; row[1] = receiptNo; row[2] = r.bol; row[3] = r.customer || ''; row[4] = u.n;
    fields.forEach(function (f) { row[headers.indexOf(f.label)] = u[f.key] == null ? '' : String(u[f.key]); });
    row[headers.indexOf('Scanned at')] = u.scannedAt ? new Date(u.scannedAt) : '';
    return row;
  });
  const start = sh.getLastRow() + 1;
  // Keep serials/models as text so leading zeros survive
  sh.getRange(start, 1, rows.length, headers.length).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, 1).setNumberFormat('m/d/yyyy h:mm am/pm');
  sh.getRange(start, headers.indexOf('Scanned at') + 1, rows.length, 1).setNumberFormat('m/d/yyyy h:mm am/pm');
  sh.getRange(start, 1, rows.length, headers.length).setValues(rows);
}

function unitsCsv_(r, fields, units) {
  const head = ['BOL', 'Customer', 'Carrier', 'Trailer', 'PO', 'Line'].concat(fields.map(function (f) { return f.label; })).concat(['Scanned at']);
  const tz = Session.getScriptTimeZone();
  const out = [head].concat(units.slice().sort(function (a, b) { return a.n - b.n; }).map(function (u) {
    return [r.bol, r.customer, r.carrier, r.trailer, r.po, u.n].concat(fields.map(function (f) { return u[f.key]; }))
      .concat([u.scannedAt ? Utilities.formatDate(new Date(u.scannedAt), tz, 'M/d/yyyy h:mm a') : '']);
  }));
  return out.map(function (row) { return row.map(csv_).join(','); }).join('\r\n');
}

// ---------- utils ----------
function csv_(v) { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function h_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function safe_(s) { return String(s || '').replace(/[\\/:*?"<>|#%]/g, '-').slice(0, 60); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Run from the editor to send yourself a sample email (no photos) and check the layout. */
function testEmail() {
  const ss = SpreadsheetApp.openById(props_().getProperty('SHEET_ID'));
  const folder = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  const fields = [{ key: 'model', label: 'Model number' }, { key: 'serial', label: 'Serial number' }, { key: 'weight', label: 'Unit weight (lbs)' }, { key: 'year', label: 'Model / production year' }];
  const r = { bol: 'TEST123', customer: 'Sample Customer', carrier: 'Sample Carrier', trailer: '5301', expected: 3, receivedBy: 'Test', site: 'New warehouse',
    createdAt: new Date().toISOString(), sentAt: new Date().toISOString(), notes: 'Layout test' };
  const units = [{ n: 1, model: 'AB-100', serial: 'SN0001', weight: '1250', year: '2026' }, { n: 2, model: 'AB-100', serial: 'SN0002', weight: '1250', year: '2026' }];
  sendEmail_(r, fields, units, [], 'RCV-TEST', folder, ss);
}
