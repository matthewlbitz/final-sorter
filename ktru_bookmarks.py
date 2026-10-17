#!/usr/bin/env python3
"""Create KTRU bookmark reports from SQLite. Python 3.9+, no packages required.

Usage: python3 ktru_bookmarks.py /path/to/masterAlbums.db
Run --help for options. The source database is opened read-only.
"""
import argparse
import csv
import hashlib
import itertools
import json
import re
import sqlite3
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

GENRES = ['Hip Hop', 'Jazz', 'Rock', 'Classical/Stage&Screen', 'Folk & Country',
          'Pop', 'Funk / Soul', 'Blues', 'World', 'Electronic', 'Reggae', 'Latin',
          'Brass & Military', 'Non-Music', "Children's"]
REQUIRED = ['primary_genre', 'secondary_genre', 'artist_sort', 'final_shelf']


def clean(v):
    return '' if v is None else str(v).strip()


def sort_text(v):
    # Same artist comparison as the final-sorter allocator: NFC + lowercase.
    return unicodedata.normalize('NFC', clean(v)).lower()


def genre_key(v):
    return (GENRES.index(v) if v in GENRES else len(GENRES), sort_text(v))


def section_key(k):
    return genre_key(k[0]), (-1, '') if not k[1] else genre_key(k[1])


def id_key(value):
    return (0, value) if isinstance(value, (int, float)) else (1, clean(value))


def shelf_key(v):
    m = re.fullmatch(r'(\d+)([A-Z])', v)
    return (0, int(m[1]), m[2]) if m else (1, 0, v)


def letter(v):
    # Preserve punctuation/numbers/non-Latin starts instead of silently moving artists.
    first = sort_text(v)[:1]
    return first.upper() if 'a' <= first <= 'z' else ('0–9' if first.isdigit() else 'Other')


def qi(name):
    return '"' + name.replace('"', '""') + '"'


def read_catalog(path, table):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as con:
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA query_only=ON')
        con.execute('BEGIN')
        schema = [dict(r) for r in con.execute('PRAGMA table_info(' + qi(table) + ')')]
        columns = {r['name'] for r in schema}
        missing = set(REQUIRED) - columns
        if missing:
            tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            raise ValueError(f'Table {table!r} missing fields: {sorted(missing)}. Tables: {tables}')
        selected = REQUIRED + [v for v in ['id', 'artist', 'title', 'barcode'] if v in columns]
        rows = [dict(r) for r in con.execute('SELECT ' + ','.join(map(qi, selected)) + ' FROM ' + qi(table))]
    for i, row in enumerate(rows, 1):
        row['source_record'] = i
        for key in selected:
            if key != 'id':
                row[key] = clean(row[key])
    return rows, schema


def partition_letters(rows, target, minimum):
    """Optimal contiguous groups of whole letter runs; never split one artist/letter.

    Penalize short ranges heavily. A large single letter is allowed to exceed target.
    Nonstandard initials stay in their actual sorted positions, in separate runs.
    """
    runs = [list(g) for _, g in itertools.groupby(rows, lambda r: letter(r['artist_sort']))]
    n = len(runs)
    if not n:
        return []
    sums = [0]
    for run in runs:
        sums.append(sums[-1] + len(run))
    best = [(float('inf'), []) for _ in range(n + 1)]
    best[0] = (0, [])
    for end in range(1, n + 1):
        for start in range(end):
            count = sums[end] - sums[start]
            cost = ((count - target) / target) ** 2 + 0.15
            if count < minimum:
                cost += 10 * ((minimum - count) / minimum) ** 2
            proposal = best[start][0] + cost
            if proposal < best[end][0]:
                best[end] = proposal, best[start][1] + [(start, end)]
    return [list(itertools.chain.from_iterable(runs[a:b])) for a, b in best[n][1]]


def xml_text(v):
    # XML 1.0 cannot contain most control characters.
    return escape(re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]', '', str(v)))


