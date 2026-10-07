/* Physical stack convention reused from shelf-lookup/batch-sort.js:
   each scan/placement goes on top; display the newest ten top-to-bottom. */
const screen=document.getElementById('screen'), message=document.getElementById('message');
let batchConfirm=null, enterHeld=false;
let selectedTarget=null, scanOnly=true, randomSourceId=null, predictionQueue=[];
let state, view={type:'home'}, busy=false, searchVersion=0;
const el=(tag,text,parent=screen)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n;};
function button(text,fn,parent=screen,quiet=false){const b=el('button',text,parent);b.type='button';b.className=quiet?'quiet':'';b.onclick=()=>run(fn);return b;}
function input(label,value='',parent=screen){const l=el('label',label,parent), i=el('input',undefined,l);i.value=value;i.autocomplete='off';return i;}
async function request(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);message.textContent='';try{await fn();}catch(e){message.textContent=e.message;try{state=await request('/api/state');render();}catch{message.textContent+=' — Connection lost. Reload to resume.';}}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function action(type,data={}){state=await request('/api/action',{type,revision:state.revision,...data});}
function form(fn,parent=screen){const f=el('form',undefined,parent);f.onsubmit=e=>{e.preventDefault();run(fn);};return f;}
function submit(text,f){const b=el('button',text,f);b.type='submit';return b;}
function go(v){view=v;render();}
function destination(value){const m=String(value||'').match(/^(\d+)[A-Z]$/);return m?+m[1]:null;}
function render(){
  batchConfirm=null;searchVersion++;screen.classList.remove('compact-sort');screen.replaceChildren();document.getElementById('home').hidden=!!state.batch||view.type==='home';
  if(state.batch)return renderBatch();
  if(view.type==='shelf')return renderShelf();
  if(view.type==='shelved')return renderShelved();
  if(view.type==='source'||view.type==='column')return renderStack();
  if(view.type==='unassigned')return renderUnassigned();
  const f=form(async()=>{
    if(!select.value){await startScanSort();return;}
    await action('target',{shelf:select.value});selectedTarget=state.targetShelf;scanOnly=false;predictionQueue=state.recommendations.map(r=>r.label.replace(/^Shelf /,''));render();
  });f.className='target-picker';
  const targetLabel=el('label','Target shelf',f),select=el('select',undefined,targetLabel);select.setAttribute('aria-label','Target shelf');
  const blank=el('option','Scan & Sort — no target shelf',select);blank.value='';
  for(const shelf of state.shelves){const option=el('option',shelf,select);option.value=shelf;}
  select.value=scanOnly?'':selectedTarget||'';
  select.onchange=()=>{if(!select.value){scanOnly=true;selectedTarget=null;render();}};
  submit('Start',f);

  if(scanOnly){
    const source=state.sources.find(s=>s.id===randomSourceId&&s.status!=='complete')||state.sources.find(s=>s.label.startsWith('Scan & Sort ')&&s.status!=='complete');
    randomSourceId=source?.id||null;
    renderScanSection(source,'Scan CDs',null,true);
  }else if(selectedTarget){
    const labels=new Map(state.recommendations.map(r=>[r.label.replace(/^Shelf /,''),r.count]));
    for(const source of state.sources.filter(s=>s.status!=='complete'&&!s.label.startsWith('Scan & Sort ')))if(!labels.has(source.label))labels.set(source.label,0);
    for(const label of labels.keys())if(!predictionQueue.includes(label))predictionQueue.push(label);
    predictionQueue.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    el('h2',`Predicted shelves: [${predictionQueue.join(', ')}]`);
    const pending=predictionQueue.filter(label=>{
      const source=state.sources.find(s=>s.label===label);
      return !source||source.status==='scanning'||(source.status==='complete'&&labels.has(label));
    });
    if(pending.length){
      const label=pending[0],source=state.sources.find(s=>s.label===label&&s.status==='scanning');
      renderScanSection(source,'Shelf '+label,{label,count:labels.get(label)||0},false);
    }else el('p','Finished scanning all predicted shelves. Sort the saved stacks below.');
    const saved=state.sources.filter(s=>s.status==='saved'&&!s.label.startsWith('Scan & Sort '));
    if(saved.length){
      const work=el('section');work.className='next';el('h2','Saved stacks',work);
      for(const source of saved)button(`Sort shelf ${source.label} · ${source.count} CDs`,async()=>{await action('batch',{kind:'source',sourceId:source.id});render();},work,true);
    }
    if(state.unavailable)el('p',`${state.unavailable} CDs have unknown source locations.`);
    if(state.alreadyShelved.length){
      const here=el('section');here.className='next';el('h2',`Already on ${state.targetShelf} · ${state.alreadyShelved.length} need tape`,here);
      button('Tape CDs already here',()=>go({type:'shelved'}),here);
    }
  }
  const columns=[...new Set(state.items.filter(i=>i.stage==='column').map(i=>i.column_no))].sort((a,b)=>(a===state.targetColumn)-(b===state.targetColumn)||b-a);
  if(columns.length){el('h2','Column stacks');const wrap=el('div');wrap.className='columns';for(const c of columns)button(`${c} · ${state.items.filter(i=>i.stage==='column'&&i.column_no===c).length}`,()=>go({type:'column',column:c}),wrap,true);}
  const shelves=[...new Set(state.items.filter(i=>i.stage==='shelf').map(i=>i.shelf_label))];
  if(shelves.length){el('h2','Shelf piles · ready to tape');for(const shelf of shelves)button(shelf,()=>go({type:'shelf',shelf}),screen,true);}
  const unknown=state.items.filter(i=>i.stage==='unassigned').length;
  if(unknown)button(`Set aside · ${unknown}`,()=>go({type:'unassigned'}),screen,true);
  if(scanOnly&&state.sources.some(s=>s.status!=='complete'&&!s.label.startsWith('Scan & Sort ')))button(`Resume target shelf ${state.targetShelf}`,()=>{selectedTarget=state.targetShelf;scanOnly=false;predictionQueue=[];render();},screen,true);
  if(!selectedTarget&&!scanOnly){
    for(const source of state.sources.filter(s=>s.status!=='complete')){
      button('Resume '+source.label,()=>{
        if(source.label.startsWith('Scan & Sort ')){scanOnly=true;randomSourceId=source.id;}else selectedTarget=state.targetShelf;
        render();
      },screen,true);
    }
  }
}
function renderScanSection(source,title,prediction,direct){
  const section=el('section');section.className='next scan-section';section.dataset.source=prediction?.label||'scan-sort';
  el('h2',title,section);
  if(prediction)el('p',`${prediction.count} CDs predicted for ${state.targetShelf}`,section);
  el('p','Scan in order, placing each CD on top of the stack.',section);
  const sourceId=source?.id;
  const items=state.items.filter(i=>i.source_id===sourceId&&i.stage==='source');
  if(!source||source.status==='scanning'){
    const f=form(async()=>{
      let id=sourceId;
      if(!id){await action(direct?'scan-sort':'source',direct?{}:{label:prediction.label});id=state.openedSourceId;if(direct)randomSourceId=id;}
      await action('scan',{sourceId:id,barcode:barcode.value});view={type:'home'};render();
      document.querySelector(`[data-source="${section.dataset.source}"] input`)?.focus();
    },section);
    const barcode=input('Barcode','',f);barcode.setAttribute('aria-label',title+' barcode');submit('Add',f);
    el('h3',items.length+' scanned',section);
    if(items[0])el('p',`${items[0].barcode} · ${items[0].album?.title||'Unassigned'}`,section);
    if(!items.length&&!direct)button('Finish scanning — shelf is empty',async()=>{
      let id=sourceId;
      if(!id){await action('source',{label:prediction.label});id=state.openedSourceId;}
      await action('empty-source',{sourceId:id});render();document.querySelector('.scan-section input')?.focus();
    },section);
    if(items.length){
      button('Finish scanning',async()=>{await action('save',{sourceId});render();document.querySelector('.scan-section input')?.focus();},section);
      button('Remove last scan',async()=>{await action('remove',{sourceId});render();},section,true);
    }
  }else if(source.status==='saved'){
    el('p',items.length+' CDs saved · keep this stack in order.',section);
    button('Sort this stack',async()=>{await action('batch',{kind:direct?'scan-sort':'source',sourceId});render();},section);
    if(direct)button('Refresh assignments',async()=>{await action('reconcile');render();},section,true);
  }
}

