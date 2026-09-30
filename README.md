# KTRU final sorter

Run `npm start` in this folder and open http://localhost:3000. `PORT` and `KTRU_DB` override the port and catalog file. Run `npm test` for the workflow checks.

## Target-shelf workflow

1. Select an exact **target shelf**, such as `18Q`.
2. Review **All pull locations**. Albums without barcodes are excluded from this retrieval list. You can still scan any source shelf manually while processing the unassigned/unsorted sections.
3. Scan each actual source shelf and save it as a separate stack. Put each newly scanned CD on top. Scans save immediately. Scanning identifies a working location; it does not claim final placement.
4. Sort saved source stacks into persistent destination-column piles, ten at a time. New arrivals go on top. Unknown barcodes go to Unassigned. Assign those in Shelf Lookup using this same catalog file, then use **Refresh assignments** and sort the identified stack into columns.
5. Clear other columns first, placing those CDs directly into their `final_shelf` without requiring tape. In the target's column, the display distinguishes **TAPE PILE** (the exact target shelf) from **FINAL SHELF** (other destinations, including other shelves in that same column). Already-taped CDs can go directly to their final shelf.
6. Open the target's persistent shelf pile. Apply primary (bottom) tape to consecutive CDs, up to ten at a time. Confirm primary taping and final placement. Secondary tape and review checks belong to the coworker handoff.
7. **Already on this shelf — needs tape** lists previously confirmed placements. Scan those CDs individually at the shelf, apply the displayed primary tape, and confirm their return. Their physical order is not assumed.

Choose a new target after finishing the working stacks. Completed sources can be opened again and completed CDs can be scanned again; active duplicates are blocked. An unobserved CD can still be predicted at a previously visited source because visiting the source does not prove its entire contents were found.

## Location rules

For assigned albums belonging to the exact target `final_shelf`:

- In a working source/column/shelf/Unassigned pile: show that known location immediately. Barcode assignments made outside this app are recognized for predictions even before reconciliation.
- `sorted = 1`: use the confirmed final shelf. If primary tape is missing, show an on-shelf primary tape job. Primary-complete CDs leave the initial-pass queue; full completion is tracked separately.
- Otherwise: estimate from `new_shelf_label`: only columns 9–18, 20, and 24–28 are trusted exact shelves. All other columns and missing labels are excluded from predictions and remain manual intake.
- No assigned barcode: exclude it from retrieval predictions and report the excluded count.

The app records `sorted_shelf` alongside confirmed placement. If the catalog's final destination changes later, the previous confirmed shelf remains the predicted physical location until that CD is moved again. A manually set `sorted = 1` without a recorded `sorted_shelf` is interpreted as an explicit assertion of placement at its current `final_shelf`.

## Progress and recovery

`rainbow_albums` now contains independent tracking fields:

- `scanned_at`: the CD was identified in a working stack.
- `sorted`, `sorted_at`, `sorted_shelf`: final placement was confirmed.
- `taped`, `taped_at`: the coworker confirmed primary tape, review presence/absence, and secondary tape (or no secondary genre). Legacy values are retained without assuming a review check.

Working pile membership and order remain in `catchall_items`. Scanning a previously placed CD moves it back into a working stack and clears its current placement flag; its existing tape status is retained. Removing the latest uncommitted scan restores that scan's prior tracking state.

A full SQLite backup is made before schema migration. Existing records, saved stacks, and open batches are retained. Legacy open batches finish according to their saved destinations. Do not run an old server version against the migrated database.

Refresh or restart to resume the exact displayed batch. If interrupted halfway, finish only the rows you have not yet moved before confirming the whole batch. Use one physical sorting operator at a time. Stale confirmations are rejected.

## Tape reference

**Tape colors** under the header shows the shared KTRU map. Bottom = primary genre; top = secondary genre. No secondary genre means no top tape. Same-shelf neighbors are highlighted without reordering; they can still require different secondary colors. Unrecognized tape genres must be corrected before a tape section can start.

