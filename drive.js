import { validRevision, stamp, fingerprint, filename, txt, updatedFor } from './core.js';

const API = 'https://www.googleapis.com/drive/v3';
export class Drive {
  constructor(config, onAuthLost = () => {}) { this.config = config; this.onAuthLost = onAuthLost; this.token = null; this.expires = 0; this.dataFolder = null; }
  get connected() { return Boolean(this.token && Date.now() < this.expires); }
  disconnect() { this.token = null; this.expires = 0; this.dataFolder = null; }
  async connect() {
    if (!globalThis.google?.accounts?.oauth2) throw Error('Google 登入元件尚未載入，請確認網路後再試。');
    const response = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({ client_id: this.config.clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: r => r.error ? reject(Error(r.error_description || r.error)) : resolve(r),
        error_callback: r => reject(Error(r.type === 'popup_closed' ? '已取消 Google 登入。' : '無法開啟登入視窗，請允許此網站開啟彈出視窗。')) });
      client.requestAccessToken({ prompt: '' });
    });
    this.token = response.access_token;
    this.expires = Date.now() + Math.max(0, Number(response.expires_in) - 60) * 1000;
    const about = await this.request('/about?fields=user(permissionId,emailAddress,displayName)');
    return about.user;
  }
  async request(path, options = {}, upload = false) {
    if (!this.connected) { this.disconnect(); this.onAuthLost(); throw Error('Google 授權尚未建立或已過期，請重新連接。'); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try { response = await fetch((upload ? 'https://www.googleapis.com/upload/drive/v3' : API) + path, {
      ...options, headers: { ...options.headers, Authorization: `Bearer ${this.token}` }, signal: controller.signal
    }); } catch (e) { throw Error(e.name === 'AbortError' ? 'Google Drive 連線逾時，內容仍保存在本地，請稍後重試。' : '無法連線 Google Drive，請檢查網路。'); }
    finally { clearTimeout(timeout); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 401) { this.disconnect(); this.onAuthLost(); }
      if (response.status === 404) throw Error('找不到雲端檔案或尚未授權資料夾，請重新選取目標資料夾。');
      if (response.status === 403) throw Error('Google Drive 拒絕存取，請檢查資料夾權限、API 設定或用量限制。');
      throw Error(error.error?.message || `Google Drive 錯誤 ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }
  async list(query) {
    const files = []; let page;
    do {
      const params = new URLSearchParams({ q: `trashed = false and (${query})`, fields: 'nextPageToken,files(id,name,createdTime,modifiedTime,appProperties,mimeType)', pageSize: '1000' });
      if (page) params.set('pageToken', page);
      const result = await this.request('/files?' + params);
      files.push(...(result.files || [])); page = result.nextPageToken;
    } while (page);
    return files.sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id));
  }
  async ensureFolder() {
    if (this.dataFolder) return this.dataFolder;
    const root = this.config.folderId;
    const target = await this.request(`/files/${encodeURIComponent(root)}?fields=id,mimeType,capabilities(canAddChildren)`);
    if (target.mimeType !== 'application/vnd.google-apps.folder' || !target.capabilities?.canAddChildren) throw Error('目標必須是你可以寫入的 Google Drive 資料夾。');
    const folders = await this.list(`'${root}' in parents and appProperties has { key='wanin' and value='data-v1' }`);
    if (folders.length) this.dataFolder = folders[0].id;
    else this.dataFolder = (await this.request('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '_WaninWorkOutput_data', mimeType: 'application/vnd.google-apps.folder', parents: [root], appProperties: { wanin: 'data-v1' } }) })).id;
    return this.dataFolder;
  }
  async media(path, metadata, content, mimeType, method = 'POST') {
    const boundary = 'wanin_' + crypto.randomUUID().replaceAll('-', '');
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    return this.request(path + '?uploadType=multipart&fields=id,name,modifiedTime,appProperties', { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, true);
  }
  async pull(known) {
    // All marked data folders are scanned: simultaneous first connections may create two folders.
    const folders = await this.list(`'${this.config.folderId}' in parents and appProperties has { key='wanin' and value='data-v1' }`);
    const fetched = []; const seen = new Set();
    for (const folder of folders) {
      for (const file of await this.list(`'${folder.id}' in parents and appProperties has { key='wanin' and value='revision-v1' }`)) {
        const id = file.appProperties?.revision;
        if (!id) throw Error('同步資料缺少版本識別碼，已暫停更新 TXT。');
        seen.add(id);
        if (known.has(id) || fetched.some(r => r.id === id)) continue;
        const data = await this.request(`/files/${encodeURIComponent(file.id)}?alt=media`);
        if (!validRevision(data) || data.id !== id) throw Error('雲端同步資料格式異常，已停止同步，請保留檔案並下載本地備份。');
        fetched.push(data);
      }
    }
    return { fetched, seen };
  }
  async push(revision) {
    const parent = await this.ensureFolder();
    return this.media('/files', { name: revision.id + '.json', parents: [parent], mimeType: 'application/json', appProperties: { wanin: 'revision-v1', revision: revision.id } }, JSON.stringify(revision), 'application/json');
  }
  async reports() {
    return this.list(`'${this.config.folderId}' in parents and appProperties has { key='wanin' and value='txt-v1' }`);
  }
  async writeReport(date, done, revisions, files, force = false) {
    const content = txt(revisions, date, done);
    const hash = await fingerprint(content);
    const status = done ? 'done' : 'todo';
    const matching = files.filter(f => f.appProperties?.date === date && f.appProperties?.status === status);
    const props = { wanin: 'txt-v1', date, status, hash, contentUpdatedAt: updatedFor(revisions, date) || '', generatedAt: stamp() };
    const results = [];
    if (!matching.length) {
      // Never overwrite an unrelated same-name user file silently.
      const escaped = filename(date, done).replaceAll("'", "\\'");
      const collision = await this.list(`'${this.config.folderId}' in parents and name = '${escaped}'`);
      if (collision.length) throw Error(`${filename(date, done)} 已存在但不是由本工具建立。請先重新命名該檔案，再重試；工具沒有覆蓋它。`);
      results.push(await this.media('/files', { name: filename(date, done), parents: [this.config.folderId], mimeType: 'text/plain', appProperties: props }, content, 'text/plain'));
    } else {
      // If concurrent creation produced duplicates, keep their contents convergent; no destructive cleanup.
      for (const file of matching) {
        if (!force && file.appProperties.hash === hash) { results.push(file); continue; }
        results.push(await this.media('/files/' + encodeURIComponent(file.id), { name: filename(date, done), appProperties: props }, content, 'text/plain', 'PATCH'));
      }
    }
    return results;
  }
  async pickFolder() {
    if (!this.connected) throw Error('請先連接 Google。');
    if (!this.config.apiKey) throw Error('請在連線設定填入 Google Picker API Key。');
    if (!globalThis.gapi) throw Error('Google 選擇器尚未載入，請檢查網路。');
    await new Promise((resolve, reject) => gapi.load('picker', { callback: resolve, onerror: () => reject(Error('無法載入 Google 選擇器。')), timeout: 15000, ontimeout: () => reject(Error('Google 選擇器載入逾時。')) }));
    return new Promise((resolve, reject) => {
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true);
      const project = this.config.projectNumber || this.config.clientId.split('-')[0];
      const picker = new google.picker.PickerBuilder().setAppId(project).setDeveloperKey(this.config.apiKey).setOAuthToken(this.token).setOrigin(location.origin).setLocale('zh-TW').setTitle('請選取工作紀錄的目標資料夾').addView(view).setCallback(data => {
        if (data.action === google.picker.Action.PICKED) { picker.setVisible(false); resolve(data.docs[0].id); }
        if (data.action === google.picker.Action.CANCEL) { picker.setVisible(false); reject(Error('已取消資料夾授權。')); }
      }).build();
      picker.setVisible(true);
    });
  }
}
