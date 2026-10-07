const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const {openStore}=require('../workflow');
const {resetSorted}=require('../reset-sorted');
test('placement reset backs up data, keeps saved work, and cannot restore false sorted flags on undo/restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ktru-reset-')),file=path.join(dir,'catalog.db');let store;
 try{
 const db=new Database(file);db.exec(`CREATE TABLE rainbow_albums(id INTEGER,barcode TEXT,artist TEXT,title TEXT,final_shelf TEXT,new_shelf_label TEXT,assigned_at TEXT,primary_genre TEXT);
 INSERT INTO rainbow_albums VALUES(1,'DONE','Artist','Done','9A','18B','assigned','Rock'),(2,'SAVED','Artist','Saved','9A','18B','assigned','Rock'),(3,'COLUMN','Artist','Column','9A','18B','assigned','Rock');`);db.close();store=openStore(file);
 const act=(type,args={})=>store.action({type,revision:store.state().revision,...args});
 let id=act('scan-sort').openedSourceId;for(const barcode of ['DONE','COLUMN'])act('scan',{sourceId:id,barcode});act('save',{sourceId:id});act('batch',{kind:'scan-sort',sourceId:id});act('confirm');act('batch',{kind:'scan-column',column:9});act('confirm');
 id=act('scan-sort').openedSourceId;act('scan',{sourceId:id,barcode:'SAVED'});act('save',{sourceId:id});
 const scanning=act('scan-sort').openedSourceId;act('scan',{sourceId:scanning,barcode:'DONE'});
 store.db.exec("UPDATE rainbow_albums SET taped=1 WHERE barcode='COLUMN'");
 act('batch',{kind:'scan-sort',sourceId:id});
 const before=store.state(),catalog=store.db.prepare('SELECT id,barcode,artist,title,final_shelf,new_shelf_label,assigned_at,taped FROM rainbow_albums ORDER BY id').all();store.db.close();store=null;
 const result=resetSorted(file);assert.equal(result.cleared,1);assert(fs.existsSync(result.backup));
 const backup=new Database(result.backup,{readonly:true});assert.equal(backup.prepare("SELECT sorted FROM rainbow_albums WHERE barcode='COLUMN'").get().sorted,1);backup.close();
 store=openStore(file);assert.deepEqual(store.state().batch,before.batch);assert.deepEqual(store.state().sources,before.sources);
 assert.deepEqual(store.db.prepare('SELECT id,barcode,artist,title,final_shelf,new_shelf_label,assigned_at,taped FROM rainbow_albums ORDER BY id').all(),catalog);
 assert.equal(store.db.prepare('SELECT count(*) n FROM rainbow_albums WHERE sorted<>0 OR sorted_shelf IS NOT NULL OR sorted_at IS NOT NULL').get().n,0);
 assert.equal(store.state().items.some(i=>i.stage==='sorted'),false);assert.equal(store.state().items.filter(i=>i.stage==='source').length,2);
 act('confirm');act('remove',{sourceId:scanning});assert.equal(store.db.prepare("SELECT sorted FROM rainbow_albums WHERE barcode='DONE'").get().sorted,0);
 store.db.close();store=openStore(file);assert.equal(store.state().items.find(i=>i.barcode==='SAVED').stage,'column');assert.equal(store.db.prepare("SELECT sorted FROM rainbow_albums WHERE barcode='COLUMN'").get().sorted,0);
 }finally{if(store)store.db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
