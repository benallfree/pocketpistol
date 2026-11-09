// Pocketpistol's MCP tools, as a pbjsmcp-compatible provider. Pocketpistol
// registers no MCP endpoint; the host wires these into its own server:
//
//   const { createMcpServer } = require('pbjsmcp')
//   const { mcpTools } = require('pocketpistol')
//   createMcpServer({ name: 'myapp', tools: [...mcpTools(), ...myTools] }).handle(e)
//
// Options (same shape as pbjsmcp's pocketbaseTools):
//   groups:   subset of ['subscribers', 'campaigns', 'contacts'] (default: all)
//   readOnly: true to include only tools that change nothing
//
// Every tool requires a superuser itself, whatever auth the host's route uses,
// because the tools read and write pp_* collections directly.
//
// Agent-first: every Pocketpistol feature needs a tool here.

const contacts = require('./contacts.js')
const sources = require('./sources.js')
const campaigns = require('./campaigns.js')
const segments = require('./segments.js')

const MAX_LIMIT = 200
const READ = { readOnlyHint: true }
const WRITE = { readOnlyHint: false, destructiveHint: false }
const DESTROY = { readOnlyHint: false, destructiveHint: true }
const ALL_GROUPS = ['subscribers', 'campaigns', 'contacts']

const clampLimit = (n, fallback) => Math.max(1, Math.min(MAX_LIMIT, parseInt(n, 10) || fallback))

const parseJson = (raw, fallback) => {
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch (_) {
    return fallback
  }
}

const subscriberJson = (r) => ({
  id: r.id,
  email: r.getString('email'),
  name: r.getString('name'),
  status: r.getString('status'),
  source: r.getString('source'),
  external_id: r.getString('external_id'),
  tags: parseJson(r.getString('tags'), []),
  local_tags: parseJson(r.getString('local_tags'), []),
  source_suppressed: r.getBool('source_suppressed'),
  created: r.getString('created'),
})

const segmentSchema = {
  type: 'object',
  description:
    'Audience as tag lists, matched against source tags and local tags together. all = has every tag, ' +
    'any = has at least one, none = has none. {} = every subscriber. Only active, unsuppressed subscribers get mail.',
  properties: {
    all: { type: 'array', items: { type: 'string' } },
    any: { type: 'array', items: { type: 'string' } },
    none: { type: 'array', items: { type: 'string' } },
  },
}

const MERGE_HELP =
  'Merge fields in subject and body: {{name}}, {{email}}, {{attributes.x}} (from the subscriber\'s source), ' +
  '{{vars.x}} (from the campaign\'s vars), with an optional fallback: {{name | "there"}}. Values are HTML-escaped in the body.'

const campaignProperties = {
  subject: { type: 'string', minLength: 1 },
  body: { type: 'string', description: 'HTML body' },
  segment: segmentSchema,
  vars: { type: 'object', description: 'Campaign-wide values for {{vars.x}}' },
}

