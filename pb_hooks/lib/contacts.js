// Contact sync: other apps (a "source", e.g. the PocketHost mothership) mirror
// their users into `subscribers`. Used by the /api/pocketpistol/contacts routes
// and by the MCP tools, so both behave the same.
//
// Rules:
// - A synced contact is keyed by (source, external_id), not email, because
//   emails change.
// - The source owns `tags`, `attributes`, `source_suppressed` and
//   `source_updated`, and always sends the full set of tags.
// - Pocketpistol owns `status` and `local_tags`. Sync never changes them, so a
//   local unsubscribe sticks.
// - An upsert older than the stored `source_updated` is ignored ("stale"), so
//   retries and out-of-order deliveries are harmless.

const MAX_BATCH = 500
const MAX_TAGS = 100
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TAG_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/

class ContactError extends Error {}

const fail = (msg) => {
  throw new ContactError(msg)
}

const findOrNull = (app, filter, params) => {
  try {
    return app.findFirstRecordByFilter('subscribers', filter, params)
  } catch (_) {
    return null
  }
}

const parseJson = (raw, fallback) => {
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch (_) {
    return fallback
  }
}

const checkSource = (source) => {
  const s = `${source || ''}`.trim()
  if (!SOURCE_RE.test(s)) fail(`Invalid source "${s}": use 1-64 lowercase letters, digits, "-" or "_".`)
  return s
}

const checkExternalId = (externalId) => {
  const x = `${externalId === undefined || externalId === null ? '' : externalId}`.trim()
  if (!x || x.length > 128) fail('external_id is required (max 128 characters).')
  return x
}

/** Lowercase, trim, dedupe and sort. Throws on an invalid tag. */
const normalizeTags = (tags) => {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) fail('tags must be an array of strings.')
  const out = {}
  tags.forEach((t) => {
    const tag = `${t}`.trim().toLowerCase()
    if (!TAG_RE.test(tag)) fail(`Invalid tag "${t}": use 1-64 of a-z, 0-9, ":", ".", "_" or "-", starting with a letter or digit.`)
    out[tag] = true
  })
  const list = Object.keys(out).sort()
  if (list.length > MAX_TAGS) fail(`Too many tags (${list.length}, max ${MAX_TAGS}).`)
  return list
}

const parseUpdated = (updated) => {
  if (updated === undefined || updated === null || updated === '') return new DateTime()
  let dt
  try {
    dt = new DateTime(`${updated}`)
  } catch (_) {
    dt = null
  }
  if (!dt || dt.isZero()) fail(`Invalid updated timestamp "${updated}": use ISO 8601, e.g. 2026-11-09T19:00:00Z.`)
  return dt
}

const contactJson = (r) => ({
  id: r.id,
  source: r.getString('source'),
  external_id: r.getString('external_id'),
  email: r.getString('email'),
  name: r.getString('name'),
  status: r.getString('status'),
  tags: parseJson(r.getString('tags'), []),
  local_tags: parseJson(r.getString('local_tags'), []),
  attributes: parseJson(r.getString('attributes'), {}),
  source_suppressed: r.getBool('source_suppressed'),
  source_updated: r.getString('source_updated'),
})

/**
 * Create or update one contact.
 * Returns { result: 'created' | 'updated' | 'linked' | 'stale', contact }.
 * 'linked' means an existing hand-added subscriber with the same email was
 * attached to this source.
 */
