# KTRU final sorter

Run `npm start` in this folder and open http://localhost:3001. `PORT` and `KTRU_DB` override the port and catalog file. Run `npm test` for the workflow checks.

## Target-shelf workflow

1. The default dropdown option is **Scan & Sort — no target shelf**. To use Target Sort, choose a shelf and press **Start**.
2. The page shows **Predicted shelves: […]** and one scan section for the first unfinished shelf. **Finish scanning** saves that stack and advances to the next shelf. Saved stacks remain below for sorting. An empty shelf can be marked empty to advance too. Albums without barcodes are excluded from this retrieval list. You can still scan any source shelf manually while processing the unassigned/unsorted sections.
3. Scan each actual source shelf and save it as a separate stack. Put each newly scanned CD on top. Scans save immediately. Scanning identifies a working location; it does not claim final placement.
4. Sort saved source stacks into persistent destination-column piles, ten at a time. New arrivals go on top. Unknown barcodes go to Unassigned. Assign those in Shelf Lookup using this same catalog file, then use **Refresh assignments** and sort the identified stack into columns.
5. Clear other columns first, placing those CDs directly into their `final_shelf` without requiring tape. In the target's column, the display distinguishes **TAPE PILE** (the exact target shelf) from **FINAL SHELF** (other destinations, including other shelves in that same column). Already-taped CDs can go directly to their final shelf.
6. Open the target's persistent shelf pile. Apply primary (bottom) tape to consecutive CDs, up to ten at a time. Confirm primary taping and final placement. This confirms primary tape only.
7. **Already on this shelf — needs tape** lists previously confirmed placements. Scan those CDs individually at the shelf, apply the displayed primary tape, and confirm their return. Their physical order is not assumed.

Choose a new target after finishing the working stacks. Completed sources can be opened again and completed CDs can be scanned again; active duplicates are blocked. After the source stack is fully processed, CDs not found in it have unknown locations until scanned again.

## Location rules

For assigned albums belonging to the exact target `final_shelf`:

- In a working source/column/shelf/Unassigned pile: show that known location immediately. Barcode assignments made outside this app are recognized for predictions even before reconciliation.
- `sorted = 1`: use the confirmed final shelf. If primary tape is missing, show an on-shelf primary tape job. Primary-complete CDs leave the initial-pass queue; full completion is tracked separately.
- Otherwise: use `new_shelf_label` only in columns 9–18, 20, and 24–28. Columns 1–8, 19, 21–23, and 29–32 are unknown until scanned. Confirmed placements remain known in any column.
- No assigned barcode: exclude it from retrieval predictions and report the excluded count.

The app records `sorted_shelf` alongside confirmed placement. If the catalog's final destination changes later, the previous confirmed shelf remains the predicted physical location until that CD is moved again. A manually set `sorted = 1` without a recorded `sorted_shelf` is interpreted as an explicit assertion of placement at its current `final_shelf`.

## Progress and recovery

`rainbow_albums` now contains independent tracking fields:

- `scanned_at`: the CD was identified in a working stack.
- `sorted`, `sorted_at`, `sorted_shelf`: final placement was confirmed.
- `taped`, `taped_at`: legacy tape flags retained without inventing review checks or secondary tape confirmation.

Working pile membership and order remain in `catchall_items`. Scanning a previously placed CD moves it back into a working stack and clears its current placement flag; its existing tape status is retained. Removing the latest uncommitted scan restores that scan's prior tracking state.

A full SQLite backup is made before schema migration. Existing records, saved stacks, and open batches are retained. Legacy open batches finish according to their saved destinations. Do not run an old server version against the migrated database.

Refresh or restart to resume the exact displayed batch. If interrupted halfway, finish only the rows you have not yet moved before confirming the whole batch. Use one physical sorting operator at a time. Stale confirmations are rejected.

## Tape reference

**Tape colors** under the header shows the shared KTRU map. Bottom = primary genre; top = secondary genre. No secondary genre means no top tape. Same-shelf neighbors are highlighted without reordering; they can still require different secondary colors. Unrecognized tape genres must be corrected before a tape section can start.

