const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const {openStore}=require('../workflow');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ktru-independent-')),file=path.join(dir,'catalog.db');
 const db=new Database(file);
 db.exec(`CREATE TABLE rainbow_albums(id INTEGER,barcode TEXT,artist TEXT,title TEXT,final_shelf TEXT,new_shelf_label TEXT,assigned_at TEXT,primary_genre TEXT,secondary_genre TEXT);
 INSERT INTO rainbow_albums VALUES(1,'COLUMN','Artist','Column CD','9A','18B',NULL,'Rock',NULL);`);
 const add=db.prepare("INSERT INTO rainbow_albums(id,barcode,final_shelf) VALUES(?,?,NULL)");
 for(let i=0;i<10;i++)add.run(i+2,'PENDING'+i);
 db.close();let store=openStore(file);
 const act=(type,args={})=>store.action({type,revision:store.state().revision,...args});
 return {get store(){return store;},act,restart(){store.db.close();store=openStore(file);},close(){store.db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
for(const kind of ['scan-column','column'])for(const saved of [false,true])test(`${kind} sorts only its column while ten unrelated scans remain ${saved?'saved':'scanning'}`,()=>{
 const f=fixture();try{
 let id=f.act('scan-sort').openedSourceId;f.act('scan',{sourceId:id,barcode:'COLUMN'});f.act('save',{sourceId:id});f.act('batch',{kind:'scan-sort',sourceId:id});f.act('confirm');
 id=f.act('scan-sort').openedSourceId;for(let i=0;i<10;i++)f.act('scan',{sourceId:id,barcode:'PENDING'+i});if(saved)f.act('save',{sourceId:id});
 const pending=()=>({source:f.store.db.prepare('SELECT * FROM catchall_sources WHERE id=?').get(id),items:f.store.db.prepare('SELECT * FROM catchall_items WHERE source_id=? ORDER BY id').all(id),albums:f.store.db.prepare("SELECT * FROM rainbow_albums WHERE barcode LIKE 'PENDING%' ORDER BY id").all()});
 const before=pending();f.restart();assert.deepEqual(pending(),before);
 const b=f.act('batch',{kind,column:9}).batch;assert.deepEqual(b.rows.map(i=>i.barcode),['COLUMN']);f.restart();assert.deepEqual(f.store.state().batch,b);f.act('confirm');f.restart();assert.deepEqual(pending(),before);
 assert.equal(f.store.db.prepare("SELECT sorted FROM rainbow_albums WHERE barcode='COLUMN'").get().sorted,kind==='column'?0:1);
 assert.equal(f.store.db.prepare("SELECT stage FROM catchall_items WHERE barcode='COLUMN'").get().stage,kind==='column'?'shelf':'sorted');
 if(saved){const batch=f.act('batch',{kind:'scan-sort',sourceId:id}).batch;assert(batch.rows.every(i=>i.placement==='set-aside'));assert.deepEqual(pending(),before);f.restart();assert.deepEqual(f.store.state().batch,batch);f.act('confirm');assert(f.store.state().items.filter(i=>i.barcode.startsWith('PENDING')).every(i=>i.stage==='unassigned'));}
 const columnItem=f.store.db.prepare("SELECT * FROM catchall_items WHERE barcode='COLUMN'").get();
 f.store.db.prepare("UPDATE catchall_items SET stage='column' WHERE id=?").run(columnItem.id);
 const after=pending();
 for(const destination of ['8A']){
 f.store.db.prepare("UPDATE rainbow_albums SET final_shelf=? WHERE barcode='COLUMN'").run(destination);
 const revision=f.store.state().revision;
 assert.throws(()=>f.act('batch',{kind,column:9}),/COLUMN.*column 9/);assert.equal(f.store.state().revision,revision);assert.equal(f.store.state().batch,null);assert.deepEqual(pending(),after);
 }
 }finally{f.close();}
});

for(const kind of ['scan-column','column'])test(`${kind} sets aside an invalid destination without marking it sorted`,()=>{const f=fixture();try{
 const id=f.act('scan-sort').openedSourceId;f.act('scan',{sourceId:id,barcode:'COLUMN'});f.act('save',{sourceId:id});f.act('batch',{kind:'scan-sort',sourceId:id});f.act('confirm');
 f.store.db.exec("UPDATE rainbow_albums SET final_shelf='bad' WHERE barcode='COLUMN'");
 const b=f.act('batch',{kind,column:9}).batch;assert.equal(b.rows[0].placement,'set-aside');f.restart();f.act('confirm');f.restart();
 assert.equal(f.store.state().items[0].stage,'unassigned');assert.equal(f.store.db.prepare("SELECT sorted FROM rainbow_albums WHERE barcode='COLUMN'").get().sorted,0);
 }finally{f.close();}});
