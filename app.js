import { today, stamp, validDate, validRevision, heads, makeRevision, txt, filename, splitImport, fingerprint, updatedFor, validateBackup, startOf, endOf, validRange, occursOn, dateLabel, datesOf, reportDates } from './core.js?v=20261029-1';
import { Drive } from './drive.js?v=20261029-1';
const $ = id => document.getElementById(id);
const DEFAULT = { revisions: [], uploaded: [], binding: null, reports: [], lastSync: null };
let state, db, drive, busy = false, syncing = false, retry = 0, timer, toastTimer, editor = null, importText = '', importChunks = [], exportSnapshot = null, exportFiles = [], queryStatus = 'all', localOwner = true;
let config = { ...window.WANIN_CONFIG };
let previewEpoch = 0;
let connecting = false;
let notesEditor = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatTime = value => value ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '尚無紀錄';
function notify(message, error = false) { $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 12000 : 5000); }
function guard(fn) { return async (...args) => { try { await fn(...args); } catch (e) { notify(e.message, true); } }; }
function storageGet(key, fallback) { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
function status(message, detail, ok = false) { $('sync-status').textContent = message; $('sync-detail').textContent = detail; $('status-dot').classList.toggle('online', ok); }
function confirmAction(title, message, labels = {}) {
  if ($('confirm-dialog').open) return Promise.resolve(false);
  $('confirm-yes').textContent = labels.yes || '確認'; $('confirm-no').textContent = labels.no || '取消';
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-dialog').showModal();
  return new Promise(resolve => {
    const finish = value => { $('confirm-dialog').close(); $('confirm-yes').onclick = null; $('confirm-no').onclick = null; $('confirm-dialog').oncancel = null; resolve(value); };
    $('confirm-yes').onclick = () => finish(true); $('confirm-no').onclick = () => finish(false);
    $('confirm-dialog').oncancel = e => { e.preventDefault(); finish(null); };
  });
}
function openDatabase() { return new Promise((resolve, reject) => { const req = indexedDB.open('wanin-work-output-v1', 1); req.onupgradeneeded = () => req.result.createObjectStore('state'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(Error('無法開啟本地儲存空間，請允許網站儲存資料。')); }); }
function readState() { return new Promise((resolve, reject) => { const req = db.transaction('state').objectStore('state').get('main'); req.onsuccess = () => resolve(req.result || structuredClone(DEFAULT)); req.onerror = () => reject(Error('無法讀取本地工作紀錄。')); }); }
let writeChain = Promise.resolve();
function persist() {
  const snapshot = structuredClone(state);
  const write = () => new Promise((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(snapshot, 'main'); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(Error('本地保存失敗，可能是空間不足。請立即下載完整備份，勿關閉此頁。')); });
  const task = writeChain.then(write); writeChain = task.catch(() => {}); return task;
}
function pendingCount() { const uploaded = new Set(state.uploaded); return state.revisions.filter(r => !uploaded.has(r.id)).length; }
function render() {
  const groups = heads(state.revisions), date = $('filter-date').value, search = $('search').value.toLocaleLowerCase();
  const active = groups.filter(g => g.conflict || !g.versions[0].deleted);
  const dated = active.filter(g => g.versions.some(r => (!date || occursOn(r, date)) && (r.text + '\n' + (r.notes || '')).toLocaleLowerCase().includes(search)));
  const normal = dated.filter(g => !g.conflict);
  $('date-range-label').textContent = date ? `顯示範圍：${date}` : '顯示範圍：所有日期';
  $('all-dates').setAttribute('aria-pressed', String(!date));
  $('today-button').setAttribute('aria-pressed', String(date === today()));
  $('count-all').textContent = dated.length; $('count-todo').textContent = normal.filter(g => !g.versions[0].done).length; $('count-done').textContent = normal.filter(g => g.versions[0].done).length;
  const visible = dated.filter(g => g.conflict || queryStatus === 'all' || g.versions[0].done === (queryStatus === 'done'))
    .sort((a, b) => startOf(b.versions[0]).localeCompare(startOf(a.versions[0])) || a.versions[0].createdAt.localeCompare(b.versions[0].createdAt) || (a.versions[0].order || '').localeCompare(b.versions[0].order || '') || a.recordId.localeCompare(b.recordId));
  const notesMarkup = r => r.notes?.trim() ? `<div class="entry-notes"><span>備註</span><p>${escape(r.notes)}</p></div>` : '';
  $('entries').innerHTML = visible.map(g => {
    if (g.conflict) return `<article class="entry conflict"><strong>這筆工作有 ${g.versions.length} 個不同版本</strong><p class="hint">選擇要保留的版本。所有舊版本仍保存在完整備份。</p>${g.versions.map(r => `<div class="conflict-version"><p class="entry-text">${escape(r.deleted ? '〔此版本已刪除〕\n' + r.text : r.text)}</p>${notesMarkup(r)}<div class="entry-meta">${escape(dateLabel(r))} · ${r.done ? '完成' : '未完成'} · ${escape(formatTime(r.updatedAt))}</div><button class="secondary small" data-action="resolve" data-id="${escape(r.id)}">保留此版本${r.deleted ? '（刪除）' : ''}</button></div>`).join('')}</article>`;
    const r = g.versions[0];
    return `<article class="entry ${r.done ? 'done' : ''}"><input class="toggle" type="checkbox" aria-label="切換完成狀態：${escape(r.text.slice(0, 30))}" ${r.done ? 'checked' : ''} data-action="toggle" data-id="${escape(r.id)}"><div class="entry-content"><p class="entry-text">${escape(r.text)}</p>${notesMarkup(r)}<div class="entry-meta"><span class="badge ${r.done ? 'done' : ''}">${r.done ? '完成' : '未完成'}</span><span>${escape(dateLabel(r))}</span><span>${state.uploaded.includes(r.id) ? '已同步' : '待同步'}</span></div></div><div class="entry-actions"><button class="quiet" data-action="notes" data-id="${escape(r.id)}">${r.notes?.trim() ? '編輯備註' : '新增備註'}</button><button class="quiet" data-action="edit" data-id="${escape(r.id)}">編輯</button><button class="quiet" data-action="delete" data-id="${escape(r.id)}">刪除</button></div></article>`;
  }).join('');
  $('empty').hidden = Boolean(visible.length); $('empty').querySelector('h3').textContent = active.length ? '沒有符合條件的工作' : '為今天留下第一筆紀錄';
  $('conflict-banner').hidden = !groups.some(g => g.conflict);
  $('list-summary').textContent = `顯示 ${visible.length} 筆 · 共 ${active.length} 筆工作`;
  document.querySelectorAll('[data-status]').forEach(b => { const selected = b.dataset.status === queryStatus; b.classList.toggle('active', selected); b.setAttribute('aria-pressed', selected); });
  $('connect-button').textContent = drive?.connected ? '重新連接 Google' : '連接 Google Drive';
}
async function addRevision(r) {
  state.revisions.push(r);
  await persist(); render(); schedule();
}
function updateDateLimits() {
  $('entry-end-date').min = $('entry-date').value;
  $('import-end-date').min = $('import-date').value;
}
function resetEditor() { editor = null; $('entry-text').value = ''; $('entry-notes').value = ''; $('entry-done').checked = false; $('editor-title').textContent = '新增工作'; $('save-entry').textContent = '＋ 新增工作'; $('cancel-edit').hidden = true; localStorage.removeItem('wanin-draft'); $('draft-note').textContent = ''; }
function saveDraft() { updateDateLimits(); localStorage.setItem('wanin-draft', JSON.stringify({ text: $('entry-text').value, notes: $('entry-notes').value, date: $('entry-date').value, endDate: $('entry-end-date').value, done: $('entry-done').checked, editor })); $('draft-note').textContent = '草稿已存本地'; }
function schedule(delay = 4000) {
  clearTimeout(timer);
  if (connecting) return;
  if (!drive?.connected || !localOwner) { if (state && !syncing) status('已存本地', `${pendingCount()} 個版本待同步；連接 Google Drive 後自動同步。`); return; }
  timer = setTimeout(() => guard(() => sync())(), delay);
}
async function sync({ reports = true } = {}) {
  if (syncing) throw Error('同步正在進行，請稍候再試。');
  if (!localOwner) throw Error('請使用已開啟的主要分頁。');
  if (!drive?.connected) throw Error('請先連接 Google Drive，或使用輸出按鈕下載 TXT。');
  syncing = true; $('sync-button').disabled = true; status('同步中', '本地內容已保存，正在比對 Google Drive。');
  try {
    await drive.ensureFolder();
    const merge = async () => {
      const incoming = await drive.pull(new Set(state.revisions.map(r => r.id)));
      state.revisions.push(...incoming.fetched);
      const uploaded = new Set(state.uploaded);
      for (const id of incoming.seen) uploaded.add(id);
      state.uploaded = [...uploaded];
      await persist();
      return incoming.seen;
    };
    const remoteIds = await merge();
    for (const revision of [...state.revisions]) {
      if (remoteIds.has(revision.id)) continue;
      await drive.push(revision); remoteIds.add(revision.id);
      if (!state.uploaded.includes(revision.id)) state.uploaded.push(revision.id);
      await persist();
    }
    await merge();
    // Missing ancestors can mean another device's upload is still in progress. Never export a partial graph.
    validateBackup({ format: 'wanin-backup-v1', revisions: state.revisions });
    state.lastSync = stamp(); retry = 0;
    await persist(); render();
    const allUploaded = state.revisions.every(r => state.uploaded.includes(r.id));
    if (reports && !$('export-dialog').open && allUploaded) {
      try { await updateReports(); }
      catch (e) { $('export-status').textContent = 'TXT 更新未完成，可使用手動輸出重試'; throw e; }
    }
    status(allUploaded ? '紀錄已同步' : '已存本地，等待下一次同步', `${formatTime(state.lastSync)}${heads(state.revisions).some(g => g.conflict) ? ' · 有版本需要處理' : ''}`, allUploaded);
    schedule(allUploaded ? 30000 : 4000);
  } catch (e) {
    retry = Math.min(retry + 1, 5); status('同步未完成', e.message); render();
    if (drive.connected) schedule(Math.min(30000 * 2 ** retry, 300000));
    throw e;
  } finally { syncing = false; $('sync-button').disabled = false; }
}
async function updateReports({ date = null, force = false } = {}) {
  const snapshot = structuredClone(state.revisions);
  const dates = date ? [date] : reportDates(snapshot);
  const blocked = new Set(heads(snapshot).filter(g => g.conflict).flatMap(g => g.versions.flatMap(datesOf)));
  let files = await drive.reports();
  for (const d of dates) {
    if (blocked.has(d)) { if (date) throw Error('這個日期有不同修改版本，請先處理。'); continue; }
    for (const done of [true, false]) {
      const updated = await drive.writeReport(d, done, snapshot, files, force);
      files = files.filter(f => !updated.some(u => u.id === f.id)).concat(updated);
      state.reports = files; await persist();
    }
  }
  $('export-status').textContent = blocked.size ? '部分 TXT 等待處理版本差異' : `TXT 已檢查 · ${formatTime(stamp())}`;
  return files;
}
function loadScript(src, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.async = true; const timeout = setTimeout(() => reject(Error('Google 元件載入逾時，請檢查網路。')), 20000); script.onload = () => { clearTimeout(timeout); resolve(); }; script.onerror = () => { clearTimeout(timeout); script.remove(); reject(Error('無法載入 Google 元件，請確認網路或擋廣告設定。')); }; document.head.append(script); });
}
async function connect() {
  if (syncing || connecting) throw Error('連接或同步正在進行，請稍候再試。');
  if (!config.clientId) { openSettings(); return; }
  connecting = true; clearTimeout(timer);
  $('connect-button').disabled = true; $('sync-button').disabled = true;
  try {
    await loadScript('https://accounts.google.com/gsi/client', () => Boolean(globalThis.google?.accounts?.oauth2));
    drive = new Drive(config, () => status('需要重新連接', 'Google 授權已過期；內容仍在本地。'));
    const user = await drive.connect();
    if (state.binding && (state.binding.account !== user.permissionId || state.binding.folder !== config.folderId)) throw Error('目前本地紀錄綁定另一個 Google 帳號或資料夾。請使用原帳號與資料夾；若要搬移，先下載完整備份並使用另一個瀏覽器設定檔還原。');
    await drive.authorizeTargetFolder(() => loadScript('https://apis.google.com/js/api.js', () => Boolean(globalThis.gapi)));
    if (!state.binding && state.revisions.length && !await confirmAction('同步本地紀錄到 Google Drive？', `將把本機的 ${state.revisions.length} 個工作版本上傳到目前選取的資料夾。`)) { drive.disconnect(); return; }
    state.binding = { account: user.permissionId, folder: config.folderId };
    await persist(); await sync();
    notify(`已連接 ${user.emailAddress || user.displayName || 'Google Drive'}`);
  } catch (e) { drive?.disconnect(); status('尚未連接', e.message); throw e; }
  finally {
    connecting = false; $('connect-button').disabled = false; $('sync-button').disabled = false; render();
    if (drive?.connected) schedule(30000);
  }
}
function openSettings() {
  $('client-id').value = config.clientId || ''; $('api-key').value = config.apiKey || ''; $('project-number').value = config.projectNumber || ''; $('folder-id').value = config.folderId || '';
  $('settings-dialog').showModal();
}
function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function currentImportChunks() { return splitImport(importText, $('import-mode').value, $('strip-numbers').checked); }
function renderImport() {
  updateDateLimits();
  importChunks = currentImportChunks();
  const date = $('import-date').value, endDate = $('import-end-date').value, done = $('import-status').value === 'done';
  const existing = heads(state.revisions).flatMap(g => g.versions).filter(r => !r.deleted);
  const duplicates = importChunks.filter(t => existing.some(r => r.text === t && startOf(r) === date && endOf(r) === endDate && r.done === done)).length;
  $('import-preview').textContent = importChunks.length ? importChunks.slice(0, 30).map((t, i) => `${i + 1}.${t}`).join('\n') : '請先選擇 TXT 檔案。';
  $('import-summary').textContent = `將加入 ${importChunks.length} 筆${duplicates ? `，其中 ${duplicates} 筆可能重複；確認時可決定是否跳過。` : '，不會刪除現有紀錄。'}${importChunks.length > 30 ? '預覽僅顯示前 30 筆。' : ''}`;
  $('confirm-import').disabled = !importChunks.length || !validRange(date, endDate);
}
async function decodeImport() {
  const file = $('import-file').files[0];
  if (!file) { importText = ''; renderImport(); return; }
  if (file.size > 5 * 1024 * 1024) throw Error('請匯入 5 MB 以下的 TXT；較大檔案請先拆分。');
  const bytes = await file.arrayBuffer();
  try { importText = new TextDecoder($('import-encoding').value, { fatal: true }).decode(bytes); }
  catch { importText = ''; renderImport(); throw Error('無法以目前編碼讀取檔案，請改選 Big5 或 UTF-16。'); }
  renderImport();
}
async function previewExport(fetchCloud = true) {
  const epoch = ++previewEpoch;
  $('download-txt').disabled = true; $('upload-txt').disabled = true;
  const date = $('export-date').value;
  if (!validDate(date)) { $('export-comparison').textContent = '請選擇有效日期。'; exportSnapshot = null; return; }
  exportSnapshot = structuredClone(state.revisions);
  try { txt(exportSnapshot, date, true); } catch (e) { exportSnapshot = null; $('export-comparison').textContent = e.message; $('download-txt').disabled = true; $('upload-txt').disabled = true; return; }
  let cloudKnown = false;
  exportFiles = state.reports;
  if (fetchCloud && drive?.connected) {
    $('export-cloud-note').textContent = '正在查詢雲端 TXT 更新時間…';
    try { exportFiles = await drive.reports(); cloudKnown = true; state.reports = exportFiles; await persist(); }
    catch (e) { $('export-cloud-note').textContent = `${e.message} 下方時間為本地快取，無法確認目前雲端狀態。`; }
  }
  if (cloudKnown) $('export-cloud-note').textContent = `已查詢雲端 · ${formatTime(stamp())}。手動輸出期間暫停自動更新 TXT。`;
  else if (!drive?.connected) $('export-cloud-note').textContent = '尚未連接 Google，無法取得目前雲端時間；下方若有時間，為上次查詢的本地快取。可直接下載。';
  if (epoch !== previewEpoch) return;
  const snapshot = exportSnapshot;
  const cards = [];
  for (const done of [true, false]) {
    const content = txt(snapshot, date, done), hash = await fingerprint(content);
    const files = exportFiles.filter(f => f.appProperties?.date === date && f.appProperties?.status === (done ? 'done' : 'todo'));
    const last = files.map(f => f.modifiedTime).sort().at(-1);
    const same = files.length && files.every(f => f.appProperties.hash === hash);
    cards.push(`<section class="export-card"><h3>${filename(date, done)}</h3><dl><dt>本次內容最後更新</dt><dd>${escape(formatTime(updatedFor(snapshot, date)))}</dd><dt>雲端上次成功更新</dt><dd>${last ? escape(formatTime(last)) : cloudKnown ? '尚未輸出' : '無快取紀錄（雲端狀態未知）'}</dd><dt>內容比較</dt><dd>${files.length ? same ? '與上次輸出一致' : '有變更' : cloudKnown ? '首次輸出' : '無法確認'}${files.length > 1 ? ' · 雲端有重複檔案，會一併更新' : ''}</dd></dl><pre class="preview">${escape(content || '（此狀態沒有工作，將輸出空白 TXT）')}</pre><button class="secondary small" data-download-status="${done ? 'done' : 'todo'}">下載這份 TXT</button></section>`);
  }
  if (epoch !== previewEpoch) return;
  $('export-comparison').innerHTML = cards.join(''); $('download-txt').disabled = false; $('upload-txt').disabled = !drive?.connected;
}
async function signature(revisions, date) { return fingerprint(JSON.stringify([txt(revisions, date, true), txt(revisions, date, false)])); }
async function manualUpload() {
  if (!exportSnapshot) throw Error('請先選擇有效日期並處理版本差異。');
  if (syncing) throw Error('請等同步完成後再確認上傳。');
  const date = $('export-date').value, oldSignature = await signature(exportSnapshot, date);
  const oldFiles = JSON.stringify(exportFiles.map(f => [f.id, f.modifiedTime]).sort());
  $('upload-txt').disabled = true;
  try {
    await sync({ reports: false });
    const currentFiles = await drive.reports();
    if (oldSignature !== await signature(state.revisions, date) || oldFiles !== JSON.stringify(currentFiles.map(f => [f.id, f.modifiedTime]).sort())) {
      await previewExport(); notify('內容或雲端檔案已有更新，已重新顯示比較，請再次確認。'); return;
    }
    if (pendingCount()) throw Error('還有本地版本尚未上傳，請完成同步後再輸出。');
    syncing = true;
    await updateReports({ date, force: true });
    $('export-dialog').close(); notify('兩份 TXT 已成功上傳 Google Drive。');
  } finally { syncing = false; $('upload-txt').disabled = !drive?.connected; schedule(30000); }
}
async function boot() {
  if (navigator.locks) {
    let ready;
    const obtained = new Promise(resolve => ready = resolve);
    navigator.locks.request('wanin-work-output-writer', { ifAvailable: true }, lock => {
      localOwner = Boolean(lock); ready(); return lock ? new Promise(() => {}) : undefined;
    });
    await obtained;
  }
  if (!localOwner) { document.querySelectorAll('button,input,textarea,select').forEach(el => el.disabled = true); status('已在另一個分頁開啟', '請關閉這個分頁，使用原本的工作簿，避免本地資料互相覆蓋。'); return; }
  config = { ...config, ...storageGet('wanin-config', {}) };
  db = await openDatabase(); state = await readState();
  validateBackup({ format: 'wanin-backup-v1', revisions: state.revisions });
  drive = new Drive(config);
  $('entry-date').value = $('entry-end-date').value = $('import-date').value = $('import-end-date').value = $('export-date').value = today();
  $('filter-date').value = ''; // Show work from all dates when opening the app.
  const draft = storageGet('wanin-draft', null);
  if (draft) {
    $('entry-text').value = draft.text || ''; $('entry-notes').value = draft.notes ?? draft.editor?.notes ?? ''; $('entry-date').value = validDate(draft.date) ? draft.date : today(); $('entry-end-date').value = validDate(draft.endDate) ? draft.endDate : draft.editor ? endOf(draft.editor) : $('entry-date').value; $('entry-done').checked = Boolean(draft.done);
    if (draft.editor && state.revisions.some(r => r.id === draft.editor.id)) { editor = draft.editor; $('editor-title').textContent = '編輯工作'; $('save-entry').textContent = '儲存修改'; $('cancel-edit').hidden = false; }
    $('draft-note').textContent = '已還原本地草稿';
  }
  updateDateLimits();
  $('entry-form').onsubmit = guard(async e => {
    e.preventDefault(); if (busy) return; busy = true;
    try {
      const revision = makeRevision({ previous: editor ? [editor] : [], text: $('entry-text').value, notes: $('entry-notes').value, date: $('entry-date').value, endDate: $('entry-end-date').value, done: $('entry-done').checked });
      await addRevision(revision); resetEditor(); notify('工作已保存在本地。');
    } finally { busy = false; }
  });
  for (const id of ['entry-date', 'entry-end-date', 'entry-text', 'entry-notes', 'entry-done']) $(id).addEventListener('input', guard(saveDraft));
  $('cancel-edit').onclick = () => resetEditor();
  $('entries').onclick = guard(async e => {
    const target = e.target.closest('[data-action]'); if (!target || busy) return;
    const r = state.revisions.find(r => r.id === target.dataset.id); if (!r) return;
    const action = target.dataset.action;
    if (action === 'notes') {
      if (editor?.recordId === r.recordId) { $('entry-notes').focus(); $('entry-notes').scrollIntoView({ behavior: 'smooth', block: 'center' }); notify('這筆工作正在編輯，請在備註欄位修改後儲存。'); return; }
      notesEditor = structuredClone(r); $('notes-work-text').textContent = r.text; $('notes-text').value = r.notes || '';
      $('notes-dialog').showModal(); $('notes-text').focus(); return;
    }
    if (action === 'edit') {
      editor = structuredClone(r); $('entry-date').value = startOf(r); $('entry-end-date').value = endOf(r); $('entry-text').value = r.text; $('entry-notes').value = r.notes || ''; $('entry-done').checked = r.done;
      $('editor-title').textContent = '編輯工作'; $('save-entry').textContent = '儲存修改'; $('cancel-edit').hidden = false; saveDraft(); $('entry-text').focus(); $('entry-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
    }
    busy = true;
    try {
      if (action === 'delete' && !await confirmAction('刪除這筆工作？', '刪除會同步到其他裝置，也會更新對應 TXT。完整備份仍保留歷史版本。')) return;
      const versions = heads(state.revisions).find(g => g.recordId === r.recordId)?.versions || [r];
      await addRevision(makeRevision({ previous: action === 'resolve' ? versions : [r], text: r.text, notes: r.notes || '', startDate: startOf(r), endDate: endOf(r), done: action === 'toggle' ? !r.done : r.done, deleted: action === 'delete' || r.deleted }));
      if (editor?.recordId === r.recordId && action !== 'toggle') resetEditor();
    } finally { busy = false; render(); }
  });
  $('notes-form').onsubmit = guard(async e => {
    e.preventDefault(); if (busy || !notesEditor) return;
    const previous = notesEditor, notes = $('notes-text').value;
    if (notes === (previous.notes || '')) { $('notes-dialog').close(); return; }
    busy = true; $('save-notes').disabled = true;
    try {
      await addRevision(makeRevision({ previous: [previous], text: previous.text, startDate: startOf(previous), endDate: endOf(previous), done: previous.done, notes }));
      $('notes-dialog').close(); notify('備註已保存在本地，工作原文保持不變。');
    } finally { busy = false; $('save-notes').disabled = false; }
  });
  $('notes-dialog').addEventListener('close', () => { notesEditor = null; });
  ['filter-date', 'search'].forEach(id => $(id).addEventListener('input', render));
  $('today-button').onclick = () => { $('filter-date').value = today(); render(); };
  $('all-dates').onclick = () => { $('filter-date').value = ''; render(); };
  document.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { queryStatus = b.dataset.status; render(); });
  document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('settings-button').onclick = openSettings;
  $('settings-form').onsubmit = guard(async e => {
    e.preventDefault(); if (syncing || connecting) throw Error('連接或同步進行中，請稍後再修改連線設定。');
    const clientId = $('client-id').value.trim(), apiKey = $('api-key').value.trim();
    const value = $('folder-id').value.trim(), folder = value.match(/\/folders\/([\w-]+)/)?.[1] || value;
    if (!/^[\w-]+$/.test(folder)) throw Error('請填寫有效的資料夾 ID 或 Google Drive 資料夾連結。');
    if (!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw Error('OAuth Client ID 格式不正確，請確認是網頁應用程式用戶端。');
    if (state.binding && folder !== state.binding.folder) throw Error('本地資料已綁定原資料夾。請先備份，並使用另一個瀏覽器設定檔搬移資料。');
    if ($('project-number').value.trim() && !/^\d+$/.test($('project-number').value.trim())) throw Error('專案編號必須是純數字。');
    config = { clientId, apiKey, folderId: folder, projectNumber: $('project-number').value.trim() || clientId.split('-')[0] };
    localStorage.setItem('wanin-config', JSON.stringify(config)); drive?.disconnect(); drive = new Drive(config); clearTimeout(timer);
    $('settings-dialog').close(); status('設定已保存', '請按「連接 Google Drive」完成登入與資料夾選取。'); render();
  });
  $('disconnect-button').onclick = () => { if (syncing || connecting) return notify('請等連接或同步結束後再中斷。', true); drive?.disconnect(); clearTimeout(timer); $('settings-dialog').close(); status('已中斷連線', '工作保留在本地；Google 帳號的網站授權可至帳號設定撤銷。'); render(); };
  $('connect-button').onclick = guard(connect);
  $('sync-button').onclick = guard(async () => {
    if (connecting || syncing) throw Error('連接或同步正在進行，請稍候再試。');
    if (!drive?.connected) return connect();
    await sync();
  });
  $('import-button').onclick = () => { $('import-date').value = $('import-end-date').value = $('filter-date').value || today(); $('import-dialog').showModal(); renderImport(); };
  $('import-file').onchange = guard(decodeImport); $('import-encoding').onchange = guard(decodeImport);
  ['import-date', 'import-end-date', 'import-status', 'import-mode', 'strip-numbers'].forEach(id => $(id).onchange = renderImport);
  $('confirm-import').onclick = guard(async () => {
    if (busy) return; busy = true;
    try {
      const date = $('import-date').value, endDate = $('import-end-date').value, done = $('import-status').value === 'done';
      if (!validRange(date, endDate)) throw Error('結束日期不可早於開始日期，請指定有效日期區間。');
      const existing = new Set(heads(state.revisions).flatMap(g => g.versions).filter(r => !r.deleted && startOf(r) === date && endOf(r) === endDate && r.done === done).map(r => r.text));
      let chunks = currentImportChunks(); const duplicate = chunks.some(t => existing.has(t)) || new Set(chunks).size !== chunks.length;
      if (duplicate) {
        const skip = await confirmAction('偵測到可能重複的工作', '要跳過相同日期、狀態及內容的重複項目，還是全部加入？', { yes: '跳過重複', no: '全部加入' });
        if (skip === null) return;
        if (skip) chunks = chunks.filter(t => { if (existing.has(t)) return false; existing.add(t); return true; });
      }
      const revisions = chunks.map(text => makeRevision({ text, date, endDate, done })); state.revisions.push(...revisions);
      await persist(); $('import-dialog').close(); render(); schedule(); notify(`已加入 ${revisions.length} 筆工作。`);
    } finally { busy = false; }
  });
  $('backup-button').onclick = () => download(`工作紀錄備份_${today()}.json`, JSON.stringify({ format: 'wanin-backup-v1', exportedAt: stamp(), revisions: state.revisions }, null, 2), 'application/json');
  $('restore-button').onclick = () => $('restore-file').click();
  $('restore-file').onchange = guard(async () => {
    const file = $('restore-file').files[0]; if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw Error('備份超過 20 MB，請先聯絡維護者。');
      const restored = validateBackup(JSON.parse(await file.text()));
      const known = new Map(state.revisions.map(r => [r.id, r]));
      for (const r of restored) if (known.has(r.id) && JSON.stringify(known.get(r.id)) !== JSON.stringify(r)) throw Error('同一版本識別碼的內容不一致，已停止還原。');
      const additions = restored.filter(r => !known.has(r.id));
      if (!await confirmAction('還原完整備份？', `將合併 ${additions.length} 個新版本，不會清除現有紀錄。連線後會自動同步到目前資料夾。`)) return;
      state.revisions.push(...additions); await persist(); render(); schedule(); notify(`已合併 ${additions.length} 個版本。`);
    } finally { $('restore-file').value = ''; }
  });
  $('export-button').onclick = guard(async () => { $('export-date').value = $('filter-date').value || today(); $('export-dialog').showModal(); await previewExport(); });
  $('export-date').onchange = guard(() => previewExport());
  $('export-dialog').addEventListener('close', () => schedule());
  $('export-comparison').onclick = guard(e => {
    const button = e.target.closest('[data-download-status]');
    if (!button || !exportSnapshot) return;
    const date = $('export-date').value, done = button.dataset.downloadStatus === 'done';
    download(filename(date, done), txt(exportSnapshot, date, done));
  });
  $('download-txt').onclick = guard(async () => {
    const date = $('export-date').value;
    if (!exportSnapshot || !validDate(date)) throw Error('請先指定日期並確認預覽。');
    for (const done of [true, false]) download(filename(date, done), txt(exportSnapshot, date, done));
    notify('已送出兩份 TXT 下載，若只收到一份，請允許 Chrome 多檔下載。');
  });
  $('upload-txt').onclick = guard(manualUpload);
  window.addEventListener('online', () => schedule(1000)); window.addEventListener('offline', () => status('目前離線', '內容會保存在本地，連線後再同步。'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(1000); });
  window.addEventListener('beforeunload', e => { if (syncing) { e.preventDefault(); e.returnValue = ''; } });
  render(); status('已存本地', `${pendingCount()} 個版本待同步；連接 Google Drive 後自動同步。`);
}
boot().catch(e => { status('本地資料無法開啟', e.message); document.querySelectorAll('button,input,textarea,select').forEach(el => el.disabled = true); notify(e.message + ' 未覆蓋原有資料。', true); });
