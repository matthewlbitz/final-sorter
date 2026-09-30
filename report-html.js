const fs=require('fs'),path=require('path');
const {snapshot,markdown}=require('./station-report');
const {colors,tape}=require('./public/sorting-guide');
const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
// Decode only the escaping emitted by our own Markdown report, then HTML-escape it.
const cell=v=>escape(v.trim().replace(/\\([\\`*_\[\]])/g,'$1').replaceAll('&#124;','|').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
function columnTables(body){
 return body.replace(/<div class="table-scroll"><table>([\s\S]*?)<\/table><\/div>/g,(original,content)=>{
  const rows=content.match(/<tr>[\s\S]*?<\/tr>/g)||[],header=rows.shift(),groups=new Map();
  if(!rows.some(r=>/^<tr><td>\d+[A-Z]/.test(r)))return original;
  for(const row of rows){const col=row.match(/^<tr><td>(\d+)[A-Z]/)?.[1]||'Other';if(!groups.has(col))groups.set(col,[]);groups.get(col).push(row);}
  return [...groups].map(([col,rows])=>`<details class="column-group"><summary>Column ${col} <span>${rows.length} rows</span></summary><div class="table-scroll"><table>${header}${rows.join('')}</table></div></details>`).join('');
 });
}
function html(db){
 const data=snapshot(db),text=markdown(db),css=fs.readFileSync(path.join(__dirname,'ktru_stacks_map.html'),'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
 const groups=text.split(/^## /m).slice(1);let tables='';
 for(const [index,group] of groups.entries()){
  const lines=group.trim().split('\n'),title=lines.shift();let body='',inTable=false,header=false;
  for(const line of lines){
   if(line.startsWith('|')){
    if(/^\|[\s:|\-]+$/.test(line))continue;
    if(!inTable){body+='<div class="table-scroll"><table>';inTable=true;header=true;}
    const tag=header?'th':'td';body+=`<tr>${line.slice(1,-1).split('|').map(v=>`<${tag}>${cell(v)}</${tag}>`).join('')}</tr>`;header=false;
   }else{
    if(inTable){body+='</table></div>';inTable=false;}
    if(line.startsWith('### '))body+=`<h3>${cell(line.slice(4))}</h3>`;
    else if(line.trim())body+=`<p class="note">${cell(line)}</p>`;
   }
  }
  if(inTable)body+='</table></div>';
  tables+=`<details class="report-section" id="section-${index}" ${index===1?'open':''}><summary>${escape(title)}</summary>${columnTables(body)}</details>`;
 }
 const shelves=[...new Set(data.albums.map(a=>a.final).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
 const count=fn=>data.albums.filter(fn).length;
 const metrics=[['Catalog CDs',data.albums.length],['Final shelves',shelves.length],['Initial passes',data.passes.length],['Coworker ready',data.queue.length],['Fully finished',count(a=>a.finished)],['Unassigned',count(a=>!a.assigned)]];
 const columnCards=new Map();
 shelves.forEach(s=>{
  const all=data.albums.filter(a=>a.final===s),pass=data.passes.find(p=>p.shelf===s),q=data.queue.filter(a=>a.final===s);
  const locations=[...new Set(all.map(a=>a.location).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const genres=new Map();for(const a of all)genres.set(a.primary_genre||'Missing genre',(genres.get(a.primary_genre||'Missing genre')||0)+1);
  const splits=[...genres].sort((a,b)=>b[1]-a[1]);
  const primary=splits[0]?.[0],color=tape(primary)?.hex||'#deddd6';
  const card=`<section class="genre-card shelf-card" data-visited="${!!pass}" data-ready="${q.length>0}"><header><div><h2>${s}</h2><span class="range">${pass?'INITIAL PASS DONE':'NOT YET VISITED'}</span></div><div class="tape" style="background:${color};color:${color==='#202020'?'white':'black'}">${escape(primary)}</div></header><div class="card-body"><p class="query"><b>${s}:</b> [${locations.join(', ')}]</p><p class="muted">${all.length} CDs · ${all.filter(a=>a.atFinal).length} at final · ${all.filter(a=>a.finished).length} finished</p>${pass?`<p class="handoff">${q.length} ready for coworker · ${q.filter(a=>!a.primary).length} need primary</p><small>Initial pass: ${escape(pass.completed_at)}</small>`:''}<div class="splits">${splits.map(([g,n])=>`<span><i style="background:${tape(g)?.hex||'#deddd6'}"></i>${escape(g)} <b>${n}</b></span>`).join('')}</div><p class="muted">${all.filter(a=>!a.assigned).length} unassigned · ${all.filter(a=>a.assigned&&!a.location&&!a.working).length} excluded / unknown · ${all.filter(a=>a.working).length} in stacks</p></div></section>`;
  const col=parseInt(s);if(!columnCards.has(col))columnCards.set(col,[]);columnCards.get(col).push(card);
 });
 const cards=[...columnCards].map(([col,items])=>`<details class="column-group map-column"><summary>Column ${col} <span class="column-count">${items.length} shelves</span></summary><div class="grid">${items.join('')}</div></details>`).join('');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KTRU // Station report</title><style>${css}
 .column-group{margin:8px 0}.column-group summary{display:list-item}.column-group summary span{float:right;font-size:11px;font-weight:400;letter-spacing:0}.column-group .grid{padding:8px}.report-section>.column-group{margin:8px}.column-group[hidden]{display:none!important}.stats{display:grid;grid-template-columns:repeat(6,1fr);border:2px solid #000;margin:14px 0}.stat{padding:14px 10px;background:white;border-right:1px solid #000}.stat:last-child{border:0}.stat strong{display:block;font-size:30px;letter-spacing:-.06em}.stat small{line-height:1.4}.intro{font-size:13px;line-height:1.6;max-width:850px}.controls{grid-template-columns:1fr auto auto}.controls select{border:2px solid #000;border-radius:0;background:white;padding:10px;font:700 12px monospace;max-width:100%}.section-title{font-size:22px;letter-spacing:-.03em;text-transform:uppercase;border-top:3px solid #000;padding-top:16px;margin-top:25px}.card-body{padding:12px}.query{font:700 13px monospace;line-height:1.6;margin:0;overflow-wrap:anywhere}.muted{font:11px monospace;color:#555;line-height:1.6}.handoff{background:#ecebe5;padding:8px;font:700 12px monospace}.splits{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.splits span{display:flex;gap:5px;align-items:center;font-size:12px;border:1px solid #ccc;padding:4px 6px}.splits i{width:9px;height:14px;border:1px solid #aaa}.table-scroll{overflow-x:auto}td:last-child,th:last-child{white-space:normal}td{line-height:1.45;min-width:65px}th{position:sticky;top:0}h3{padding:0 12px}nav{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}a{color:inherit;font:700 12px monospace}.footer{margin-top:25px;border-top:2px solid;padding:14px 0;font:11px monospace;line-height:1.7}.empty{padding:20px;border:2px solid #000}.legend-item{flex-basis:150px}.report-section .note{font-size:12px;line-height:1.6}.brand{flex-wrap:wrap}.report-section{margin-top:10px}
 @media(max-width:760px){.stats{grid-template-columns:repeat(3,1fr)}.stat{border-bottom:1px solid #000}.controls{grid-template-columns:1fr auto}.controls input{grid-column:1/-1}.brand{font-size:23px}}
 @media print{.report-section{display:block!important}.report-section::details-content{content-visibility:visible!important;display:block!important}.table-scroll{overflow:visible}.stats{grid-template-columns:repeat(6,1fr)}nav{display:none}tr{break-inside:avoid}.shelf-card{break-inside:avoid}.hidden{display:none!important}summary{background:#eee;color:#000}th{position:static}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}*{print-color-adjust:exact}}
 </style></head><body><main class="wrap"><header class="top"><div class="brand"><span class="ktru">KTRU</span><span class="slash">//</span><span>STATION REPORT</span></div><div class="meta">${escape(new Date().toISOString())} · SAVED SNAPSHOT · ALL TIMES UTC</div></header>
 <p class="intro">A station-wide handoff: where each shelf’s CDs are predicted to be, which initial passes are done, and what your coworker can finish now. This file works offline. Export a new report from the sorter to refresh it.</p>
 <div class="stats">${metrics.map(([l,n])=>`<div class="stat"><strong>${n.toLocaleString('en-US')}</strong><small>${l}</small></div>`).join('')}</div>
 <nav><a href="#shelves">Shelf map</a><a href="#section-1">Coworker handoff</a><a href="#section-2">Location counts</a><a href="#section-3">Genre detail</a><a href="#section-4">Source backlog</a></nav>
 <h2 class="section-title" id="shelves">Shelf map</h2><p class="intro">Lists exclude unassigned CDs and untrusted old locations. Known working stacks override shelf estimates. Initial pass done does not mean every CD has arrived.</p>
 <div class="controls"><input id="search" type="search" aria-label="Search shelf map" placeholder="SEARCH SHELF / GENRE / SOURCE"><select id="filter" aria-label="Filter shelf map"><option value="all">ALL SHELVES</option><option value="visited">INITIAL PASS DONE</option><option value="ready">COWORKER READY</option><option value="unvisited">NOT YET VISITED</option></select><button id="print">PRINT</button></div><p id="count" class="muted" aria-live="polite"></p>
 <div id="cards">${cards}</div><p id="empty" class="empty" hidden>No shelves match this view.</p>
 <h2 class="section-title">Station detail</h2><p class="intro">Expand a section for the complete tables. Shelf-map filters affect the cards above only; these tables always retain the full snapshot.</p>${tables}
 <footer class="footer">KTRU // STATION OPERATIONS<br>Catalog-based estimates, not a physical inventory. Primary tape, review checks, and full completion are tracked separately.</footer></main>
 <script>
 const search=document.getElementById('search'),filter=document.getElementById('filter'),cards=[...document.querySelectorAll('.shelf-card')];
 function update(){const q=search.value.trim().toLowerCase();let n=0;for(const c of cards){const mode=filter.value,match=c.textContent.toLowerCase().includes(q)&&(mode==='all'||mode==='visited'&&c.dataset.visited==='true'||mode==='unvisited'&&c.dataset.visited==='false'||mode==='ready'&&c.dataset.ready==='true');c.classList.toggle('hidden',!match);if(match)n++;}for(const group of document.querySelectorAll('.map-column')){const shown=group.querySelectorAll('.shelf-card:not(.hidden)').length;group.hidden=!shown;group.querySelector('.column-count').textContent=shown+' shelves';if(q||filter.value!=='all')group.open=shown>0;else group.open=false;}document.getElementById('count').textContent=n+' of '+cards.length+' shelves shown';document.getElementById('empty').hidden=n>0;}
 search.addEventListener('input',update);filter.addEventListener('change',update);update();
 let previouslyOpen=[];window.addEventListener('beforeprint',()=>{previouslyOpen=[...document.querySelectorAll('details')].map(d=>[d,d.open]);for(const [d]of previouslyOpen)d.open=true;});window.addEventListener('afterprint',()=>{for(const[d,open]of previouslyOpen)d.open=open;});document.getElementById('print').onclick=()=>window.print();
 </script></body></html>`;
}
module.exports={html};
