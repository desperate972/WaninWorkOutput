import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRevision, heads, txt, filename, validDate, splitImport, validateBackup, fingerprint, updatedFor, startOf, endOf, datesOf, reportDates, occursOn, dateLabel, kindOf, reportModes, reportStatus } from '../core.js';
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

test('reuses an accessible saved folder without loading or opening Picker', async () => {
  const drive = new Drive({folderId:'saved-folder'}); let pickerLoads=0, pickerOpens=0;
  drive.request = async path => { assert.match(path,/saved-folder/); return {id:'saved-folder',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}}; };
  drive.pickFolder = async () => { pickerOpens++; return 'saved-folder'; };
  await drive.authorizeTargetFolder(async () => pickerLoads++);
  await drive.authorizeTargetFolder(async () => pickerLoads++);
  assert.equal(pickerLoads,0); assert.equal(pickerOpens,0);
});
test('a fresh connection reuses previously granted folder access', async () => {
  const previousGoogle=globalThis.google;
  globalThis.google={accounts:{oauth2:{initTokenClient: options=>({requestAccessToken:()=>options.callback({access_token:'new-test-token',expires_in:3600})})}}};
  try {
    const drive=new Drive({folderId:'saved-folder',clientId:'test-only'});
    drive.request=async path=>path.startsWith('/about') ? {user:{permissionId:'same-account'}} : {mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};
    drive.pickFolder=async()=>assert.fail('reconnection must not open Picker');
    const user=await drive.connect(); await drive.authorizeTargetFolder();
    assert.equal(user.permissionId,'same-account'); assert.equal(drive.connected,true);
  } finally { if(previousGoogle===undefined) delete globalThis.google; else globalThis.google=previousGoogle; }
});
test('missing per-file access opens Picker once and validates the chosen folder', async () => {
  const drive=new Drive({folderId:'saved-folder'}); let granted=false, loads=0, opens=0;
  drive.request=async()=>{if(!granted) throw Object.assign(Error('not shared'),{status:404}); return {mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};};
  drive.pickFolder=async()=>{opens++; granted=true; return 'saved-folder';};
  await drive.authorizeTargetFolder(async()=>loads++); await drive.authorizeTargetFolder(async()=>loads++);
  assert.equal(loads,1); assert.equal(opens,1);
});
test('insufficient file permission can request the same folder grant again', async () => {
  const drive=new Drive({folderId:'saved-folder'}); let granted=false;
  drive.request=async()=>{if(!granted) throw Object.assign(Error('permission'),{status:403,reasons:['insufficientFilePermissions']}); return {mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};};
  drive.pickFolder=async()=>{granted=true; return 'saved-folder';}; await drive.authorizeTargetFolder(); assert.equal(granted,true);
});
test('quota, API, network and authentication errors never open Picker', async () => {
  for(const failure of [Object.assign(Error('quota'),{status:403,reasons:['userRateLimitExceeded']}),Object.assign(Error('API disabled'),{status:403,reasons:['accessNotConfigured']}),Object.assign(Error('expired'),{status:401}),Error('network')]) {
    const drive=new Drive({folderId:'saved-folder'}); drive.request=async()=>{throw failure;}; drive.pickFolder=async()=>assert.fail('unexpected Picker');
    await assert.rejects(()=>drive.authorizeTargetFolder(),e=>e===failure);
  }
});
test('wrong folder selection cannot silently switch sync destination', async () => {
  const drive=new Drive({folderId:'saved-folder'}); drive.request=async()=>{throw Object.assign(Error('missing'),{status:404});}; drive.pickFolder=async()=>'other-folder';
  await assert.rejects(()=>drive.authorizeTargetFolder(),/選取的資料夾與設定不同/); assert.equal(drive.config.folderId,'saved-folder');
});
test('read-only and trashed targets fail without writing or opening Picker', async () => {
  for(const target of [{mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:false}},{mimeType:'application/vnd.google-apps.folder',trashed:true,capabilities:{canAddChildren:true}}]) {
    const drive=new Drive({folderId:'saved-folder'}); drive.request=async()=>target; drive.pickFolder=async()=>assert.fail('unexpected Picker');
    await assert.rejects(()=>drive.authorizeTargetFolder(),/垃圾桶或無法寫入/);
  }
});
test('cancelling reauthorization preserves the configured folder', async () => {
  const drive=new Drive({folderId:'saved-folder'}); drive.request=async()=>{throw Object.assign(Error('missing'),{status:404});}; drive.pickFolder=async()=>{throw Error('已取消資料夾授權。');};
  await assert.rejects(()=>drive.authorizeTargetFolder(),/取消/); assert.equal(drive.config.folderId,'saved-folder');
});

