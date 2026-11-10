// Pocketpistol's collections, imported on every boot with $app.importCollections().
// Names are pp_* so they never collide with the host app's own collections.
//
// Collection and field ids are fixed on purpose: the import matches existing
// collections and fields by id, so stable ids make re-imports update in place
// instead of dropping and re-adding columns. Collection ids are ppc_* because
// PocketBase rejects a collection whose name equals its own (or any) collection id.
//
// API rules are null (superuser only). Public pages go through hooks.

const autodates = (prefix) => [
  { id: `${prefix}_created`, name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
  { id: `${prefix}_updated`, name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
]

const collections = [
  {
    id: 'ppc_subscribers',
    name: 'pp_subscribers',
    type: 'base',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { id: 'pp_sub_email', name: 'email', type: 'email', required: true },
      { id: 'pp_sub_name', name: 'name', type: 'text' },
      {
        id: 'pp_sub_status',
        name: 'status',
        type: 'select',
        maxSelect: 1,
        // bounced = hard bounce or suppressed by the host (lib/mailer.js suppress()).
        values: ['pending', 'active', 'unsubscribed', 'bounced'],
      },
      { id: 'pp_sub_unsub_at', name: 'unsubscribed_at', type: 'date' },
      // Why the status last changed away from active (e.g. "one-click unsubscribe").
      { id: 'pp_sub_status_note', name: 'status_note', type: 'text', max: 500 },
      // Sync from other apps (lib/contacts.js). A synced subscriber is keyed by
      // (source, external_id). The source owns `tags`, `attributes`,
      // `source_suppressed` and `source_updated`; Pocketpistol owns `status`
      // and `local_tags`, and sync never touches them.
      { id: 'pp_sub_source', name: 'source', type: 'text', max: 64 },
      { id: 'pp_sub_ext_id', name: 'external_id', type: 'text', max: 128 },
      { id: 'pp_sub_tags', name: 'tags', type: 'json' },
      { id: 'pp_sub_local_tags', name: 'local_tags', type: 'json' },
      { id: 'pp_sub_attributes', name: 'attributes', type: 'json' },
      { id: 'pp_sub_src_suppressed', name: 'source_suppressed', type: 'bool' },
      { id: 'pp_sub_src_updated', name: 'source_updated', type: 'date' },
      ...autodates('pp_sub'),
    ],
    indexes: [
      'CREATE UNIQUE INDEX `idx_pp_subscribers_email` ON `pp_subscribers` (`email`)',
      "CREATE UNIQUE INDEX `idx_pp_subscribers_source_ext` ON `pp_subscribers` (`source`, `external_id`) WHERE `source` != ''",
    ],
  },
  {
    id: 'ppc_campaigns',
    name: 'pp_campaigns',
    type: 'base',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { id: 'pp_cmp_subject', name: 'subject', type: 'text', required: true },
      { id: 'pp_cmp_body', name: 'body', type: 'editor' },
      {
        id: 'pp_cmp_status',
        name: 'status',
        type: 'select',
        maxSelect: 1,
        values: ['draft', 'sending', 'sent', 'cancelled'],
      },
      { id: 'pp_cmp_queued_at', name: 'queued_at', type: 'date' },
      { id: 'pp_cmp_sent_at', name: 'sent_at', type: 'date' },
      // Audience: { all, any, none } tag lists over tags + local_tags (lib/segments.js).
      { id: 'pp_cmp_segment', name: 'segment', type: 'json' },
      // Campaign-wide merge values for {{vars.x}} (lib/render.js).
      { id: 'pp_cmp_vars', name: 'vars', type: 'json' },
      ...autodates('pp_cmp'),
    ],
    indexes: [],
  },
  {
    id: 'ppc_sends',
    name: 'pp_sends',
    type: 'base',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        id: 'pp_snd_campaign',
        name: 'campaign',
        type: 'relation',
        collectionId: 'ppc_campaigns',
        cascadeDelete: true,
        maxSelect: 1,
        required: true,
      },
      {
        id: 'pp_snd_subscriber',
        name: 'subscriber',
        type: 'relation',
        collectionId: 'ppc_subscribers',
        cascadeDelete: true,
        maxSelect: 1,
        required: true,
      },
      {
        id: 'pp_snd_status',
        name: 'status',
        type: 'select',
        maxSelect: 1,
        values: ['queued', 'sent', 'failed', 'skipped'],
      },
      // The address it was queued for, so history survives an email change.
      { id: 'pp_snd_email', name: 'email', type: 'text' },
      { id: 'pp_snd_attempts', name: 'attempts', type: 'number', onlyInt: true },
      { id: 'pp_snd_error', name: 'error', type: 'text' },
      { id: 'pp_snd_sent_at', name: 'sent_at', type: 'date' },
      ...autodates('pp_snd'),
    ],
    indexes: [
      'CREATE UNIQUE INDEX `idx_pp_sends_pair` ON `pp_sends` (`campaign`, `subscriber`)',
      'CREATE INDEX `idx_pp_sends_status` ON `pp_sends` (`status`, `created`)',
    ],
  },
  {
    // Pocketpistol's own key/value state, e.g. the unsubscribe-link signing secret.
    id: 'ppc_meta',
    name: 'pp_meta',
    type: 'base',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { id: 'pp_meta_key', name: 'key', type: 'text', required: true, max: 100 },
      { id: 'pp_meta_value', name: 'value', type: 'json' },
      ...autodates('pp_meta'),
    ],
    indexes: ['CREATE UNIQUE INDEX `idx_pp_meta_key` ON `pp_meta` (`key`)'],
  },
]

module.exports = { collections }
