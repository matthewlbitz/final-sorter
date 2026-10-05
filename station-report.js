const fs=require('fs'),path=require('path');
const {tape,colors}=require('./public/sorting-guide');
const label=v=>{const m=String(v||'').trim().toUpperCase().match(/^(\d{1,2})([A-Z])$/);return m&&+m[1]>=1&&+m[1]<=32?`${+m[1]}${m[2]}`:null;};
const assigned=a=>!!String(a.barcode||'').trim();
const placed=a=>Number(a.sorted)===1&&!!label(a.final_shelf)&&(!a.sorted_shelf||label(a.sorted_shelf)===label(a.final_shelf));
const trusted=a=>{const s=label(a.new_shelf_label);const c=parseInt(s);return s&&!['26P','27P'].includes(s)&&((c>=9&&c<=18)||c===20||(c>=24&&c<=28))?s:null;};
const order=(a,b)=>a.localeCompare(b,undefined,{numeric:true});
function migrate(db,filename){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='catchall_passes'").get())return;
  const dir=path.join(path.dirname(filename),'backups');fs.mkdirSync(dir,{recursive:true});
  db.exec(`VACUUM INTO '${path.join(dir,'before-handoff-'+require('crypto').randomUUID()+'.db').replaceAll("'","''")}'`);
  db.transaction(()=>db.exec(`
    CREATE TABLE catchall_passes(shelf TEXT PRIMARY KEY,completed_at TEXT NOT NULL);
    CREATE TABLE catchall_finishing(album_rowid INTEGER PRIMARY KEY,primary_at TEXT,primary_genre TEXT,secondary_at TEXT,secondary_genre TEXT,review_at TEXT,has_review INTEGER CHECK(has_review IN (0,1)));
  `))();
}
function primaryKnown(a,f){return f?.primary_at?f.primary_genre===(a.primary_genre||''):Number(a.taped)===1;}
function primaryDone(db,a){return primaryKnown(a,db.prepare('SELECT * FROM catchall_finishing WHERE album_rowid=?').get(a.catalog_rowid));}
function snapshot(db){
  const passes=db.prepare('SELECT * FROM catchall_passes ORDER BY completed_at,shelf').all();
  const passMap=new Map(passes.map(p=>[p.shelf,p]));
  const finishing=new Map(db.prepare('SELECT * FROM catchall_finishing').all().map(f=>[f.album_rowid,f]));
  const sources=new Map(db.prepare('SELECT * FROM catchall_sources').all().map(s=>[s.id,s]));
  const active=db.prepare("SELECT * FROM catchall_items WHERE stage<>'sorted'").all();
  const byId=new Map(active.filter(i=>i.album_rowid).map(i=>[i.album_rowid,i]));
  const byCode=new Map(active.map(i=>[i.barcode,i]));
  const unknown=new Set(db.prepare('SELECT album_rowid FROM catchall_unknown_locations').all().map(i=>i.album_rowid));
  const albums=db.prepare('SELECT rowid AS catalog_rowid,* FROM rainbow_albums').all().map(a=>{
    const f=finishing.get(a.catalog_rowid),item=byId.get(a.catalog_rowid)||byCode.get(String(a.barcode||'').trim());
    const primary=primaryKnown(a,f),review=!!f?.review_at;
    const secondary=!!f?.secondary_at&&f.secondary_genre===(a.secondary_genre||'');
    const atFinal=assigned(a)&&placed(a)&&!item&&!unknown.has(a.catalog_rowid);
    let location=null,working=null;
    if(assigned(a)){
      if(item)working=item.stage==='source'?`Source stack ${sources.get(item.source_id)?.label||'?'}`:item.stage==='column'?`Column ${item.column_no} pile`:item.stage==='shelf'?`Shelf ${item.shelf_label} pile`:'Unassigned stack';
      else if(!unknown.has(a.catalog_rowid))location=label(a.sorted_shelf)||(placed(a)?label(a.final_shelf):trusted(a));
    }
    return {...a,final:label(a.final_shelf),assigned:assigned(a),primary,review,secondary,hasReview:f?.has_review??null,atFinal,finished:atFinal&&primary&&secondary&&review,location,working,visited:passMap.has(label(a.final_shelf)),lateArrival:!!passMap.get(label(a.final_shelf))&&!!a.sorted_at&&a.sorted_at>passMap.get(label(a.final_shelf)).completed_at};
  });
  const queue=albums.filter(a=>a.visited&&a.atFinal&&!a.finished).sort((a,b)=>order(a.final,b.final)||order(a.artist||'',b.artist||'')||order(a.title||'',b.title||''));
  return {passes,queue,albums,active,sources:[...sources.values()]};
}
const esc=v=>String(v??'—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','&#124;').replace(/[\r\n]+/g,' ').replace(/([\\`*_\[\]])/g,'\\$1');
const breakdown=values=>{const counts=new Map();for(const v of values)counts.set(v||'None / missing',(counts.get(v||'None / missing')||0)+1);return [...counts].sort((a,b)=>b[1]-a[1]||order(a[0],b[0])).map(([k,n])=>`${esc(k)}: ${n}`).join('; ')||'—';};
function markdown(db){
  const {albums,passes,queue,active,sources}=snapshot(db);
  const count=fn=>albums.filter(fn).length,now=new Date().toISOString();
  const shelves=[...new Set(albums.map(a=>a.final).filter(Boolean).concat(passes.map(p=>p.shelf)))].sort(order);
  const lines=['# KTRU station report','',`Snapshot: ${now} (UTC) · Revision ${db.prepare('SELECT revision FROM catchall_meta').get().revision}`,'',
    '## Station totals','',
    '| Measure | CDs / shelves |','| --- | ---: |',
    `| Catalog records | ${albums.length} |`,
    `| Populated final shelves | ${shelves.length} |`,
    `| Unassigned records | ${count(a=>!a.assigned)} |`,
    `| Confirmed at final shelf | ${count(a=>a.atFinal)} |`,
    `| Primary tape recorded | ${count(a=>a.primary)} |`,
    `| Review checks recorded | ${count(a=>a.review)} |`,
    `| Reviews present / absent | ${count(a=>a.review&&a.hasReview===1)} / ${count(a=>a.review&&a.hasReview===0)} |`,
    `| Fully finished at final shelf | ${count(a=>a.finished)} |`,
    `| Initial shelf passes completed | ${passes.length} |`,
    `| Tape follow-up queue ready now | ${queue.length} |`,
    `| Active physical stack CDs (including unknown barcodes) | ${active.length} |`,
    `| Invalid / missing final shelf | ${count(a=>!a.final)} |`,'',
    'Counts describe catalog records, not an audited physical inventory. Primary tape alone is not full completion. Legacy taped flags count as primary tape but never imply a review check. Empty source shelves are not inventoried by this database.','',
    '## Tape follow-up handoff','',
    'Initial pass means the first available CDs received primary tape. It does not mean every destined CD has arrived. Historical tape and review records are retained; no finishing confirmation workflow is available. Late arrivals need primary tape too unless already recorded.','',
    '| Visited target | Initial pass (UTC) | Ready now | Need primary | Need review | Need secondary check | Still elsewhere / unassigned | Finished |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const p of passes){const all=albums.filter(a=>a.final===p.shelf),q=queue.filter(a=>a.final===p.shelf);lines.push(`| ${p.shelf} | ${p.completed_at} | ${q.length} | ${q.filter(a=>!a.primary).length} | ${q.filter(a=>!a.review).length} | ${q.filter(a=>!a.secondary).length} | ${all.filter(a=>!a.atFinal).length} | ${all.filter(a=>a.finished).length} |`);}
  if(!passes.length)lines.push('| No initial passes recorded | — | 0 | 0 | 0 | 0 | — | 0 |');
  lines.push('','### Ready CDs','', '| Shelf | Barcode | Artist — album | Primary tape | Secondary tape | Review | Arrival |','| --- | --- | --- | --- | --- | --- | --- |');
  for(const a of queue)lines.push(`| ${a.final} | ${esc(a.barcode)} | ${esc(a.artist)} — ${esc(a.title)} | ${a.primary?'Done':esc(tape(a.primary_genre)?.color||'Check genre')} | ${a.secondary?'Done':esc(tape(a.secondary_genre)?.color||'None; confirm')} | ${a.review?(a.hasReview?'Present':'Absent'):'Check'} | ${a.lateArrival?'After initial pass':'Initial / date unknown'} |`);
  lines.push('','## Every target shelf: current location query','',
    'Each list includes assigned CDs at confirmed physical shelves (including finished CDs) and unsorted CDs at catalog source shelf labels. Unassigned CDs and broad/jumbled areas are excluded. Working stacks override shelf estimates and are listed separately. These are catalog-based predictions, not physical guarantees. Counts after each shelf show matching CDs.','',
    '| Target: [shelves] | Counts by location | Total | Unassigned | Excluded / unknown | In stacks | At final | Primary | Fully finished | Initial pass |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for(const s of shelves){const all=albums.filter(a=>a.final===s),locations=[...new Set(all.map(a=>a.location).filter(Boolean))].sort(order);lines.push(`| ${s}: [${locations.join(', ')}] | ${breakdown(all.map(a=>a.location).filter(Boolean))} | ${all.length} | ${all.filter(a=>!a.assigned).length} | ${all.filter(a=>a.assigned&&!a.location&&!a.working).length} | ${all.filter(a=>a.working).length} | ${all.filter(a=>a.atFinal).length} | ${all.filter(a=>a.primary).length} | ${all.filter(a=>a.finished).length} | ${passes.find(p=>p.shelf===s)?.completed_at||'Not yet'} |`);}
  lines.push('','## Genre splits by target shelf','','| Shelf | Primary genres | Secondary genres | Tape combinations | Working locations |','| --- | --- | --- | --- | --- |');
  for(const s of shelves){const all=albums.filter(a=>a.final===s);lines.push(`| ${s} | ${breakdown(all.map(a=>a.primary_genre))} | ${breakdown(all.map(a=>a.secondary_genre))} | ${breakdown(all.map(a=>`${tape(a.primary_genre)?.color||'Check primary'} + ${tape(a.secondary_genre)?.color||'no top tape'}`))} | ${breakdown(all.map(a=>a.working).filter(Boolean))} |`);}
  lines.push('','## Source areas still needing intake','','Old shelf labels below are historical grouping, including the excluded areas; they are not guaranteed locations. A completed source scan is not proof the physical shelf is now empty.','', '| Old source label | Unassigned | Assigned, not at final | In working stacks | Source scan status |','| --- | ---: | ---: | ---: | --- |');
  const old=[...new Set(albums.map(a=>a.new_shelf_label||'Unknown'))].sort(order);
  for(const s of old){const all=albums.filter(a=>(a.new_shelf_label||'Unknown')===s),un=all.filter(a=>!a.assigned).length,pending=all.filter(a=>a.assigned&&!a.atFinal&&!a.working).length,working=all.filter(a=>a.working).length;if(un||pending||working)lines.push(`| ${esc(s)} | ${un} | ${pending} | ${working} | ${sources.find(x=>x.label===s)?.status||'Not scanned'} |`);}
  lines.push('','## Tape reference','','| Genre | Tape color |','| --- | --- |');for(const [g,c] of colors)lines.push(`| ${esc(g)} | ${c} |`);
  lines.push('','Primary = bottom; secondary = top. No secondary genre means no top tape. Review presence is recorded separately; no review-dependent tape rule is assumed.','');
  return lines.join('\n');
}
module.exports={migrate,primaryDone,snapshot,markdown};
