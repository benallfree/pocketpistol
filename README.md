# Pocketpistol

Drop-in bulk mail for the [PocketBase](https://pocketbase.io) you already run.

> Early. Contact sync, campaigns with tag-based audiences and merge fields, and the MCP tools work. Sending, public unsubscribe pages and the admin screens are still to come.

- **Drop-in:** one file in `pb_hooks`. No separate server, no migrations to copy.
- **Its own collections:** `pp_subscribers`, `pp_campaigns`, `pp_sends`, imported on every boot. They never collide with yours.
- **Mirrors your users:** describe how your records become contacts, and Pocketpistol keeps them in sync from your own record hooks.
- **Agent-ready:** ships [pbjsmcp](https://github.com/benallfree/pbjsmcp)-compatible MCP tools for you to add to your own MCP server.
- **Admin page** inside the PocketBase dashboard (`/_/#/pocketpistol`, PocketBase 0.37+).

## Install

```bash
npm i github:benallfree/pocketpistol
echo "require('pocketpistol')" > pb_hooks/pocketpistol.pb.js
```

Start PocketBase from the folder that contains `node_modules`. PocketBase resolves package names from its working directory.

## Mirror your users

Create `pb_hooks/pocketpistol.config.js`:

```js
module.exports = {
  sources: {
    users: {
      collection: 'users',
      // Return null to leave a record out (an existing contact is removed).
      contact: (user, app) => ({
        email: user.email(),
        name: user.getString('name'),
        suppressed: !user.verified(), // don't mail this address
        tags: [`plan:${user.getString('plan')}`],
        attributes: { username: user.getString('username') }, // merge fields
      }),
      // Re-sync the owner when records in other collections change.
      related: {
        projects: (project) => project.getString('owner'),
      },
    },
  },
}
```

Pocketpistol hooks the after-success create, update and delete events of every collection named there. A sync error is logged and never fails your own save. Restart PocketBase after adding a source. After changing `contact()`, run the `resync_contacts` tool to re-process existing records.

Each contact's `tags`, `attributes` and suppression come from your config. Pocketpistol's own fields (`status`, `local_tags`) are never touched by sync, so an unsubscribe sticks.

## Campaigns

A campaign has a subject, an HTML body, an audience and optional `vars`:

- **Audience:** `{ "all": ["plan:premium"], "any": ["discord", "has-projects"], "none": ["lapsed"] }`, matched against each subscriber's tags (from your config) and local tags. `{}` is everyone. Only active subscribers your source doesn't suppress get mail.
- **Merge fields:** `{{name}}`, `{{email}}`, `{{attributes.username}}`, `{{vars.total}}`, with a fallback: `{{name | "there"}}`.

The `preview_segment` and `preview_campaign` tools show who a campaign reaches and what one subscriber would receive.

## MCP tools

Pocketpistol doesn't add an MCP endpoint. Add its tools to yours:

```js
// pb_hooks/mcp.pb.js
routerAdd(
  'POST',
  '/mcp',
  (e) => {
    const { createMcpServer } = require('pbjsmcp')
    const { mcpTools } = require('pocketpistol')
    return createMcpServer({ name: 'myapp', version: '1.0.0', tools: [...mcpTools()] }).handle(e)
  },
  $apis.requireSuperuserAuth()
)
```

`mcpTools({ groups: ['subscribers', 'campaigns', 'contacts'], readOnly: true })` picks a subset. Every tool requires a superuser on its own, whatever your route allows.

## Contacts from other apps

Apps on another server can push contacts over HTTP (superuser auth):

- `PUT /api/pocketpistol/contacts/{source}/{external_id}` with `{ email, name, tags, attributes, suppressed, updated }`
- `POST /api/pocketpistol/contacts/batch` with `{ source, contacts: [...] }` (up to 500)
- `DELETE /api/pocketpistol/contacts/{source}/{external_id}`

## Notes

- `pp_*` collections belong to Pocketpistol. Changes you make to them in the dashboard are reverted on the next boot.
- If one of your collections already uses a Pocketpistol name, Pocketpistol logs the conflict and disables itself. Your app keeps running.
- Development happens in [`example/`](example/), a small host app: `cd example && npm i && pocketbase superuser upsert you@example.com <password> && pocketbase serve --dev`.

## License

MIT
