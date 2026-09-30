const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const {openStore,shelf,estimatedLocation}=require('../workflow');
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ktru-test-')),file=path.join(dir,'catalog.db');
  const db=new Database(file);
  db.exec(`CREATE TABLE rainbow_albums(id INTEGER,barcode TEXT,artist TEXT,title TEXT,final_shelf TEXT,new_shelf_label TEXT,assigned_at TEXT,primary_genre TEXT DEFAULT 'Rock',secondary_genre TEXT)`);
  const add=db.prepare('INSERT INTO rainbow_albums(id,barcode,artist,title,final_shelf,new_shelf_label) VALUES(?,?,?,?,?,?)');
  ['1A','8F','9A','18B','20C','24D','28E','19A','21A','23F'].forEach((old,i)=>add.run(i+1,'T'+(i+1),'Artist','Target '+(i+1),'32L',old));
  add.run(11,null,'Unknown artist','Unassigned target','32L','29A');
  add.run(12,'OTHER','Artist','Same column other shelf','32K','9A');
  add.run(13,'REMOTE','Artist','Different column','9A','9A');
  db.close();
  const f={dir,file,store:openStore(file)};
  f.act=(type,args={})=>f.store.action({type,revision:f.store.state().revision,...args});
  f.read=code=>f.store.db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums WHERE barcode=?').get(code);
  f.restart=()=>{f.store.db.close();f.store=openStore(file);};
  f.close=()=>{f.store.db.close();fs.rmSync(dir,{recursive:true,force:true});};
  f.source=(label,codes)=>{const state=f.act('source',{label});const sourceId=state.openedSourceId;for(const barcode of codes)f.act('scan',{sourceId,barcode});f.act('save',{sourceId});while(f.store.state().items.some(i=>i.stage==='source'&&i.source_id===sourceId)){f.act('batch',{kind:'source',sourceId});f.act('confirm');}return sourceId;};
  return f;
}
test('exact target shelf predictions follow all area rules and exclude unassigned albums',()=>{
 const f=fixture();try{
 const s=f.act('target',{shelf:'32L'});assert.equal(s.total,11);assert.equal(s.remaining,10);assert.equal(s.excludedUnassigned,1);
 const expected={'shelf-9A':1,'shelf-18B':1,'shelf-20C':1,'shelf-24D':1,'shelf-28E':1};
 assert.deepEqual(Object.fromEntries(s.recommendations.map(r=>[r.key,r.count])),expected);
 assert(!s.recommendations.some(r=>r.key==='unassigned-29-32'));
 assert.equal(estimatedLocation({barcode:null,new_shelf_label:'9A'}),null);
 assert.equal(shelf('33A'),null);assert(shelf('10A').rank>shelf('9Z').rank);
 assert.throws(()=>f.act('target',{shelf:'32Z'}),/populated/);
 }finally{f.close();}
});
test('scan records known working location immediately, never falsely confirms final placement, and removal restores it',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});const sourceId=f.act('source',{label:'9A'}).openedSourceId;
 f.act('scan',{sourceId,barcode:'T3'});assert.equal(f.read('T3').sorted,0);assert(f.read('T3').scanned_at);
 let s=f.store.state();assert(!s.recommendations.some(r=>r.key==='shelf-9A'));assert.equal(s.inProgress[0].label,'Source stack 9A');assert.equal(s.inProgress[0].count,1);
 assert.throws(()=>f.act('scan',{sourceId,barcode:'T3'}),/already in a working stack/);
 f.restart();assert.equal(f.store.state().inProgress[0].count,1);
 f.act('remove',{sourceId});assert.equal(f.read('T3').scanned_at,null);assert(f.store.state().recommendations.some(r=>r.key==='shelf-9A'));
 }finally{f.close();}
});
test('all non-target CDs reach final shelves, including the same column; target piles await tape and placement',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.source('9A',['T1','OTHER','REMOTE']);
 assert.throws(()=>f.act('batch',{kind:'column',column:32}),/other columns/);
 f.act('batch',{kind:'column',column:9});f.act('confirm');assert.equal(f.read('REMOTE').sorted,1);assert.equal(f.read('REMOTE').taped,0);
 const state=f.act('batch',{kind:'column',column:32});
 assert.equal(state.batch.rows.find(i=>i.barcode==='OTHER').placement,'sorted');assert.equal(state.batch.rows.find(i=>i.barcode==='T1').placement,'shelf');
 f.act('confirm');assert.equal(f.read('OTHER').sorted,1);assert.equal(f.read('OTHER').sorted_shelf,'32K');assert.equal(f.read('OTHER').taped,0);assert.equal(f.read('T1').sorted,0);
 const pending=f.act('batch',{kind:'tape',shelf:'32L'}).batch;f.restart();assert.deepEqual(f.store.state().batch,pending);
 f.act('confirm');assert.equal(f.read('T1').sorted,1);assert.equal(f.read('T1').taped,0);assert(require('../station-report').primaryDone(f.store.db,f.read('T1')));
 const s=f.act('target',{shelf:'32K'});assert.equal(s.alreadyShelved[0].barcode,'OTHER');assert.deepEqual(s.predictedLocations,[{key:'final-32K',label:'Shelf 32K',type:'already-shelved',count:1}]);
 assert.throws(()=>f.act('tape-existing',{barcode:'T1'}),/not an untaped/);
 f.act('tape-existing',{barcode:'OTHER'});f.restart();assert.equal(f.store.state().batch.kind,'tape-existing');f.act('confirm');
 assert.equal(f.read('OTHER').taped,0);assert(require('../station-report').primaryDone(f.store.db,f.read('OTHER')));assert.equal(f.store.state().remaining,0);assert.equal(f.store.state().complete,1);
 }finally{f.close();}
});
test('persistent piles accumulate across shelves and consume adjacent tape combinations in physical order',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.store.db.exec("UPDATE rainbow_albums SET secondary_genre=CASE WHEN id=1 THEN 'Jazz' WHEN id=2 THEN 'Pop' ELSE NULL END");
 f.source('9A',['T1','T2']);f.act('batch',{kind:'column',column:32});f.act('confirm');
 f.source('9B',['T3','T4']);f.act('batch',{kind:'column',column:32});f.act('confirm');
 assert.deepEqual(f.store.state().items.filter(i=>i.stage==='shelf').map(i=>i.barcode),['T4','T3','T2','T1']);
 assert.throws(()=>f.act('target',{shelf:'32K'}),/Finish the current/);
 assert.deepEqual(f.act('batch',{kind:'tape',shelf:'32L'}).batch.rows.map(i=>i.barcode),['T4','T3']);f.act('confirm');
 assert.equal(f.act('batch',{kind:'tape',shelf:'32L'}).batch.rows[0].album.secondary_genre,'Pop');f.act('confirm');
 assert.equal(f.act('batch',{kind:'tape',shelf:'32L'}).batch.rows[0].album.secondary_genre,'Jazz');f.act('confirm');
 assert.equal(f.store.state().complete,4);
 }finally{f.close();}
});
test('external assignments reconcile in place and immediately avoid false old-location predictions',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.source('29A',['NEW']);
 f.store.db.prepare("UPDATE rainbow_albums SET barcode='NEW' WHERE id=11").run();
 assert.equal(f.store.state().excludedUnassigned,0);assert.equal(f.store.state().inProgress[0].label,'Unassigned stack');
 assert.throws(()=>f.act('batch',{kind:'unassigned'}),/Assign every/);
 f.act('reconcile');assert(f.read('NEW').scanned_at);assert.equal(f.read('NEW').sorted,0);
 const b=f.act('batch',{kind:'unassigned'}).batch;assert.equal(b.rows[0].destination,32);f.act('confirm');assert.equal(f.store.state().items[0].stage,'column');
 }finally{f.close();}
});
test('sorted catalog flags are recognized without a workflow item and tape-at-shelf is verified by barcode',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.store.db.exec("UPDATE rainbow_albums SET sorted=1 WHERE id IN (1,2); UPDATE rainbow_albums SET taped=1 WHERE id=2");
 assert.equal(f.store.state().alreadyShelved.length,1);assert.equal(f.store.state().complete,1);
 f.act('tape-existing',{barcode:'T1'});f.act('confirm');assert.equal(f.store.state().complete,2);assert.equal(f.store.state().items.length,0);
 // Reset must restore the pre-existing placement flag, not erase catalog history.
 f.act('reset',{confirmation:'RESET'});assert.equal(f.read('T1').sorted,1);assert.equal(f.read('T1').taped,0);assert.equal(f.read('T2').taped,1);
 }finally{f.close();}
});
test('finished CDs can be scanned again; removing the scan restores their immediately previous confirmed location',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32K'});f.source('9A',['T1']);f.act('batch',{kind:'column',column:32});f.act('confirm');assert.equal(f.read('T1').sorted,1);
 const sourceId=f.act('source',{label:'9A'}).openedSourceId;f.act('scan',{sourceId,barcode:'T1'});assert.equal(f.read('T1').sorted,0);
 f.act('remove',{sourceId});assert.equal(f.read('T1').sorted,1);assert.equal(f.read('T1').sorted_shelf,'32L');assert.equal(f.store.state().items[0].stage,'sorted');
 }finally{f.close();}
});
test('changed destinations, changed tape combinations and stale confirmations cannot silently finish work',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.source('9A',['T1']);f.act('batch',{kind:'column',column:32});
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='32K' WHERE id=1");assert.throws(()=>f.act('confirm'),/final shelf changed/);assert.equal(f.read('T1').sorted,0);
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='32L' WHERE id=1");f.act('confirm');f.act('batch',{kind:'tape',shelf:'32L'});
 f.store.db.exec("UPDATE rainbow_albums SET secondary_genre='Jazz' WHERE id=1");assert.throws(()=>f.act('confirm'),/Tape genres changed/);
 f.store.db.exec('UPDATE rainbow_albums SET secondary_genre=NULL WHERE id=1');const rev=f.store.state().revision;f.act('confirm');
 assert.throws(()=>f.store.action({type:'confirm',revision:rev}),/State changed/);
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='32K' WHERE id=1");f.act('target',{shelf:'32K'});assert(f.store.state().recommendations.some(r=>r.label==='Shelf 32L'));
 }finally{f.close();}
});
test('reset backs up state and restores only workflow tracking, preserving assignments and catalog content',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});const before=f.store.db.prepare('SELECT * FROM rainbow_albums').all();
 f.source('9A',['T1','OTHER']);f.act('batch',{kind:'column',column:32});f.act('confirm');
 assert.throws(()=>f.act('reset',{confirmation:'no'}),/Type RESET/);const prior=f.store.state();
 const result=f.act('reset',{confirmation:'RESET'});assert.equal(result.items.length,0);assert.equal(result.sources.length,0);assert.deepEqual(f.store.db.prepare('SELECT * FROM rainbow_albums').all(),before);
 const backup=new Database(path.join(f.dir,'backups',result.resetBackup),{readonly:true});assert.equal(backup.prepare('SELECT count(*) n FROM catchall_items').get().n,2);backup.close();
 assert.throws(()=>f.store.action({type:'reset',revision:prior.revision,confirmation:'RESET'}),/State changed/);
 }finally{f.close();}
});
test('legacy v2 migration preserves active batch/order and imports confirmed sorted records without inventing tape',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.source('9A',['REMOTE']);f.act('batch',{kind:'column',column:9});f.act('confirm');
 const id=f.act('source',{label:'9B'}).openedSourceId;f.act('scan',{sourceId:id,barcode:'T1'});f.act('save',{sourceId:id});f.act('batch',{kind:'source',sourceId:id});const b=f.store.state().batch;
 f.store.db.exec(`DROP TABLE catchall_catalog_baseline; ALTER TABLE catchall_meta DROP COLUMN target_shelf; ALTER TABLE catchall_items DROP COLUMN scanned_at; ALTER TABLE catchall_items DROP COLUMN scan_previous; UPDATE catchall_meta SET version=2;`);
 for(const name of ['sorted','taped','scanned_at','sorted_at','taped_at','sorted_shelf'])f.store.db.exec(`ALTER TABLE rainbow_albums DROP COLUMN ${name}`);
 f.restart();assert.equal(f.store.db.prepare('SELECT version FROM catchall_meta').get().version,3);assert.deepEqual(f.store.state().batch,b);assert.equal(f.read('REMOTE').sorted,1);assert.equal(f.read('REMOTE').taped,0);assert.equal(f.read('T1').sorted,0);
 const backups=fs.readdirSync(path.join(f.dir,'backups'));assert(backups.some(n=>n.startsWith('before-target-shelf-')));
 f.act('confirm');assert.equal(f.store.state().items.find(i=>i.barcode==='T1').stage,'column');
 }finally{f.close();}
});

