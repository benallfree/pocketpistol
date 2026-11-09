// Pocketpistol's MCP tools. Each one is a thin wrapper over app logic, so the
// admin UI, public pages and agents all share the same behavior.

const MAX_LIMIT = 200

const clampLimit = (n, fallback) => Math.max(1, Math.min(MAX_LIMIT, parseInt(n, 10) || fallback))

const subscriberJson = (r) => ({
  id: r.id,
  email: r.getString('email'),
  name: r.getString('name'),
  status: r.getString('status'),
  source: r.getString('source'),
  external_id: r.getString('external_id'),
  tags: JSON.parse(r.getString('tags') || '[]') || [],
  local_tags: JSON.parse(r.getString('local_tags') || '[]') || [],
  source_suppressed: r.getBool('source_suppressed'),
  created: r.getString('created'),
})

const campaignJson = (r) => ({
  id: r.id,
  subject: r.getString('subject'),
  status: r.getString('status'),
  sent_at: r.getString('sent_at'),
  created: r.getString('created'),
})

const tools = [
  {
    name: 'get_stats',
    description: 'Counts of subscribers by status and campaigns by status.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const count = (collection, field, value) =>
        $app.countRecords(collection, $dbx.hashExp({ [field]: value }))
      return {
        subscribers: {
          active: count('subscribers', 'status', 'active'),
          pending: count('subscribers', 'status', 'pending'),
          unsubscribed: count('subscribers', 'status', 'unsubscribed'),
        },
        campaigns: {
          draft: count('campaigns', 'status', 'draft'),
          sending: count('campaigns', 'status', 'sending'),
          sent: count('campaigns', 'status', 'sent'),
        },
      }
    },
  },
  {
    name: 'list_subscribers',
    description: 'List subscribers, newest first. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'active', 'unsubscribed'] },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 },
      },
    },
    handler: ({ args }) => {
      const filter = args.status ? 'status = {:status}' : ''
      const records = $app.findRecordsByFilter('subscribers', filter, '-created', clampLimit(args.limit, 50), 0, {
        status: args.status || '',
      })
      return { subscribers: records.map(subscriberJson) }
    },
  },
  {
    name: 'add_subscribers',
    description:
      'Add subscribers by email. Existing emails are skipped, not modified (so this never re-subscribes someone who unsubscribed).',
    inputSchema: {
      type: 'object',
      properties: {
        subscribers: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            properties: { email: { type: 'string', format: 'email' }, name: { type: 'string' } },
            required: ['email'],
          },
        },
        status: { type: 'string', enum: ['pending', 'active'], default: 'active' },
      },
      required: ['subscribers'],
    },
    handler: ({ args }) => {
      const list = args.subscribers || []
      const status = args.status === 'pending' ? 'pending' : 'active'
      const collection = $app.findCollectionByNameOrId('subscribers')
      const added = []
      const skipped = []
      const failed = []
      $app.runInTransaction((txApp) => {
        list.forEach((s) => {
          const email = `${(s && s.email) || ''}`.trim().toLowerCase()
          try {
            txApp.findFirstRecordByData('subscribers', 'email', email)
            skipped.push(email)
            return
          } catch (_) {
            // not found: create it
          }
          try {
            const r = new Record(collection)
            r.set('email', email)
            r.set('name', `${(s && s.name) || ''}`)
            r.set('status', status)
            txApp.save(r)
            added.push(email)
          } catch (err) {
            failed.push({ email, error: `${err}` })
          }
        })
      })
      return { added: added.length, skipped, failed }
    },
  },
  {
    name: 'list_campaigns',
    description: 'List campaigns, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 } },
    },
    handler: ({ args }) => {
      const records = $app.findRecordsByFilter('campaigns', '', '-created', clampLimit(args.limit, 50), 0)
      return { campaigns: records.map(campaignJson) }
    },
  },
  {
    name: 'create_campaign',
    description: 'Create a draft campaign. Nothing is sent; sending is a separate step.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', minLength: 1 },
        body: { type: 'string', description: 'HTML body' },
      },
      required: ['subject'],
    },
    handler: ({ args }) => {
      const r = new Record($app.findCollectionByNameOrId('campaigns'))
      r.set('subject', `${args.subject || ''}`)
      r.set('body', `${args.body || ''}`)
      r.set('status', 'draft')
      $app.save(r)
      return campaignJson(r)
    },
  },
]

// Contact sync tools: same logic as the /api/pocketpistol/contacts routes.
const contactProperties = {
  external_id: { type: 'string', description: "The contact's id in the source app" },
  email: { type: 'string', format: 'email' },
  name: { type: 'string' },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: 'The FULL set of source tags. Replaces the stored tags; omitted tags are removed.',
  },
  attributes: { type: 'object', description: 'Merge fields for message bodies. Replaces the stored attributes.' },
  suppressed: { type: 'boolean', description: 'True if the source says not to mail this address (e.g. unverified).' },
  updated: {
    type: 'string',
    description: "When the source last changed this contact (ISO 8601). Older than what's stored = ignored as stale.",
  },
}

tools.push(
  {
    name: 'upsert_contacts',
    description:
      'Create or update contacts synced from another app (a "source"), keyed by source + external_id. ' +
      "Replaces each contact's source tags and attributes. Never changes a subscriber's status or local tags, " +
      'so it never re-subscribes anyone. Returns counts plus per-contact failures.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source app id, e.g. "pockethost"' },
        contacts: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: { type: 'object', properties: contactProperties, required: ['external_id', 'email'] },
        },
      },
      required: ['source', 'contacts'],
    },
    handler: ({ args }) => require(`${__hooks}/lib/contacts.js`).upsertContacts(args.source, args.contacts),
  },
  {
    name: 'delete_contact',
    description: 'Permanently delete a synced contact and their send history.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' }, external_id: { type: 'string' } },
      required: ['source', 'external_id'],
    },
    handler: ({ args }) => require(`${__hooks}/lib/contacts.js`).deleteContact(args.source, args.external_id),
  },
  {
    name: 'list_tags',
    description: 'Every tag in use with its subscriber count. local=true for tags added in Pocketpistol, false for source tags.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ tags: require(`${__hooks}/lib/contacts.js`).listTags() }),
  }
)

module.exports = { tools }
