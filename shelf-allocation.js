// Preserved canonical allocator from the original shelf-layout generator.
const GENRES = ['Hip Hop','Jazz','Rock','Classical/Stage&Screen','Folk & Country','Pop','Funk / Soul','Blues','World','Electronic','Reggae','Latin','Brass & Military','Non-Music',"Children's"];
const clean = v => String(v ?? '').trim();
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
function capacity(label) {
  const match = /^(\d+)([A-Z])$/.exec(label);
  if (!match || +match[1]<1 || +match[1]>32) throw Error(`Invalid shelf: ${label}`);
  const n = +match[1];
  if (n<=3 || (n>=6 && n<=12) || (n>=15 && n<=18)) return 30;
  if (n<=5 || label==='13A') return 60;
  if (n<=14 || n===28 || n===29) return 40;
  if (n===26 || n===27 || n===32) return 70;
  return 50;
}
function allocate(albums, labels=Object.keys(require('./shelf-capacities.json').capacities), capacities=require('./shelf-capacities.json').capacities) {
  const physical = label => capacities ? capacities[label] : capacity(label);
  if (labels.some(label=>!Number.isInteger(physical(label)) || physical(label)<=5)) throw Error("Invalid physical capacity");
  if (new Set(labels).size!==labels.length) throw Error('Duplicate shelf labels');
  const shelves = [...labels].sort((a,b)=>parseInt(a)-parseInt(b)||compare(a,b)).map(label=>({label, status:'REMAINING',primary_genre:null,secondary_genre:null,count:0,physical_capacity:physical(label),usable_capacity:physical(label)-5,albums:[]}));
  const excluded=[], valid=[], ids=new Set();
  for (const row of albums) {
    const reasons=[];
    if (row.id==null || ids.has(row.id)) throw Error(`Missing or duplicate album ID: ${row.id}`);
    ids.add(row.id);
    const primary=clean(row.primary_genre), secondary=clean(row.secondary_genre);
    if (!GENRES.includes(primary)) reasons.push(primary ? `Unrecognized/ambiguous primary genre: ${primary}` : 'Missing primary genre');
    if (secondary && !GENRES.includes(secondary)) reasons.push(`Unrecognized/ambiguous secondary genre: ${secondary}`);
    if (!clean(row.artist_sort) || clean(row.artist_sort)==='[Unknown artist]') reasons.push('Missing/unresolved artist-sort value');
    if (reasons.length) excluded.push({...row,reasons});
    else valid.push({...row,primary_genre:primary,secondary_genre:secondary===primary ? '' : secondary});
  }
  const rank = genre => GENRES.indexOf(genre);
  valid.sort((a,b)=>rank(a.primary_genre)-rank(b.primary_genre)||rank(a.secondary_genre)-rank(b.secondary_genre)||compare(clean(a.artist_sort).normalize('NFC').toLowerCase(),clean(b.artist_sort).normalize('NFC').toLowerCase())||compare(clean(a.title).normalize('NFC').toLowerCase(),clean(b.title).normalize('NFC').toLowerCase())||compare(a.id,b.id));
  const sections=[];
  for (const album of valid) {
    let section=sections.at(-1);
    if (!section || section.primary_genre!==album.primary_genre || section.secondary_genre!==album.secondary_genre) {
      section={primary_genre:album.primary_genre,secondary_genre:album.secondary_genre,albums:[]};sections.push(section);
    }
    section.albums.push(album);
  }
  const primaryGroups=[];
  for (const album of valid) {
    let group=primaryGroups.at(-1);
    if (!group || group.primary_genre!==album.primary_genre) {
      group={primary_genre:album.primary_genre,albums:[]};primaryGroups.push(group);
    }
    group.albums.push(album);
  }
  let cursor=0; const unplaced=[];
  primaryGroups.forEach(group=>{
    // Start each primary genre on a fresh shelf, but pack secondary sections continuously.
    let offset=0;
    while(offset<group.albums.length && cursor<shelves.length) {
      const shelf=shelves[cursor++];
      Object.assign(shelf,{status:'OCCUPIED',primary_genre:group.primary_genre,sections:[]});
      shelf.albums=group.albums.slice(offset,offset+shelf.usable_capacity);
      shelf.count=shelf.albums.length;offset+=shelf.count;
      shelf.albums.forEach((album,i)=>{
        let part=shelf.sections.at(-1);
        if (!part || part.secondary_genre!==album.secondary_genre) {
          part={secondary_genre:album.secondary_genre,start_position:i+1,end_position:i+1,count:0};
          shelf.sections.push(part);
        }
        part.count++;part.end_position=i+1;
      });
      shelf.secondary_genre=shelf.sections.length===1?shelf.sections[0].secondary_genre:null;
    }
    unplaced.push(...group.albums.slice(offset));
  });
  const occupied=shelves.filter(s=>s.status==='OCCUPIED').length, boundaries=shelves.filter(s=>s.status==='EMPTY BOUNDARY').length;
  return {summary:{albums_considered:albums.length,albums_eligible:valid.length,albums_placed:valid.length-unplaced.length,albums_excluded:excluded.length,albums_unplaced:unplaced.length,nonempty_sections:sections.length,nonempty_primary_genres:primaryGroups.length,occupied_shelves:occupied,boundary_shelves:boundaries,required_boundary_shelves:0,total_shelves_consumed:cursor,total_shelves:shelves.length,remaining_shelves:shelves.length-cursor,total_physical_capacity:shelves.reduce((n,s)=>n+s.physical_capacity,0),total_usable_capacity_before_boundaries:shelves.reduce((n,s)=>n+s.usable_capacity,0),eligible_layout_fits:unplaced.length===0,full_catalog_fits:excluded.length ? 'UNDETERMINED: excluded records require resolution' : unplaced.length===0},ordered_albums:valid,shelves,excluded,unplaced};
}

module.exports={allocate,GENRES};
