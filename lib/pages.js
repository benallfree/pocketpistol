// Public pages (unsubscribe). Built-in templates live in the package's
// templates/ folder. A host overrides one by putting a file with the same name
// in pb_hooks/pocketpistol/templates/ (e.g. unsubscribe.html, _style.css).
//
// Templates use the same {{name}} placeholders as campaigns, with the values
// HTML-escaped; {{style}} inserts _style.css as is.

const render = require('./render.js')

const DEFAULT_DIR = `${__dirname}/../templates`
const overrideDir = () => `${__hooks}/pocketpistol/templates`

const readTemplate = (name) => {
  const dirs = [overrideDir(), DEFAULT_DIR]
  for (let i = 0; i < dirs.length; i++) {
    try {
      return toString($os.readFile(`${dirs[i]}/${name}`))
    } catch (_) {
      // try the next folder
    }
  }
  throw new Error(`Pocketpistol template ${name} not found.`)
}

/** Render a page template with ctx values (escaped). */
const page = (name, ctx) => {
  ctx = ctx || {}
  const tpl = readTemplate(name).replace(/\{\{\s*style\s*\}\}/g, () => readTemplate('_style.css'))
  return render.renderTemplate(tpl, ctx, { html: true, roots: Object.keys(ctx) }).text
}

const INVALID =
  'The link may be incomplete. Copy the whole link from the email into your browser, or reply to the email and ask to be removed.'

/**
 * Handle GET and POST /pocketpistol/unsubscribe.
 * GET shows a confirmation (link scanners prefetch GETs, so a GET never
 * unsubscribes). POST unsubscribes: the confirmation form, or a mail client's
 * RFC 8058 one-click request.
 */
const handleUnsubscribe = (e) => {
  const mailer = require('./mailer.js')
  const { disabledReason } = require('./install.js')
  const q = e.request.url.query()
  const s = q.get('s')
  const t = q.get('t')

  if (disabledReason()) {
    return e.html(503, page('link-invalid.html', { message: 'Unsubscribing is temporarily unavailable. Please try again later.' }))
  }
  if (q.get('test')) {
    return e.html(200, page('link-invalid.html', { message: "This was a test email, so this link doesn't unsubscribe anyone." }))
  }
  if (!mailer.verifyToken(s, t)) return e.html(400, page('link-invalid.html', { message: INVALID }))

  if (e.request.method === 'POST') {
    const body = e.requestInfo().body || {}
    const oneClick = `${body['List-Unsubscribe'] || ''}` === 'One-Click'
    const out = mailer.unsubscribe(s, t, oneClick ? 'one-click unsubscribe' : 'unsubscribe page')
    if (!out.ok) return e.html(400, page('link-invalid.html', { message: INVALID }))
    return e.html(200, page('unsubscribed.html', { email: out.email }))
  }

  let subscriber
  try {
    subscriber = $app.findRecordById('pp_subscribers', s)
  } catch (_) {
    return e.html(400, page('link-invalid.html', { message: INVALID }))
  }
  const email = subscriber.getString('email')
  if (subscriber.getString('status') === 'unsubscribed') return e.html(200, page('unsubscribed.html', { email }))
  const action = `/pocketpistol/unsubscribe?s=${encodeURIComponent(s)}&t=${encodeURIComponent(t)}`
  return e.html(200, page('unsubscribe.html', { email, action_url: action }))
}

module.exports = { page, handleUnsubscribe }
