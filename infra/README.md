# infra/  ✅ (persistence & IO — Node + SQLite, zero npm deps)

Technical core (no business workflow). Server entry is `shell/server.js`; this folder is what it
requires. Built on Node built-ins (`node:http` + `node:sqlite`, Node ≥22.5). Run: `npm start` → http://localhost:3000

| File | Purpose |
|---|---|
| `db.js` | SQLite connection, schema, seed (`data/db/kd.db`); also defines `UPLOADS_DIR = data/uploads` |
| `repo.js` | Repository — **all SQL lives here** (the swap point for PostgreSQL later) |
| `files.js` | Save uploaded `data:` URLs to `data/uploads/`, keep only the path in the DB |
| `admin.js` | Backup / restore / reset (`data/backups/`) |
| `scripts/` | `init-db`, `backup`, `restore`, `reconcile`, `selftest` (see `package.json`) |

The UI (`shell/scripts/db.js`) talks to the server over the REST `/api/*`, with a localStorage
fallback when opened without the server.
