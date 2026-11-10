// Segments: a campaign's audience, as tag lists matched against each
// subscriber's source tags and local tags together.
//
//   { all: ['plan:premium'], any: ['discord', 'has-projects'], none: ['lapsed'] }
//
// all  = must have every tag
// any  = must have at least one (ignored when empty)
// none = must have none of them
// An empty segment matches every subscriber.
//
// Only "mailable" subscribers receive mail: status 'active' and not suppressed
// by their source.

const { normalizeTags, parseJson } = require('./contacts.js')

const KEYS = ['all', 'any', 'none']

/** Validate and normalize a segment. Throws on unknown keys or bad tags. */
const normalizeSegment = (segment) => {
  if (segment === undefined || segment === null || segment === '') segment = {}
  if (typeof segment === 'string') segment = parseJson(segment, null)
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    throw new Error('segment must be an object like { "all": [], "any": [], "none": [] }.')
  }
  Object.keys(segment).forEach((k) => {
    if (KEYS.indexOf(k) < 0) throw new Error(`Unknown segment key "${k}": use all, any or none.`)
  })
  const out = {}
  KEYS.forEach((k) => (out[k] = normalizeTags(segment[k])))
  return out
}

const jsonArray = (col) => `CASE WHEN json_valid(s.${col}) AND json_type(s.${col}) = 'array' THEN s.${col} ELSE '[]' END`

/** SQL for "subscriber s has tag {:p}" across tags and local_tags. */
const hasTag = (p) =>
  `(EXISTS (SELECT 1 FROM json_each(${jsonArray('tags')}) WHERE value = {:${p}})` +
  ` OR EXISTS (SELECT 1 FROM json_each(${jsonArray('local_tags')}) WHERE value = {:${p}}))`

const MAILABLE = `(s.status = 'active' AND COALESCE(s.source_suppressed, 0) = 0)`

/** { sql, params }: a WHERE clause over pp_subscribers aliased as s. */
const segmentWhere = (segment) => {
  const seg = normalizeSegment(segment)
  const params = {}
  let n = 0
  const param = (tag) => {
    const name = `t${n++}`
    params[name] = tag
    return name
  }
  const parts = []
  seg.all.forEach((t) => parts.push(hasTag(param(t))))
  if (seg.any.length > 0) parts.push(`(${seg.any.map((t) => hasTag(param(t))).join(' OR ')})`)
  seg.none.forEach((t) => parts.push(`NOT ${hasTag(param(t))}`))
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params, segment: seg }
}

/** { sql, params }: segment AND mailable. For sending. */
const mailableWhere = (segment) => {
  const w = segmentWhere(segment)
  return { sql: `(${w.sql}) AND ${MAILABLE}`, params: w.params, segment: w.segment }
}

/**
 * Who a segment reaches: counts (matched, mailable, and why the rest are
 * excluded) plus a sample of mailable subscribers.
 */
const previewSegment = (segment, sampleSize) => {
  const w = segmentWhere(segment)
  const counts = new DynamicModel({ matched: 0, mailable: 0, unsubscribed: 0, bounced: 0, pending: 0, suppressed: 0 })
  $app
    .db()
    .newQuery(
      `SELECT COUNT(*) AS matched,
              COALESCE(SUM(CASE WHEN ${MAILABLE} THEN 1 ELSE 0 END), 0) AS mailable,
              COALESCE(SUM(CASE WHEN s.status = 'unsubscribed' THEN 1 ELSE 0 END), 0) AS unsubscribed,
              COALESCE(SUM(CASE WHEN s.status = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced,
              COALESCE(SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN s.status = 'active' AND COALESCE(s.source_suppressed, 0) != 0 THEN 1 ELSE 0 END), 0) AS suppressed
       FROM pp_subscribers s WHERE ${w.sql}`
    )
    .bind(w.params)
    .one(counts)

  const limit = Math.max(0, Math.min(50, parseInt(sampleSize, 10) || 10))
  const rows = arrayOf(new DynamicModel({ id: '', email: '', name: '', tags: '', local_tags: '' }))
  if (limit > 0) {
    $app
      .db()
      .newQuery(
        `SELECT s.id, s.email, s.name, s.tags, s.local_tags FROM pp_subscribers s
         WHERE (${w.sql}) AND ${MAILABLE} ORDER BY s.created DESC LIMIT ${limit}`
      )
      .bind(w.params)
      .all(rows)
  }

  return {
    segment: w.segment,
    matched: counts.matched,
    mailable: counts.mailable,
    excluded: { unsubscribed: counts.unsubscribed, bounced: counts.bounced, pending: counts.pending, suppressed: counts.suppressed },
    sample: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      tags: parseJson(r.tags, []),
      local_tags: parseJson(r.local_tags, []),
    })),
  }
}

module.exports = { normalizeSegment, segmentWhere, mailableWhere, previewSegment }
