/// <reference path="../pb_data/types.d.ts" />

// PocketPages: renders everything under pb_hooks/pages
require('pocketpages')

// Schema: Pocketpistol owns its collections. They're imported on every boot.
// The import is transactional and idempotent, and deleteMissing=false means
// it never touches collections that aren't ours.
onBootstrap((e) => {
  e.next()
  const { collections } = require(`${__hooks}/lib/schema.js`)
  $app.importCollections(collections, false)
})

// Admin UI extension: serves pb_hooks/admin at /_/extensions/pocketpistol/
// Only browser files belong in admin/ because every file there is public.
$app.onServe().bindFunc((e) => {
  if (!e.uiExtensions) {
    console.warn('Pocketpistol: admin UI extensions need PocketBase 0.37+. Admin page disabled.')
    return e.next()
  }
  e.uiExtensions.push({
    name: 'pocketpistol',
    fs: $os.dirFS(`${__hooks}/admin`),
  })
  e.next()
})

// MCP endpoint (Streamable HTTP, stateless JSON). Agent-first: every feature
// should be reachable as a tool. Auth: any superuser token, including
// long-lived static tokens from POST /api/collections/_superusers/impersonate/{id}.
routerAdd(
  'POST',
  '/mcp',
  (e) => {
    const { createMcpServer, pocketbaseTools } = require('pbjsmcp')
    const { tools } = require(`${__hooks}/lib/tools.js`)
    return createMcpServer({
      name: 'pocketpistol',
      version: '0.0.1',
      instructions:
        'Pocketpistol is a bulk mail app. Use its tools (get_stats, add_subscribers, create_campaign, ...) for mail work, ' +
        'and the pb_* tools for general PocketBase admin. Sending is not available yet.',
      tools: [...tools, ...pocketbaseTools()],
    }).handle(e)
  },
  $apis.requireSuperuserAuth()
)

// No server-initiated stream: the spec says GET returns 405 in that case.
routerAdd('GET', '/mcp', (e) => {
  e.response.header().set('Allow', 'POST')
  return e.json(405, { message: 'Use POST' })
})

// TODO: cron that drains the send queue
// cronAdd('pocketpistol-send', '* * * * *', () => {
//   require(`${__hooks}/lib/mailer.js`).drainQueue()
// })

// TODO: RFC 8058 one-click unsubscribe (List-Unsubscribe-Post)
// routerAdd('POST', '/unsubscribe', (e) => { ... })
