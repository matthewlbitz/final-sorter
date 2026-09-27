const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const {openStore,shelf}=require('../workflow');
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ktru-test-'));const file=path.join(dir,'catalog.db');const db=new Database(file);db.exec('CREATE TABLE rainbow_albums(id INTEGER,barcode TEXT,artist TEXT,title TEXT,final_shelf TEXT,new_shelf_label TEXT,assigned_at TEXT,primary_genre TEXT DEFAULT 'Rock',secondary_genre TEXT)');const add=db.prepare('INSERT INTO rainbow_albums(id,barcode,artist,title,final_shelf,new_shelf_label,assigned_at) VALUES(?,?,?,?,?,?,NULL)');for(let i=1;i<=25;i++)add.run(i,'CD'+i,'Artist','Album '+i,i===25?'9A':'32P',i<=12?'23F':i<=24?'23G':'17A');add.run(26,null,'Unknown Artist','Searchable Album','32P','23G');db.close();return {dir,file,store:openStore(file)};}
function act(s,type,args={}){return s.action({revision:s.state().revision,type,...args});}
test('physical order, shared columns, unknown assignment, restart and final confirmation',()=>{
 const f=fixture();let s=f.store;
 try{
 act(s,'target',{column:32});assert.equal(s.state().remaining,25);assert.equal(s.state().recommendations[0].label,'23G');
 act(s,'source',{label:'23F'});let sourceId=s.state().sources[0].id;
 for(let i=1;i<=12;i++)act(s,'scan',{sourceId,barcode:'CD'+i});
 act(s,'scan',{sourceId,barcode:'UNKNOWN'});assert.throws(()=>act(s,'scan',{sourceId,barcode:'CD1'}),/already/);
 act(s,'save',{sourceId});act(s,'batch',{kind:'source',sourceId});
 assert.deepEqual(s.state().batch.rows.map(i=>i.barcode),['UNKNOWN','CD12','CD11','CD10','CD9','CD8','CD7','CD6','CD5','CD4']);
 const before=s.state();s.db.close();s=openStore(f.file);assert.deepEqual(s.state().batch,before.batch);
 assert.throws(()=>act(s,'source',{label:'NEW'}),/Finish/);
 act(s,'confirm');act(s,'batch',{kind:'source',sourceId});act(s,'confirm');
 assert.equal(s.state().remaining,25);assert.equal(s.state().sources[0].status,'complete');
 act(s,'source',{label:'23G'});sourceId=s.state().sources[0].id;
 for(let i=13;i<=24;i++)act(s,'scan',{sourceId,barcode:'CD'+i});act(s,'save',{sourceId});
 for(let n=0;n<2;n++){act(s,'batch',{kind:'source',sourceId});act(s,'confirm');}
 const unknown=s.state().items.find(i=>i.barcode==='UNKNOWN');assert.equal(s.search('Searchable')[0].catalog_rowid,26);
 act(s,'assign',{itemId:unknown.id,albumId:26});assert.equal(s.state().items.find(i=>i.id===unknown.id).stage,'unassigned');
 act(s,'route',{itemId:unknown.id});
 act(s,'batch',{kind:'column',column:32});assert.deepEqual(s.state().batch.rows.map(i=>i.barcode),['UNKNOWN','CD13','CD14','CD15','CD16','CD17','CD18','CD19','CD20','CD21']);
 assert.equal(s.state().remaining,25);const revision=s.state().revision;act(s,'confirm');assert.equal(s.state().remaining,25);
 assert.throws(()=>s.action({revision,type:'confirm'}),/State changed/);
 while(s.state().items.some(i=>i.stage==='column')){act(s,'batch',{kind:'column',column:32});act(s,'confirm');}
 assert.equal(s.state().remaining,25);assert.equal(s.state().items.filter(i=>i.sorted_at).length,0);
 assert.deepEqual(s.state().items.filter(i=>i.stage==='shelf').slice(0,3).map(i=>i.barcode),['CD12','CD11','CD10']);
 while(s.state().items.some(i=>i.stage==='shelf')){act(s,'batch',{kind:'tape',shelf:'32P'});act(s,'confirm');}
 assert.equal(s.state().remaining,0);assert.equal(s.state().items.filter(i=>i.sorted_at&&i.taped_at).length,25);
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM rainbow_albums').get().n,26);
 assert.equal(fs.readdirSync(path.join(f.dir,'backups')).length,1);
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('natural ranges, remove scan, stale writes and assignment conflicts',()=>{const f=fixture(),s=f.store;try{
 assert(shelf('10A').rank>shelf('9Z').rank);assert.equal(shelf('33A'),null);
 assert.throws(()=>act(s,'target',{column:33}),/Choose a column/);
 act(s,'source',{label:'17A'});const sourceId=s.state().sources[0].id;act(s,'scan',{sourceId,barcode:'CD25'});act(s,'remove',{sourceId});assert.equal(s.state().items.length,0);
 assert.throws(()=>act(s,'save',{sourceId}),/at least/);
 act(s,'scan',{sourceId,barcode:'X'});act(s,'save',{sourceId});act(s,'batch',{kind:'source',sourceId});act(s,'confirm');const itemId=s.state().items[0].id;
 assert.throws(()=>act(s,'assign',{itemId,albumId:1}),/already has/);assert.equal(s.state().items[0].album_rowid,null);
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('deferred unknown CDs preserve physical order and catalog changes cannot mark a wrong shelf sorted',()=>{
 const f=fixture(),s=f.store;try{
 act(s,'source',{label:'23F'});const sourceId=s.state().sources[0].id;
 for(const barcode of ['CD1','FIRST','SECOND'])act(s,'scan',{sourceId,barcode});
 act(s,'save',{sourceId});act(s,'batch',{kind:'source',sourceId});act(s,'confirm');
 const before=s.state().items.filter(i=>i.stage==='unassigned');assert.deepEqual(before.map(i=>i.barcode),['FIRST','SECOND']);
 act(s,'defer',{itemId:before[0].id});assert.deepEqual(s.state().items.filter(i=>i.stage==='unassigned').map(i=>i.barcode),['SECOND','FIRST']);
 act(s,'batch',{kind:'column',column:32});s.db.prepare("UPDATE rainbow_albums SET final_shelf='31A' WHERE id=1").run();
 assert.throws(()=>act(s,'confirm'),/final shelf changed/);assert(s.state().batch);assert.equal(s.state().items.filter(i=>i.stage==='sorted').length,0);
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('column target is exact, persists, and preserves legacy batches and sorted work',()=>{
 const f=fixture();let s=f.store;try{
 s.db.prepare("UPDATE catchall_meta SET range_start='9B',range_end='32P'").run();
 assert.equal(s.state().targetColumn,32);assert.equal(s.state().remaining,25);
 act(s,'target',{column:9});assert.equal(s.state().remaining,1);assert.equal(s.state().recommendations[0].label,'17A');
 act(s,'source',{label:'17A'});const sourceId=s.state().sources[0].id;
 act(s,'scan',{sourceId,barcode:'CD25'});act(s,'save',{sourceId});act(s,'batch',{kind:'source',sourceId});
 const before=s.state();s.db.close();s=openStore(f.file);
 assert.equal(s.state().targetColumn,9);assert.deepEqual(s.state().batch,before.batch);
 assert.throws(()=>act(s,'target',{column:32}),/Finish/);
 act(s,'confirm');act(s,'batch',{kind:'column',column:9});act(s,'confirm');
 act(s,'batch',{kind:'tape',shelf:'9A'});act(s,'confirm');
 act(s,'target',{column:32});assert.equal(s.state().remaining,25);assert.equal(s.state().items.filter(i=>i.stage==='sorted').length,1);
 for(const column of [0,33,1.5,'9'])assert.throws(()=>act(s,'target',{column}),/Choose a column/);
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('opening a source without finishing scans does not hide unfinished recommendations',()=>{
 const f=fixture(),s=f.store;try{
 act(s,'target',{column:32});act(s,'source',{label:'23G'});
 assert.equal(s.state().recommendations[0].label,'23G');
 act(s,'scan',{sourceId:s.state().sources[0].id,barcode:'CD13'});
 assert.equal(s.state().recommendations.find(r=>r.label==='23G').count,12);
 act(s,'save',{sourceId:s.state().sources[0].id});assert(!s.state().recommendations.some(r=>r.label==='23G'));
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('reset requires explicit confirmation, saves recoverable progress, and preserves catalog assignments',()=>{
 const f=fixture(),s=f.store;try{
 act(s,'target',{column:32});act(s,'source',{label:'23F'});const sourceId=s.state().sources[0].id;
 act(s,'scan',{sourceId,barcode:'NEW'});act(s,'save',{sourceId});act(s,'batch',{kind:'source',sourceId});act(s,'confirm');
 act(s,'assign',{itemId:s.state().items[0].id,albumId:26});act(s,'route',{itemId:s.state().items[0].id});act(s,'batch',{kind:'column',column:32});
 const original=s.state();const catalog=s.db.prepare('SELECT * FROM rainbow_albums').all();
 assert.throws(()=>act(s,'reset',{confirmation:'no'}),/Type RESET/);assert.deepEqual(s.state(),original);
 const result=act(s,'reset',{confirmation:'RESET'});
 assert.equal(result.items.length,0);assert.equal(result.sources.length,0);assert.equal(result.batch,null);assert.equal(result.targetColumn,32);assert.equal(result.remaining,25);
 assert.deepEqual(s.db.prepare('SELECT * FROM rainbow_albums').all(),catalog);
 const backup=new Database(path.join(f.dir,'backups',result.resetBackup),{readonly:true});
 assert.equal(backup.prepare('SELECT count(*) n FROM catchall_items').get().n,1);assert(backup.prepare('SELECT batch FROM catchall_meta').get().batch);backup.close();
 assert.throws(()=>s.action({type:'reset',revision:original.revision,confirmation:'RESET'}),/State changed/);
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('other columns clear first; shelf piles accumulate and tape sections survive restart',()=>{
 const f=fixture();let s=f.store;try{
 act(s,'target',{column:32});
 s.db.exec("UPDATE rainbow_albums SET secondary_genre=CASE WHEN id=1 THEN 'Jazz' WHEN id=2 THEN 'Pop' ELSE NULL END");
 const addSource=(label,codes)=>{act(s,'source',{label});const sourceId=s.state().sources[0].id;for(const barcode of codes)act(s,'scan',{sourceId,barcode});act(s,'save',{sourceId});act(s,'batch',{kind:'source',sourceId});act(s,'confirm');};
 addSource('A',['CD1','CD2','CD25']);
 assert.throws(()=>act(s,'batch',{kind:'column',column:32}),/other columns/);
 act(s,'batch',{kind:'column',column:9});assert.equal(s.state().batch.mode,'final-shelves');act(s,'confirm');
 assert.equal(s.state().items.find(i=>i.barcode==='CD25').stage,'sorted');assert.equal(s.state().items.find(i=>i.barcode==='CD25').taped_at,null);
 act(s,'batch',{kind:'column',column:32});assert.equal(s.state().batch.mode,'shelf-piles');act(s,'confirm');
 addSource('B',['CD3','CD4']);act(s,'batch',{kind:'column',column:32});act(s,'confirm');
 assert.deepEqual(s.state().items.filter(i=>i.stage==='shelf').map(i=>i.barcode),['CD4','CD3','CD2','CD1']);
 assert.throws(()=>act(s,'target',{column:31}),/Finish the current/);
 act(s,'batch',{kind:'tape',shelf:'32P'});assert.deepEqual(s.state().batch.rows.map(i=>i.barcode),['CD4','CD3']);
 const batch=s.state().batch;s.db.close();s=openStore(f.file);assert.deepEqual(s.state().batch,batch);
 act(s,'confirm');act(s,'batch',{kind:'tape',shelf:'32P'});assert.equal(s.state().batch.rows[0].album.secondary_genre,'Pop');assert.equal(s.state().batch.rows.length,1);act(s,'confirm');
 act(s,'batch',{kind:'tape',shelf:'32P'});assert.equal(s.state().batch.rows[0].album.secondary_genre,'Jazz');act(s,'confirm');
 assert.equal(s.state().items.filter(i=>i.taped_at).length,4);
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('version-one migration preserves scans, sorted records and the displayed legacy batch',()=>{
 const f=fixture();let s=f.store;try{
 act(s,'source',{label:'23F'});act(s,'scan',{sourceId:1,barcode:'CD1'});act(s,'save',{sourceId:1});act(s,'batch',{kind:'source',sourceId:1});
 const batch=s.state().batch;
 s.db.exec("ALTER TABLE catchall_items DROP COLUMN shelf_label; ALTER TABLE catchall_items DROP COLUMN taped_at; UPDATE catchall_meta SET version=1");
 s.db.close();s=openStore(f.file);
 assert.equal(s.db.prepare('SELECT version FROM catchall_meta').get().version,2);assert.deepEqual(s.state().batch,batch);assert.equal(s.state().items.length,1);
 assert(fs.readdirSync(path.join(f.dir,'backups')).some(n=>n.startsWith('before-shelf-piles-')));
 act(s,'confirm');assert.equal(s.state().items[0].stage,'column');
 }finally{s.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