const contactProperties = {
  external_id: { type: 'string', description: "The contact's id in the source" },
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

const ALL_TOOLS = [
  {
    group: 'subscribers',
    name: 'get_stats',
    description: 'Counts of subscribers by status and campaigns by status.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const count = (collection, value) => $app.countRecords(collection, $dbx.hashExp({ status: value }))
      return {
        subscribers: {
          active: count('pp_subscribers', 'active'),
          pending: count('pp_subscribers', 'pending'),
          unsubscribed: count('pp_subscribers', 'unsubscribed'),
        },
        campaigns: {
          draft: count('pp_campaigns', 'draft'),
          sending: count('pp_campaigns', 'sending'),
          sent: count('pp_campaigns', 'sent'),
        },
      }
    },
  },
  {
    group: 'subscribers',
    name: 'list_subscribers',
    description: 'List subscribers, newest first. Optionally filter by status.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'active', 'unsubscribed'] },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 },
      },
    },
    handler: ({ args }) => {
      const filter = args.status ? 'status = {:status}' : ''
      const records = $app.findRecordsByFilter('pp_subscribers', filter, '-created', clampLimit(args.limit, 50), 0, {
        status: args.status || '',
      })
      return { subscribers: records.map(subscriberJson) }
    },
  },
  {
    group: 'subscribers',
    name: 'add_subscribers',
    description:
      'Add subscribers by email (not linked to any source). Existing emails are skipped, not modified, ' +
      'so this never re-subscribes someone who unsubscribed.',
    annotations: WRITE,
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
      const collection = $app.findCollectionByNameOrId('pp_subscribers')
      const added = []
      const skipped = []
      const failed = []
      $app.runInTransaction((txApp) => {
        list.forEach((s) => {
          const email = `${(s && s.email) || ''}`.trim().toLowerCase()
          try {
            txApp.findFirstRecordByData('pp_subscribers', 'email', email)
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
            r.set('tags', [])
            r.set('local_tags', [])
            txApp.save(r)
            added.push(email)
          } catch (err) {
            failed.push({ email, error: contacts.errorText(err) })
          }
        })
      })
      return { added: added.length, skipped, failed }
    },
  },
  {
    group: 'campaigns',
    name: 'list_campaigns',
    description: 'List campaigns, newest first (without bodies; use get_campaign for one in full).',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 } },
    },
    handler: ({ args }) => ({ campaigns: campaigns.listCampaigns(clampLimit(args.limit, 50)) }),
  },
  {
    group: 'campaigns',
    name: 'get_campaign',
    description: 'One campaign in full: subject, HTML body, segment, vars, and how many subscribers its segment reaches.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: ({ args }) => campaigns.getCampaign(args.id),
  },
  {
    group: 'campaigns',
    name: 'create_campaign',
    description:
      'Create a draft campaign. Nothing is sent; sending is a separate step. ' +
      MERGE_HELP +
      ' Returns the campaign with its audience counts.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: campaignProperties,
      required: ['subject'],
    },
    handler: ({ args }) => campaigns.createCampaign(args),
  },
  {
    group: 'campaigns',
    name: 'update_campaign',
    description:
      "Change a draft campaign's subject, body, segment or vars. Omitted fields stay as they are; " +
      'segment and vars are replaced as a whole. Only drafts can be edited. ' +
      MERGE_HELP,
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, ...campaignProperties },
      required: ['id'],
    },
    handler: ({ args }) => campaigns.updateCampaign(args.id, args),
  },
  {
    group: 'campaigns',
    name: 'preview_segment',
    description:
      'Who a segment reaches before you use it: matched and mailable counts, why the rest are excluded ' +
      '(unsubscribed, pending, suppressed by their source), and a sample of mailable subscribers.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        segment: segmentSchema,
        sample: { type: 'integer', minimum: 0, maximum: 50, default: 10 },
      },
      required: ['segment'],
    },
    handler: ({ args }) => segments.previewSegment(args.segment, args.sample === undefined ? 10 : args.sample),
  },
  {
    group: 'campaigns',
    name: 'preview_campaign',
    description:
      'Render a campaign for one subscriber (by subscriber_id or email; default: the newest mailable ' +
      'subscriber in its audience). Returns the final subject and HTML body, plus merge fields that had no ' +
      'value (missing) or are not recognized (unknown). Sends nothing.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign id' },
        subscriber_id: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
      required: ['id'],
    },
    handler: ({ args }) => campaigns.previewCampaign(args.id, args),
  },
  {
    group: 'contacts',
    name: 'list_sources',
    description:
      'Sources configured in the host app (pocketpistol.config.js): which collection each mirrors, ' +
      'its related collections, and how many contacts it has.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      sources: sources.listSources().map(([name, src]) => ({
        name,
        collection: src.collection,
        related: Object.keys(src.related || {}),
        contacts: $app.countRecords('pp_subscribers', $dbx.hashExp({ source: name })),
      })),
    }),
  },
  {
    group: 'contacts',
    name: 'resync_contacts',
    description:
      'Re-sync every record of a configured source (or all sources) into subscribers, and remove contacts ' +
      'whose source record is gone. Run after changing pocketpistol.config.js. Never changes status or local tags.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name; omit for all sources' } },
    },
    handler: ({ args }) => ({ results: sources.resync($app, args.source || '') }),
  },
  {
    group: 'contacts',
    name: 'upsert_contacts',
    description:
      'Create or update contacts from a source that is NOT configured in this app (e.g. another server), ' +
      'keyed by source + external_id. Replaces their source tags and attributes. Never changes a subscriber\'s ' +
      'status or local tags, so it never re-subscribes anyone. Returns counts plus per-contact failures.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source id, e.g. "crm"' },
        contacts: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: { type: 'object', properties: contactProperties, required: ['external_id', 'email'] },
        },
      },
      required: ['source', 'contacts'],
    },
    handler: ({ args }) => contacts.upsertContacts(args.source, args.contacts),
  },
  {
    group: 'contacts',
    name: 'delete_contact',
    description: 'Permanently delete a contact and their send history.',
    annotations: DESTROY,
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' }, external_id: { type: 'string' } },
      required: ['source', 'external_id'],
    },
    handler: ({ args }) => contacts.deleteContact(args.source, args.external_id),
  },
  {
    group: 'contacts',
    name: 'list_tags',
    description: 'Every tag in use with its subscriber count. local=true for tags added in Pocketpistol, false for source tags.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ tags: contacts.listTags() }),
  },
]

const requireSuperuser = (auth) => {
  if (!auth || !auth.isSuperuser()) throw new Error('Pocketpistol tools require a superuser.')
}

/** pbjsmcp-compatible tool definitions. */
const mcpTools = (opts) => {
  opts = opts || {}
  const groups = opts.groups || ALL_GROUPS
  return ALL_TOOLS.filter((t) => groups.indexOf(t.group) >= 0)
    .filter((t) => !opts.readOnly || t.annotations.readOnlyHint)
    .map((t) => ({
      name: t.name,
      description: t.description,
      annotations: t.annotations,
      inputSchema: t.inputSchema,
      handler: (ctx) => {
        requireSuperuser(ctx && ctx.auth)
        require('./install.js').assertEnabled()
        return t.handler(ctx)
      },
    }))
}

module.exports = { mcpTools, ALL_GROUPS }
