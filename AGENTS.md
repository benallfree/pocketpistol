# Pocketpistol: notes for agents

A drop-in extension that adds bulk mail to an existing PocketBase. It runs inside the host's JS hooks (goja, not Node). The repo is the npm package; `example/` is a small host app for development. See README.md for the host's view.

## Layout

```
index.js         package entry: registers hooks when loaded from a *.pb.js, exports the API
lib/             server code: schema, install (guarded import), contacts, sources (config-driven sync),
                 segments (audiences), render (merge fields), campaigns, tools (MCP provider), mailer
admin/           browser code for the admin extension, served at /_/extensions/pocketpistol/
example/         host app: pb_hooks/{pocketpistol.pb.js, pocketpistol.config.js, mcp.pb.js}, pb_migrations/
```

Run it from `example/`: `npm i`, then `pocketbase superuser upsert test@example.com testpassword123` (always before the first serve of a fresh data dir, or PocketBase opens a browser window for the superuser install page), then `pocketbase serve --dev`. For throwaway test instances, pass the same `--dir` to both commands. `example/node_modules/pocketpistol` is a symlink to the repo root.

## Agent-first

Every feature must be usable by an agent, not only by a person in the UI. A feature isn't done until it has a tool in `mcpTools()` (`lib/tools.js`).

- **Logic lives in `lib/`** as plain functions that take arguments and return plain JSON-able objects.
- **Everything else is a thin layer over `lib/`:** MCP tools, the admin extension, routes and (later) public pages.
- **When you add or change a feature**, add or update its tool in the same change. The tool description is the agent's only documentation: say what it does, what it won't do and any side effects ("nothing is sent").
- Some tools still hold their logic inline. Move it into a `lib/` module as soon as a second caller needs it.

## MCP provider

- Pocketpistol registers **no** MCP endpoint. It exports `mcpTools({ groups, readOnly })`, pbjsmcp-compatible tool objects the host adds to its own server. `example/pb_hooks/mcp.pb.js` shows the wiring.
- Every tool checks for a superuser itself (`requireSuperuser`), whatever the host's route allows. Keep that for new tools.
- Each tool has a `group` and annotations: `READ`, `WRITE` or `DESTROY` (sets `destructiveHint`).
- pbjsmcp is not a dependency of the package, only of `example/`. Fix protocol issues upstream in pbjsmcp.

## Drop-in rules

- **Hook handlers run in isolated runtimes.** They can't see variables from the file that registered them. Handlers call `require('pocketpistol')` and go through the exported API.
- **Exception:** `$app.onServe().bindFunc(...)` runs in the loading runtime. It can use module variables, and a bare `require('pocketpistol')` there fails (it resolves from the package folder). Use a captured variable.
- **Package names resolve from PocketBase's working directory**, so hosts must start PocketBase from the folder that contains `node_modules`. Inside the package, use relative requires (`./lib/x.js`). `__dirname` is the package's real folder.
- **Never touch host collections' schema.** Pocketpistol only reads host records (in `contact()` callbacks) and writes `pp_*`.
- **Pocketpistol must never stop the host from starting.** `lib/install.js` checks for collections that clash with ours before importing, and a conflict or failed import only disables Pocketpistol (reason in `$app.store()`; sync hooks skip, routes return 503, tools error). New entry points must check `disabledReason()` / `assertEnabled()`.
- **Sync must never fail the host's save.** Source hooks run after success and log errors (`lib/sources.js`).
- **Never put server code in `admin/`.** Every file there is public.

## Schema

- `lib/schema.js`, imported on every boot with `$app.importCollections(collections, false)`. No migration files.
- Names are `pp_*`. Collection ids are `ppc_*` (PocketBase rejects a collection whose name equals its own or any other collection id, even on a fresh database). Field ids are fixed. Never change an existing id; add new fields with new ids.
- All `pp_*` collections are superuser-only (`null` rules). Host edits to them are reverted on boot.

## Contacts and sources

- `lib/contacts.js` upserts contacts keyed by `(source, external_id)`. The source owns `tags`, `attributes`, `source_suppressed` and `source_updated` and always sends the full tag set. Pocketpistol owns `status` and `local_tags`; sync must never change them.
- `lib/sources.js` reads the host's `pb_hooks/pocketpistol.config.js` and syncs on after-success record hooks, including `related` collections. `resync()` re-processes a whole source and removes contacts whose record is gone.
- HTTP routes under `/api/pocketpistol/contacts` serve sources outside the host app.

## Campaigns and audiences

- A campaign's `segment` is `{ all, any, none }` tag lists matched against `tags` and `local_tags` together (`lib/segments.js`, SQL with `json_each`, tags bound as params). `{}` matches everyone. Mailable = `status = 'active'` and not `source_suppressed`; `mailableWhere()` is what sending must use.
- Merge fields (`lib/render.js`): `{{name}}`, `{{email}}`, `{{attributes.x}}`, `{{vars.x}}`, optional `| "fallback"`. HTML-escaped in bodies, not in subjects. Missing and unknown fields are reported, never fatal.
- Only drafts can be edited (`lib/campaigns.js`).

## Not built yet

Sending (queue cron over `pp_sends`, `lib/mailer.js`), public pages (unsubscribe, subscribe, preferences, archive) with overridable templates, `suppress()` for bounce handlers, `pp_settings`, real admin screens, scoped API tokens.

## Plans

Plans and roadmap live outside this repo, in the private repo `benallfree/ben` under `docs/pocketpistol/` (locally `/Volumes/Code/repos/root/docs/pocketpistol/`). Check there before starting a feature, and write new plans there, not here.