test('note-only editing leaves original work, date and completion unchanged', () => {
  const a=create('  工作原文\n第二行  ',{done:true});
  const b=create(a.text,{previous:[a],date:a.date,done:a.done,notes:'補充進度'});
  assert.equal(b.text,a.text); assert.equal(b.date,a.date); assert.equal(b.done,a.done); assert.equal(b.recordId,a.recordId); assert.equal(b.createdAt,a.createdAt); assert.equal(b.notes,'補充進度');
});
test('notes survive completion changes, date changes and deletion history', () => {
  const a=create('工作',{notes:'等待新版測試'}), b=create(a.text,{previous:[a],done:true}), c=create(b.text,{previous:[b],date:'2026-10-28',done:true}), d=create(c.text,{previous:[c],date:c.date,done:true,deleted:true});
  assert.equal(b.notes,a.notes); assert.equal(c.notes,a.notes); assert.equal(d.notes,a.notes);
});
test('explicitly clearing notes does not restore an older note', () => {
  const a=create('工作',{notes:'舊備註'}), b=create(a.text,{previous:[a],notes:''}), c=create(b.text,{previous:[b],done:true});
  assert.equal(b.notes,''); assert.equal(c.notes,''); assert.equal(txt([a,b,c],day,true),'1.工作');
});
test('TXT includes notes below the correct item with multiline indentation', () => {
  const a=create('第一件',{notes:'進度\n待確認\r\n最後一行'}), b=create('第二件'); b.createdAt='2099-01-01T00:00:00Z';
  assert.equal(txt([a,b],day,false),'1.第一件\r\n  備註：進度\r\n        待確認\r\n        最後一行\r\n2.第二件');
});
test('old revisions and backups without notes are still accepted', () => {
  const a=create(); delete a.notes;
  assert.equal(validateBackup({format:'wanin-backup-v1',revisions:[a]}).length,1);
  assert.equal(txt([a],day,false),'1.工作 A');
  assert.equal(create(a.text,{previous:[a],done:true}).notes,'');
});
test('backup roundtrip preserves multiline notes and rejects invalid note types', () => {
  const a=create('工作',{notes:'第一行\n第二行 <script>純文字</script>'});
  const restored=validateBackup(JSON.parse(JSON.stringify({format:'wanin-backup-v1',revisions:[a]})));
  assert.equal(restored[0].notes,a.notes);
  assert.throws(()=>validateBackup({format:'wanin-backup-v1',revisions:[{...a,notes:123}]}),/格式/);
  assert.throws(()=>create('工作',{notes:'a'.repeat(100001)}),/備註/);
});
test('concurrent notes edits are preserved as separate versions', () => {
  const a=create('工作'), b=create(a.text,{previous:[a],notes:'電腦備註'}), c=create(a.text,{previous:[a],notes:'手機備註'});
  assert.equal(heads([a,b,c])[0].conflict,true); assert.throws(()=>txt([a,b,c],day,false),/不同版本/);
  const resolved=create(c.text,{previous:[b,c],notes:c.notes});
  assert.equal(txt([a,b,c,resolved],day,false),'1.工作\r\n  備註：手機備註');
});
test('Drive journal transfers notes and updates TXT when only notes change', async () => {
  const drive=new MemoryDrive(), a=create('工作',{notes:'原備註'}); await drive.push(a);
  const pulled=await drive.pull(new Set()); assert.equal(pulled.fetched[0].notes,a.notes);
  let files=await drive.writeReport(day,false,[a],[]); const writes=drive.writes;
  const b=create(a.text,{previous:[a],notes:'新備註'}); files=await drive.writeReport(day,false,[a,b],files);
  assert.equal(drive.writes,writes+1); assert.equal(drive.contents.get(files[0].id),'1.工作\r\n  備註：新備註');
});