function renderShelf(){
  const items=state.items.filter(i=>i.stage==='shelf'&&i.shelf_label===view.shelf);
  el('h2',`Shelf ${view.shelf} · ${items.length} CDs`);
  if(!items.length){button('Continue',()=>go({type:'home'})).focus();return;}
  el('p','Keep the pile in order. These are the tape sections from top to bottom.');
  const sections=SortingGuide.tapeSections(items);
  for(const [index,section] of sections.entries()){
    const card=el('div');card.className='tape-section-card';el('strong',`Section ${index+1} · ${section.count} CDs`,card);renderTape(section.album,card);
  }
  button('Tape the top section',async()=>{await action('batch',{kind:'tape',shelf:view.shelf});render();}).focus({preventScroll:true});
}
function renderStack(){
  const source=view.type==='source';
  const items=state.items.filter(i=>source?i.stage==='source'&&i.source_id===view.id:i.stage==='column'&&i.column_no===view.column);
  const name=source?state.sources.find(s=>s.id===view.id)?.label:'Column '+view.column;
  el('h2',name+' · '+items.length+' CDs');
  if(!items.length){button('Continue',()=>go({type:'home'})).focus();return;}
  const direct=source&&state.sources.find(s=>s.id===view.id)?.label.startsWith('Scan & Sort ');
  if(direct){
    el('p','Top CD first · place each CD on its final shelf. Placement is saved only after you confirm each batch. CDs without a valid shelf go to Set aside and leave this sorter when confirmed.');
    button('Refresh assignments',async()=>{await action('reconcile');render();},screen,true);
    button('Sort this stack',async()=>{await action('batch',{kind:'scan-sort',sourceId:view.id});render();}).focus();return;
  }
  const directColumn=!source&&items.every(i=>state.sources.find(s=>s.id===i.source_id)?.label.startsWith('Scan & Sort '));
  const target=!directColumn&&!source&&view.column===state.targetColumn;
  if(target&&state.items.some(i=>i.stage==='column'&&i.column_no!==state.targetColumn)){el('p','Clear the other column stacks first.');button('Back to columns',()=>go({type:'home'}));return;}
  el('p',source?'Pick up from the top. Place each CD on top of its destination pile.':target?`Put CDs for ${state.targetShelf} on its tape pile. Place the rest in final shelves.`:'Place each CD in its final shelf. No taping in this step.');
  button(source?'Sort into columns':target?'Sort target pile & final shelves':'Sort into final shelves',async()=>{await action('batch',{kind:source?'source':directColumn?'scan-column':'column',sourceId:view.id,column:view.column});render();}).focus();
}
function renderBatch(){
  const b=state.batch;
  if(b.kind==='tape'||b.kind==='tape-existing')return renderTapeBatch(b);
  const columns=b.kind==='source'||b.kind==='unassigned'||b.kind==='scan-sort'&&b.mode==='columns';
  screen.classList.add('compact-sort');
  if(b.kind==='scan-sort'){el('h2',columns?'Pass 1 · stack → columns':'Scan & Sort → final shelves');}
  else if (b.kind === 'source') {
    el('h2', `Sort ${state.sources.find(s=>s.id===b.sourceId)?.label} → columns`);
  } else if (b.kind === 'unassigned') {
    el('h2', 'Sort assigned stack → columns');
  } else {
    el(
      'h2',
      `Pass 2 · Column ${b.column} → ${b.mode==='target-shelf'?'target pile / final shelves':b.mode==='shelf-piles'?'shelf piles':'final shelves'}`
    );
  }
  el(
    'p',
    columns
      ? 'Top CD first · place each CD on its destination column pile, or in Set aside'
      : b.mode === 'target-shelf'
        ? 'Top CD first · target CDs go to the tape pile; all others go to final shelves'
        : b.mode === 'shelf-piles'
        ? 'Top CD first · place onto labeled shelf piles · tape later'
        : 'Top CD first · place in the final shelves, or in Set aside'
  );
  const output=el('div');output.className='batch-output';
  for(const group of SortingGuide.shelfRuns(b.rows,columns?'column':'shelf')) {
    const repeated=group.count>1;
    const wrap=el('div',undefined,output);wrap.className=repeated?'shelf-run':'single-run';
    if(repeated)el('div',`${group.count} CDs → ${columns?'column':'shelf'} ${group.shelf}`,wrap).className='run-label';
    for(let index=group.start;index<group.end;index++) {
      const i=b.rows[index], row=el('div',undefined,wrap);row.className='batch-row';
      el('div',String(index+1).padStart(2,'0'),row).className='batch-number';
      const dest=el('div',undefined,row);dest.className='batch-shelf';
      el('span',i.placement==='set-aside'?'SET ASIDE':columns?'COLUMN':i.placement==='shelf'||b.mode==='shelf-piles'?'TAPE PILE':'FINAL SHELF',dest).className='eyebrow';
      el('strong',i.placement==='set-aside'?'Set aside':String(i.destination),dest);
      const detail=el('div',undefined,row);detail.className='batch-detail';
      el('strong',i.album?`${i.album.artist||''} — ${i.album.title||''}`:'Unassigned',detail);
      el('small',i.barcode,detail);

    }
  }
  const next=button(`Placed these ${b.rows.length} CDs — continue (Enter)`,async()=>{
    await action('confirm');
    const remaining = state.items.some(i => {
      if (b.kind === 'source'||b.kind==='scan-sort') {
        return i.stage === 'source' && i.source_id === b.sourceId;
      }

      if (b.kind === 'unassigned') {
        return i.stage === 'unassigned';
      }

      return i.stage === 'column' && i.column_no === b.column;
    });
    if(remaining)await action('batch',{kind:b.kind,sourceId:b.sourceId,column:b.column});
    else view={type:'home'};
    render();
  });prepareBatchConfirm(next);screen.scrollIntoView({block:'start',behavior:'instant'});next.focus({preventScroll:true});
}
function renderTapeBatch(b){
  el('h2',`Primary tape · shelf ${b.shelf}`);
  const card=el('section');card.className='next taping-instruction';
  el('h3',b.kind==='tape-existing'?'Tape this CD':`Take the top ${b.rows.length} CDs`,card);renderTape(b.rows[0].album,card,true);
  el('p',`Apply the bottom (primary) tape. Then place these CDs on final shelf ${b.shelf}.`,card);
  const list=el('ol');list.className='taping-albums';
  for(const i of b.rows)el('li',`${i.album.artist} — ${i.album.title} · ${i.barcode}`,list);
  const next=button(`Primary taped & placed ${b.rows.length} CDs on ${b.shelf} (Enter)`,async()=>{
    await action('confirm');
    if(b.kind==='tape-existing'){view={type:'shelved'};render();return;}
    view={type:'shelf',shelf:b.shelf};
    if(state.items.some(i=>i.stage==='shelf'&&i.shelf_label===b.shelf))await action('batch',{kind:'tape',shelf:b.shelf});
    else view={type:'home'};
    render();
  });prepareBatchConfirm(next);screen.scrollIntoView({block:'start',behavior:'instant'});next.focus({preventScroll:true});
}
function renderShelved(){
  el('h2',`Already on shelf ${state.targetShelf}`);
  if(!state.alreadyShelved.length){el('p','No confirmed CDs here still need tape.');button('Continue',()=>go({type:'home'})).focus();return;}
  el('p',`${state.alreadyShelved.length} need tape. Scan one CD, tape it, and return it to this shelf.`);
  const f=form(async()=>{await action('tape-existing',{barcode:barcode.value});render();});
  const barcode=input('Barcode from this shelf','',f);submit('Show tape',f);
  const list=el('details');el('summary','CDs still needing tape',list);
  for(const a of state.alreadyShelved)el('p',`${a.artist} — ${a.title} · ${a.barcode}`,list);
  barcode.focus();
}
function renderTape(album,parent,primaryOnly=false) {
  const wrap=el('div',undefined,parent);wrap.className='tape-guide';
  if(!album){el('span','Tape after assignment',wrap).className='tape-note';return;}
  for(const [position,genre] of [['Bottom',album.primary_genre],['Top',album.secondary_genre]]) {
    if(primaryOnly&&position==='Top')continue;
    const tape=SortingGuide.tape(genre);
    const line=el('div',undefined,wrap);line.className='tape-line';
    if(tape?.hex){const swatch=el('span',undefined,line);swatch.className='swatch';swatch.style.backgroundColor=tape.hex;swatch.setAttribute('aria-hidden','true');}
    const label=tape?`${position} · ${tape.hex?tape.color:'check genre'}`:position==='Top'?'Top · no tape':'Bottom · check genre';
    el('span',label,line);
    line.title=tape?.genre|| (position==='Top'?'No secondary genre':'Missing primary genre');
    if((tape&&!tape.hex)||(!tape&&position==='Bottom'))line.classList.add('tape-review');
  }
}
function renderUnassigned() {
  const items = state.items.filter(i => i.stage === 'unassigned');

  if (!items.length) {
    view = {type:'home'};
    return render();
  }

  const unresolved = items.filter(i => !SortingGuide.finalShelf(i));
  const assignedCount = items.length - unresolved.length;

  el('span', 'SET ASIDE PILE', screen).className = 'eyebrow';
  el('h2', `${items.length} CDs`);

  el(
    'p',
    `${assignedCount} / ${items.length} ready to sort`
  );

  if (unresolved.length) {
    el(
      'p',
      `${unresolved.length} need an album assignment or valid final shelf in Shelf Lookup. Keep the physical stack together and in order.`
    );

    button(
      'Refresh assignments',
      async () => {
        await action('reconcile');
        render();
      }
    ).focus();

    button(
      'Back',
      () => go({type:'home'}),
      screen,
      true
    );

    return;
  }

  renderAssignedUnassigned(items);
}

