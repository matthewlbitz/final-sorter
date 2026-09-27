const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const {tape,tapeKey} = require('./public/sorting-guide');
const shelf = value => {
  const m = String(value || '').trim().toUpperCase().match(/^(\d{1,2})([A-Z])$/);
  return m && +m[1] >= 1 && +m[1] <= 32 ? {label: `${+m[1]}${m[2]}`, column: +m[1], rank: +m[1]*26 + m[2].charCodeAt(0)-65} : null;
};

function estimatedLocation(album) {
  // Albums without an assigned barcode are physically in 29–32.
  if (!String(album.barcode || '').trim()) {
    return {
      key: 'unassigned-29-32',
      label: 'Columns 29–32',
      type: 'section'
    };
  }

  const old = shelf(album.new_shelf_label);

  if (!old) {
    return {
      key: 'unknown',
      label: 'Unknown location',
      type: 'unknown'
    };
  }

  const c = old.column;

  // Columns 1–8: correct column, but not necessarily correct shelf.
  if (c >= 1 && c <= 8) {
    return {
      key: `column-${c}`,
      label: `Column ${c}`,
      type: 'column'
    };
  }

  // Column 19 is jumbled.
  if (c === 19) {
    return {
      key: 'section-19',
      label: 'Column 19 (jumbled)',
      type: 'section'
    };
  }

  // Columns 21–23 are jumbled together.
  if (c >= 21 && c <= 23) {
    return {
      key: 'section-21-23',
      label: 'Columns 21–23 (jumbled)',
      type: 'section'
    };
  }

  // These areas are accurate down to the individual shelf.
  if (
    (c >= 9 && c <= 18) ||
    c === 20 ||
    (c >= 24 && c <= 28)
  ) {
    return {
      key: `shelf-${old.label}`,
      label: `Shelf ${old.label}`,
      type: 'shelf'
    };
  }

  return {
    key: `column-${c}`,
    label: `Column ${c}`,
    type: 'column'
  };
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
  if(db.prepare('SELECT version FROM catchall_meta').get().version!==2) throw new Error('Unsupported workflow version');
  db.pragma('foreign_keys = ON');
  const meta=()=>db.prepare('SELECT * FROM catchall_meta').get();
  const album=id=>db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums WHERE rowid=?').get(id);
  const enrich=i=>({...i,album:i.album_rowid ? album(i.album_rowid):null});
  const allItems=()=>db.prepare('SELECT * FROM catchall_items ORDER BY position DESC').all().map(enrich);
  const fail=msg=>{throw new Error(msg);};
  const seq=()=>{db.prepare('UPDATE catchall_meta SET sequence=sequence+1').run();return meta().sequence;};
  function state() {
    const m=meta(), items=allItems();
    const bounds=db.prepare('SELECT DISTINCT final_shelf FROM rainbow_albums').all().map(a=>shelf(a.final_shelf)).filter(Boolean).sort((a,b)=>a.rank-b.rank);
    // Legacy ranges select their highest column; no stack or catalog migration is needed.
    const targetColumn=shelf(m.range_end)?.column||bounds.at(-1)?.column||32;
    const start=`${targetColumn}A`, end=`${targetColumn}Z`;
    const sources=db.prepare('SELECT * FROM catchall_sources ORDER BY id DESC').all();
    const active = new Set(
      items
        .filter(i =>
          i.album_rowid &&
          i.stage !== 'sorted'
        )
        .map(i => i.album_rowid)
    );
    const used=new Set();
    const sorted=new Set(items.filter(i=>i.stage==='sorted').map(i=>i.album_rowid));
    const groups = new Map();
    let remaining = 0;
    let unavailable = 0;

    for (const a of db.prepare(`
      SELECT
        rowid AS rid,
        final_shelf,
        new_shelf_label,
        barcode
      FROM rainbow_albums
    `).all()) {

      const final = shelf(a.final_shelf);

      // Only albums ultimately belonging in our target column.
      if (!final || final.column !== targetColumn) continue;

      // Already physically placed in its final location.
      if (sorted.has(a.rid)) continue;

      remaining++;

      // Final Sorter has already encountered this album.
      //
      // It might currently be:
      //   - in a scanned source stack
      //   - in a column pile
      //   - in an unassigned pile
      //   - in a target shelf pile
      //
      // In all of those cases, its old new_shelf_label is no longer
      // useful for telling us where to pull it from.
      if (active.has(a.rid)) continue;

      // We have never encountered this CD, so estimate where it
      // currently lives based on the station's starting state.
      const location = estimatedLocation(a);

      if (location.type === 'unknown') {
        unavailable++;
        continue;
      }

      const g = groups.get(location.key) || {
        key: location.key,
        label: location.label,
        type: location.type,
        count: 0,
        highest: 0
      };

      g.count++;
      g.highest = Math.max(g.highest, final.rank);

      groups.set(location.key, g);
    }
    return {
      revision:m.revision,
      targetColumn,
      start,
      end,
      remaining,
      unavailable,
      sources: sources.map(s=>({
        ...s,
        count:items.filter(i=>i.source_id===s.id&&i.stage==='source').length
      })),
      items,

      recommendations: [...groups.values()].sort((a, b) => {
        const priority = location => {
          if (location.type === 'shelf') return 1;
          if (location.type === 'column') return 2;

          if (
            location.key === 'section-19' ||
            location.key === 'section-21-23'
          ) return 3;

          if (location.key === 'unassigned-29-32') return 4;

          return 5;
        };

        return (
          priority(a) - priority(b) ||
          b.count - a.count ||
          a.label.localeCompare(b.label, undefined, {numeric:true})
        );
      }),

      batch:m.batch?JSON.parse(m.batch):null
    };
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
    return db.transaction(()=>{
      const m=meta();
      if(body.revision!==m.revision)fail('State changed. Refresh and check the current stack.');
      const b=m.batch?JSON.parse(m.batch):null;
      if(b&&body.type!=='confirm'&&body.type!=='reset')fail('Finish the displayed 10 CDs before changing stacks.');
      const source=()=>db.prepare('SELECT * FROM catchall_sources WHERE id=?').get(body.sourceId)||fail('Source not found');
      if(body.type==='reset'){
        db.exec('DELETE FROM catchall_assignments; DELETE FROM catchall_items; DELETE FROM catchall_sources;');
        db.prepare('UPDATE catchall_meta SET sequence=0,batch=NULL').run();
      } else if(body.type==='target'){
        if(!Number.isInteger(body.column)||body.column<1||body.column>32)fail('Choose a column from 1 to 32.');
        if(db.prepare("SELECT 1 FROM catchall_items WHERE stage IN ('source','column','shelf','unassigned')").get())fail('Finish the current stacks and shelf piles before changing the target column.');
        db.prepare('UPDATE catchall_meta SET range_start=?,range_end=?').run(`${body.column}A`,`${body.column}Z`);
      } else if(body.type==='range'){
        fail('Column selection has replaced shelf ranges. Refresh this page.');
      } else if(body.type==='source') {
        const label=String(body.label||'').trim().toUpperCase();if(!label||label.length>40)fail('Enter a source shelf.');
        if(db.prepare('SELECT 1 FROM catchall_sources WHERE label=?').get(label))fail('This shelf is already saved. Open its stack below.');
        db.prepare("INSERT INTO catchall_sources(label,status) VALUES(?,'scanning')").run(label);
      } else if(body.type==='scan') {
        const s=source();if(s.status!=='scanning')fail('This stack is already saved.');
        const code=String(body.barcode||'').trim();if(!code||code.length>128)fail('Scan a barcode.');
        if(db.prepare('SELECT 1 FROM catchall_items WHERE barcode=?').get(code))fail('Barcode already in this workflow. Keep this CD aside and check its stack.');
        const matches=db.prepare('SELECT rowid AS rid FROM rainbow_albums WHERE TRIM(barcode)=?').all(code);
        if(matches.length>1)fail('Barcode matches multiple albums. Correct the catalog before scanning.');
        db.prepare("INSERT INTO catchall_items(source_id,barcode,album_rowid,stage,position) VALUES(?,?,?,'source',?)").run(s.id,code,matches[0]?.rid||null,seq());
      } else if(body.type==='remove') {
        const s=source();if(s.status!=='scanning')fail('Only unsaved scans can be removed.');
        db.prepare('DELETE FROM catchall_items WHERE id=(SELECT id FROM catchall_items WHERE source_id=? ORDER BY position DESC LIMIT 1)').run(s.id);
      } else if(body.type==='save') {
        const s=source();if(s.status!=='scanning')fail('Stack already saved.');
        if(!db.prepare('SELECT 1 FROM catchall_items WHERE source_id=?').get(s.id))fail('Scan at least one CD.');
        db.prepare("UPDATE catchall_sources SET status='saved' WHERE id=?").run(s.id);
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
          mode=body.column===target?'shelf-piles':'final-shelves';
          if(mode==='shelf-piles'&&db.prepare("SELECT 1 FROM catchall_items WHERE stage='column' AND column_no<>?").get(target))fail('Clear the other columns before the target column.');
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
        const rows=items.map(enrich).map(i=>{
          const dest=shelf(i.album?.final_shelf);
          if(body.kind==='tape'&&dest?.label!==i.shelf_label)fail('A final shelf changed. Correct the catalog before taping this pile.');
          if(body.kind==='column'&&(!dest||dest.column!==i.column_no))fail('A catalog destination changed. Check this column before continuing.');
          return {
            ...i,
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
          if((b.kind==='column'||b.kind==='tape') && shelf(album(i.album_rowid)?.final_shelf)?.label!==i.destination)fail('A final shelf changed while this batch was open. Restore its catalog destination before confirming.');
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
          else if(b.kind==='column'&&b.mode==='shelf-piles')db.prepare("UPDATE catchall_items SET stage='shelf',shelf_label=?,position=? WHERE id=?").run(i.destination,seq(),i.id);
          else {
            if(b.kind==='tape'&&tapeKey(album(i.album_rowid))!==tapeKey(i.album))fail('Tape genres changed. Restore the displayed genres before confirming this section.');
            const now=new Date().toISOString();
            db.prepare("UPDATE catchall_items SET stage='sorted',sorted_at=?,taped_at=? WHERE id=?").run(now,b.kind==='tape'?now:null,i.id);
          }
        }
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
      if(resetBackup)result.resetBackup=path.basename(resetBackup);
      return result;
    }).immediate();
  }
  function search(q) {
    const terms=String(q||'').trim().toLowerCase().split(/\s+/).filter(Boolean);if(!terms.length)return [];
    return db.prepare("SELECT rowid AS catalog_rowid,id,artist,title,final_shelf FROM rainbow_albums WHERE COALESCE(TRIM(barcode),'')='' AND rowid NOT IN (SELECT album_rowid FROM catchall_items WHERE album_rowid IS NOT NULL)").all().filter(a=>terms.every(t=>`${a.artist} ${a.title}`.toLowerCase().includes(t))).slice(0,40);
  }
  return {db,state,action,search};
}
module.exports={openStore,shelf};
