// Campaigns: a subject, an HTML body with merge fields (lib/render.js), an
// audience segment (lib/segments.js) and campaign-wide vars. Only drafts can be
// edited. Nothing here sends mail.

const { parseJson } = require('./contacts.js')
const segments = require('./segments.js')
const render = require('./render.js')

const campaignJson = (r) => ({
  id: r.id,
  subject: r.getString('subject'),
  status: r.getString('status'),
  segment: parseJson(r.getString('segment'), {}),
  vars: parseJson(r.getString('vars'), {}),
  sent_at: r.getString('sent_at'),
  created: r.getString('created'),
  updated: r.getString('updated'),
})

const findCampaign = (id) => {
  try {
    return $app.findRecordById('pp_campaigns', `${id || ''}`)
  } catch (_) {
    throw new Error(`Campaign "${id}" not found. Use list_campaigns to see ids.`)
  }
}

const checkVars = (vars) => {
  if (vars === undefined || vars === null) return {}
  if (typeof vars !== 'object' || Array.isArray(vars)) throw new Error('vars must be an object of name: value.')
  return vars
}

/** Apply the editable fields present in `data`. */
const applyFields = (r, data) => {
  if (data.subject !== undefined) {
    const subject = `${data.subject || ''}`.trim()
    if (!subject) throw new Error('subject must not be empty.')
    r.set('subject', subject)
  }
  if (data.body !== undefined) r.set('body', `${data.body || ''}`)
  if (data.segment !== undefined) r.set('segment', segments.normalizeSegment(data.segment))
  if (data.vars !== undefined) r.set('vars', checkVars(data.vars))
}

/** Create a draft. Returns the campaign plus its audience counts. */
const createCampaign = (data) => {
  data = data || {}
  const r = new Record($app.findCollectionByNameOrId('pp_campaigns'))
  r.set('status', 'draft')
  r.set('segment', segments.normalizeSegment({}))
  r.set('vars', {})
  applyFields(r, {
    subject: data.subject === undefined ? '' : data.subject, // required
    body: data.body,
    segment: data.segment,
    vars: data.vars,
  })
  $app.save(r)
  return getCampaign(r.id)
}

/** Change a draft's subject, body, segment or vars. Omitted fields stay as they are. */
const updateCampaign = (id, data) => {
  const r = findCampaign(id)
  if (r.getString('status') !== 'draft') {
    throw new Error(`Campaign is "${r.getString('status')}"; only drafts can be edited.`)
  }
  applyFields(r, data || {})
  $app.save(r)
  return getCampaign(r.id)
}

/** The full campaign, including the body and who its segment reaches. */
const getCampaign = (id) => {
  const r = findCampaign(id)
  const audience = segments.previewSegment(parseJson(r.getString('segment'), {}), 0)
  return {
    ...campaignJson(r),
    body: r.getString('body'),
    audience: { matched: audience.matched, mailable: audience.mailable, excluded: audience.excluded },
  }
}

/**
 * Render a campaign for one subscriber: by subscriber id or email, otherwise
 * the newest mailable subscriber in its audience. Reports missing merge fields.
 */
const previewCampaign = (id, who) => {
  const campaign = findCampaign(id)
  who = who || {}
  let subscriber = null
  if (who.subscriber_id || who.email) {
    try {
      subscriber = who.subscriber_id
        ? $app.findRecordById('pp_subscribers', `${who.subscriber_id}`)
        : $app.findFirstRecordByData('pp_subscribers', 'email', `${who.email}`.trim().toLowerCase())
    } catch (_) {
      throw new Error(`No subscriber ${who.subscriber_id || who.email}.`)
    }
  } else {
    const sample = segments.previewSegment(parseJson(campaign.getString('segment'), {}), 1).sample
    if (sample.length > 0) subscriber = $app.findRecordById('pp_subscribers', sample[0].id)
  }
  const out = render.renderCampaign(campaign, subscriber)
  return {
    campaign_id: campaign.id,
    subscriber: subscriber ? { id: subscriber.id, email: subscriber.getString('email') } : null,
    ...out,
  }
}

const listCampaigns = (limit) =>
  $app.findRecordsByFilter('pp_campaigns', '', '-created', limit, 0).map(campaignJson)

module.exports = { campaignJson, createCampaign, updateCampaign, getCampaign, previewCampaign, listCampaigns }
