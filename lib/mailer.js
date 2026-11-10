// Sending. Mail goes through the host's own mailer ($app.newMailClient()), so
// it uses the host's SMTP settings and sender unless pocketpistol.config.js
// overrides them:
//
//   mail: { from: { address, name }, perMinute: 60, maxAttempts: 3 }
//
// Flow: send_campaign queues one pp_sends row per mailable subscriber in the
// campaign's segment, then a cron (index.js) drains up to `perMinute` rows each
// minute. Each row is re-checked before sending, so an unsubscribe or a
// suppression after queueing still wins. Every message gets a signed
// unsubscribe link and RFC 8058 one-click List-Unsubscribe headers.

const { parseJson } = require('./contacts.js')
const segments = require('./segments.js')
const render = require('./render.js')
const meta = require('./meta.js')

const LOCK_KEY = 'pocketpistol:draining'
const LOCK_MS = 5 * 60 * 1000

const clamp = (n, lo, hi, fallback) => Math.max(lo, Math.min(hi, parseInt(n, 10) || fallback))

/** Mail settings: config overrides, else the host's sender settings. */
const mailSettings = () => {
  const cfg = require('./sources.js').loadConfig().mail || {}
  const hostMeta = $app.settings().meta
  const from = cfg.from || {}
  return {
    from: { address: from.address || hostMeta.senderAddress, name: from.name || hostMeta.senderName },
    perMinute: clamp(cfg.perMinute, 1, 1000, 60),
    maxAttempts: clamp(cfg.maxAttempts, 1, 10, 3),
  }
}

/** The host's public URL, needed for unsubscribe links. */
const appUrl = () => {
  const url = `${$app.settings().meta.appURL || ''}`.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) {
    throw new Error('Set the Application URL in PocketBase settings first; unsubscribe links need it.')
  }
  return url
}

const sign = (subscriberId) => $security.hs256(`unsubscribe:${subscriberId}`, meta.linkSecret())

const unsubscribeUrl = (subscriberId) =>
  `${appUrl()}/pocketpistol/unsubscribe?s=${encodeURIComponent(subscriberId)}&t=${sign(subscriberId)}`

const verifyToken = (subscriberId, token) =>
  !!subscriberId && !!token && $security.equal(sign(`${subscriberId}`), `${token}`)

const FOOTER = (url) =>
  `<p style="margin-top:32px;font-size:12px;color:#888"><a href="${render.escapeHtml(url)}" style="color:#888">Unsubscribe</a></p>`

/**
 * Subject, HTML and headers for one subscriber. Adds an unsubscribe footer
 * unless the body already uses {{unsubscribe_url}}.
 */
