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
  f.columns=()=>{for(const column of [...new Set(f.store.state().items.filter(i=>i.stage==='column').map(i=>i.column_no))])while(f.store.state().items.some(i=>i.stage==='column'&&i.column_no===column)){f.act('batch',{kind:'scan-column',column});f.act('confirm');}};
  return f;
}
test('target shelf predicts only trusted source areas and excludes unassigned albums',()=>{
 const f=fixture();try{
 const s=f.act('target',{shelf:'32L'});assert.equal(s.total,11);assert.equal(s.remaining,10);assert.equal(s.excludedUnassigned,1);
 const expected=Object.fromEntries(['9A','18B','20C','24D','28E'].map(s=>['shelf-'+s,1]));
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

test('Scan & Sort persists ten-CD batches, order and placement without changing target or inventing tape',()=>{
 const f=fixture();try{
 const target=f.store.state().targetShelf;
 const sourceId=f.act('scan-sort').openedSourceId;
 const codes=['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','OTHER','REMOTE'];
 for(const barcode of codes)f.act('scan',{sourceId,barcode});
 assert.throws(()=>f.act('scan',{sourceId,barcode:'T1'}),/already in/);
 assert.equal(f.read('T1').sorted,0);f.act('save',{sourceId});
 assert.throws(()=>f.act('batch',{kind:'source',sourceId}),/Use Scan & Sort/);
 let b=f.act('batch',{kind:'scan-sort',sourceId}).batch;
 assert.deepEqual(b.rows.map(i=>i.barcode),codes.slice(2).reverse());assert.equal(b.rows.length,10);
 assert.equal(b.mode,'columns');assert.equal(b.rows[0].destination,9);assert.equal(b.rows[1].destination,32);
 f.restart();assert.deepEqual(f.store.state().batch,b);
 const revision=f.store.state().revision;f.act('confirm');
 assert.throws(()=>f.store.action({type:'confirm',revision}),/State changed/);
 b=f.act('batch',{kind:'scan-sort',sourceId}).batch;assert.deepEqual(b.rows.map(i=>i.barcode),['T2','T1']);
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='9A' WHERE barcode='T1'");
 assert.throws(()=>f.act('confirm'),/destination column changed/);assert.equal(f.read('T2').sorted,0);
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='32L' WHERE barcode='T1'");f.act('confirm');f.restart();
 assert.equal(f.store.state().targetShelf,target);assert.equal(f.store.state().sources.find(s=>s.id===sourceId).status,'complete');
 assert(codes.every(code=>f.read(code).sorted===0));
 const columnBatch=f.act('batch',{kind:'scan-column',column:32}).batch;assert.deepEqual(columnBatch.rows.map(i=>i.barcode),['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10']);assert.equal(columnBatch.rows[0].destination,'32L');f.act('confirm');f.columns();
 for(const barcode of codes){const a=f.read(barcode);assert.equal(a.sorted,1);assert.equal(a.sorted_shelf,a.final_shelf);assert(a.scanned_at&&a.sorted_at);assert.equal(a.taped,0);}
 f.act('target',{shelf:'32L'});assert.equal(f.store.state().recommendations.length,0);assert.equal(f.store.state().alreadyShelved.length,10);
 const report=f.store.report();assert.match(report,/32L: \[32L\]/);
 }finally{f.close();}
});
test('Scan & Sort sets unresolved CDs aside and removed actions cannot mutate the DB',()=>{
 const f=fixture();try{
 const sourceId=f.act('scan-sort').openedSourceId;f.act('scan',{sourceId,barcode:'UNKNOWN'});f.act('save',{sourceId});
 const aside=f.act('batch',{kind:'scan-sort',sourceId}).batch;assert.equal(aside.rows[0].placement,'set-aside');f.act('confirm');
 f.store.db.prepare("UPDATE rainbow_albums SET barcode='UNKNOWN' WHERE id=11").run();
 f.act('reconcile');assert(f.read('UNKNOWN').scanned_at);
 f.act('batch',{kind:'unassigned'});f.act('confirm');assert.equal(f.read('UNKNOWN').sorted,0);f.columns();assert.equal(f.read('UNKNOWN').sorted,1);
 const before=f.store.db.prepare('SELECT * FROM rainbow_albums').all();const revision=f.store.state().revision;
 assert.throws(()=>f.act('reset',{confirmation:'RESET'}),/Unknown action/);
 assert.throws(()=>f.act('coworker-finish',{}),/Unknown action/);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM rainbow_albums').all(),before);assert.equal(f.store.state().revision,revision);
 }finally{f.close();}
});

test('clear unfinished stacks cancels open batch, restores source predictions and preserves confirmed work',()=>{
 const f=fixture();try{
 let sourceId=f.act('scan-sort').openedSourceId;
 f.act('scan',{sourceId,barcode:'T1'});f.act('save',{sourceId});f.act('batch',{kind:'scan-sort',sourceId});f.act('confirm');f.columns();
 const confirmed=f.read('T1');
 sourceId=f.act('scan-sort').openedSourceId;f.act('scan',{sourceId,barcode:'T3'});f.act('save',{sourceId});f.act('batch',{kind:'scan-sort',sourceId});
 const revision=f.store.state().revision;f.act('clear-stacks');
 assert.equal(f.store.state().batch,null);assert(!f.store.state().items.some(i=>i.stage!=='sorted'));assert.deepEqual(f.read('T1'),confirmed);
 assert.equal(f.store.state().recommendations.find(r=>r.label==='Shelf 9A').count,1);
 assert.throws(()=>f.store.action({type:'confirm',revision}),/State changed/);
 f.restart();assert.equal(f.store.state().batch,null);assert.equal(f.read('T1').sorted,1);
 }finally{f.close();}
});

test('emptying a source invalidates unobserved catalog locations, including CDs destined for it',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});
 f.source('9A',['T3']);
 const s=f.store.state();assert(!s.recommendations.some(r=>r.label==='Shelf 9A'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM catchall_unknown_locations').get().n,2);
 f.restart();assert(!f.store.state().recommendations.some(r=>r.label==='Shelf 9A'));
 f.act('batch',{kind:'column',column:32});f.act('confirm');f.act('batch',{kind:'tape',shelf:'32L'});f.act('confirm');
 f.act('target',{shelf:'9A'});assert.equal(f.store.state().alreadyShelved.length,0);assert.equal(f.store.state().unavailable,1);
 // A new scan finds the CD; confirmed placement restores its known location.
 const sourceId=f.act('scan-sort').openedSourceId;f.act('scan',{sourceId,barcode:'REMOTE'});f.act('save',{sourceId});f.act('batch',{kind:'scan-sort',sourceId});f.act('confirm');f.columns();
 assert.equal(f.store.state().alreadyShelved.length,1);
 assert(!f.store.db.prepare('SELECT 1 FROM catchall_unknown_locations WHERE album_rowid=?').get(f.read('REMOTE').catalog_rowid));
 }finally{f.close();}
});

test('confirmed placements in broad areas remain known while old labels are unknown',()=>{
 const f=fixture();try{
 f.act('target',{shelf:'32L'});f.store.db.exec("UPDATE rainbow_albums SET sorted_shelf='19A',sorted=1 WHERE barcode='T1'");
 assert(f.store.state().recommendations.some(r=>r.label==='Shelf 19A'&&r.count===1));
 assert.equal(estimatedLocation({barcode:'x',new_shelf_label:'21A'}),null);
 assert.match(f.store.report(),/32L: \[9A, 18B, 19A, 20C, 24D, 28E\]/);
 }finally{f.close();}
});
