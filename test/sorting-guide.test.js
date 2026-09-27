const {test}=require('node:test');
const assert=require('node:assert/strict');
const {tape,shelfRuns}=require('../public/sorting-guide');
const row=(s,secondary)=>({album:{final_shelf:s,secondary_genre:secondary}});
test('exact-shelf neighbors are highlighted in full without joining columns or unknowns',()=>{
 const rows=[row('32A','Jazz'),row('32A','Rock'),row('32B'),row('31A'),row('31A'),row('32A'),{},{}];
 const copy=JSON.stringify(rows);
 assert.deepEqual(shelfRuns(rows),[
  {start:0,end:2,shelf:'32A',count:2},{start:2,end:3,shelf:'32B',count:1},
  {start:3,end:5,shelf:'31A',count:2},{start:5,end:6,shelf:'32A',count:1},
  {start:6,end:7,shelf:null,count:1},{start:7,end:8,shelf:null,count:1}]);
 assert.equal(JSON.stringify(rows),copy);
});
test('tape aliases match the actual catalog, including bottom and top differences',()=>{
 const expected={'Hip Hop':'red',Jazz:'orange',Rock:'yellow','Classical/Stage&Screen':'light green','Folk & Country':'dark green',Pop:'baby blue','Funk / Soul':'medium blue',Blues:'dark blue',World:'purple',Electronic:'pink',Reggae:'brown',Latin:'black','Brass & Military':'grey','Non-Music':'white',"Children's":'gold'};
 for(const [genre,color] of Object.entries(expected))assert.equal(tape(genre).color,color);
 assert.equal(tape(null),null);assert.equal(tape('   '),null);assert.equal(tape('Unknown genre').hex,null);
 assert.notEqual(tape('Rock').color,tape('Jazz').color);
});
