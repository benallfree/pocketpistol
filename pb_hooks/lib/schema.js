// Pocketpistol's collections, imported on boot with $app.importCollections().
//
// Collection and field ids are fixed on purpose: the import matches existing
// collections and fields by id, so stable ids make re-imports update in place
// instead of dropping and re-adding columns.
//
// API rules are null (superuser only). Public pages go through hooks.

const autodates = (prefix) => [
  { id: `${prefix}_created`, name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
  { id: `${prefix}_updated`, name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
]

const collections = [
  {
    id: 'pp_subscribers',
    name: 'subscribers',
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
        values: ['pending', 'active', 'unsubscribed'],
      },
      { id: 'pp_sub_unsub_at', name: 'unsubscribed_at', type: 'date' },
      ...autodates('pp_sub'),
    ],
    indexes: ['CREATE UNIQUE INDEX `idx_pp_subscribers_email` ON `subscribers` (`email`)'],
  },
  {
    id: 'pp_campaigns',
    name: 'campaigns',
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
        values: ['draft', 'sending', 'sent'],
      },
      { id: 'pp_cmp_sent_at', name: 'sent_at', type: 'date' },
      ...autodates('pp_cmp'),
    ],
    indexes: [],
  },
  {
    id: 'pp_sends',
    name: 'sends',
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
        collectionId: 'pp_campaigns',
        cascadeDelete: true,
        maxSelect: 1,
        required: true,
      },
      {
        id: 'pp_snd_subscriber',
        name: 'subscriber',
        type: 'relation',
        collectionId: 'pp_subscribers',
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
      { id: 'pp_snd_error', name: 'error', type: 'text' },
      { id: 'pp_snd_sent_at', name: 'sent_at', type: 'date' },
      ...autodates('pp_snd'),
    ],
    indexes: ['CREATE UNIQUE INDEX `idx_pp_sends_pair` ON `sends` (`campaign`, `subscriber`)'],
  },
]

module.exports = { collections }