test('initial pass, late arrivals, coworker review and tape confirmation survive restart and reset',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32K'});
 assert.throws(()=>f.act('initial-pass'),/Finish the predicted/);
 f.source('9A',['OTHER']);f.act('batch',{kind:'column',column:32});f.act('confirm');
 assert.throws(()=>f.act('initial-pass'),/Finish the predicted/);
 f.act('batch',{kind:'tape',shelf:'32K'});f.act('confirm');
 assert.equal(f.read('OTHER').taped,0);
 f.act('initial-pass');f.restart();
 let h=f.store.state().handoff;assert.equal(h.passes.length,1);assert.equal(h.queue.length,1);assert(h.queue[0].primary);assert(!h.queue[0].review);
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='32K',sorted=1,sorted_shelf='32K',sorted_at='2099-01-01' WHERE barcode='T1'");
 h=f.store.state().handoff;assert.equal(h.queue.length,2);assert(h.queue.find(a=>a.barcode==='T1').lateArrival);assert(!h.queue.find(a=>a.barcode==='T1').primary);
 assert.throws(()=>f.act('coworker-finish',{barcode:'OTHER'}),/Confirm primary/);
 f.act('coworker-finish',{barcode:'OTHER',hasReview:false,primaryConfirmed:true,secondaryConfirmed:true});
 assert.equal(f.read('OTHER').taped,1);assert.equal(f.store.state().handoff.queue.length,1);
 f.act('coworker-finish',{barcode:'T1',hasReview:true,primaryConfirmed:true,secondaryConfirmed:true});
 assert.equal(f.store.state().handoff.queue.length,0);
 const report=f.store.report();assert.match(report,/Reviews present \/ absent \| 1 \/ 1/);assert.match(report,/32K: \[32K\]/);
 f.store.db.exec("UPDATE rainbow_albums SET secondary_genre='Jazz' WHERE barcode='OTHER'");
 assert.equal(f.store.state().handoff.queue.length,1);assert(!f.store.state().handoff.queue[0].secondary);
 f.act('reset',{confirmation:'RESET'});assert.equal(f.store.state().handoff.passes.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM catchall_finishing').get().n,0);
 }finally{f.close();}
});
test('report is read-only, escapes catalog markup, covers every shelf and separates working locations',()=>{
 const f=fixture();try{
 f.store.db.exec("UPDATE rainbow_albums SET primary_genre='Rock|<b> & Jazz' WHERE barcode='T3'");
 const before=f.store.state().revision;
 let report=f.store.report();assert.equal(f.store.state().revision,before);
 assert.match(report,/32L: \[9A, 18B, 20C, 24D, 28E\]/);
 assert(!report.includes('32L: [1A'));assert.match(report,/Rock&#124;&lt;b&gt; &amp; Jazz/);
 f.act('target',{shelf:'32L'});const id=f.act('source',{label:'9A'}).openedSourceId;f.act('scan',{sourceId:id,barcode:'T3'});
 report=f.store.report();assert.match(report,/32L: \[18B, 20C, 24D, 28E\]/);assert.match(report,/Source stack 9A/);
 }finally{f.close();}
});
test('coworker finishing can proceed during an unrelated sorting batch without losing its order',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32K'});
 f.store.db.exec("UPDATE rainbow_albums SET sorted=1,sorted_shelf='32K',taped=1 WHERE barcode='OTHER'");
 f.act('initial-pass');
 f.act('target',{shelf:'32L'});f.source('9A',['T3']);
 const batch=f.act('batch',{kind:'column',column:32}).batch;
 const oldRevision=f.store.state().revision;
 f.act('coworker-finish',{barcode:'OTHER',hasReview:true,primaryConfirmed:true,secondaryConfirmed:true});
 assert.deepEqual(f.store.state().batch,batch);
 assert.throws(()=>f.store.action({type:'confirm',revision:oldRevision}),/State changed/);
 f.act('confirm');assert.equal(f.store.state().items.find(i=>i.barcode==='T3').stage,'shelf');
 }finally{f.close();}
});
