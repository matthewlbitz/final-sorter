/* Physical stack convention reused from shelf-lookup/batch-sort.js:
   each scan/placement goes on top; display the newest ten top-to-bottom. */
const screen=document.getElementById('screen'), message=document.getElementById('message');
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
async function startSource(label) {
  await action('source',{label});
  const source=state.sources.find(s=>s.id===state.openedSourceId);
  go({type:source.status==='saved'?'source':'scan',id:source.id});
}
async function startRecommendation(rec) {
  if(rec.type==='shelf')return startSource(rec.label.replace(/^Shelf\s+/i,''));
  go({type:'pull',recommendation:rec});
}
function render(){
  searchVersion++;screen.replaceChildren();document.getElementById('home').hidden=!!state.batch||view.type==='home';
  if(view.type==='handoff')return renderHandoff();
  if(state.batch)return renderBatch();
  if(view.type==='scan')return renderScan();
  if(view.type==='saved')return renderSaved();
  if(view.type==='shelf')return renderShelf();
  if(view.type==='shelved')return renderShelved();
  if(view.type==='source'||view.type==='column')return renderStack();
  if(view.type==='unassigned')return renderUnassigned();
  if(view.type==='pull')return renderPull(0);
  const priorities=state.handoff.targets||[];
  if(priorities.length&&!state.items.some(i=>i.stage!=='sorted')){
    const rec=priorities[0],box=el('section');box.className='next';
    el('h2',`Recommended next: ${rec.shelf}`,box);
    el('p',`${rec.expected} target CDs · ${rec.ready} already there · ${rec.pullCount} source shelves · ~${rec.handled} CDs to handle`,box);
    el('p',`${rec.coworker} additional coworker jobs · ${rec.excluded} unassigned / excluded target CDs`,box);
    button(`Choose ${rec.shelf}`,async()=>{await action('target',{shelf:rec.shelf});render();},box);
    const options=el('details',undefined,box);el('summary','Compare next targets',options);
    for(const r of priorities.slice(1,6))button(`${r.shelf} · ${r.expected} target CDs / ${r.pullCount} pulls / ~${r.handled} handled`,async()=>{await action('target',{shelf:r.shelf});render();},options,true);
    el('p','Estimated payoff per handling effort, not a timed route. Recalculates as CDs move. Keep clearing excluded backlog shelves separately.',options);
  }
  const f=form(async()=>{await action('target',{shelf:select.value});render();});f.className='target-picker';
  const targetLabel=el('label','Target shelf',f), select=el('select',undefined,targetLabel);
  for(const label of state.shelves){const option=el('option',label,select);option.value=label;option.selected=label===state.targetShelf;}
  submit('Choose shelf',f);
  const pass=state.handoff.passes.find(p=>p.shelf===state.targetShelf);
  const handoff=el('details');el('summary',`Initial passes & coworker handoff · ${state.handoff.queue.length} ready`,handoff);
  el('p',pass?`Initial pass completed ${new Date(pass.completed_at).toLocaleString()}`:'Initial pass not recorded for this target.',handoff);
  if(pass)button('Undo initial-pass mark',async()=>{await action('undo-pass',{shelf:state.targetShelf});render();},handoff,true);
  else {
    el('p','After all predicted pulls and primary tape are done, record your initial pass. Excluded and unassigned CDs may arrive later.',handoff);
    button('Mark initial pass complete',async()=>{await action('initial-pass');render();},handoff,true);
  }
  button('Open coworker handoff',()=>go({type:'handoff'}),handoff,true);
  el('p',`Visited: ${state.handoff.passes.map(p=>p.shelf).join(', ')||'None yet'}`,handoff);
  const saved=state.sources.filter(s=>s.status==='saved'&&s.count);
  const columnList=[...new Set(state.items.filter(i=>i.stage==='column').map(i=>i.column_no))].sort((a,b)=>(a===state.targetColumn)-(b===state.targetColumn)||b-a);
  const shelfList=[...new Set(state.items.filter(i=>i.stage==='shelf').map(i=>i.shelf_label))].sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  const hasSources=state.items.some(i=>i.stage==='source');
  if(!view.intake) {
    const work=el('section');work.className='next';
    if(saved.length){el('h2','Sort saved shelves → columns',work);el('p',`${saved.length} source stacks ready`,work);button('Start with '+saved[0].label,()=>go({type:'source',id:saved[0].id}),work);}
    else if(hasSources){const pending=state.sources.find(s=>s.status==='scanning'&&s.count);el('h2','Finish scanning '+pending.label,work);button('Resume scanning',()=>go({type:'scan',id:pending.id}),work);}
    else if(columnList.length){const c=columnList[0];el('h2',c===state.targetColumn?'Separate the target shelf':'Clear the other columns',work);el('p',c===state.targetColumn?`Shelf ${state.targetShelf} → tape pile; other CDs → final shelves`:'Place these CDs directly in their final shelves; tape the target shelf later.',work);button('Sort column '+c,()=>go({type:'column',column:c}),work);}
    else if(shelfList.length){el('h2','Tape a shelf pile',work);el('p','Select a shelf below. Tape one matching section at a time.',work);}
    else work.remove();
  }
  const rec=state.recommendations[0];
  const next=el((saved.length||columnList.length||shelfList.length)&&!view.intake?'details':'section');next.className='next';
  if(next.tagName==='DETAILS')el('summary','Scan another shelf',next);
    if (rec) {
    el('h2', 'Pull next: ' + rec.label, next);

    el(
      'p',
      `${rec.count} expected for shelf ${state.targetShelf}`,
      next
    );

    button(
      rec.type === 'shelf'
        ? `Scan ${rec.label}`
        : `Choose shelf in ${rec.label}`,
      () => startRecommendation(rec),
      next
    );
  }
  else {el('h2',state.remaining?'No remaining pull locations':'Primary pass ready',next);el('p',state.remaining?'Finish saved stacks or check the remaining catalog locations.':'All assigned CDs for this shelf are placed and have primary tape.',next);}
  el('p',`${state.remaining} assigned CDs left for primary pass · ${state.excludedUnassigned} unassigned excluded`,next);
  if(state.unavailable)el('p',`${state.unavailable} CDs are excluded from shelf predictions or have no usable location.`,next);
  if(state.recommendations.length>1){
    const pulls=el('details',undefined,next);el('summary',`All pull locations · ${state.recommendations.length}`,pulls);
    for(const location of state.recommendations){const row=el('div',undefined,pulls);row.className='location-row';el('span',`${location.label} · ${location.count} target CDs`,row);button('Pull',()=>startRecommendation(location),row,true);}
  }
  if(state.alreadyShelved.length){const here=el('section');here.className='next';el('h2',`Already on ${state.targetShelf} · ${state.alreadyShelved.length} need tape`,here);el('p','Confirmed final location. Tape these at the shelf without sorting them again.',here);button('Tape CDs already here',()=>go({type:'shelved'}),here);}
  if(state.inProgress.length){const progress=el('details');el('summary',`Target CDs already in working stacks · ${state.inProgress.reduce((n,g)=>n+g.count,0)}`,progress);for(const g of state.inProgress){const row=el('div',undefined,progress);row.className='location-row';el('span',`${g.label} · ${g.count}`,row);button('Open',()=>{if(g.stage==='source'){const source=state.sources.find(s=>s.id===g.sourceId);go({type:source.status==='scanning'?'scan':'source',id:g.sourceId});}else if(g.stage==='column')go({type:'column',column:g.column});else if(g.stage==='shelf')go({type:'shelf',shelf:g.shelf});else go({type:'unassigned'});},row,true);}}

  const open=state.sources.filter(s=>s.status!=='complete');
  if(open.length){const savedWork=el('details');el('summary','Source stacks · '+open.length,savedWork);for(const s of open)button(`${s.label} · ${s.count} CDs${s.status==='scanning'?' · scanning':''}`,()=>go({type:s.status==='scanning'?'scan':'source',id:s.id}),savedWork,true);}
  const columns=columnList;
  if(columns.length){el('h2','Column stacks');const wrap=el('div');wrap.className='columns';for(const c of columns)button(`${c}${c===state.targetColumn?' (target)':''} · ${state.items.filter(i=>i.stage==='column'&&i.column_no===c).length}`,()=>go({type:'column',column:c}),wrap,true);}
  if(shelfList.length){el('h2','Shelf piles · ready to tape');const wrap=el('div');wrap.className='columns';for(const label of shelfList)button(`${label} · ${state.items.filter(i=>i.stage==='shelf'&&i.shelf_label===label).length}`,()=>go({type:'shelf',shelf:label}),wrap,true);}
  const unknown=state.items.filter(i=>i.stage==='unassigned').length;
  if(unknown)button(`Unassigned · ${unknown}`,()=>go({type:'unassigned'}),screen,true);
  const d=el('details');el('summary','Choose another source shelf',d);
  const manual=form(async()=>{await startSource(label.value);},d);const label=input('Source shelf','',manual);submit('Scan shelf',manual);
  if(state.recommendations.length>1)el('p','Next: '+state.recommendations.slice(1,6).map(r=>`${r.label} (${r.count})`).join(' · '),d);
}

