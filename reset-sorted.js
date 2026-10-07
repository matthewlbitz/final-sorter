const Database=require('better-sqlite3');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function resetSorted(filename){
 const db=new Database(filename,{fileMustExist:true});
 try{
 db.pragma('busy_timeout = 5000');db.pragma('foreign_keys = ON');
 const exists=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 const dir=path.join(path.dirname(filename),'backups');fs.mkdirSync(dir,{recursive:true});
 const backup=path.join(dir,'before-clear-sorted-'+crypto.randomUUID()+'.db');
 let cleared;
 // Close station apps before running; preserve a complete SQLite backup.
 db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
 db.transaction(()=>{
 cleared=db.prepare('SELECT count(*) n FROM rainbow_albums WHERE sorted=1 OR sorted_shelf IS NOT NULL OR sorted_at IS NOT NULL').get().n;
 db.exec('UPDATE rainbow_albums SET sorted=0,sorted_shelf=NULL,sorted_at=NULL');
 if(exists('catchall_items')){
 const completed=db.prepare("SELECT id FROM catchall_items WHERE stage='sorted'").all();
 if(exists('catchall_assignments'))for(const i of completed)db.prepare('DELETE FROM catchall_assignments WHERE item_id=?').run(i.id);
 db.exec("DELETE FROM catchall_items WHERE stage='sorted'; UPDATE catchall_items SET sorted_at=NULL");
 for(const i of db.prepare('SELECT id,scan_previous FROM catchall_items WHERE scan_previous IS NOT NULL').all()){
 const prior=JSON.parse(i.scan_previous);
 if(prior.album)Object.assign(prior.album,{sorted:0,sorted_shelf:null,sorted_at:null});
 if(prior.item?.stage==='sorted')prior.item=null;
 db.prepare('UPDATE catchall_items SET scan_previous=? WHERE id=?').run(JSON.stringify(prior),i.id);
 }
 }
 if(exists('catchall_catalog_baseline'))db.exec('UPDATE catchall_catalog_baseline SET sorted=0,sorted_shelf=NULL,sorted_at=NULL');
 if(exists('catchall_passes'))db.exec('DELETE FROM catchall_passes');
 if(exists('catchall_meta')){
 const m=db.prepare('SELECT batch FROM catchall_meta').get();
 // A shelf-verification batch refers to a placement that is being cleared.
 if(m?.batch&&JSON.parse(m.batch).kind==='tape-existing')db.exec('UPDATE catchall_meta SET batch=NULL');
 db.exec('UPDATE catchall_meta SET revision=revision+1');
 }
 }).immediate();
 return {backup,cleared};
 }finally{db.close();}
}
if(require.main===module){
 if(!process.argv.includes('--confirm-clear-sorted')){console.error('Close Final Sorter and Shelf Lookup first. Run with --confirm-clear-sorted to clear placement records while preserving saved stacks and catalog assignments.');process.exitCode=1;}
 else {const file=process.env.KTRU_DB||path.join(__dirname,'..','data','masterAlbums.db');try{console.log(resetSorted(file));}catch(e){console.error(e.message);process.exitCode=1;}}
}
module.exports={resetSorted};
