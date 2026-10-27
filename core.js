export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
export const stamp = () => new Date().toISOString();
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validRevision(r) {
  return r && typeof r.id === 'string' && r.id.length <= 100 && typeof r.recordId === 'string' &&
    Array.isArray(r.parents) && r.parents.every(p => typeof p === 'string') && !r.parents.includes(r.id) &&
    validDate(r.date) && typeof r.text === 'string' && r.text.length <= 1000000 &&
    typeof r.done === 'boolean' && typeof r.deleted === 'boolean' &&
    typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) &&
    typeof r.updatedAt === 'string' && Number.isFinite(Date.parse(r.updatedAt));
}
export function heads(revisions) {
  const consumed = new Set(revisions.flatMap(r => r.parents));
  const groups = new Map();
  for (const r of revisions) {
    if (consumed.has(r.id)) continue;
    if (!groups.has(r.recordId)) groups.set(r.recordId, []);
    groups.get(r.recordId).push(r);
  }
  return [...groups.values()].map(versions => ({
    recordId: versions[0].recordId,
    versions: versions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
    conflict: versions.length > 1
  }));
}
export function makeRevision({ previous = [], text, date, done, deleted = false, recordId }) {
  if (!validDate(date) || typeof text !== 'string' || (!deleted && !text.trim())) throw Error('請填寫有效日期及工作內容。');
  const now = stamp();
  return {
    id: crypto.randomUUID(), recordId: recordId || previous[0]?.recordId || crypto.randomUUID(),
    parents: previous.map(r => r.id), text, date, done: Boolean(done), deleted,
    createdAt: previous[0]?.createdAt || now, updatedAt: now
  };
}
export function entriesFor(revisions, date, done) {
  const groups = heads(revisions);
  if (groups.some(g => g.conflict && g.versions.some(r => r.date === date))) throw Error(`${date} 有尚未處理的不同版本，請先選擇要保留的版本。`);
  return groups.map(g => g.versions[0]).filter(r => !r.deleted && r.date === date && r.done === done)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.recordId.localeCompare(b.recordId));
}
export function txt(revisions, date, done) {
  return entriesFor(revisions, date, done).map((r, i) => `${i + 1}.${r.text}`).join('\r\n');
}
export const filename = (date, done) => `${date}_${done ? '完成' : '未完成'}.txt`;
export function updatedFor(revisions, date) {
  const affected = new Set(revisions.filter(r => r.date === date).map(r => r.id));
  return revisions.filter(r => r.date === date || r.parents.some(id => affected.has(id))).map(r => r.updatedAt).sort().at(-1) || null;
}
export function splitImport(text, mode, stripNumbers) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const chunks = mode === 'lines' ? normalized.split('\n').filter(s => s.trim()) : [normalized];
  return chunks.map(s => stripNumbers ? s.replace(/^\s*\d+[.．、]\s?/, '') : s).filter(s => s.trim());
}
export async function fingerprint(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function validateBackup(data) {
  if (!data || data.format !== 'wanin-backup-v1' || !Array.isArray(data.revisions) || !data.revisions.every(validRevision)) {
    throw Error('備份格式無效，未匯入任何資料。');
  }
  const ids = new Set();
  const byId = new Map(data.revisions.map(r => [r.id, r]));
  for (const r of data.revisions) {
    if (ids.has(r.id)) throw Error('備份包含重複版本識別碼。');
    ids.add(r.id);
    for (const p of r.parents) if (!byId.has(p) || byId.get(p).recordId !== r.recordId) throw Error('備份缺少原始版本或版本關係錯誤。');
  }
  const visiting = new Set(), visited = new Set();
  function visit(r) {
    if (visiting.has(r.id)) throw Error('備份版本關係有循環。');
    if (visited.has(r.id)) return;
    visiting.add(r.id);
    for (const p of r.parents) visit(byId.get(p));
    visiting.delete(r.id); visited.add(r.id);
  }
  data.revisions.forEach(visit);
  return data.revisions;
}