function renderPull() {
  const rec = view.recommendation;

  if (!rec) {
    go({type:'home'});
    return;
  }

  el('span', 'PULL LOCATION', screen).className = 'eyebrow';
  el('h2', rec.label);

  el(
    'p',
    `${rec.count} expected for target shelf ${state.targetShelf}.`
  );

  if (rec.type === 'column') {
    el(
      'p',
      `Choose the actual shelf you're pulling from in ${rec.label}.`
    );
  } else {
    el(
      'p',
      'This area is not shelf-accurate. Choose the actual shelf you physically pull.'
    );
  }

  const f = form(async () => {
    const label = shelfInput.value.trim().toUpperCase();

    if (!/^\d{1,2}[A-Z]$/.test(label)) {
      throw new Error('Enter a shelf like 19A or 22F.');
    }

    const column = Number(label.match(/^\d+/)[0]);

    // Make sure the shelf actually belongs to the recommended area.
    if (rec.key === 'section-19' && column !== 19) {
      throw new Error('Choose a shelf in Column 19.');
    }

    if (
      rec.key === 'section-21-23' &&
      (column < 21 || column > 23)
    ) {
      throw new Error('Choose a shelf in Columns 21–23.');
    }

    if (
      rec.key === 'unassigned-29-32' &&
      (column < 29 || column > 32)
    ) {
      throw new Error('Choose a shelf in Columns 29–32.');
    }

    if (
      rec.type === 'column' &&
      rec.key.startsWith('column-')
    ) {
      const expected = Number(rec.key.replace('column-', ''));

      if (column !== expected) {
        throw new Error(`Choose a shelf in Column ${expected}.`);
      }
    }

    await startSource(label);
  });

  const shelfInput = input('Actual shelf', '', f);
  shelfInput.placeholder = 'e.g. 19A';

  submit('Start scanning', f);

  button(
    'Back',
    () => go({type:'home'}),
    screen,
    true
  );

  shelfInput.focus();
}