function renderAssignedUnassigned(items) {
  el('span', 'SET ASIDE PILE', screen).className = 'eyebrow';
  el('h2', `${items.length} CDs assigned`);

  el(
    'p',
    'All barcodes are identified. Keep the stack together and sort it into columns.'
  );

  const preview = el('div');
  preview.className = 'assigned-preview';

  for (const i of items.slice(0, 5)) {
    const row = el('div', undefined, preview);
    row.className = 'assigned-preview-row';

    const dest = destination(i.album?.final_shelf);

    el('strong', i.album?.artist || 'Unknown artist', row);
    el('span', i.album?.title || 'Untitled', row);
    el(
      'small',
      `${i.barcode} · Column ${dest || '?'} · ${i.album?.final_shelf || '?'}`,
      row
    );
  }

  if (items.length > 5) {
    el('p', `+ ${items.length - 5} more`, preview);
  }

  button(
    'Sort this stack into columns',
    async () => {
      await action('batch', {kind:'unassigned'});
      render();
    }
  ).focus();
}

document.getElementById('home').onclick=()=>run(()=>go({type:'home'}));
run(async()=>{state=await request('/api/state');render();});

// Reuse the same color map as each CD's tape instructions.
for(const [genre,color,hex] of SortingGuide.colors) {
  const cell=el('div',undefined,document.getElementById('tape-chart'));cell.className='tape-key';
  const swatch=el('span',undefined,cell);swatch.className='swatch';swatch.style.backgroundColor=hex;swatch.setAttribute('aria-hidden','true');
  const words=el('div',undefined,cell);el('strong',genre,words);el('span',color,words);
}
async function startScanSort(){
  const source=state.sources.find(s=>s.id===randomSourceId&&s.status!=='complete')||state.sources.find(s=>s.label.startsWith('Scan & Sort ')&&s.status!=='complete');
  if(source)randomSourceId=source.id;else{await action('scan-sort');randomSourceId=state.openedSourceId;}
  scanOnly=true;view={type:'home'};render();
}

function prepareBatchConfirm(button){
  batchConfirm=button;
  const confirm=button.onclick;
  button.onclick=()=>{
    if(busy)return;
    const label=button.textContent;
    button.textContent='Saving…';
    button.setAttribute('aria-busy','true');
    Promise.resolve(confirm()).finally(()=>{
      if(button.isConnected){button.textContent=label;button.removeAttribute('aria-busy');}
    });
  };
}
document.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||!state?.batch||!batchConfirm||event.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  if(event.target.closest?.('input,select,textarea,[contenteditable="true"]'))return;
  event.preventDefault();
  if(event.repeat||enterHeld)return;
  enterHeld=true;
  if(!busy&&!batchConfirm.disabled)batchConfirm.click();
});
document.addEventListener('keyup',event=>{
  if(event.key==='Enter'&&enterHeld){event.preventDefault();enterHeld=false;}
});
window.addEventListener('blur',()=>{enterHeld=false;});