const buildMessage = (campaign, subscriber, unsubUrl) => {
  const out = render.renderCampaign(campaign, subscriber, { unsubscribe_url: unsubUrl })
  const usesLink = /\{\{\s*unsubscribe_url\b/.test(campaign.getString('body'))
  return {
    subject: out.subject,
    html: usesLink ? out.body : out.body + FOOTER(unsubUrl),
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    missing: out.missing,
    unknown: out.unknown,
  }
}

const deliver = (settings, to, msg) => {
  if (!settings.from.address) throw new Error('No sender address: set one in PocketBase mail settings or mail.from.')
  $app.newMailClient().send(
    new MailerMessage({
      from: settings.from,
      to: [{ address: to }],
      subject: msg.subject,
      html: msg.html,
      headers: msg.headers,
    })
  )
}

const findCampaign = (id) => {
  try {
    return $app.findRecordById('pp_campaigns', `${id || ''}`)
  } catch (_) {
    throw new Error(`Campaign "${id}" not found. Use list_campaigns to see ids.`)
  }
}

/**
 * Send a campaign to test addresses only. Renders it as one real subscriber
 * (by email, else the newest mailable one in its audience). The unsubscribe
 * link in a test points nowhere real. Records nothing in pp_sends.
 */
const sendTest = (campaignId, to, asEmail) => {
  const campaign = findCampaign(campaignId)
  const list = (Array.isArray(to) ? to : [to]).map((a) => `${a || ''}`.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0 || list.length > 10) throw new Error('Give 1-10 test addresses in "to".')
  let subscriber = null
  if (asEmail) {
    try {
      subscriber = $app.findFirstRecordByData('pp_subscribers', 'email', `${asEmail}`.trim().toLowerCase())
    } catch (_) {
      throw new Error(`No subscriber ${asEmail}.`)
    }
  } else {
    const sample = segments.previewSegment(parseJson(campaign.getString('segment'), {}), 1).sample
    if (sample.length > 0) subscriber = $app.findRecordById('pp_subscribers', sample[0].id)
  }
  const msg = buildMessage(campaign, subscriber, `${appUrl()}/pocketpistol/unsubscribe?test=1`)
  msg.subject = `[TEST] ${msg.subject}`
  const settings = mailSettings()
  list.forEach((addr) => deliver(settings, addr, msg))
  return {
    sent_to: list,
    rendered_as: subscriber ? subscriber.getString('email') : null,
    subject: msg.subject,
    missing: msg.missing,
    unknown: msg.unknown,
  }
}

const nowSql = `strftime('%Y-%m-%d %H:%M:%fZ', 'now')`

/** Counts of a campaign's sends by status. */
const campaignStats = (campaignId) => {
  const rows = arrayOf(new DynamicModel({ status: '', n: 0 }))
  $app
    .db()
    .newQuery('SELECT status, COUNT(*) AS n FROM pp_sends WHERE campaign = {:c} GROUP BY status')
    .bind({ c: campaignId })
    .all(rows)
  const out = { queued: 0, sent: 0, failed: 0, skipped: 0 }
  rows.forEach((r) => (out[r.status] = r.n))
  return out
}

/**
 * Queue a draft campaign: one pp_sends row per mailable subscriber in its
 * segment, then status 'sending'. The cron sends them.
 */
const queueCampaign = (campaignId) => {
  const campaign = findCampaign(campaignId)
  if (campaign.getString('status') !== 'draft') {
    throw new Error(`Campaign is "${campaign.getString('status')}"; only drafts can be sent.`)
  }
  if (!campaign.getString('subject').trim()) throw new Error('Campaign has no subject.')
  appUrl() // fail early without an app URL
  if (!mailSettings().from.address) throw new Error('No sender address: set one in PocketBase mail settings or mail.from.')

  const w = segments.mailableWhere(parseJson(campaign.getString('segment'), {}))
  let queued = 0
  $app.runInTransaction((txApp) => {
    txApp
      .db()
      .newQuery(
        `INSERT OR IGNORE INTO pp_sends (id, campaign, subscriber, email, status, attempts, error, sent_at, created, updated)
         SELECT substr(lower(hex(randomblob(8))), 1, 15), {:campaign}, s.id, s.email, 'queued', 0, '', '', ${nowSql}, ${nowSql}
         FROM pp_subscribers s WHERE ${w.sql}`
      )
      .bind({ ...w.params, campaign: campaign.id })
      .execute()
    queued = txApp.countRecords('pp_sends', $dbx.hashExp({ campaign: campaign.id, status: 'queued' }))
    if (queued === 0) throw new Error('The segment reaches no mailable subscribers. Check it with preview_segment.')
    const c = txApp.findRecordById('pp_campaigns', campaign.id)
    c.set('status', 'sending')
    c.set('queued_at', new DateTime())
    txApp.save(c)
  })
  const perMinute = mailSettings().perMinute
  return { campaign_id: campaign.id, queued, per_minute: perMinute, estimated_minutes: Math.ceil(queued / perMinute) }
}

/** Why a subscriber can't be mailed now, or null. */
const skipReason = (s) => {
  if (!s) return 'subscriber deleted'
  if (s.getString('status') !== 'active') return s.getString('status') || 'not active'
  if (s.getBool('source_suppressed')) return 'suppressed by source'
  return null
}

/**
 * Send up to `limit` (default: perMinute) queued messages from campaigns that
 * are sending. Marks campaigns sent once nothing is left queued. Called every
 * minute by the cron; one run at a time.
 */
const drainQueue = (limit) => {
  const store = $app.store()
  const now = Date.now()
  const lockedAt = store.get(LOCK_KEY)
  if (lockedAt && now - lockedAt < LOCK_MS) return { skipped_run: 'another run is in progress' }
  store.set(LOCK_KEY, now)
  try {
    return drain(limit)
  } finally {
    store.remove(LOCK_KEY)
  }
}

const drain = (limit) => {
  const settings = mailSettings()
  limit = clamp(limit, 1, 1000, settings.perMinute)
  const out = { sent: 0, failed: 0, retrying: 0, skipped: 0, completed: [] }

  const rows = arrayOf(new DynamicModel({ id: '' }))
  $app
    .db()
    .newQuery(
      `SELECT d.id FROM pp_sends d JOIN pp_campaigns c ON c.id = d.campaign
       WHERE d.status = 'queued' AND c.status = 'sending' ORDER BY d.created, d.id LIMIT ${limit}`
    )
    .all(rows)
  if (rows.length === 0) {
    finishCampaigns(out)
    return out
  }

  const base = appUrl() // throws without an app URL; everything stays queued

  const campaigns = {}
  rows.forEach(({ id }) => {
    const send = $app.findRecordById('pp_sends', id)
    const campaignId = send.getString('campaign')
    const campaign = campaigns[campaignId] || (campaigns[campaignId] = $app.findRecordById('pp_campaigns', campaignId))
    let subscriber = null
    try {
      subscriber = $app.findRecordById('pp_subscribers', send.getString('subscriber'))
    } catch (_) {}

    const reason = skipReason(subscriber)
    if (reason) {
      send.set('status', 'skipped')
      send.set('error', reason)
      $app.save(send)
      out.skipped++
      return
    }

    try {
      const msg = buildMessage(campaign, subscriber, `${base}/pocketpistol/unsubscribe?s=${subscriber.id}&t=${sign(subscriber.id)}`)
      deliver(settings, subscriber.getString('email'), msg)
      send.set('status', 'sent')
      send.set('error', '')
      send.set('sent_at', new DateTime())
      out.sent++
    } catch (err) {
      const attempts = send.getInt('attempts') + 1
      send.set('attempts', attempts)
      send.set('error', `${(err && err.message) || err}`.slice(0, 500))
      if (attempts >= settings.maxAttempts) {
        send.set('status', 'failed')
        out.failed++
      } else {
        out.retrying++
      }
    }
    $app.save(send)
  })
  finishCampaigns(out)
  return out
}

/** Mark sending campaigns with nothing left queued as sent. */
const finishCampaigns = (out) => {
  $app.findRecordsByFilter('pp_campaigns', "status = 'sending'", '', 0, 0).forEach((c) => {
    if ($app.countRecords('pp_sends', $dbx.hashExp({ campaign: c.id, status: 'queued' })) > 0) return
    c.set('status', 'sent')
    c.set('sent_at', new DateTime())
    $app.save(c)
    out.completed.push(c.id)
  })
}

/** Stop a sending campaign: queued sends become skipped. Already-sent mail stays sent. */
const cancelSending = (campaignId) => {
  const campaign = findCampaign(campaignId)
  if (campaign.getString('status') !== 'sending') {
    throw new Error(`Campaign is "${campaign.getString('status')}"; only a sending campaign can be cancelled.`)
  }
  let cancelled = 0
  $app.runInTransaction((txApp) => {
    cancelled = txApp.countRecords('pp_sends', $dbx.hashExp({ campaign: campaign.id, status: 'queued' }))
    txApp
      .db()
      .newQuery(
        `UPDATE pp_sends SET status = 'skipped', error = 'cancelled', updated = ${nowSql}
         WHERE campaign = {:c} AND status = 'queued'`
      )
      .bind({ c: campaign.id })
      .execute()
    const c = txApp.findRecordById('pp_campaigns', campaign.id)
    c.set('status', 'cancelled')
    txApp.save(c)
  })
  return { campaign_id: campaign.id, cancelled, stats: campaignStats(campaign.id) }
}

const setStatus = (subscriber, status, note) => {
  subscriber.set('status', status)
  subscriber.set('status_note', `${note || ''}`.slice(0, 500))
  if (status === 'unsubscribed') subscriber.set('unsubscribed_at', new DateTime())
  $app.save(subscriber)
}

/**
 * Unsubscribe from a signed link. Returns { ok, email, already } or
 * { ok: false } for a bad or unknown link.
 */
const unsubscribe = (subscriberId, token, note) => {
  if (!verifyToken(subscriberId, token)) return { ok: false }
  let s
  try {
    s = $app.findRecordById('pp_subscribers', `${subscriberId}`)
  } catch (_) {
    return { ok: false }
  }
  const already = s.getString('status') === 'unsubscribed'
  if (!already) setStatus(s, 'unsubscribed', note || 'unsubscribe link')
  return { ok: true, email: s.getString('email'), already }
}

/**
 * Stop mailing an address. For the host's bounce/complaint handler, or an
 * agent. kind: 'bounce' (status bounced), 'complaint' or 'unsubscribe'
 * (status unsubscribed). Returns { found, email, status }.
 */
const suppress = (email, kind, note) => {
  const addr = `${email || ''}`.trim().toLowerCase()
  const status = kind === 'complaint' || kind === 'unsubscribe' ? 'unsubscribed' : 'bounced'
  let s
  try {
    s = $app.findFirstRecordByData('pp_subscribers', 'email', addr)
  } catch (_) {
    return { found: false, email: addr }
  }
  setStatus(s, status, note || kind || 'bounce')
  return { found: true, email: addr, status }
}

module.exports = {
  mailSettings,
  unsubscribeUrl,
  verifyToken,
  buildMessage,
  sendTest,
  queueCampaign,
  drainQueue,
  cancelSending,
  campaignStats,
  unsubscribe,
  suppress,
}