function renderScan(){
  const s=state.sources.find(s=>s.id===view.id);if(!s||s.status!=='scanning'){view={type:'home'};return render();}
  el('h2','Scanning '+s.label);el('p','Place each scanned CD on top. Keep the stack in order.');
  const f=form(async()=>{const barcode=scan.value;await action('scan',{sourceId:s.id,barcode});render();});
  const scan=input('Barcode','',f);scan.id='barcode-input';submit('Add',f);
  const items=state.items.filter(i=>i.source_id===s.id&&i.stage==='source');el('h3',items.length+' scanned');
  if(items[0])el('p',`${items[0].barcode} · ${items[0].album?.title||'Unassigned'}`);
  if(items.length){button('Finish & save stack',async()=>{await action('save',{sourceId:s.id});go({type:'saved',id:s.id});});button('Remove last scan',async()=>{await action('remove',{sourceId:s.id});render();},screen,true);}
  scan.focus();
}
function renderSaved(){
  const s=state.sources.find(s=>s.id===view.id);
  el('h2',`${s?.label} saved`);el('p','Keep this stack separate and in order.');
  button('Scan another shelf',()=>go({type:'home',intake:true})).focus();
  button('Sort saved shelves into columns',()=>go({type:'source',id:s.id}),screen,true);
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
  const target=!source&&view.column===state.targetColumn;
  if(!source&&state.items.some(i=>i.stage==='source')){el('p','Finish scanning and sorting the source shelves first.');button('Back to saved work',()=>go({type:'home'}));return;}
  if(target&&state.items.some(i=>i.stage==='column'&&i.column_no!==state.targetColumn)){el('p','Clear the other column stacks first.');button('Back to columns',()=>go({type:'home'}));return;}
  el('p',source?'Pick up from the top. Place each CD on top of its destination pile.':target?`Put CDs for ${state.targetShelf} on its tape pile. Place the rest in final shelves.`:'Place each CD in its final shelf. No taping in this step.');
  button(source?'Sort into columns':target?'Sort target pile & final shelves':'Sort into final shelves',async()=>{await action('batch',{kind:source?'source':'column',sourceId:view.id,column:view.column});render();}).focus();
}
function renderBatch(){
  const b=state.batch;
  if(b.kind==='tape'||b.kind==='tape-existing')return renderTapeBatch(b);
  if (b.kind === 'source') {
    el('h2', `Sort ${state.sources.find(s=>s.id===b.sourceId)?.label} → columns`);
  } else if (b.kind === 'unassigned') {
    el('h2', 'Sort assigned stack → columns');
  } else {
    el(
      'h2',
      `Column ${b.column} → ${b.mode==='target-shelf'?'target pile / final shelves':b.mode==='shelf-piles'?'shelf piles':'final shelves'}`
    );
  }
  el(
    'p',
    b.kind === 'source' || b.kind === 'unassigned'
      ? 'Top CD first · place each CD on top of its destination column pile'
      : b.mode === 'target-shelf'
        ? 'Top CD first · target CDs go to the tape pile; all others go to final shelves'
        : b.mode === 'shelf-piles'
        ? 'Top CD first · place onto labeled shelf piles · tape later'
        : 'Top CD first · place in the final shelves'
  );
  const output=el('div');output.className='batch-output';
  for(const group of SortingGuide.shelfRuns(b.rows)) {
    const repeated=group.count>1;
    const wrap=el('div',undefined,output);wrap.className=repeated?'shelf-run':'single-run';
    if(repeated)el('div',`${group.count} CDs → shelf ${group.shelf}`,wrap).className='run-label';
    for(let index=group.start;index<group.end;index++) {
      const i=b.rows[index], row=el('div',undefined,wrap);row.className='batch-row';
      el('div',String(index+1).padStart(2,'0'),row).className='batch-number';
      const dest=el('div',undefined,row);dest.className='batch-shelf';
      el('span',b.kind==='source'||b.kind==='unassigned'?'COLUMN':i.placement==='shelf'||b.mode==='shelf-piles'?'TAPE PILE':'FINAL SHELF',dest).className='eyebrow';
      el('strong',String(i.destination),dest);
      if((b.kind === 'source' || b.kind === 'unassigned')&&group.shelf)el('small','Shelf '+group.shelf,dest);
      const detail=el('div',undefined,row);detail.className='batch-detail';
      el('strong',i.album?.title||'Unassigned',detail);
      if(i.album?.artist)el('span',i.album.artist,detail);
      el('small',i.barcode,detail);
      renderTape(i.album,row);
    }
  }
  const next=button(`Placed these ${b.rows.length} CDs — continue (Enter)`,async()=>{
    await action('confirm');
    const remaining = state.items.some(i => {
      if (b.kind === 'source') {
        return i.stage === 'source' && i.source_id === b.sourceId;
      }

      if (b.kind === 'unassigned') {
        return i.stage === 'unassigned';
      }

      return i.stage === 'column' && i.column_no === b.column;
    });
    if(remaining)await action('batch',{kind:b.kind,sourceId:b.sourceId,column:b.column});
    else {
      const another=b.kind==='source'&&state.sources.find(s=>s.status==='saved'&&s.count);
      view=another?{type:'source',id:another.id}:{type:'home'};
    }
    render();
  });screen.scrollIntoView({block:'start'});next.focus({preventScroll:true});
}
function renderTapeBatch(b){
  el('h2',`Primary tape · shelf ${b.shelf}`);
  const card=el('section');card.className='next taping-instruction';
  el('h3',b.kind==='tape-existing'?'Tape this CD':`Take the top ${b.rows.length} CDs`,card);renderTape(b.rows[0].album,card,true);
  el('p',`Apply the bottom (primary) tape only. Your coworker handles the review check and top tape. Then place these CDs on final shelf ${b.shelf}.`,card);
  const list=el('ol');list.className='taping-albums';
  for(const i of b.rows)el('li',`${i.album.artist} — ${i.album.title} · ${i.barcode}`,list);
  const next=button(`Primary taped & placed ${b.rows.length} CDs on ${b.shelf} (Enter)`,async()=>{
    await action('confirm');
    if(b.kind==='tape-existing'){view={type:'shelved'};render();return;}
    view={type:'shelf',shelf:b.shelf};
    if(state.items.some(i=>i.stage==='shelf'&&i.shelf_label===b.shelf))await action('batch',{kind:'tape',shelf:b.shelf});
    else view={type:'home'};
    render();
  });screen.scrollIntoView({block:'start'});next.focus({preventScroll:true});
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

  const unresolved = items.filter(i => !i.album);
  const assignedCount = items.length - unresolved.length;

  el('span', 'UNASSIGNED STACK', screen).className = 'eyebrow';
  el('h2', `${items.length} CDs`);

  el(
    'p',
    `${assignedCount} / ${items.length} assigned`
  );

  if (unresolved.length) {
    el(
      'p',
      `${unresolved.length} still need to be assigned in Shelf Lookup. Keep the physical stack together and in order.`
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
  el('span', 'UNASSIGNED STACK', screen).className = 'eyebrow';
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
document.getElementById('reset-form').onsubmit=e=>{
  e.preventDefault();run(async()=>{
    await action('reset',{confirmation:document.getElementById('reset-confirmation').value});
    document.getElementById('reset-confirmation').value='';
    document.getElementById('reset-result').textContent='Progress cleared. Backup saved: backups/'+state.resetBackup;
    view={type:'home'};render();
  });
};

function renderHandoff(){
  el('h2','Coworker handoff');
  el('p',`${state.handoff.queue.length} CDs ready on visited shelves. Refresh when new CDs arrive.`);
  button('Refresh handoff',async()=>{state=await request('/api/state');render();},screen,true);
  const f=form(async()=>{const a=state.handoff.queue.find(a=>String(a.barcode).trim()===barcode.value.trim());if(!a)throw Error('This barcode is not ready on a visited shelf. Refresh the handoff.');view.albumId=a.catalog_rowid;render();});
  const barcode=input('Scan barcode','',f);submit('Check CD',f);
  const a=state.handoff.queue.find(a=>a.catalog_rowid===view.albumId);
  if(a){
    const panel=el('section');panel.className='next';el('h3',`${a.final} · ${a.artist} — ${a.title}`,panel);renderTape(a,panel);
    el('p',a.primary?'Primary tape recorded. Check it is present.':'Primary tape needed — this CD has no recorded primary pass.',panel);
    const finish=form(async()=>{await action('coworker-finish',{barcode:a.barcode,hasReview:review.value==='yes',primaryConfirmed:primary.checked,secondaryConfirmed:secondary.checked});delete view.albumId;render();},panel);
    const primary=input('Primary tape is on this CD','',finish);primary.type='checkbox';primary.required=true;
    const secondary=input(a.secondary_genre?'Secondary tape is on this CD':'No secondary genre; no top tape needed','',finish);secondary.type='checkbox';secondary.required=true;
    const l=el('label','Does the CD have a review?',finish),review=el('select',undefined,l);review.required=true;
    for(const [value,text] of [['','Choose after checking'],['yes','Yes — review present'],['no','No — review absent']]){const o=el('option',text,review);o.value=value;}
    submit('Checked, taped & on final shelf',finish);
  }
  const list=el('details');el('summary','Ready shelves',list);
  for(const shelf of [...new Set(state.handoff.queue.map(a=>a.final))]){
    const q=state.handoff.queue.filter(a=>a.final===shelf);el('p',`${shelf} · ${q.length} ready · ${q.filter(a=>!a.primary).length} need primary tape`,list);
  }
  if(!a)barcode.focus();
}

document.getElementById('coworker').onclick=()=>run(async()=>{state=await request('/api/state');go({type:'handoff'});});
