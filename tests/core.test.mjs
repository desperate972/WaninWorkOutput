import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRevision, heads, txt, filename, validDate, splitImport, validateBackup, fingerprint, updatedFor } from '../core.js';
import { Drive } from '../drive.js';
const day = '2026-10-27';
const create = (text = '工作 A', extra = {}) => makeRevision({ text, date: day, done: false, ...extra });

test('validates dates, including leap days', () => { assert.equal(validDate('2026-02-30'), false); assert.equal(validDate('2024-02-29'), true); assert.equal(validDate('2026-2-1'), false); });
test('preserves exact text and newlines, adds continuous numbering', () => {
  const a = create('  原文\n第二行  '), b = create('下一件'); b.createdAt = '2099-01-01T00:00:00.000Z';
  assert.equal(txt([a, b], day, false), '1.  原文\n第二行  \r\n2.下一件');
});
test('separates done and todo and numbers each from one', () => {
  const a = create('工作 A'), b = create('工作 B', { done: true });
  assert.equal(txt([a,b], day, true), '1.工作 B'); assert.equal(txt([a,b], day, false), '1.工作 A');
  assert.equal(filename(day,true), '2026-10-27_完成.txt'); assert.equal(filename(day,false), '2026-10-27_未完成.txt');
});
test('moving a task to done removes it from todo', () => {
  const a = create(), b = create(a.text, { previous: [a], done: true });
  assert.equal(txt([a,b],day,false),''); assert.equal(txt([a,b],day,true),'1.工作 A');
});
test('date changes remove the old entry and affect both dates update timestamps', () => {
  const a = create(); a.updatedAt = a.createdAt = '2026-10-27T01:00:00Z';
  const b = create(a.text, { previous:[a], date:'2026-10-28' }); b.updatedAt = '2026-10-27T02:00:00Z';
  assert.equal(txt([a,b],day,false),''); assert.equal(txt([a,b],'2026-10-28',false),'1.工作 A');
  assert.equal(updatedFor([a,b],day), b.updatedAt);
});
test('concurrent edits survive as conflicts and block that date export', () => {
  const a = create(), b = create('電腦修改', { previous:[a] }), c = create('手機修改', { previous:[a] });
  assert.equal(heads([a,b,c])[0].versions.length,2); assert.throws(() => txt([a,b,c],day,false), /不同版本/);
  assert.equal(txt([a,b,c],'2026-10-28',false),'');
});
test('resolution consumes both concurrent heads', () => {
  const a = create(), b = create('電腦修改',{previous:[a]}), c = create('手機修改',{previous:[a]}), d = create('電腦修改',{previous:[b,c]});
  assert.equal(heads([a,b,c,d])[0].conflict,false); assert.equal(txt([a,b,c,d],day,false),'1.電腦修改');
});
test('deletion and concurrent editing are a conflict, not silent loss', () => {
  const a = create(), b = create(a.text,{previous:[a],deleted:true}), c = create('手機修改',{previous:[a]});
  assert.equal(heads([a,b,c])[0].conflict,true); assert.equal(txt([a,b],day,false),'');
});
test('TXT import is whole by default, optional line splitting and number removal', () => {
  const source = '\uFEFF1.第一件\r\n\r\n2.第二件\r\n';
  assert.deepEqual(splitImport(source,'whole',false), ['1.第一件\n\n2.第二件\n']);
  assert.deepEqual(splitImport(source,'lines',true), ['第一件','第二件']);
});
test('backup rejects invalid date, duplicate ids, missing ancestors and cycles', () => {
  const a = create(), b = create('修改',{previous:[a]});
  const check = revisions => validateBackup({format:'wanin-backup-v1',revisions});
  assert.equal(check([a,b]).length,2); assert.throws(()=>check([b]),/缺少/); assert.throws(()=>check([a,a]),/重複/);
  assert.throws(()=>check([{...a,date:'2026-02-30'}]),/格式/);
  assert.throws(()=>check([{...a,parents:[b.id]},b]),/循環/);
});
test('fingerprints reflect exact content', async () => { assert.equal(await fingerprint('原文'),await fingerprint('原文')); assert.notEqual(await fingerprint('原文'),await fingerprint('原文 ')); });