test('same-day and legacy jobs map to one day without rewriting old versions', () => {
  const a=create('舊工作'); delete a.startDate; delete a.endDate;
  assert.equal(validateBackup({format:'wanin-backup-v1',revisions:[a]}).length,1);
  assert.equal(startOf(a),day); assert.equal(endOf(a),day); assert.deepEqual(datesOf(a),[day]); assert.equal(dateLabel(a),day);
  assert.equal(a.startDate,undefined);
});
test('three-day jobs appear on all inclusive dates with notes, never outside', () => {
  const a=create('跨日工作',{startDate:'2026-10-29',endDate:'2026-10-31',notes:'跨日備註'});
  assert.deepEqual(datesOf(a),['2026-10-29','2026-10-30','2026-10-31']);
  for(const date of datesOf(a)) {assert.equal(occursOn(a,date),true); assert.equal(txt([a],date,false),'1.跨日工作\r\n  備註：跨日備註');}
  assert.equal(txt([a],'2026-10-28',false),''); assert.equal(txt([a],'2026-11-01',false),'');
  assert.equal(heads([a]).length,1); assert.equal(dateLabel(a),'2026-10-29 ～ 2026-10-31');
});
test('range enumeration crosses month, year and leap boundaries in UTC', () => {
  assert.deepEqual(datesOf(create('跨月',{startDate:'2026-10-31',endDate:'2026-11-02'})),['2026-10-31','2026-11-01','2026-11-02']);
  assert.deepEqual(datesOf(create('跨年',{startDate:'2026-12-31',endDate:'2027-01-01'})),['2026-12-31','2027-01-01']);
  assert.deepEqual(datesOf(create('閏年',{startDate:'2024-02-28',endDate:'2024-03-01'})),['2024-02-28','2024-02-29','2024-03-01']);
});
test('reversed, partial and inconsistent date ranges are rejected', () => {
  assert.throws(()=>create('反向',{startDate:'2026-10-31',endDate:'2026-10-29'}),/結束日期/);
  const a=create('正常',{startDate:'2026-10-29',endDate:'2026-10-31'});
  const check=r=>validateBackup({format:'wanin-backup-v1',revisions:[r]});
  assert.throws(()=>check({...a,endDate:undefined}),/格式/);
  assert.throws(()=>check({...a,endDate:'2026-02-30'}),/格式/);
  assert.throws(()=>check({...a,date:'2026-10-28'}),/格式/);
});
test('note-only, completion and deletion changes retain the original range', () => {
  const a=create('工作',{startDate:'2026-10-29',endDate:'2026-10-31'}), b=makeRevision({previous:[a],text:a.text,done:false,notes:'補充'}), c=makeRevision({previous:[b],text:b.text,done:true}), d=makeRevision({previous:[c],text:c.text,done:true,deleted:true});
  for(const r of [b,c,d]) {assert.equal(startOf(r),'2026-10-29');assert.equal(endOf(r),'2026-10-31');}
  for(const date of datesOf(a)) {assert.equal(txt([a,b,c],date,false),'');assert.equal(txt([a,b,c],date,true),'1.工作\r\n  備註：補充');assert.equal(txt([a,b,c,d],date,true),'');}
});
test('shortening a range preserves old report dates and removes stale content', () => {
  const a=create('工作',{startDate:'2026-10-29',endDate:'2026-10-31'}); a.updatedAt='2026-10-29T01:00:00Z';
  const b=create(a.text,{previous:[a],startDate:'2026-10-30',endDate:'2026-10-30'});b.updatedAt='2026-10-29T02:00:00Z';
  assert.deepEqual(reportDates([a,b]),['2026-10-29','2026-10-30','2026-10-31']);
  assert.equal(txt([a,b],'2026-10-29',false),'');assert.equal(txt([a,b],'2026-10-30',false),'1.工作');assert.equal(txt([a,b],'2026-10-31',false),'');
  assert.equal(updatedFor([a,b],'2026-10-29'),b.updatedAt);assert.equal(updatedFor([a,b],'2026-10-31'),b.updatedAt);
});
test('moving a range includes the union of old and new days for report cleanup', () => {
  const a=create('工作',{startDate:'2026-10-29',endDate:'2026-10-31'}), b=create(a.text,{previous:[a],startDate:'2026-11-02',endDate:'2026-11-03'});
  assert.deepEqual(reportDates([a,b]),['2026-10-29','2026-10-30','2026-10-31','2026-11-02','2026-11-03']);
  assert.equal(txt([a,b],'2026-10-30',false),'');assert.equal(txt([a,b],'2026-11-03',false),'1.工作');
});
test('range conflicts block every affected date, and resolving retains chosen range', () => {
  const a=create('工作',{startDate:'2026-10-29',endDate:'2026-10-31'}), b=create(a.text,{previous:[a],startDate:'2026-10-29',endDate:'2026-10-30'}), c=create(a.text,{previous:[a],startDate:'2026-10-30',endDate:'2026-11-01'});
  for(const date of ['2026-10-29','2026-10-30','2026-10-31','2026-11-01']) assert.throws(()=>txt([a,b,c],date,false),/不同版本/);
  const d=makeRevision({previous:[b,c],text:c.text,startDate:startOf(c),endDate:endOf(c),done:false});
  assert.equal(txt([a,b,c,d],'2026-10-29',false),'');assert.equal(txt([a,b,c,d],'2026-11-01',false),'1.工作');
});
test('range backup roundtrip and a second device preserve all date fields', async () => {
  const drive=new MemoryDrive(), a=create('工作',{startDate:'2026-10-29',endDate:'2026-10-31',notes:'備註'}); await drive.push(a);
  const {fetched}=await drive.pull(new Set()); const restored=validateBackup(JSON.parse(JSON.stringify({format:'wanin-backup-v1',revisions:fetched})));
  assert.equal(startOf(restored[0]),startOf(a));assert.equal(endOf(restored[0]),endOf(a));assert.equal(restored[0].notes,a.notes);
});
test('Drive writes both status files on all three days and clears shortened days', async () => {
  const drive=new MemoryDrive(), a=create('工作',{startDate:'2026-10-29',endDate:'2026-10-31'});
  let files=[];
  for(const date of reportDates([a]))for(const done of [true,false])files.push(...await drive.writeReport(date,done,[a],files));
  assert.equal(drive.files.length,6);
  const b=create(a.text,{previous:[a],startDate:'2026-10-30',endDate:'2026-10-30'});
  for(const date of reportDates([a,b]))for(const done of [true,false])await drive.writeReport(date,done,[a,b],drive.files);
  for(const f of drive.files)assert.equal(drive.contents.get(f.id), f.appProperties.date==='2026-10-30'&&f.appProperties.status==='todo'?'1.工作':'');
});