const upsertContact = (app, source, externalId, data) => {
  source = checkSource(source)
  externalId = checkExternalId(externalId)
  data = data || {}

  const email = `${data.email || ''}`.trim().toLowerCase()
  if (!email) fail('email is required.')
  const tags = normalizeTags(data.tags)
  const attributes = data.attributes === undefined || data.attributes === null ? {} : data.attributes
  if (typeof attributes !== 'object' || Array.isArray(attributes)) fail('attributes must be an object.')
  const updated = parseUpdated(data.updated)

  let result = 'updated'
  let r = findOrNull(app, 'source = {:source} && external_id = {:ext}', { source, ext: externalId })

  if (r) {
    const stored = r.getDateTime('source_updated')
    if (!stored.isZero() && updated.before(stored)) return { result: 'stale', contact: contactJson(r) }
  } else {
    const byEmail = findOrNull(app, 'email = {:email}', { email })
    if (byEmail && byEmail.getString('source')) {
      fail(
        `Email ${email} already belongs to contact ${byEmail.getString('source')}/${byEmail.getString('external_id')}.`
      )
    }
    if (byEmail) {
      r = byEmail
      result = 'linked'
    } else {
      r = new Record(app.findCollectionByNameOrId('subscribers'))
      r.set('status', 'active')
      r.set('local_tags', [])
      result = 'created'
    }
    r.set('source', source)
    r.set('external_id', externalId)
  }

  if (r.getString('email') !== email) {
    const other = findOrNull(app, 'email = {:email} && id != {:id}', { email, id: r.id || '' })
    if (other) fail(`Can't change email to ${email}: another subscriber already has it.`)
  }

  r.set('email', email)
  if (data.name !== undefined) r.set('name', `${data.name || ''}`)
  r.set('tags', tags)
  r.set('attributes', attributes)
  r.set('source_suppressed', !!data.suppressed)
  r.set('source_updated', updated)
  app.save(r)

  return { result, contact: contactJson(r) }
}

/**
 * Upsert many contacts from one source. One bad contact doesn't stop the rest.
 * Each item needs `external_id` plus the upsertContact fields.
 */
const upsertContacts = (source, contacts) => {
  source = checkSource(source)
  if (!Array.isArray(contacts) || contacts.length === 0) fail('contacts must be a non-empty array.')
  if (contacts.length > MAX_BATCH) fail(`Too many contacts (${contacts.length}, max ${MAX_BATCH} per batch).`)

  const counts = { created: 0, updated: 0, linked: 0, stale: 0 }
  const failed = []
  $app.runInTransaction((txApp) => {
    contacts.forEach((c, i) => {
      const externalId = c && c.external_id
      try {
        const { result } = upsertContact(txApp, source, externalId, c)
        counts[result]++
      } catch (err) {
        failed.push({ index: i, external_id: externalId === undefined ? null : externalId, error: errorText(err) })
      }
    })
  })
  return Object.assign(counts, { failed })
}

/** Delete a synced contact (their sends cascade). Returns { deleted }. */
const deleteContact = (source, externalId) => {
  source = checkSource(source)
  externalId = checkExternalId(externalId)
  const r = findOrNull($app, 'source = {:source} && external_id = {:ext}', { source, ext: externalId })
  if (!r) return { deleted: false }
  $app.delete(r)
  return { deleted: true, email: r.getString('email') }
}

/** Every tag in use (source and local), with how many subscribers have it. */
const listTags = () => {
  const arr = (col) => `json_each(CASE WHEN json_valid(s.${col}) AND json_type(s.${col}) = 'array' THEN s.${col} ELSE '[]' END)`
  const rows = arrayOf(new DynamicModel({ tag: '', count: 0, local: false }))
  $app
    .db()
    .newQuery(
      `SELECT j.value AS tag, COUNT(*) AS count, 0 AS local FROM subscribers s, ${arr('tags')} j GROUP BY j.value
       UNION ALL
       SELECT j.value AS tag, COUNT(*) AS count, 1 AS local FROM subscribers s, ${arr('local_tags')} j GROUP BY j.value
       ORDER BY count DESC, tag`
    )
    .all(rows)
  return rows.map((r) => ({ tag: r.tag, count: r.count, local: !!r.local }))
}

/** Readable message for errors from this module, PocketBase validation, or anything else. */
const errorText = (err) => {
  if (err instanceof ContactError) return err.message
  const msg = `${(err && err.message) || err}`
  return msg.replace(/^Error: /, '')
}

module.exports = {
  MAX_BATCH,
  ContactError,
  upsertContact,
  upsertContacts,
  deleteContact,
  listTags,
  contactJson,
  errorText,
}