class MemoryDrive extends Drive {
  constructor() { super({folderId:'root'}); this.files=[]; this.contents=new Map(); this.writes=0; }
  get connected() { return true; }
  async ensureFolder() { return 'data'; }
  async list(q) {
    if (q.includes("value='data-v1'")) return [{id:'data'}];
    if (q.includes("value='revision-v1'")) return this.files.filter(f=>f.appProperties?.wanin==='revision-v1');
    if (q.includes("value='txt-v1'")) return this.files.filter(f=>f.appProperties?.wanin==='txt-v1');
    if (q.includes('name =')) return this.files.filter(f=>q.includes(f.name));
    return [];
  }
  async request(path) { const id=path.split('/').at(-1).split('?')[0]; return JSON.parse(this.contents.get(id)); }
  async media(path, metadata, content, mime, method='POST') {
    const id = method==='POST' ? crypto.randomUUID() : path.split('/').at(-1);
    const previous = this.files.find(f=>f.id===id);
    const file = {...previous,...metadata,id,modifiedTime:new Date().toISOString()};
    this.files=this.files.filter(f=>f.id!==id).concat(file); this.contents.set(id,content); this.writes++; return file;
  }
}
test('Drive revision journal supports a second device and deduplicates pulls', async () => {
  const drive = new MemoryDrive(), a = create(); await drive.push(a);
  const first = await drive.pull(new Set()); assert.deepEqual(first.fetched,[a]); assert.equal(first.seen.has(a.id),true);
  const again = await drive.pull(new Set([a.id])); assert.equal(again.fetched.length,0);
});
test('two devices append concurrent revisions without overwriting originals', async () => {
  const drive = new MemoryDrive(), a = create(), b=create('電腦',{previous:[a]}), c=create('手機',{previous:[a]});
  await drive.push(a); await drive.push(b); await drive.push(c);
  const all=await drive.pull(new Set()); assert.equal(all.fetched.length,3); assert.equal(heads(all.fetched)[0].conflict,true);
});
test('automatic TXT writes skip unchanged reports, manual force updates', async () => {
  const drive=new MemoryDrive(), a=create(); let files=[];
  files=await drive.writeReport(day,false,[a],files); assert.equal(drive.writes,1);
  files=await drive.writeReport(day,false,[a],files); assert.equal(drive.writes,1);
  await drive.writeReport(day,false,[a],files,true); assert.equal(drive.writes,2);
});
test('TXT updates existing file id and empties a status after transition', async () => {
  const drive=new MemoryDrive(), a=create(); const files=await drive.writeReport(day,false,[a],[]);
  const b=create(a.text,{previous:[a],done:true}); const updated=await drive.writeReport(day,false,[a,b],files);
  assert.equal(updated[0].id,files[0].id); assert.equal(drive.contents.get(files[0].id),'');
});
test('unmanaged same-name TXT is never silently overwritten', async () => {
  const drive=new MemoryDrive(); drive.files=[{id:'external',name:filename(day,false)}];
  await assert.rejects(()=>drive.writeReport(day,false,[create()],[]),/不是由本工具建立/); assert.equal(drive.writes,0);
});
test('corrupt cloud revisions stop synchronization', async () => {
  const drive=new MemoryDrive(), a=create(); await drive.push(a); drive.contents.set(drive.files[0].id,JSON.stringify({...a,date:'invalid'}));
  await assert.rejects(()=>drive.pull(new Set()),/格式異常/);
});
test('duplicate report files converge without deletion', async () => {
  const drive=new MemoryDrive(), a=create();
  const files=await drive.writeReport(day,false,[a],[]);
  const duplicate={...files[0],id:'duplicate'}; drive.files.push(duplicate); drive.contents.set('duplicate','old');
  const b=create('更新',{previous:[a]}); await drive.writeReport(day,false,[a,b],drive.files);
  assert.equal(drive.contents.get(files[0].id),'1.更新'); assert.equal(drive.contents.get('duplicate'),'1.更新'); assert.equal(drive.files.length,2);
});

test('batch imports retain input order even at identical timestamps', () => {
  const revisions = Array.from({length:100},(_,i)=>create(`第 ${i+1} 件`));
  for (const r of revisions) r.createdAt='2026-10-27T00:00:00Z';
  const lines = txt(revisions,day,false).split('\r\n');
  assert.equal(lines[0],'1.第 1 件'); assert.equal(lines[99],'100.第 100 件');
});
test('expired authorization stops API access without losing stored revisions', async () => {
  const drive = new Drive({});
  await assert.rejects(()=>drive.request('/files'),/過期/); assert.equal(drive.connected,false);
});
test('401 clears the in-memory token and requests reconnection', async () => {
  const previousFetch=globalThis.fetch; let notified=false;
  globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:'Expired'}})});
  try {
    const drive=new Drive({},()=>notified=true); drive.token='test-only'; drive.expires=Date.now()+10000;
    await assert.rejects(()=>drive.request('/files'),/Expired/); assert.equal(drive.token,null); assert.equal(notified,true);
  } finally {globalThis.fetch=previousFetch;}
});
test('quota errors are reported rather than marked successful', async () => {
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:false,status:403,json:async()=>({})});
  try {
    const drive=new Drive({}); drive.token='test-only'; drive.expires=Date.now()+10000;
    await assert.rejects(()=>drive.request('/files'),/用量限制/);
  } finally {globalThis.fetch=previousFetch;}
});