## Scan & Sort

Leave the target dropdown on **Scan & Sort — no target shelf**. The inline scanner is ready by default; choose a target shelf and press **Start** to switch to sequential source-shelf scanning. No target shelf or source label is required. Scan any physical stack, including columns 1–8, 19, and 21–23. Put each scanned CD on top, following the same stack convention as Target Sort. Use the inline **Scan CDs** box, then choose **Finish scanning** and **Sort this stack**. Pass 1 shows the top ten CDs with destination column numbers only. Place each on top of its column pile. After all source stacks are cleared, select a column pile for pass 2, which shows full destination shelf labels. Consecutive highlighting uses columns in pass 1 and exact shelves in pass 2. Confirm only after physically placing those CDs; continue until the stack is empty.

Scanning saves immediately, but never claims final placement. Pass 1 saves column-pile membership and order without claiming final placement. Confirming pass 2 writes `sorted=1`, `sorted_shelf`, and `sorted_at` in `rainbow_albums` and marks its `catchall_items` rows sorted. Target Sort uses that confirmed location rather than the old source estimate. Untaped CDs appear as on-shelf tape jobs. Tape and review completion are independent and are not asserted by Scan & Sort.

Unknown barcodes and invalid destinations block the affected batch. Correct them in Shelf Lookup using the shared database, then choose **Refresh assignments**. Saved stack order and open batches survive refresh/restart; duplicate active scans, stale confirmations, and destinations edited during an open batch are rejected. Scan & Sort resumes an existing unfinished session in the same inline section; after reloading, use **Resume** if needed. Target selection is preserved.

## Database and station reports

The default database remains `../data/masterAlbums.db` (relative to this project), shared with Shelf Lookup. `KTRU_DB` overrides it. Scan & Sort reuses the current version-3 database: Scan & Sort sessions use the existing source/item tables with uniquely labeled sources. No database is reset or replaced. Existing older-schema backup/migrations remain available.

The coworker interface and confirmation action have been removed, as has the reset interface and backend action. Historical `catchall_finishing`, initial passes, and catalog tracking values remain intact. Primary-tape tracking is still used by Target Sort.

Download the station report for one compact offline table: each target shelf, source shelves with CD counts, confirmed final placements, working stacks, unknown locations, and unassigned CDs. Totals show sorted CDs, in-progress CDs, and unknown locations. It uses the stacks map’s paper background, black header, bold type, and square borders, and prints without extra controls.

Update station application code, retain its live shared database, and restart the server. Check that `KTRU_DB`, if set, still points to that live database. Do not overwrite it with the Mac catalog or an older repository copy.

## Unusable shelves

26P and 27P are excluded from destination allocation and old-location recommendations because CDs do not fit. Historical source labels remain intact. The catalog rejects new final-shelf assignments to either shelf. `shelf-capacities.json` preserves the allocation estimates and exclusions. The reallocation preserved the canonical genre/subgenre/artist/title order, fresh shelves for primary genres, and five reserved slots per shelf. Children’s now occupies 32M; 32N is spare. `shelf-reallocation-audit.json` lists every changed destination and the pre-change backup.

## Source shelf list

There is no recommended-next-target ranking. The home screen lists every trusted catalog source shelf containing assigned CDs for the entered target, ordered by shelf label. Active stacks appear separately; confirmed CDs already on the target shelf are offered for primary tape only if needed. Confirmed placements at an older destination remain the known location after a catalog destination change. Offline reports show all target shelves in one table.

## Empty source shelves

After the last source batch is confirmed, CDs that were predicted at that source but were not found in the scanned stack are marked as having an unknown location. This includes CDs whose final destination is that shelf. They no longer appear in source pull lists or report location queries. Actual working stacks and subsequent confirmed placements take precedence. Scan and place a missing CD again to establish its location. Historical catalog source labels and album content remain intact.

An additive migration creates `catchall_unknown_locations(album_rowid, marked_at)` with a full database backup first. No catalog rows or existing tracking tables are replaced.
