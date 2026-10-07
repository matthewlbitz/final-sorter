const Database=require('better-sqlite3');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function clearSetAside(filename){
 const db=new Database(filename,{fileMustExist:true});
 try{
 db.pragma('busy_timeout = 5000');db.pragma('foreign_keys = ON');
 if(db.prepare('SELECT batch FROM catchall_meta').get()?.batch)throw Error('Finish the displayed batch before clearing the old Set aside pile.');
 const dir=path.join(path.dirname(filename),'backups');fs.mkdirSync(dir,{recursive:true});
 const backup=path.join(dir,'before-clear-set-aside-'+crypto.randomUUID()+'.db');
 db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
 const cleared=db.transaction(()=>{
 if(db.prepare('SELECT batch FROM catchall_meta').get()?.batch)throw Error('Finish the displayed batch before clearing the old Set aside pile.');
 const items=db.prepare("SELECT id FROM catchall_items WHERE stage='unassigned'").all();
 for(const item of items){
 db.prepare('DELETE FROM catchall_assignments WHERE item_id=?').run(item.id);
 db.prepare('DELETE FROM catchall_items WHERE id=?').run(item.id);
 }
 if(items.length)db.exec('UPDATE catchall_meta SET revision=revision+1');
 return items.length;
 }).immediate();
 return {backup,cleared};
 }finally{db.close();}
}
if(require.main===module){
 if(!process.argv.includes('--confirm-clear-set-aside')){console.error('Close Final Sorter and Shelf Lookup first. Run with --confirm-clear-set-aside to remove only the old Set aside pile from the sorter.');process.exitCode=1;}
 else{try{console.log(clearSetAside(process.env.KTRU_DB||path.join(__dirname,'..','data','masterAlbums.db')));}catch(e){console.error(e.message);process.exitCode=1;}}
}
module.exports={clearSetAside};
