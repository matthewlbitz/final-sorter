const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const {tape,tapeKey} = require('./public/sorting-guide');
const shelf = value => {
  const m = String(value || '').trim().toUpperCase().match(/^(\d{1,2})([A-Z])$/);
  return m && +m[1] >= 1 && +m[1] <= 32 ? {label: `${+m[1]}${m[2]}`, column: +m[1], rank: +m[1]*26 + m[2].charCodeAt(0)-65} : null;
};

function estimatedLocation(album) {
  if (!String(album.barcode || '').trim()) return null;

  const old = shelf(album.new_shelf_label);

  if (!old) {
    return {
      key: 'unknown',
      label: 'Unknown location',
      type: 'unknown'
    };
  }

  if (['26P','27P'].includes(old.label)) return null;
  const c = old.column;
  if ((c >= 9 && c <= 18) || c === 20 || (c >= 24 && c <= 28))
    return {key:`shelf-${old.label}`,label:`Shelf ${old.label}`,type:'shelf'};
  return null; // Broad/jumbled areas are manual intake, never shelf predictions.

}

function openStore(filename) {
  if (!fs.existsSync(filename)) throw new Error('Catalog database not found: '+filename);
  const db = new Database(filename);
  db.pragma('busy_timeout = 5000');
  const columns = db.prepare('PRAGMA table_info(rainbow_albums)').all().map(c=>c.name);
  for (const name of ['id','barcode','artist','title','final_shelf','new_shelf_label','assigned_at'])
    if (!columns.includes(name)) throw new Error('Missing catalog column: '+name);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='catchall_meta'").get()) {
    const backup = path.join(path.dirname(filename), 'backups'); fs.mkdirSync(backup,{recursive:true});
    db.exec(`VACUUM INTO '${path.join(backup, 'before-catchall-'+Date.now()+'.db').replaceAll("'","''")}'`);
    db.transaction(()=>db.exec(`
      CREATE TABLE catchall_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL, range_start TEXT, range_end TEXT, batch TEXT);
      INSERT INTO catchall_meta VALUES(1,2,0,0,NULL,NULL,NULL);
      CREATE TABLE catchall_sources (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('scanning','saved','complete')));
      CREATE TABLE catchall_items (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES catchall_sources(id), barcode TEXT NOT NULL UNIQUE, album_rowid INTEGER UNIQUE, stage TEXT NOT NULL CHECK(stage IN ('source','column','unassigned','shelf','sorted')), column_no INTEGER, position INTEGER NOT NULL, sorted_at TEXT, shelf_label TEXT, taped_at TEXT);
      CREATE INDEX catchall_items_stage ON catchall_items(stage,column_no,position);
      CREATE TABLE catchall_assignments (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, album_rowid INTEGER NOT NULL, barcode TEXT NOT NULL, assigned_at TEXT NOT NULL);
    `))();
  }
  if(db.prepare('SELECT version FROM catchall_meta').get().version===1) {
    const dir=path.join(path.dirname(filename),'backups');fs.mkdirSync(dir,{recursive:true});
    const backup=path.join(dir,'before-shelf-piles-'+require('crypto').randomUUID()+'.db');
    db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
    db.transaction(()=>{
      db.exec(`CREATE TABLE catchall_items_v2 (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES catchall_sources(id), barcode TEXT NOT NULL UNIQUE, album_rowid INTEGER UNIQUE, stage TEXT NOT NULL CHECK(stage IN ('source','column','unassigned','shelf','sorted')), column_no INTEGER, position INTEGER NOT NULL, sorted_at TEXT, shelf_label TEXT, taped_at TEXT);
        INSERT INTO catchall_items_v2(id,source_id,barcode,album_rowid,stage,column_no,position,sorted_at) SELECT id,source_id,barcode,album_rowid,stage,column_no,position,sorted_at FROM catchall_items;
        DROP TABLE catchall_items;
        ALTER TABLE catchall_items_v2 RENAME TO catchall_items;
        CREATE INDEX catchall_items_stage ON catchall_items(stage,column_no,position);
        UPDATE catchall_meta SET version=2,revision=revision+1;`);
    })();
  }
  if(db.prepare('SELECT version FROM catchall_meta').get().version===2) {
    const dir=path.join(path.dirname(filename),'backups');fs.mkdirSync(dir,{recursive:true});
    const backup=path.join(dir,'before-target-shelf-'+require('crypto').randomUUID()+'.db');
    db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
    db.transaction(()=>{
      const existing=new Set(db.prepare('PRAGMA table_info(rainbow_albums)').all().map(c=>c.name));
      for(const [name,definition] of Object.entries({sorted:'INTEGER NOT NULL DEFAULT 0',taped:'INTEGER NOT NULL DEFAULT 0',scanned_at:'TEXT',sorted_at:'TEXT',taped_at:'TEXT',sorted_shelf:'TEXT'})) {
        if(!existing.has(name))db.exec(`ALTER TABLE rainbow_albums ADD COLUMN ${name} ${definition}`);
      }
      db.exec(`ALTER TABLE catchall_meta ADD COLUMN target_shelf TEXT;
        ALTER TABLE catchall_items ADD COLUMN scanned_at TEXT;
        ALTER TABLE catchall_items ADD COLUMN scan_previous TEXT;
        CREATE TABLE catchall_catalog_baseline(album_rowid INTEGER PRIMARY KEY,sorted INTEGER,taped INTEGER,scanned_at TEXT,sorted_at TEXT,taped_at TEXT,sorted_shelf TEXT);`);
      // Existing explicit sorted flags remain valid, but future destination changes invalidate their location.
      db.exec("UPDATE rainbow_albums SET sorted_shelf=final_shelf WHERE sorted=1 AND sorted_shelf IS NULL");
      for(const item of db.prepare('SELECT * FROM catchall_items WHERE album_rowid IS NOT NULL').all()) {
        db.prepare(`INSERT OR IGNORE INTO catchall_catalog_baseline SELECT rowid,sorted,taped,scanned_at,sorted_at,taped_at,sorted_shelf FROM rainbow_albums WHERE rowid=?`).run(item.album_rowid);
        if(item.stage==='sorted')db.prepare('UPDATE rainbow_albums SET sorted=1,sorted_shelf=final_shelf,sorted_at=COALESCE(?,sorted_at),taped=CASE WHEN ? IS NOT NULL THEN 1 ELSE taped END,taped_at=COALESCE(?,taped_at) WHERE rowid=?').run(item.sorted_at,item.taped_at,item.taped_at,item.album_rowid);
        else db.prepare('UPDATE rainbow_albums SET sorted=0,sorted_shelf=NULL,sorted_at=NULL WHERE rowid=?').run(item.album_rowid);
      }
      db.exec('UPDATE catchall_meta SET version=3,revision=revision+1');
    })();
  }
  if(db.prepare('SELECT version FROM catchall_meta').get().version!==3) throw new Error('Unsupported workflow version');
  const handoff=require('./station-report');
  handoff.migrate(db,filename);
  db.pragma('foreign_keys = ON');
  const meta=()=>db.prepare('SELECT * FROM catchall_meta').get();
  const album=id=>db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums WHERE rowid=?').get(id);
  const enrich=i=>({...i,album:i.album_rowid ? album(i.album_rowid):null});
  const allItems=()=>db.prepare('SELECT * FROM catchall_items ORDER BY position DESC').all().map(enrich);
  const fail=msg=>{throw new Error(msg);};
  const seq=()=>{db.prepare('UPDATE catchall_meta SET sequence=sequence+1').run();return meta().sequence;};
  const captureBaseline=id=>db.prepare(`INSERT OR IGNORE INTO catchall_catalog_baseline SELECT rowid,sorted,taped,scanned_at,sorted_at,taped_at,sorted_shelf FROM rainbow_albums WHERE rowid=?`).run(id);
  const markScanned=(id,now)=>{
    if(!id)return;
    captureBaseline(id);
    db.prepare('UPDATE rainbow_albums SET scanned_at=?,sorted=0,sorted_shelf=NULL,sorted_at=NULL WHERE rowid=?').run(now,id);
  };
  const placed=a=>Number(a.sorted)===1&&(!a.sorted_shelf||shelf(a.sorted_shelf)?.label===shelf(a.final_shelf)?.label);
  function state() {
    const m=meta(), items=allItems(), sources=db.prepare('SELECT * FROM catchall_sources ORDER BY id DESC').all();
    const albums=db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums').all();
    const shelves=[...new Set(albums.map(a=>shelf(a.final_shelf)?.label).filter(Boolean))].sort((a,b)=>shelf(b).rank-shelf(a).rank);
    const oldColumn=shelf(m.range_end)?.column;
    const targetShelf=shelf(m.target_shelf)?.label||shelves.find(v=>shelf(v).column===oldColumn)||shelves[0]||'32A';
    const targetColumn=shelf(targetShelf).column;
    const activeByAlbum=new Map(items.filter(i=>i.album_rowid&&i.stage!=='sorted').map(i=>[i.album_rowid,i]));
    // External barcode assignments are immediately recognized for location prediction, even before Refresh assignments.
    const activeByBarcode=new Map(items.filter(i=>i.stage!=='sorted').map(i=>[i.barcode,i]));
    const groups=new Map(), progress=new Map(), alreadyShelved=[];
    let remaining=0,unavailable=0,excludedUnassigned=0,complete=0,total=0;
    for(const a of albums) {
      if(shelf(a.final_shelf)?.label!==targetShelf)continue;
      total++;
      if(!String(a.barcode||'').trim()){excludedUnassigned++;continue;}
      const item=activeByAlbum.get(a.catalog_rowid)||activeByBarcode.get(String(a.barcode).trim());
      if(item){
        remaining++;
        const source=sources.find(s=>s.id===item.source_id);
        const key=item.stage==='source'?`source-${item.source_id}`:item.stage==='column'?`column-${item.column_no}`:item.stage==='shelf'?`pile-${item.shelf_label}`:'unassigned';
        const label=item.stage==='source'?`Source stack ${source?.label}`:item.stage==='column'?`Column ${item.column_no} pile`:item.stage==='shelf'?`Shelf ${item.shelf_label} pile`:'Unassigned stack';
        const g=progress.get(key)||{key,label,stage:item.stage,sourceId:item.source_id,column:item.column_no,shelf:item.shelf_label,count:0};g.count++;progress.set(key,g);continue;
      }
      if(placed(a)&&handoff.primaryDone(db,a)){complete++;continue;}
      remaining++;
      if(placed(a)){alreadyShelved.push(a);continue;}
      // If a formerly placed album's destination was edited, retain its last confirmed physical shelf.
      const prior=shelf(a.sorted_shelf);
      const location=prior?{key:`shelf-${prior.label}`,label:`Shelf ${prior.label}`,type:'shelf'}:estimatedLocation(a);
      if(!location||location.type==='unknown'){unavailable++;continue;}
      const g=groups.get(location.key)||{...location,count:0};g.count++;groups.set(location.key,g);
    }
    const rank=location=>location.type==='shelf'?1:location.type==='column'?2:3;
    const recommendations=[...groups.values()].sort((a,b)=>rank(a)-rank(b)||b.count-a.count||a.label.localeCompare(b.label,undefined,{numeric:true}));
    const ready=alreadyShelved.length?[{key:`final-${targetShelf}`,label:`Shelf ${targetShelf}`,type:'already-shelved',count:alreadyShelved.length}]:[];
    return {revision:m.revision,targetShelf,targetColumn,shelves,start:targetShelf,end:targetShelf,total,remaining,complete,unavailable,excludedUnassigned,
      handoff:(()=>{const data=handoff.snapshot(db);return {passes:data.passes,queue:data.queue,targets:require('./target-priority').rankTargets(data,targetShelf)};})(),sources:sources.map(s=>({...s,count:items.filter(i=>i.source_id===s.id&&i.stage==='source').length})),items,recommendations,
      predictedLocations:[...recommendations,...ready],inProgress:[...progress.values()],alreadyShelved,batch:m.batch?JSON.parse(m.batch):null};
  }
  function action(body) {
    let resetBackup;
    if(body.type==='reset') {
      if(body.confirmation!=='RESET')fail('Type RESET to clear sorting progress.');
      if(body.revision!==meta().revision)fail('State changed. Refresh before resetting.');
      const dir=path.join(path.dirname(filename),'backups');fs.mkdirSync(dir,{recursive:true});
      resetBackup=path.join(dir,'before-reset-'+require('crypto').randomUUID()+'.db');
      // A consistent full backup must succeed before anything is cleared.
      db.exec(`VACUUM INTO '${resetBackup.replaceAll("'","''")}'`);
    }
    let openedSourceId;
    return db.transaction(()=>{
      const m=meta();
      if(body.revision!==m.revision)fail('State changed. Refresh and check the current stack.');
      const b=m.batch?JSON.parse(m.batch):null;
      if(b&&body.type!=='confirm'&&body.type!=='reset'&&body.type!=='coworker-finish')fail('Finish the displayed 10 CDs before changing stacks.');
      const source=()=>db.prepare('SELECT * FROM catchall_sources WHERE id=?').get(body.sourceId)||fail('Source not found');
      if(body.type==='reset'){
        for(const a of db.prepare('SELECT * FROM catchall_catalog_baseline').all())db.prepare('UPDATE rainbow_albums SET sorted=?,taped=?,scanned_at=?,sorted_at=?,taped_at=?,sorted_shelf=? WHERE rowid=?').run(a.sorted,a.taped,a.scanned_at,a.sorted_at,a.taped_at,a.sorted_shelf,a.album_rowid);
        db.exec('DELETE FROM catchall_passes; DELETE FROM catchall_finishing; DELETE FROM catchall_catalog_baseline; DELETE FROM catchall_assignments; DELETE FROM catchall_items; DELETE FROM catchall_sources;');
        db.prepare('UPDATE catchall_meta SET sequence=0,batch=NULL').run();
      } else if(body.type==='initial-pass'){
        const current=state();
        if(current.recommendations.length||current.inProgress.length||current.alreadyShelved.length)fail('Finish the predicted pulls and primary taping for this target first.');
        db.prepare('INSERT INTO catchall_passes(shelf,completed_at) VALUES(?,?) ON CONFLICT(shelf) DO NOTHING').run(current.targetShelf,new Date().toISOString());
      } else if(body.type==='undo-pass'){
        db.prepare('DELETE FROM catchall_passes WHERE shelf=?').run(shelf(body.shelf)?.label||'');
      } else if(body.type==='coworker-finish'){
        const matches=db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums WHERE TRIM(barcode)=?').all(String(body.barcode||'').trim());
        if(matches.length!==1)fail('Scan a uniquely assigned barcode.');
        const a=matches[0];
        const pending=handoff.snapshot(db).queue.find(i=>i.catalog_rowid===a.catalog_rowid);
        if(!pending)fail('This CD is not on a visited shelf ready for coworker finishing. Refresh the handoff.');
        if(typeof body.hasReview!=='boolean'||body.primaryConfirmed!==true||body.secondaryConfirmed!==true)fail('Confirm primary tape, review check, and secondary tape before finishing.');
        if(!tape(a.primary_genre)?.hex||(tape(a.secondary_genre)&&!tape(a.secondary_genre).hex))fail('Correct the tape genres before finishing.');
        captureBaseline(a.catalog_rowid);
        const now=new Date().toISOString();
        db.prepare(`INSERT INTO catchall_finishing(album_rowid,primary_at,primary_genre,secondary_at,secondary_genre,review_at,has_review) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(album_rowid) DO UPDATE SET primary_at=COALESCE(primary_at,excluded.primary_at),primary_genre=excluded.primary_genre,secondary_at=excluded.secondary_at,secondary_genre=excluded.secondary_genre,review_at=excluded.review_at,has_review=excluded.has_review`).run(a.catalog_rowid,now,a.primary_genre||'',now,a.secondary_genre||'',now,Number(body.hasReview));
        db.prepare('UPDATE rainbow_albums SET taped=1,taped_at=? WHERE rowid=?').run(now,a.catalog_rowid);
      } else if(body.type==='target'){
        const target=shelf(body.shelf);
        if(!target||!state().shelves.includes(target.label))fail('Choose a populated final shelf.');
        if(db.prepare("SELECT 1 FROM catchall_items WHERE stage IN ('source','column','shelf','unassigned')").get())fail('Finish the current stacks and shelf piles before changing the target shelf.');
        db.prepare('UPDATE catchall_meta SET target_shelf=?,range_start=?,range_end=?').run(target.label,target.label,target.label);
      } else if(body.type==='range'){
        fail('Choose a target shelf instead. Refresh this page.');
      } else if(body.type==='source') {
        const label=String(body.label||'').trim().toUpperCase();if(!shelf(label))fail('Enter an actual source shelf, such as 19A.');
        const existing=db.prepare('SELECT * FROM catchall_sources WHERE label=?').get(label);
        if(existing){
          openedSourceId=existing.id;
          if(existing.status==='complete')db.prepare("UPDATE catchall_sources SET status='scanning' WHERE id=?").run(existing.id);
        }else openedSourceId=Number(db.prepare("INSERT INTO catchall_sources(label,status) VALUES(?,'scanning')").run(label).lastInsertRowid);
      } else if(body.type==='scan') {
        const s=source();if(s.status!=='scanning')fail('This stack is already saved.');
        const code=String(body.barcode||'').trim();if(!code||code.length>128)fail('Scan a barcode.');
        const existing=db.prepare('SELECT * FROM catchall_items WHERE barcode=?').get(code);
        if(existing&&existing.stage!=='sorted')fail('Barcode already in a working stack. Keep this CD aside and check its stack.');
        const matches=db.prepare('SELECT rowid AS rid FROM rainbow_albums WHERE TRIM(barcode)=?').all(code);
        if(matches.length>1)fail('Barcode matches multiple albums. Correct the catalog before scanning.');
        const id=matches[0]?.rid||null,now=new Date().toISOString();
        const prior=id?album(id):null;
        const previous=JSON.stringify({album:prior?{sorted:prior.sorted,taped:prior.taped,scanned_at:prior.scanned_at,sorted_at:prior.sorted_at,taped_at:prior.taped_at,sorted_shelf:prior.sorted_shelf}:null,item:existing||null});
        markScanned(id,now);
        if(existing)db.prepare("UPDATE catchall_items SET source_id=?,album_rowid=?,stage='source',column_no=NULL,shelf_label=NULL,position=?,sorted_at=NULL,scanned_at=?,scan_previous=? WHERE id=?").run(s.id,id,seq(),now,previous,existing.id);
        else db.prepare("INSERT INTO catchall_items(source_id,barcode,album_rowid,stage,position,scanned_at,scan_previous) VALUES(?,?,?,'source',?,?,?)").run(s.id,code,id,seq(),now,previous);
      } else if(body.type==='remove') {
        const s=source();if(s.status!=='scanning')fail('Only unsaved scans can be removed.');
        const last=db.prepare("SELECT * FROM catchall_items WHERE source_id=? AND stage='source' ORDER BY position DESC LIMIT 1").get(s.id);
        if(last) {
          const prior=last.scan_previous?JSON.parse(last.scan_previous):null;
          if(prior?.album) {
            const a=prior.album;
            db.prepare('UPDATE rainbow_albums SET sorted=?,taped=?,scanned_at=?,sorted_at=?,taped_at=?,sorted_shelf=? WHERE rowid=?').run(a.sorted,a.taped,a.scanned_at,a.sorted_at,a.taped_at,a.sorted_shelf,last.album_rowid);
          }
          if(prior?.item){
            const item=prior.item;
            db.prepare('UPDATE catchall_items SET source_id=?,album_rowid=?,stage=?,column_no=?,position=?,sorted_at=?,shelf_label=?,taped_at=?,scanned_at=?,scan_previous=? WHERE id=?').run(item.source_id,item.album_rowid,item.stage,item.column_no,item.position,item.sorted_at,item.shelf_label,item.taped_at,item.scanned_at,item.scan_previous,item.id);
          }else db.prepare('DELETE FROM catchall_items WHERE id=?').run(last.id);
        }
      } else if(body.type==='save') {
        const s=source();if(s.status!=='scanning')fail('Stack already saved.');
        if(!db.prepare('SELECT 1 FROM catchall_items WHERE source_id=?').get(s.id))fail('Scan at least one CD.');
        db.prepare("UPDATE catchall_sources SET status='saved' WHERE id=?").run(s.id);
      } else if(body.type==='tape-existing') {
        const code=String(body.barcode||'').trim();
        const candidates=db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums WHERE TRIM(barcode)=?').all(code);
        if(!code||candidates.length!==1)fail('Scan an assigned barcode from the target shelf.');
        const a=candidates[0],target=state().targetShelf;
        if(shelf(a.final_shelf)?.label!==target||!placed(a)||handoff.primaryDone(db,a))fail('This CD is not an untaped, confirmed CD on the target shelf.');
        const active=db.prepare("SELECT * FROM catchall_items WHERE album_rowid=? AND stage<>'sorted'").get(a.catalog_rowid);
        if(active)fail('This CD is still in a working pile.');
        if(!tape(a.primary_genre)?.hex||(tape(a.secondary_genre)&&!tape(a.secondary_genre).hex))fail('Correct this album’s tape genres before taping.');
        const existing=db.prepare('SELECT id FROM catchall_items WHERE album_rowid=?').get(a.catalog_rowid);
        db.prepare('UPDATE catchall_meta SET batch=?').run(JSON.stringify({kind:'tape-existing',shelf:target,rows:[{id:existing?.id,album_rowid:a.catalog_rowid,barcode:code,album:a,destination:target}]}));
      } else if(body.type==='batch') {
        let items, mode;
        if(body.kind==='source') {
          const s=source();if(s.status!=='saved')fail('Save this source stack first.');
          items=db.prepare("SELECT * FROM catchall_items WHERE source_id=? AND stage='source' ORDER BY position DESC LIMIT 10").all(s.id);
        }else if(body.kind==='unassigned') {

            // Do not physically sort until every CD in the
            // Unassigned stack has been identified.
            if (
              db.prepare(
                "SELECT 1 FROM catchall_items " +
                "WHERE stage='unassigned' AND album_rowid IS NULL"
              ).get()
            ) {
              fail('Assign every barcode in Unassigned first.');
            }

            items = db.prepare(
              "SELECT * FROM catchall_items " +
              "WHERE stage='unassigned' " +
              "ORDER BY position DESC LIMIT 10"
            ).all();

            mode = 'columns';
        } else if(body.kind==='column') {
          if(!Number.isInteger(body.column)||body.column<1||body.column>32)fail('Invalid column.');
          if(db.prepare("SELECT 1 FROM catchall_items WHERE stage='source'").get())fail('Save and sort the source shelves into columns first.');
          const target=state().targetColumn;
          mode=body.column===target?'target-shelf':'final-shelves';
          if(mode==='target-shelf'&&db.prepare("SELECT 1 FROM catchall_items WHERE stage='column' AND column_no<>?").get(target))fail('Clear the other columns before the target column.');
          items=db.prepare("SELECT * FROM catchall_items WHERE stage='column' AND column_no=? ORDER BY position DESC LIMIT 10").all(body.column);
        } else if(body.kind==='tape') {
          const label=shelf(body.shelf)?.label;if(!label)fail('Choose a shelf pile.');
          if(db.prepare("SELECT 1 FROM catchall_items WHERE stage IN ('source','column')").get())fail('Finish sorting the source and column stacks before taping.');
          const pile=db.prepare("SELECT * FROM catchall_items WHERE stage='shelf' AND shelf_label=? ORDER BY position DESC").all(label);
          const first=pile[0]&&album(pile[0].album_rowid);
          const bottom=tape(first?.primary_genre),top=tape(first?.secondary_genre);
          if(pile.length&&(!bottom?.hex||(top&&!top.hex)))fail('The top CD needs its tape genres corrected in the catalog first.');
          // One contiguous tape section, capped at ten for easy counting. Never reorder the pile.
          const key=tapeKey(first);items=[];
          for(const item of pile){if(items.length===10||tapeKey(album(item.album_rowid))!==key)break;items.push(item);}
          mode='tape-section';
        } else fail('Invalid batch type');
        if(!items.length)fail('Stack is empty.');
        const selectedTarget=state().targetShelf;
        const rows=items.map(enrich).map(i=>{
          const dest=shelf(i.album?.final_shelf);
          if(body.kind==='unassigned'&&!dest)fail('An assigned CD needs a valid final shelf before sorting.');
          if(body.kind==='tape'&&dest?.label!==i.shelf_label)fail('A final shelf changed. Correct the catalog before taping this pile.');
          if(body.kind==='column'&&(!dest||dest.column!==i.column_no))fail('A catalog destination changed. Check this column before continuing.');
          return {
            ...i,
            placement:body.kind==='column'&&dest.label===selectedTarget&&!handoff.primaryDone(db,i.album)?'shelf':'sorted',
            destination:
              body.kind === 'source' || body.kind === 'unassigned'
                ? (dest?.column || 'Unassigned')
                : dest.label
          };
        });
        db.prepare('UPDATE catchall_meta SET batch=?').run(JSON.stringify({kind:body.kind,mode,sourceId:body.sourceId,column:body.column,shelf:body.shelf,rows}));
      } else if(body.type==='confirm') {
        if(!b)fail('No batch to confirm.');
        for(const i of b.rows) {
          if(i.album_rowid&&String(album(i.album_rowid)?.barcode||'').trim()!==i.barcode)fail('A barcode assignment changed while this batch was open. Check the catalog before confirming.');
          if((b.kind==='column'||b.kind==='tape'||b.kind==='tape-existing') && shelf(album(i.album_rowid)?.final_shelf)?.label!==i.destination)fail('A final shelf changed while this batch was open. Restore its catalog destination before confirming.');
          if(b.kind === 'source') {
            db.prepare(
              'UPDATE catchall_items SET stage=?,column_no=?,position=? WHERE id=?'
            ).run(
              i.destination === 'Unassigned' ? 'unassigned' : 'column',
              i.destination === 'Unassigned' ? null : i.destination,
              seq(),
              i.id
            );
          }

          else if(b.kind === 'unassigned') {
            db.prepare(
              "UPDATE catchall_items " +
              "SET stage='column',column_no=?,position=? " +
              "WHERE id=?"
            ).run(
              i.destination,
              seq(),
              i.id
            );
          }
          else if(b.kind==='column'&&(i.placement==='shelf'||(!i.placement&&b.mode==='shelf-piles')))db.prepare("UPDATE catchall_items SET stage='shelf',shelf_label=?,position=? WHERE id=?").run(i.destination,seq(),i.id);
          else {
            if((b.kind==='tape'||b.kind==='tape-existing')&&tapeKey(album(i.album_rowid))!==tapeKey(i.album))fail('Tape genres changed. Restore the displayed genres before confirming this section.');
            const now=new Date().toISOString();
            const primary=b.kind==='tape'||b.kind==='tape-existing';
            const taped=false; // A primary pass does not imply a review check or secondary tape.
            if(primary)db.prepare(`INSERT INTO catchall_finishing(album_rowid,primary_at,primary_genre) VALUES(?,?,?) ON CONFLICT(album_rowid) DO UPDATE SET primary_at=excluded.primary_at,primary_genre=excluded.primary_genre`).run(i.album_rowid,now,album(i.album_rowid).primary_genre||'');
            captureBaseline(i.album_rowid);
            db.prepare('UPDATE rainbow_albums SET sorted=1,sorted_shelf=?,sorted_at=?,taped=CASE WHEN ? THEN 1 ELSE taped END,taped_at=CASE WHEN ? THEN ? ELSE taped_at END WHERE rowid=?').run(i.destination,now,Number(taped),Number(taped),now,i.album_rowid);
            if(i.id)db.prepare("UPDATE catchall_items SET stage='sorted',sorted_at=?,taped_at=CASE WHEN ? THEN ? ELSE taped_at END WHERE id=?").run(now,Number(taped),now,i.id);
          }
        }
        if(b.kind==='source')for(const i of b.rows)db.prepare('UPDATE catchall_items SET scan_previous=NULL WHERE id=?').run(i.id);
        if(b.kind==='source'&&!db.prepare("SELECT 1 FROM catchall_items WHERE source_id=? AND stage='source'").get(b.sourceId))db.prepare("UPDATE catchall_sources SET status='complete' WHERE id=?").run(b.sourceId);
        db.prepare('UPDATE catchall_meta SET batch=NULL').run();
      } else if (body.type === 'reconcile') {
        const unresolved = db.prepare(`
          SELECT id, barcode
          FROM catchall_items
          WHERE stage = 'unassigned'
            AND album_rowid IS NULL
          ORDER BY position DESC
        `).all();

        let matched = 0;

        for (const item of unresolved) {
          const matches = db.prepare(`
            SELECT rowid AS rid
            FROM rainbow_albums
            WHERE TRIM(barcode) = TRIM(?)
          `).all(item.barcode);

          if (matches.length > 1) {
            fail(`Barcode ${item.barcode} matches multiple albums.`);
          }

          if (matches.length === 1) {
            const alreadyUsed = db.prepare(`
              SELECT 1
              FROM catchall_items
              WHERE album_rowid = ?
                AND id <> ?
            `).get(matches[0].rid, item.id);

            if (alreadyUsed) {
              fail(`Album for barcode ${item.barcode} is already in another stack.`);
            }

            db.prepare(`
              UPDATE catchall_items
              SET album_rowid = ?
              WHERE id = ?
            `).run(matches[0].rid, item.id);

            markScanned(matches[0].rid,new Date().toISOString());
            matched++;
          }
        } 
      } else if(body.type==='assign') {
        const i=db.prepare("SELECT * FROM catchall_items WHERE id=? AND stage='unassigned'").get(body.itemId)||fail('CD is no longer unassigned.');
        if(i.album_rowid)fail('This barcode already has an album. Correct its final shelf in the catalog.');
        const a=album(body.albumId)||fail('Album not found');
        if(String(a.barcode||'').trim())fail('Album already has a barcode.');
        if(!shelf(a.final_shelf))fail('Album needs a valid final shelf before assignment.');
        if(db.prepare('SELECT 1 FROM catchall_items WHERE album_rowid=?').get(a.catalog_rowid))fail('Album is already in a stack.');
        const now=new Date().toISOString();
        db.prepare('UPDATE rainbow_albums SET barcode=?,assigned_at=? WHERE rowid=?').run(i.barcode,now,a.catalog_rowid);
        db.prepare('UPDATE catchall_items SET album_rowid=? WHERE id=?').run(a.catalog_rowid,i.id);
        markScanned(a.catalog_rowid,now);
        db.prepare('INSERT INTO catchall_assignments(item_id,album_rowid,barcode,assigned_at) VALUES(?,?,?,?)').run(i.id,a.catalog_rowid,i.barcode,now);
      } else if(body.type==='defer') {
        const i=db.prepare("SELECT * FROM catchall_items WHERE id=? AND stage='unassigned'").get(body.itemId)||fail('CD is no longer unassigned.');
        const bottom=db.prepare("SELECT MIN(position) AS position FROM catchall_items WHERE stage='unassigned'").get().position;
        db.prepare('UPDATE catchall_items SET position=? WHERE id=?').run(bottom-1,i.id);
      } else if(body.type==='route') {
        const i=db.prepare("SELECT * FROM catchall_items WHERE id=? AND stage='unassigned'").get(body.itemId)||fail('CD is no longer unassigned.');
        const dest=shelf(album(i.album_rowid)?.final_shelf);if(!dest)fail('Album needs a valid final shelf.');
        db.prepare("UPDATE catchall_items SET stage='column',column_no=?,position=? WHERE id=?").run(dest.column,seq(),i.id);
      } else fail('Unknown action');
      db.prepare('UPDATE catchall_meta SET revision=revision+1').run();
      const result=state();
      if(openedSourceId)result.openedSourceId=openedSourceId;
      if(resetBackup)result.resetBackup=path.basename(resetBackup);
      return result;
    }).immediate();
  }
  function search(q) {
    const terms=String(q||'').trim().toLowerCase().split(/\s+/).filter(Boolean);if(!terms.length)return [];
    return db.prepare("SELECT rowid AS catalog_rowid,id,artist,title,final_shelf FROM rainbow_albums WHERE COALESCE(TRIM(barcode),'')='' AND rowid NOT IN (SELECT album_rowid FROM catchall_items WHERE album_rowid IS NOT NULL)").all().filter(a=>terms.every(t=>`${a.artist} ${a.title}`.toLowerCase().includes(t))).slice(0,40);
  }
  return {db,state,action,search,report:()=>db.transaction(()=>handoff.markdown(db))(),reportHtml:()=>db.transaction(()=>require('./report-html').html(db))()};
}
module.exports={openStore,shelf,estimatedLocation};
