# AGENTS.md

## Cursor Cloud specific instructions

### What this is
A static, single-page web app: a **New Testament Reading Schedule** tracker. It is plain
`index.html` + `style.css` + `script.js` + `schedule.json` with no build step, no package
manager, and no server-side code. Progress (checked-off reading days) is meant to be stored
in a **Firebase Realtime Database** (config is embedded in `script.js`; Firebase web config
values are public by design).

### Running it (dev)
There are no dependencies to install. Serve the folder over HTTP from the repo root, e.g.:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. Opening `index.html` via `file://` will not work reliably
because `script.js` does `fetch("schedule.json")`, which requires an HTTP origin.

There is no lint/test/build tooling in this repo.

### Known pre-existing app bugs (NOT environment/setup issues)
These are code bugs that exist in the repository and prevent the UI from functioning. They are
unrelated to environment setup and were intentionally left unmodified during setup:

- `index.html` loads the Firebase v9 SDK using the ES-module CDN builds
  (`firebase-app.js` / `firebase-database.js`) as classic `<script>` tags. This throws
  `Uncaught SyntaxError: Unexpected token 'export'` and leaves the global `firebase` undefined.
  The compat builds (`firebase-app-compat.js` / `firebase-database-compat.js`) are what the
  non-module code in `script.js` expects.
- Because `firebase.initializeApp(...)` on line ~13 of `script.js` throws, the rest of
  `script.js` never runs, so the collapsible button and the reading-schedule table never
  initialize (the table stays empty).
- `schedule.json` contains a JavaScript `// ...` comment, which is invalid JSON, so
  `response.json()` would fail to parse it even after Firebase is fixed.
