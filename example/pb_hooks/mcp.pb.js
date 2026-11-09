// The host's own MCP endpoint. Pocketpistol doesn't register one; it provides
// tools that the host adds to its server (here alongside pbjsmcp's PocketBase
// admin tools). Any superuser token works, including long-lived ones from
// POST /api/collections/_superusers/impersonate/{id}.
routerAdd(
  'POST',
  '/mcp',
  (e) => {
    const { createMcpServer, pocketbaseTools } = require('pbjsmcp')
    const { mcpTools } = require('pocketpistol')
    return createMcpServer({
      name: 'pocketpistol-example',
      version: '0.0.1',
      instructions: 'Example host with Pocketpistol bulk mail tools and pb_* PocketBase admin tools.',
      tools: [...mcpTools(), ...pocketbaseTools()],
    }).handle(e)
  },
  $apis.requireSuperuserAuth()
)

routerAdd('GET', '/mcp', (e) => {
  e.response.header().set('Allow', 'POST')
  return e.json(405, { message: 'Use POST' })
})
