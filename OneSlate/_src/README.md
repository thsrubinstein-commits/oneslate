# OneSlate `_src`: editable source for the site

This folder is the source of truth. Two things get built from it:

- `index.html` + `assets/` (repo root): what GitHub Pages serves. A normal HTML page with
  fonts and JS as separate, content-hashed files, so they're cached and the page loads fast.
- `single.html` (repo root): the same app as one self-contained Claude Design bundle, for
  offline use or a native app that wants a single file.

- `template.html` — the whole app (inline CSS + the `<x-dc>` markup + the `text/x-dc`
  logic script). **This is the file you edit.**
- `shell_head.html` / `shell_tail.html` — page title/icons and the iOS notifications script
  that wrap the app in both builds.
- `9c824682-*.js` — vendor Supabase (do not edit).
- `6f8bf93b-*.js` — Claude Design runtime (do not edit).
- `*.woff2` — bundled fonts.
- `_meta.json` — asset order/metadata used by the packer.
- `bundle.py` — lossless unpack/repack tool.

## Edit workflow
```bash
# from repo root, after editing OneSlate/_src/template.html
python3 OneSlate/_src/bundle.py build OneSlate/_src .                    # index.html + assets/
python3 OneSlate/_src/bundle.py pack single.html OneSlate/_src single.html # single-file copy
```
Serve the repo root (`python3 -m http.server`) to test. If you exported a new bundle from
Claude Design, refresh the source first with
`python3 OneSlate/_src/bundle.py unpack <exported.html> OneSlate/_src`, then run both commands.
When you change `sw.js`, bump its `CACHE` name so phones drop the old cache.

## Notes on the Coursework module
- Classes live in `state.classes` (synced via `boards.data`, mirroring `events`).
- Assignments are `events` with `kind:'assignment'` (+ `classId`, `atype`, `points`,
  `done`), so they inherit the calendar, `.ics` export, and cloud sync for free.
- Syllabus parsing uses `window.claude.complete` when available and falls back to a
  regex heuristic otherwise; extracted items always land in a review step before saving.
