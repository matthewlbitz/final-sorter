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
function render(){
  searchVersion++;screen.replaceChildren();document.getElementById('home').hidden=!!state.batch||view.type==='home';
  if(state.batch)return renderBatch();
  if(view.type==='scan')return renderScan();
  if(view.type==='saved')return renderSaved();
  if(view.type==='shelf')return renderShelf();
  if(view.type==='source'||view.type==='column')return renderStack();
  if(view.type==='unassigned')return renderUnassigned();
  const f=form(async()=>{await action('target',{column:Number(select.value)});render();});f.className='target-picker';
  const targetLabel=el('label','Target column',f), select=el('select',undefined,targetLabel);
  for(let c=32;c>=1;c--){const option=el('option','Column '+c,select);option.value=c;option.selected=c===state.targetColumn;}
  submit('Choose column',f);
  const saved=state.sources.filter(s=>s.status==='saved'&&s.count);
  const columnList=[...new Set(state.items.filter(i=>i.stage==='column').map(i=>i.column_no))].sort((a,b)=>(a===state.targetColumn)-(b===state.targetColumn)||b-a);
  const shelfList=[...new Set(state.items.filter(i=>i.stage==='shelf').map(i=>i.shelf_label))].sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  const hasSources=state.items.some(i=>i.stage==='source');
  if(!view.intake) {
    const work=el('section');work.className='next';
    if(saved.length){el('h2','Sort saved shelves → columns',work);el('p',`${saved.length} source stacks ready`,work);button('Start with '+saved[0].label,()=>go({type:'source',id:saved[0].id}),work);}
    else if(hasSources){const pending=state.sources.find(s=>s.status==='scanning'&&s.count);el('h2','Finish scanning '+pending.label,work);button('Resume scanning',()=>go({type:'scan',id:pending.id}),work);}
    else if(columnList.length){const c=columnList[0];el('h2',c===state.targetColumn?'Build target shelf piles':'Clear the other columns',work);el('p',c===state.targetColumn?`Column ${c} → persistent shelf piles`:'Place these CDs directly in their final shelves; tape the target column later.',work);button('Sort column '+c,()=>go({type:'column',column:c}),work);}
    else if(shelfList.length){el('h2','Tape a shelf pile',work);el('p','Select a shelf below. Tape one matching section at a time.',work);}
    else work.remove();
  }
  const rec=state.recommendations[0];
  const next=el((saved.length||columnList.length||shelfList.length)&&!view.intake?'details':'section');next.className='next';
  if(next.tagName==='DETAILS')el('summary','Scan another shelf',next);
  if(rec){el('h2','Pull next: '+rec.label,next);el('p',`${rec.count} expected in column ${state.targetColumn}`,next);const existing=state.sources.find(s=>s.label===rec.label&&s.status==='scanning');button((existing?'Resume ':'Scan ')+rec.label,async()=>{if(!existing)await action('source',{label:rec.label});go({type:'scan',id:existing?.id||state.sources[0].id});},next);}
  else {el('h2',state.remaining?'No new source shelves for this column':'Column complete',next);el('p',state.remaining?'Finish saved stacks or check the remaining catalog locations.':'Every catalog album in this column has reached its final shelf.',next);}
  el('p',`${state.remaining} remaining in column ${state.targetColumn}${state.unavailable?' · '+state.unavailable+' not found on processed shelves or missing a source location':''}`,next);
  const open=state.sources.filter(s=>s.status!=='complete');
  if(open.length){const savedWork=el('details');el('summary','Source stacks · '+open.length,savedWork);for(const s of open)button(`${s.label} · ${s.count} CDs${s.status==='scanning'?' · scanning':''}`,()=>go({type:s.status==='scanning'?'scan':'source',id:s.id}),savedWork,true);}
  const columns=columnList;
  if(columns.length){el('h2','Column stacks');const wrap=el('div');wrap.className='columns';for(const c of columns)button(`${c}${c===state.targetColumn?' (target)':''} · ${state.items.filter(i=>i.stage==='column'&&i.column_no===c).length}`,()=>go({type:'column',column:c}),wrap,true);}
  if(shelfList.length){el('h2','Shelf piles · ready to tape');const wrap=el('div');wrap.className='columns';for(const label of shelfList)button(`${label} · ${state.items.filter(i=>i.stage==='shelf'&&i.shelf_label===label).length}`,()=>go({type:'shelf',shelf:label}),wrap,true);}
  const unknown=state.items.filter(i=>i.stage==='unassigned').length;
  if(unknown)button(`Unassigned · ${unknown}`,()=>go({type:'unassigned'}),screen,true);
  const d=el('details');el('summary','Choose another source shelf',d);
  const manual=form(async()=>{await action('source',{label:label.value});go({type:'scan',id:state.sources[0].id});},d);const label=input('Source shelf','',manual);submit('Scan shelf',manual);
  if(state.recommendations.length>1)el('p','Next: '+state.recommendations.slice(1,6).map(r=>`${r.label} (${r.count})`).join(' · '),d);
}
function renderScan(){
  const s=state.sources.find(s=>s.id===view.id);if(!s||s.status!=='scanning'){view={type:'home'};return render();}
  el('h2','Scanning '+s.label);el('p','Place each scanned CD on top. Keep the stack in order.');
  const f=form(async()=>{const barcode=scan.value;await action('scan',{sourceId:s.id,barcode});render();});
  const scan=input('Barcode','',f);scan.id='barcode-input';submit('Add',f);
  const items=state.items.filter(i=>i.source_id===s.id);el('h3',items.length+' scanned');
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
  el('p',source?'Pick up from the top. Place each CD on top of its destination pile.':target?'Place each CD on top of its labeled shelf pile. Tape these later.':'Place each CD in its final shelf. No taping in this step.');
  button(source?'Sort into columns':target?'Build shelf piles':'Sort into final shelves',async()=>{await action('batch',{kind:source?'source':'column',sourceId:view.id,column:view.column});render();}).focus();
}
function renderBatch(){
  const b=state.batch;
  if (b.kind === 'source') {
    el('h2', `Sort ${state.sources.find(s=>s.id===b.sourceId)?.label} → columns`);
  } else if (b.kind === 'unassigned') {
    el('h2', 'Sort assigned stack → columns');
  } else {
    el(
      'h2',
      `Column ${b.column} → ${b.mode==='shelf-piles'?'shelf piles':'final shelves'}`
    );
  }
  el(
    'p',
    b.kind === 'source' || b.kind === 'unassigned'
      ? 'Top CD first · place each CD on top of its destination column pile'
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
      el('span',b.kind==='source'?'COLUMN':'SHELF',dest).className='eyebrow';
      el('strong',String(i.destination),dest);
      if(b.kind === 'source' || b.kind === 'unassigned'&&group.shelf)el('small','Shelf '+group.shelf,dest);
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
  el('h2',`Tape shelf ${b.shelf}`);
  const card=el('section');card.className='next taping-instruction';
  el('h3',`Take the top ${b.rows.length} CDs`,card);renderTape(b.rows[0].album,card);
  el('p',`Apply this combination to every CD below, then place them on final shelf ${b.shelf}.`,card);
  const list=el('ol');list.className='taping-albums';
  for(const i of b.rows)el('li',`${i.album.artist} — ${i.album.title} · ${i.barcode}`,list);
  const next=button(`Taped & placed ${b.rows.length} CDs on ${b.shelf} (Enter)`,async()=>{
    await action('confirm');
    view={type:'shelf',shelf:b.shelf};
    if(state.items.some(i=>i.stage==='shelf'&&i.shelf_label===b.shelf))await action('batch',{kind:'tape',shelf:b.shelf});
    else view={type:'home'};
    render();
  });screen.scrollIntoView({block:'start'});next.focus({preventScroll:true});
}
function renderTape(album,parent) {
  const wrap=el('div',undefined,parent);wrap.className='tape-guide';
  if(!album){el('span','Tape after assignment',wrap).className='tape-note';return;}
  for(const [position,genre] of [['Bottom',album.primary_genre],['Top',album.secondary_genre]]) {
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