def col(n):
    s = ''
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def write_xlsx(path, datasets):
    """Minimal standard-library OOXML writer: typed counts, filters, frozen headers.

    All text uses inline strings, so artist names can never become Excel formulas.
    """
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        overrides = ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(datasets)+1))
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + overrides + '</Types>')
        z.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        sheets = ''.join(f'<sheet name="{xml_text(name)}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _, _) in enumerate(datasets, 1))
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheets}</sheets></workbook>')
        rels = ''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(datasets)+1))
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        z.writestr('xl/styles.xml', f'<styleSheet xmlns="{ns}"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF264653"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
        for i, (_, headers, rows) in enumerate(datasets, 1):
            matrix = [headers] + [[r.get(h, '') for h in headers] for r in rows]
            if len(matrix) > 1048576:
                raise ValueError('Too many records for one Excel worksheet')
            widths = [min(65, max(14, max(len(str(row[j])) for row in matrix) + 2)) for j in range(len(headers))]
            cols = ''.join(f'<col min="{j}" max="{j}" width="{w}" customWidth="1"/>' for j, w in enumerate(widths, 1))
            body = []
            for rn, row in enumerate(matrix, 1):
                cells = []
                for cn, value in enumerate(row, 1):
                    ref = f'{col(cn)}{rn}'
                    style = ' s="1"' if rn == 1 else ''
                    if isinstance(value, (int, float)):
                        cells.append(f'<c r="{ref}"{style}><v>{value}</v></c>')
                    else:
                        cells.append(f'<c r="{ref}" t="inlineStr"{style}><is><t xml:space="preserve">{xml_text(value)}</t></is></c>')
                body.append(f'<row r="{rn}">' + ''.join(cells) + '</row>')
            end = f'{col(len(headers))}{len(matrix)}'
            z.writestr(f'xl/worksheets/sheet{i}.xml', f'<worksheet xmlns="{ns}"><dimension ref="A1:{end}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>{cols}</cols><sheetData>' + ''.join(body) + f'</sheetData><autoFilter ref="A1:{end}"/></worksheet>')


def build(rows, target, minimum):
    sections = defaultdict(list)
    issues = []
    for row in rows:
        reasons = []
        if not row['primary_genre']:
            reasons.append('Missing primary genre')
        if not row['artist_sort'] or row['artist_sort'] == '[Unknown artist]':
            reasons.append('Missing/unresolved artist_sort')
        if not re.fullmatch(r'(?:[1-9]|[12]\d|3[0-2])[A-Z]', row['final_shelf']):
            reasons.append('Missing/invalid final_shelf')
        if row['final_shelf'] in ('26P', '27P'):
            reasons.append('Excluded shelf 26P/27P: verify source is current')
        row['issues'] = '; '.join(reasons)
        if reasons:
            issues.append(row)
        # All catalog rows remain in totals; only unresolved rows skip placement advice.
        sections[row['primary_genre'], row['secondary_genre']].append(row)

    recommendations, placements, detail, section_summary, catalog = [], [], [], [], []
    bookmark_id = 0
    positions = Counter()
    for key in sorted(sections, key=section_key):
        group = sorted(sections[key], key=lambda r: (sort_text(r['artist_sort']), sort_text(r.get('title')), id_key(r.get('id')), r['source_record']))
        for row in group:
            positions[row['final_shelf']] += 1
            row['expected_shelf_position'] = positions[row['final_shelf']]
        catalog.extend(group)
        p, s = key
        section_summary.append(dict(primary_genre=p, secondary_genre=s, cd_count=len(group), shelves=', '.join(sorted({r['final_shelf'] or '[unassigned]' for r in group}, key=shelf_key)), unresolved_count=sum(bool(r['issues']) for r in group)))
        counts = defaultdict(list)
        for row in group:
            counts[row['final_shelf'], letter(row['artist_sort'])].append(row)
        for (shelf, initial), part in sorted(counts.items(), key=lambda v: (shelf_key(v[0][0]), sort_text(v[1][0]['artist_sort']))):
            detail.append(dict(primary_genre=p, secondary_genre=s, artist_sort_letter=initial, final_shelf=shelf, cd_count=len(part), first_artist_sort=part[0]['artist_sort'], last_artist_sort=part[-1]['artist_sort']))
        eligible = [r for r in group if not r['issues']]
        for chunk_index, part in enumerate(partition_letters(eligible, target, minimum)):
            bookmark_id += 1
            ident = f'B{bookmark_id:04d}'
            initials = list(dict.fromkeys(letter(r['artist_sort']) for r in part))
            label = initials[0] if len(initials) == 1 else initials[0] + '–' + initials[-1]
            if 'Other' in initials or '0–9' in initials:
                label = ', '.join(initials)
            shelves = sorted({r['final_shelf'] for r in part}, key=shelf_key)
            notes = []
            if len(part) < minimum:
                notes.append('Small section: keep genre/subgenre label; no extra letter divider')
            if len(part) > target and len(initials) == 1:
                notes.append('Dense single letter: use shelf continuation labels; no artist split proposed')
            recommendations.append(dict(bookmark_id=ident, primary_genre=p, secondary_genre=s, letter_range=label, cd_count=len(part), shelves=', '.join(shelves), first_artist_sort=part[0]['artist_sort'], last_artist_sort=part[-1]['artist_sort'], boundary='Genre/subgenre start' if chunk_index == 0 else 'Letter range start', notes='; '.join(notes)))
            for shelf in shelves:
                subset = [r for r in part if r['final_shelf'] == shelf]
                first, last = subset[0], subset[-1]
                placements.append(dict(bookmark_id=ident, primary_genre=p, secondary_genre=s, letter_range=label, final_shelf=shelf, cd_count=len(subset), insert_before_artist_sort=first['artist_sort'], insert_before_title=first.get('title', ''), insert_before_id=first.get('id', ''), expected_shelf_position=first['expected_shelf_position'], last_artist_sort=last['artist_sort'], label_type='Section/range start' if first is part[0] else 'Shelf continuation'))
    assert sum(r['cd_count'] for r in detail) == len(rows)
    assert sum(r['cd_count'] for r in section_summary) == len(rows)
    assert sum(r['cd_count'] for r in recommendations) + len(issues) == len(rows)
    assert sum(r['cd_count'] for r in placements) + len(issues) == len(rows)
    shelf_counts = Counter(r['final_shelf'] for r in rows)
    shelf_summary = [dict(final_shelf=s, cd_count=n) for s, n in sorted(shelf_counts.items(), key=lambda v: shelf_key(v[0]))]
    return recommendations, placements, detail, section_summary, shelf_summary, catalog, issues


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('database', nargs='?', type=Path, default=Path('masterAlbums.db'))
    parser.add_argument('--out', type=Path, help='New output directory (must not already exist)')
    parser.add_argument('--table', default='rainbow_albums')
    parser.add_argument('--target', type=int, default=60, help='Preferred CDs per letter range (default 60)')
    parser.add_argument('--minimum', type=int, default=25, help='Discourage smaller ranges (default 25)')
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error(f'Database not found: {args.database}. Supply its full path.')
    if args.minimum < 1 or args.target < args.minimum:
        parser.error('Require 1 <= minimum <= target')
    rows, schema = read_catalog(args.database, args.table)
    if not rows:
        raise ValueError('Catalog is empty; no reports generated')
    result = build(rows, args.target, args.minimum)
    names = ['Bookmark ranges', 'Shelf placements', 'Letter detail', 'Genre sections', 'Shelf totals', 'Catalog', 'Needs review']
    headers = [
        ['bookmark_id','primary_genre','secondary_genre','letter_range','cd_count','shelves','first_artist_sort','last_artist_sort','boundary','notes'],
        ['bookmark_id','primary_genre','secondary_genre','letter_range','final_shelf','cd_count','insert_before_artist_sort','insert_before_title','insert_before_id','expected_shelf_position','last_artist_sort','label_type'],
        ['primary_genre','secondary_genre','artist_sort_letter','final_shelf','cd_count','first_artist_sort','last_artist_sort'],
        ['primary_genre','secondary_genre','cd_count','shelves','unresolved_count'],
        ['final_shelf','cd_count'],
        ['source_record','id','barcode','artist','title','primary_genre','secondary_genre','artist_sort','final_shelf','expected_shelf_position','issues'],
        ['source_record','id','artist','title','primary_genre','secondary_genre','artist_sort','final_shelf','issues']]
    out = args.out or Path('ktru_bookmarks_' + datetime.now().strftime('%Y%m%d_%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    summary = [
        f'KTRU bookmark report — {datetime.now(timezone.utc).isoformat()}',
        f'Source: {args.database.resolve()} / {args.table}',
        f'Catalog records: {len(rows):,}',
        f'Genre/subgenre sections: {len(result[3]):,}',
        f'Recommended letter ranges: {len(result[0]):,}',
        f'Physical placement labels including shelf continuations: {len(result[1]):,}',
        f'Records needing review (excluded from recommendations): {len(result[6]):,}',
        '',
        'Place each label immediately before the artist/title/ID listed in Shelf placements.',
        'Shelf continuation labels repeat a range on another shelf. They are optional navigation aids.',
        f'Ranges aim for {args.target} catalog records and discourage fewer than {args.minimum}.',
        'Every primary/secondary genre boundary gets a label, even for a small section.',
        'A blank secondary genre means no secondary genre. Equal primary/secondary values are preserved.',
        'Whole letter runs stay together. A dense single letter may exceed the target.',
        'Artist order uses the existing artist_sort (NFC, lowercase), then title and ID.',
        'No articles or punctuation are removed. Numbers and non-A–Z starts are reported explicitly.',
        'Expected positions assume each shelf is in canonical genre/subgenre/artist order.',
        'Shelf assignments come directly from final_shelf; this script never reallocates CDs.',
        'Counts mean database records, assuming one catalog row per CD/case. Multi-disc sets are not expanded.',
        'No barcode filter or ID deduplication is applied; the complete catalog is included.',
        'Detailed tables include unresolved rows, but placement recommendations exclude them.',
        'CSV text starting with =, +, -, or @ is prefixed with an apostrophe for spreadsheet safety.',
        'The XLSX preserves original strings as literal text. Reports are static; rerun after catalog changes.',
        '', 'Primary genre totals:']
    totals = Counter(r['primary_genre'] or '[missing]' for r in rows)
    summary.extend(f'  {g}: {totals[g]:,}' for g in sorted(totals, key=genre_key))
    summary.extend(['', 'Review reasons:'] + [f'  {reason}: {n:,}' for reason, n in Counter(reason for r in result[6] for reason in r['issues'].split('; ')).most_common()])
    datasets = [('Summary', ['item'], [{'item': line} for line in summary])]
    for name, fields, records in zip(names, headers, result):
        datasets.append((name, fields, records))
        with (out / (name.lower().replace(' ', '_') + '.csv')).open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(fields)
            for record in records:
                values = [record.get(h, '') for h in fields]
                writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in values])
    write_xlsx(out / 'ktru_bookmarks.xlsx', datasets)
    (out / 'summary.txt').write_text('\n'.join(summary) + '\n', encoding='utf-8')
    metadata = dict(source=str(args.database.resolve()), generated_utc=datetime.now(timezone.utc).isoformat(), table=args.table, schema=schema, record_count=len(rows), target=args.target, minimum=args.minimum, records_sha256=hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest())
    (out / 'source_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    print('\n'.join(summary[:8]))
    print(f'\nReports saved to: {out.resolve()}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, sqlite3.Error, OSError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)