test('legacy revisions remain work while notes have no completion behavior', () => {
  const work=create('工作'); delete work.kind;
  const note=create('筆記',{kind:'note',done:true});
  assert.equal(kindOf(work),'work'); assert.equal(kindOf(note),'note'); assert.equal(note.done,false);
  assert.deepEqual(reportModes('work'),[true,false]); assert.deepEqual(reportModes('note'),['note']); assert.equal(reportStatus('note'),'note');
  assert.equal(validateBackup({format:'wanin-backup-v1',revisions:[work,note]}).length,2);
});
test('work and notes never enter each others TXT reports', () => {
  const todo=create('未完成工作'), done=create('完成工作',{done:true}), note=create('獨立筆記',{kind:'note'});
  assert.equal(txt([todo,done,note],day,false),'1.未完成工作');assert.equal(txt([todo,done,note],day,true),'1.完成工作');assert.equal(txt([todo,done,note],day,'note'),'1.獨立筆記');
  assert.equal(filename(day,'note'),'2026-10-27_筆記.txt');
});
test('notes appear on all days of a range and disappear outside it', () => {
  const note=create('三日筆記',{kind:'note',startDate:'2026-10-30',endDate:'2026-11-01'});
  for(const date of datesOf(note))assert.equal(txt([note],date,'note'),'1.三日筆記');
  assert.equal(txt([note],'2026-10-29','note'),'');assert.equal(txt([note],'2026-11-02','note'),'');
});
test('note edits and deletion preserve type and do not create work entries', () => {
  const a=create('原筆記',{kind:'note',startDate:'2026-10-30',endDate:'2026-11-01'});
  const b=makeRevision({previous:[a],text:'更新筆記',done:true});
  assert.equal(b.kind,'note');assert.equal(b.done,false);assert.equal(endOf(b),endOf(a));
  const c=makeRevision({previous:[b],text:b.text,deleted:true});
  for(const date of datesOf(a)){assert.equal(txt([a,b],date,false),'');assert.equal(txt([a,b],date,'note'),'1.更新筆記');assert.equal(txt([a,b,c],date,'note'),'');}
});
test('note conflicts block only note reports, not work reports on the same day', () => {
  const w=create('正常工作'), a=create('筆記',{kind:'note'}), b=makeRevision({previous:[a],text:'手機版本'}), c=makeRevision({previous:[a],text:'電腦版本'});
  assert.equal(txt([w,a,b,c],day,false),'1.正常工作');assert.throws(()=>txt([w,a,b,c],day,'note'),/不同版本/);
  const d=makeRevision({previous:[b,c],text:c.text}); assert.equal(txt([w,a,b,c,d],day,'note'),'1.電腦版本');
});
test('work conflicts do not block unrelated note reports', () => {
  const a=create('工作'), b=create('A',{previous:[a]}), c=create('B',{previous:[a]}), n=create('筆記',{kind:'note'});
  assert.equal(txt([a,b,c,n],day,'note'),'1.筆記');assert.throws(()=>txt([a,b,c,n],day,false),/不同版本/);
});
test('updated timestamps stay independent between work and notes', () => {
  const w=create('工作'), n=create('筆記',{kind:'note'});w.updatedAt='2026-10-27T01:00:00Z';n.updatedAt='2026-10-27T02:00:00Z';
  assert.equal(updatedFor([w,n],day),w.updatedAt);assert.equal(updatedFor([w,n],day,'note'),n.updatedAt);
});
test('types cannot be changed or mixed in a revision chain or backup', () => {
  const a=create('工作');assert.throws(()=>makeRevision({previous:[a],text:a.text,kind:'note'}),/類型/);
  const b=create('修改',{previous:[a]});
  assert.throws(()=>validateBackup({format:'wanin-backup-v1',revisions:[a,{...b,kind:'note'}]}),/版本關係/);
  assert.throws(()=>validateBackup({format:'wanin-backup-v1',revisions:[{...a,kind:'invalid'}]}),/格式/);
});
test('Drive restores mixed backups and keeps notes TXT separate from work files', async () => {
  const drive=new MemoryDrive(), w=create('工作'), n=create('筆記',{kind:'note'});
  await drive.push(w);await drive.push(n);
  const pulled=await drive.pull(new Set());const restored=validateBackup(JSON.parse(JSON.stringify({format:'wanin-backup-v1',revisions:pulled.fetched})));
  assert.equal(restored.filter(r=>kindOf(r)==='note').length,1);
  let reports=[];for(const mode of [true,false,'note'])reports.push(...await drive.writeReport(day,mode,restored,reports));
  assert.equal(reports.length,3);
  assert.equal(drive.contents.get(reports.find(f=>f.appProperties.status==='note').id),'1.筆記');assert.equal(drive.contents.get(reports.find(f=>f.appProperties.status==='todo').id),'1.工作');
  const noteUpdate=makeRevision({previous:[n],text:'更新筆記'}), todo=reports.find(f=>f.appProperties.status==='todo'), oldTodo=drive.contents.get(todo.id);
  await drive.writeReport(day,'note',[w,n,noteUpdate],reports);assert.equal(drive.contents.get(todo.id),oldTodo);
});
test('shortening a note clears only its old daily note files', async () => {
  const drive=new MemoryDrive(), a=create('筆記',{kind:'note',startDate:'2026-10-30',endDate:'2026-11-01'});
  for(const date of datesOf(a))await drive.writeReport(date,'note',[a],drive.files);
  const b=makeRevision({previous:[a],text:a.text,startDate:'2026-10-31',endDate:'2026-10-31'});
  for(const date of reportDates([a,b]))await drive.writeReport(date,'note',[a,b],drive.files);
  assert.equal(drive.files.length,3);for(const f of drive.files)assert.equal(drive.contents.get(f.id),f.appProperties.date==='2026-10-31'?'1.筆記':'');
});
