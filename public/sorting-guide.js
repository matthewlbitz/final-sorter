/* Tape rules reused from the KTRU final sorter: primary = bottom, secondary = top. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SortingGuide = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
const colors = [
  ["Hip Hop", "red", "#d73535"],
  ["Jazz", "orange", "#ef8c25"],
  ["Rock", "yellow", "#f6d84b"],
  ["Classical/Stage & Screen", "light green", "#b8e698"],
  ["Folk/Country", "dark green", "#25723a"],
  ["Pop", "baby blue", "#a6d9f3"],
  ["Funk/Soul", "medium blue", "#367cdb"],
  ["Blues", "dark blue", "#203f8a"],
  ["World", "purple", "#8754b1"],
  ["Electronic", "pink", "#f493bc"],
  ["Reggae", "brown", "#885733"],
  ["Latin", "black", "#202020"],
  ["Brass & Military", "grey", "#92989e"],
  ["Non-Music", "white", "#ffffff"],
  ["Children's", "gold", "#c79c24"],
];
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
const aliases = Object.fromEntries(colors.map((c) => [norm(c[0]), c]));
for (const [a, i] of [
  ["folk", 4],
  ["country", 4],
  ["folkcountry", 4],
  ["folkworldcountry", 4],
  ["folkandcountry", 4],
  ["classical", 3],
  ["stageandscreen", 3],
  ["classicalstagescreen", 3],
  ["funk", 6],
  ["soul", 6],
  ["hiphop", 0],
  ["childrens", 14],
])
  aliases[a] = colors[i];
function tape(genre) {
  if (!String(genre || "").trim()) return null;
  const c = aliases[norm(genre)];
  return c
    ? { genre, color: c[1], hex: c[2] }
    : { genre, color: "REVIEW: unknown genre", hex: null };
}

function finalShelf(item) {
  const value = String(item.album?.final_shelf || '').trim().toUpperCase();
  const match = value.match(/^(\d{1,2})([A-Z])$/);
  return match && +match[1] >= 1 && +match[1] <= 32 ? `${+match[1]}${match[2]}` : null;
}
// Highlight physical neighbors only; never regroup or reorder the stack.
function shelfRuns(rows) {
  const runs = [];
  for (let start = 0; start < rows.length;) {
    const label = finalShelf(rows[start]);
    let end = start + 1;
    while (label && end < rows.length && finalShelf(rows[end]) === label) end++;
    runs.push({start, end, shelf: label, count: end - start});
    start = end;
  }
  return runs;
}
function tapeKey(album) {
  const bottom=tape(album?.primary_genre), top=tape(album?.secondary_genre);
  return JSON.stringify([bottom?.hex||`review:${album?.primary_genre||''}`,top?top.hex||`review:${top.genre}`:'none']);
}
function tapeSections(rows) {
  const sections=[];
  for(const item of rows) {
    const key=tapeKey(item.album),last=sections.at(-1);
    if(last?.key===key)last.count++;
    else sections.push({key,count:1,album:item.album});
  }
  return sections;
}
return {tape, tapeKey, tapeSections, colors, finalShelf, shelfRuns};
});
