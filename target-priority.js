// Relative work units, not time predictions. Recomputed from current physical-location estimates.
function rankTargets(data,currentShelf=''){
 const {albums,passes,queue}=data,visited=new Set(passes.map(p=>p.shelf));
 const byTarget=new Map(),byLocation=new Map();
 for(const a of albums){
  if(a.final){if(!byTarget.has(a.final))byTarget.set(a.final,[]);byTarget.get(a.final).push(a);}
  // Unassigned records contribute only to handling estimates, never predicted target CDs.
  const old=String(a.new_shelf_label||'').trim().toUpperCase();
  const loc=a.working?null:(a.location||(!a.assigned?/^(?:9|1[0-8]|20|2[4-8])[A-Z]$/.test(old)&&!['26P','27P'].includes(old)?old:null:null));
  if(loc){if(!byLocation.has(loc))byLocation.set(loc,[]);byLocation.get(loc).push(a);}
 }
 const coworkerWeight=queue.length?0.25:0.5;
 const ranked=[];
 for(const [shelf,all]of byTarget){
  if(visited.has(shelf)||['26P','27P'].includes(shelf))continue;
  const ready=all.filter(a=>a.atFinal&&!a.finished),available=all.filter(a=>a.assigned&&!a.working&&a.location&&!(a.atFinal&&a.primary));
  const pulls=[...new Set(available.filter(a=>!a.atFinal).map(a=>a.location))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const handled=pulls.flatMap(p=>byLocation.get(p)||[]);
  const incoming=available.filter(a=>!a.atFinal),payoff=ready.length+incoming.length;
  if(!payoff)continue;
  const coworker=handled.filter(a=>a.final!==shelf&&visited.has(a.final)&&!a.finished&&!a.atFinal).length;
  const future=handled.filter(a=>a.final&&a.final!==shelf&&!visited.has(a.final)&&!a.atFinal).length;
  const primary=ready.filter(a=>!a.primary).length+incoming.filter(a=>!a.primary).length;
  const effort=20*pulls.length+handled.length+primary+1;
  ranked.push({shelf,ready:ready.length,primaryNeeded:primary,pulls,pullCount:pulls.length,handled:handled.length,expected:payoff,coworker,future,excluded:all.filter(a=>!a.assigned||(!a.location&&!a.working)).length,working:all.filter(a=>a.working).length,score:(payoff+coworkerWeight*coworker+0.1*future)/effort});
 }
 return ranked.sort((a,b)=>b.score-a.score||Math.abs(parseInt(a.shelf)-parseInt(currentShelf||a.shelf))-Math.abs(parseInt(b.shelf)-parseInt(currentShelf||b.shelf))||a.shelf.localeCompare(b.shelf,undefined,{numeric:true}));
}
module.exports={rankTargets};
