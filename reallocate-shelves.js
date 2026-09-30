// One-time guarded migration. Run from this directory after stopping the sorter.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const D=require('better-sqlite3');const {allocate}=require('./shelf-allocation');const config=require('./shelf-capacities.json');
const db=new D(path.join(__dirname,'masterAlbums.db'));db.pragma('busy_timeout=5000');
const before=db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums').all();
const report=allocate(before,Object.keys(config.capacities),config.capacities);
assert.equal(report.excluded.length,0);assert.equal(report.unplaced.length,0);
const changes=report.shelves.flatMap(s=>s.albums.filter(a=>a.final_shelf!==s.label).map(a=>({rowid:a.catalog_rowid,id:a.id,from:a.final_shelf,to:s.label})));
assert(changes.every(c=>parseInt(c.from)>26||(parseInt(c.from)===26&&c.from.slice(2)>='O')),'Would change earlier shelves');
for(const s of report.shelves){assert(s.count<=s.usable_capacity);assert(!config.excluded.includes(s.label));}
if(!process.argv.includes('--apply')){console.log({changes:changes.length,summary:report.summary});db.close();process.exit();}
const backup=path.join(__dirname,'backups','before-exclude-26P-27P-'+Date.now()+'.db');fs.mkdirSync(path.dirname(backup),{recursive:true});db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
db.transaction(()=>{
 assert.equal(db.prepare('SELECT batch FROM catchall_meta').get().batch,null,'Finish the current batch first');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM catchall_items WHERE stage<>'sorted'").get().n,0,'Finish physical stacks first');
 assert.deepEqual(db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums').all(),before,'Catalog changed during planning');
 for(const c of changes)db.prepare('UPDATE rainbow_albums SET sorted_shelf=CASE WHEN sorted=1 AND sorted_shelf IS NULL THEN final_shelf ELSE sorted_shelf END,final_shelf=? WHERE rowid=?').run(c.to,c.rowid);
 db.exec(`CREATE TRIGGER IF NOT EXISTS reject_unusable_final_shelf_insert BEFORE INSERT ON rainbow_albums WHEN UPPER(TRIM(NEW.final_shelf)) IN ('26P','27P') BEGIN SELECT RAISE(ABORT,'26P and 27P are too small for CDs'); END;
 CREATE TRIGGER IF NOT EXISTS reject_unusable_final_shelf_update BEFORE UPDATE OF final_shelf ON rainbow_albums WHEN UPPER(TRIM(NEW.final_shelf)) IN ('26P','27P') BEGIN SELECT RAISE(ABORT,'26P and 27P are too small for CDs'); END;`);
 db.prepare('UPDATE catchall_meta SET revision=revision+1,target_shelf=CASE WHEN target_shelf IN (\'26P\',\'27P\') THEN \'26O\' ELSE target_shelf END').run();
 const after=db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums').all();
 for(let i=0;i<before.length;i++){const {final_shelf:a,sorted_shelf:sa,...x}=before[i],{final_shelf:b,sorted_shelf:sb,...y}=after[i];assert.deepEqual(x,y);if(sa!==sb)assert(before[i].sorted===1&&sa===null&&sb===a);}
 assert.equal(db.prepare("SELECT COUNT(*) n FROM rainbow_albums WHERE final_shelf IN ('26P','27P')").get().n,0);
 assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
}) .immediate();
fs.writeFileSync(path.join(__dirname,'shelf-reallocation-audit.json'),JSON.stringify({date:new Date().toISOString(),backup,excluded:config.excluded,summary:report.summary,changes},null,2));
console.log({backup,changed:changes.length,integrity:db.pragma('integrity_check',{simple:true})});db.close();
