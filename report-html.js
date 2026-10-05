const {snapshot}=require('./station-report');
const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const order=(a,b)=>a.localeCompare(b,undefined,{numeric:true});
function html(db){
  const {albums}=snapshot(db);
  const byShelf=new Map();
  for(const album of albums){
    if(!album.final)continue;
    if(!byShelf.has(album.final))byShelf.set(album.final,[]);
    byShelf.get(album.final).push(album);
  }
  const columns=new Map();
  [...byShelf].sort(([a],[b])=>order(a,b)).map(([shelf,items])=>{
    const sources=new Map();
    for(const a of items)if(a.location&&!a.atFinal&&!a.working)sources.set(a.location,(sources.get(a.location)||0)+1);
    const locations=[...sources].sort(([a],[b])=>order(a,b)).map(([label,n])=>`${escape(label)} (${n})`).join(', ')||'—';
    const row=`<tr><th scope="row">${escape(shelf)}</th><td>${locations}</td><td>${items.filter(a=>a.atFinal).length} / ${items.length}</td><td>${items.filter(a=>a.assigned&&!a.location&&!a.working).length}</td></tr>`;
    const column=parseInt(shelf);if(!columns.has(column))columns.set(column,[]);columns.get(column).push(row);
  });
  const headings=`<thead><tr><th scope="col">Destination shelf<small>Where these CDs belong</small></th><th scope="col">Where to pull CDs<small>Source shelf (number of CDs)</small></th><th scope="col">Placed correctly<small>Confirmed / total CDs for this shelf</small></th><th scope="col">Location unknown<small>Assigned CD, not yet located</small></th></tr></thead>`;
  const sections=[...columns].map(([column,rows])=>`<details class="column" data-column="${column}"><summary>Column ${column}<span>${rows.length} destination shelves</span></summary><div class="table-wrap"><table>${headings}<tbody>${rows.join('')}</tbody></table></div></details>`).join('');
  const generated=new Date().toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'});
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KTRU shelf report</title><style>
  :root{color-scheme:light;--ink:#0a0a0a;--paper:#f7f6f1;--soft:#deddd6}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "Arial Narrow","Helvetica Neue",Arial,sans-serif;letter-spacing:.01em}main{max-width:1180px;margin:auto;padding:18px}.top{background:var(--ink);color:#fff;border:3px solid var(--ink);padding:15px 17px 13px;margin-bottom:10px}.brand{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-weight:900;font-size:30px;line-height:1;letter-spacing:-.04em}.ktru{border:3px solid #fff;padding:4px 7px 3px;letter-spacing:-.07em}.slash{font-weight:400;opacity:.65}.meta{margin-top:10px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.13em;color:#d8d8d8}.table-wrap{overflow-x:auto;border:2px solid var(--ink);background:#fff}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--soft);vertical-align:top}thead th{background:var(--ink);color:#fff;font:700 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:uppercase;letter-spacing:.04em}tbody th{white-space:nowrap;font-size:17px;font-weight:900}td:nth-child(2){font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}td:nth-child(n+3),thead th:nth-child(n+3){text-align:right}.note{font:11px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin-top:18px;padding-top:12px;border-top:2px solid var(--ink)}@media(max-width:600px){.brand{font-size:24px}}@media print{main{padding:0}.top{-webkit-print-color-adjust:exact;print-color-adjust:exact}thead{display:table-header-group}tr{break-inside:avoid}.table-wrap{overflow:visible}table{font-size:10px}th,td{padding:5px}td:nth-child(2){font-size:10px}thead th{background:#eee;color:#000}.brand{font-size:24px}}
  .column{margin:12px 0;border:2px solid var(--ink);background:white}.column summary{cursor:pointer;padding:13px 16px;background:#e9e5d8;font-size:21px;font-weight:900}.column summary span{float:right;font:11px/2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.column .table-wrap{border:0;border-top:2px solid var(--ink)}thead th{vertical-align:top}thead small{display:block;margin-top:6px;font-size:10px;line-height:1.5;font-weight:400;text-transform:none;letter-spacing:0;color:#ddd}td:nth-child(3){background:#eef7f1;color:#20563d}td:nth-child(4){background:#fff7e8;color:#794b13}@media print{.column summary{font-size:17px}.column{break-inside:auto}thead small{color:#333}*{print-color-adjust:exact}}
  </style></head><body><main><header class="top"><div class="brand"><span class="ktru">KTRU</span><span class="slash">//</span><span>SHELF REPORT</span></div><div class="meta">${escape(generated)} · AMERICA/CHICAGO · SAVED SNAPSHOT</div></header>
  ${sections||'<p>No target shelves in the catalog.</p>'}
  <p class="note">Source shelves list CDs still needing placement. Confirmed placements and working stacks take precedence over old labels. Old labels in columns 1–8, 19, 21–23, and 29–32 are unknown until scanned. CDs missing from a processed source shelf also have unknown locations. This is a saved snapshot; download again for updated counts.</p>
  </main><script>
  let saved=[];addEventListener('beforeprint',()=>{saved=[...document.querySelectorAll('details')].map(d=>[d,d.open]);for(const[d]of saved)d.open=true;});addEventListener('afterprint',()=>{for(const[d,open]of saved)d.open=open;});
  </script></body></html>`;
}
module.exports={html};