## Resetting test progress

At the bottom, expand **Reset sorting progress**, type `RESET`, and choose **Back up & reset progress**. A full database backup must succeed first. Reset clears this workflow's scans, piles, batches, and assignment audit, and restores the catalog tracking values captured before this workflow touched each album. It keeps album content, barcode assignments, and the selected target shelf. Existing placement/tape flags that predated this workflow are preserved. This reset is for test progress, not for rearranging physical stacks.

To restore the entire backup, stop the app and restore `backups/before-reset-<id>.db` as `masterAlbums.db`. This restores all catalog content to that backup's point in time as well.

## Two-person handoff and station reports

After all predicted pulls and primary tape are done for the selected target, expand **Initial passes & coworker handoff** and choose **Mark initial pass complete**. This is explicit, not inferred from selecting a shelf. Remaining unassigned and excluded CDs may arrive later. Use **Undo initial-pass mark** to correct a mistaken mark.

Your coworker can use **Coworker** in the header without changing your sorting target, even while a sorting batch is open. Scan a ready CD, confirm primary tape, secondary tape (or none needed), and whether a review is present. A missing review is a checked result, not an incomplete check. Confirm only after the CD is on its final shelf. Later confirmed arrivals to a visited shelf appear automatically, including CDs needing primary tape. Refresh the handoff when new CDs arrive. Two clients can share the server; stale writes ask for a refresh and never silently override another confirmation.

**Download station report (.html)** creates a standalone, read-only HTML snapshot on demand, styled like ktru_stacks_map.html. It works offline, includes searchable shelf cards and handoff filters, and supports printing. It includes station totals, visited shelves and dates, ready coworker CDs and missing work, every target's location query and counts, primary/secondary genre splits, tape combinations, working piles, and historical source backlog. Completed CDs remain in the report's location query; the interactive pull list omits CDs already primary-taped at their final location. Save a report each day to compare snapshots. Reports do not send themselves to your coworker.

`catchall_passes` records initial passes and `catchall_finishing` records per-CD primary/secondary tape genre snapshots and review checks. A changed genre reopens the relevant tape task. Existing taped flags imply primary tape only; they never invent review checks. Reset clears these new tables alongside workflow progress. A consistent full backup precedes the additive migration.

## Unusable shelves

26P and 27P are excluded from destination allocation and old-location recommendations because CDs do not fit. Historical source labels remain intact. The catalog rejects new final-shelf assignments to either shelf. `shelf-capacities.json` preserves the allocation estimates and exclusions. The reallocation preserved the canonical genre/subgenre/artist/title order, fresh shelves for primary genres, and five reserved slots per shelf. Children’s now occupies 32M; 32N is spare. `shelf-reallocation-audit.json` lists every changed destination and the pre-change backup.

## Recommended targets

The home screen offers a recommended next target and up to five alternatives when no physical stacks are active. It never changes your target automatically. Ranking uses current location estimates and skips visited targets and unavailable CDs. It shows target yield, ready CDs, unique source pulls, estimated full-source handling, extra coworker jobs, and excluded target records. Unassigned records count toward source workload only, not guaranteed yield. Source estimates can omit unknown or misplaced CDs.

The relative score is (available target CDs + coworker weight × extra coworker jobs + 0.1 × future placements) / (20 × pulls + estimated source CDs handled + primary tape jobs + 1). Coworker weight is 0.5 with an empty queue and 0.25 otherwise. This is a heuristic, not a measured time estimate or optimal route. Keep manual backlog intake separate. Recalculate by refreshing after external assignments or another operator's changes.

The offline HTML report opens on ranked recommendations. Navigation separates shelf browsing, coworker handoff, backlog, locations, genre breakdowns, tape reference, and totals. The shelf browser shows one column at a time; search and status filters span all columns. Print exports the current view. Offline snapshots do not update themselves.
