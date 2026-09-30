const {test}=require('node:test'),assert=require('node:assert/strict');
const {rankTargets}=require('../target-priority');
const album=(final,location,extra={})=>({final,location,assigned:true,atFinal:false,primary:false,finished:false,working:null,...extra});
test('ready shelves outrank expensive pulls and excluded targets never inflate yield',()=>{
 const albums=[album('10A','10A',{atFinal:true}),album('11A','9A'),album('12A',null,{assigned:false,new_shelf_label:'9A'}),...Array.from({length:20},()=>album('13A','9A',{finished:true}))];
 const ranked=rankTargets({albums,passes:[],queue:[]});
 assert.equal(ranked[0].shelf,'10A');assert(!ranked.some(r=>r.shelf==='12A'));
 const r=ranked.find(r=>r.shelf==='11A');assert.equal(r.expected,1);assert.equal(r.handled,22);assert.equal(r.pullCount,1);
});
test('visited destinations count as new coworker work only when not already there; working stacks are excluded',()=>{
 const data={passes:[{shelf:'12A'}],queue:[],albums:[album('11A','9A'),album('11A','9A'),album('12A','9A'),album('12A','12A',{atFinal:true}),album('11A',null,{working:'Column pile'}),album('14A','9A')]};
 const r=rankTargets(data).find(r=>r.shelf==='11A');assert.equal(r.coworker,1);assert.equal(r.future,1);assert.equal(r.handled,4);assert.equal(r.working,1);assert.deepEqual(r.pulls,['9A']);assert(!rankTargets(data).some(r=>r.shelf==='12A'));
 const crowded=rankTargets({...data,queue:[{}]}).find(r=>r.shelf==='11A');assert(crowded.score<r.score);
});
