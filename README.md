# Pocketpistol

Self-hosted bulk mail for [PocketBase](https://pocketbase.io), built with [PocketPages](https://pocketpages.dev).

- **Admin:** manage subscribers and campaigns from a page inside the PocketBase dashboard (`/_/#/pocketpistol`). Requires PocketBase 0.37+ (admin UI extensions are experimental upstream).
- **Public pages:** subscribe, unsubscribe, preferences and a campaign archive, rendered by PocketPages.
- **Self-contained schema:** Pocketpistol imports its own collections (`subscribers`, `campaigns`, `sends`) on boot. No migration files to copy.

> Early scaffold. Sending, signed unsubscribe links and the admin screens are still TODO.

## Layout

```
pb_hooks/
  pocketpistol.pb.js   boots PocketPages, imports the schema, registers the admin extension
  lib/                 server-only code (never served)
  admin/               browser code for the admin extension, served at /_/extensions/pocketpistol/
  pages/               public PocketPages routes
```

## Run locally

```bash
npm i
pocketbase superuser upsert you@example.com <password> --dir=pb_data
pocketbase serve --dir=pb_data --dev
```

Then open http://127.0.0.1:8090/_/ and sign in.

## License

MIT
