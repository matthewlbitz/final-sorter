# KTRU final sorter

Run `npm start` in this folder, then open http://localhost:3000. Run `npm test` for workflow checks. `PORT` and `KTRU_DB` can override the port and catalog path.

1. Choose a target column (32 down to 1). Recommendations prioritize the highest final shelf, then the number of expected CDs, using `new_shelf_label` as the likely source.
2. Scan the whole source shelf, placing each scanned CD on top of the stack. Unknown barcodes are accepted. Every scan is saved immediately; **Finish & save stack** closes scanning.
3. Sort the displayed rows top to bottom, up to 10 CDs at a time. Put each CD on top of its numbered column pile or Unassigned. Confirm only after placing the whole displayed batch.
4. Keep each numbered pile intact across source shelves. New arrivals go on top. Use **Unassigned** to search artist/title, confirm the album, then confirm placement onto its column pile.
5. Open a column and sort into final shelves. Only the final placement confirmation marks these CDs sorted.

Refresh or restart to resume. An open batch is frozen until confirmed. If you stop halfway through a batch, leave the displayed rows in place and finish the remaining rows before confirming. Do not place the already moved rows again after refresh. Use one physical sorting operator at a time; stale browser actions are rejected.

The catalog schema is inspected at startup. Before the first migration a consistent full SQLite backup is saved in `backups/before-catchall-*.db`. The migration adds only `catchall_*` tables. Existing catalog rows are preserved. Barcode assignment updates `rainbow_albums.barcode` and `assigned_at` with a transaction and an assignment audit record. Sorted state is stored in `catchall_items.stage` and `sorted_at`; no speculative sorted flags are added to catalog albums.

Saved or completed source shelves are not recommended again. Incomplete scanning shelves can be recommended with Resume so opening a shelf does not hide unfinished work. Albums already in the workflow are also excluded from recommendations. The remaining count still includes CDs in intermediate piles and catalog albums missing from a processed shelf. This does not claim a column complete until all its catalog albums have reached final shelves. Duplicate barcodes are blocked rather than silently counting one CD twice.

Physical placement follows the original shelf-lookup batch sorter's reversal convention. Source scan order is reversed to consume the top first; confirmed arrivals are appended in placement order, so each persistent column is again consumed newest first. Catalog destination changes are blocked during column-batch creation if they no longer match the physical column.

The old app's unsaved browser-memory stacks cannot be recovered automatically; save/record those before reloading an old tab. Albums absent from the catalog, or without a valid final shelf, stay Unassigned until the catalog is corrected. Keep the database and its backups together when moving machines; do not replace it with a fresh catalog after starting work.

## Visual sorting guide

The interface uses the black, goldenrod, and Courier styling from the other KTRU apps. Adjacent CDs with the exact same final shelf share a gold outline and a count label in both sorting stages. They stay in physical order; CDs going to different shelves in the same column are not grouped. Groups describe the current page of up to 10 CDs.

Each known CD shows a labeled swatch for bottom tape (primary genre) and top tape (secondary genre), using the existing KTRU tape map. No secondary genre means no top tape. Missing or unrecognized genres say “check genre”; no color is guessed. Apply tape before confirming final-shelf placement. Same-shelf highlighting does not imply identical secondary tape.

The selected column is saved using the existing target settings, so this update requires no database schema migration. An old range defaults to its highest column. Existing scans, stacks, and sorted records are preserved.

## Resetting test progress

Open **Reset sorting progress** at the bottom of the page, type `RESET`, then choose **Back up & reset progress**. This clears scans, source stacks, column piles, active batches, sorted marks, and this workflow's assignment audit history. It preserves the selected target column and all catalog records, including barcode assignments. A full consistent database backup is written to `backups/before-reset-<unique-id>.db` before clearing anything; a failed backup prevents the reset. To recover a reset, stop the app and restore that full backup as `masterAlbums.db` (this also restores the catalog to that backup's point in time).

Open **Tape colors** under the header for the compact genre/color chart. Bottom tape is the primary genre; top tape is the secondary genre. No secondary genre means no top tape.
