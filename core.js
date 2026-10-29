export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
export const stamp = () => new Date().toISOString();
let entryOrder = 0;
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export const startOf = r => r.startDate ?? r.date;
export const endOf = r => r.endDate ?? startOf(r);
export const validRange = (start, end) => validDate(start) && validDate(end) && end >= start;
export const occursOn = (r, date) => startOf(r) <= date && date <= endOf(r);
export const dateLabel = r => startOf(r) === endOf(r) ? startOf(r) : `${startOf(r)} ～ ${endOf(r)}`;
export function datesOf(r) {
  const start = startOf(r), end = endOf(r);
  if (!validRange(start, end)) throw Error('結束日期不可早於開始日期，請填寫有效的日期區間。');
  const dates = [], cursor = new Date(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return dates;
}
export const reportDates = revisions => [...new Set(revisions.flatMap(datesOf))].sort();
export function validRevision(r) {
  return r && typeof r.id === 'string' && r.id.length <= 100 && typeof r.recordId === 'string' &&
    Array.isArray(r.parents) && r.parents.every(p => typeof p === 'string') && !r.parents.includes(r.id) &&
    validDate(r.date) && validRange(startOf(r), endOf(r)) && r.date === startOf(r) &&
    ((r.startDate === undefined && r.endDate === undefined) || (validDate(r.startDate) && validDate(r.endDate))) && typeof r.text === 'string' && r.text.length <= 1000000 &&
    (r.notes === undefined || (typeof r.notes === 'string' && r.notes.length <= 100000)) &&
    typeof r.done === 'boolean' && typeof r.deleted === 'boolean' &&
    (r.order === undefined || (typeof r.order === 'string' && r.order.length <= 30)) &&
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
export function makeRevision({ previous = [], text, date, startDate, endDate, done, deleted = false, recordId, notes = previous[0]?.notes ?? '' }) {
  const start = startDate ?? date ?? (previous[0] ? startOf(previous[0]) : undefined);
  const end = endDate ?? (startDate === undefined && previous[0] && (date === undefined || date === startOf(previous[0])) ? endOf(previous[0]) : start);
  if (!validRange(start, end)) throw Error('結束日期不可早於開始日期，請填寫有效的日期區間。');
  if (typeof text !== 'string' || text.length > 1000000 || (!deleted && !text.trim())) throw Error('請填寫有效日期及工作內容。');
  if (typeof notes !== 'string' || notes.length > 100000) throw Error('備註必須是文字，且不可超過 100,000 字。');
  const now = stamp();
  return {
    id: crypto.randomUUID(), recordId: recordId || previous[0]?.recordId || crypto.randomUUID(),
    parents: previous.map(r => r.id), text, notes, date: start, startDate: start, endDate: end, done: Boolean(done), deleted,
    createdAt: previous[0]?.createdAt || now, updatedAt: now,
    order: previous[0]?.order || String(++entryOrder).padStart(12, '0')
  };
}
export function entriesFor(revisions, date, done) {
  const groups = heads(revisions);
  if (groups.some(g => g.conflict && g.versions.some(r => occursOn(r, date)))) throw Error(`${date} 有尚未處理的不同版本，請先選擇要保留的版本。`);
  return groups.map(g => g.versions[0]).filter(r => !r.deleted && occursOn(r, date) && r.done === done)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.order || '').localeCompare(b.order || '') || a.recordId.localeCompare(b.recordId));
}
export function txt(revisions, date, done) {
  return entriesFor(revisions, date, done).map((r, i) => {
    const note = r.notes?.trim() ? `\r\n  備註：${r.notes.replace(/\r\n?|\n/g, '\r\n        ')}` : '';
    return `${i + 1}.${r.text}${note}`;
  }).join('\r\n');
}
export const filename = (date, done) => `${date}_${done ? '完成' : '未完成'}.txt`;
export function updatedFor(revisions, date) {
  const affected = new Set(revisions.filter(r => occursOn(r, date)).map(r => r.id));
  return revisions.filter(r => occursOn(r, date) || r.parents.some(id => affected.has(id))).map(r => r.updatedAt).sort().at(-1) || null;
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
