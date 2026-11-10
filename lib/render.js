// Merge fields in campaign subjects and bodies:
//
//   {{name}}  {{email}}  {{attributes.username}}  {{vars.total_instances}}
//   {{unsubscribe_url}}  (added when sending; otherwise a footer link is appended)
//   {{name | "there"}}   fallback when the value is missing or empty
//
// attributes come from the subscriber (set by its source); vars come from the
// campaign. Values are HTML-escaped in bodies. A placeholder with no value and
// no fallback renders empty and is reported in `missing`.

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*"((?:[^"\\]|\\.)*)"\s*)?\}\}/g
const ROOTS = ['name', 'email', 'attributes', 'vars', 'unsubscribe_url']

const escapeHtml = (s) =>
  `${s}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const lookup = (ctx, path, roots) => {
  const parts = path.split('.')
  if ((roots || ROOTS).indexOf(parts[0]) < 0) return { known: false }
  let v = ctx
  for (let i = 0; i < parts.length; i++) {
    if (v === null || v === undefined || typeof v !== 'object') return { known: true, value: undefined }
    v = v[parts[i]]
  }
  return { known: true, value: v }
}

const stringify = (v) => (typeof v === 'object' ? JSON.stringify(v) : `${v}`)

/**
 * Render one template. ctx = { name, email, attributes, vars, unsubscribe_url }.
 * opts.html escapes values; opts.roots replaces the allowed top-level names.
 * Returns { text, missing: [paths], unknown: [paths] }.
 */
const renderTemplate = (template, ctx, opts) => {
  const html = !!(opts && opts.html)
  const roots = opts && opts.roots
  const missing = {}
  const unknown = {}
  const text = `${template || ''}`.replace(PLACEHOLDER, (match, path, fallback) => {
    const { known, value } = lookup(ctx || {}, path, roots)
    if (!known) {
      unknown[path] = true
      return match
    }
    let out
    if (value === undefined || value === null || value === '') {
      if (fallback === undefined) {
        missing[path] = true
        out = ''
      } else {
        out = fallback.replace(/\\(.)/g, '$1')
      }
    } else {
      out = stringify(value)
    }
    return html ? escapeHtml(out) : out
  })
  return { text, missing: Object.keys(missing), unknown: Object.keys(unknown) }
}

/** Render a campaign's subject and body for one subscriber record. `extra` adds ctx values. */
const renderCampaign = (campaign, subscriber, extra) => {
  const { parseJson } = require('./contacts.js')
  const ctx = {
    name: subscriber ? subscriber.getString('name') : '',
    email: subscriber ? subscriber.getString('email') : '',
    attributes: subscriber ? parseJson(subscriber.getString('attributes'), {}) : {},
    vars: parseJson(campaign.getString('vars'), {}),
    ...(extra || {}),
  }
  const subject = renderTemplate(campaign.getString('subject'), ctx)
  const body = renderTemplate(campaign.getString('body'), ctx, { html: true })
  const uniq = (a, b) => a.concat(b.filter((x) => a.indexOf(x) < 0))
  return {
    subject: subject.text,
    body: body.text,
    missing: uniq(subject.missing, body.missing),
    unknown: uniq(subject.unknown, body.unknown),
  }
}

module.exports = { renderTemplate, renderCampaign, escapeHtml }
