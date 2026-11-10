// pp_meta: Pocketpistol's own key/value state.

const get = (key, fallback, app) => {
  app = app || $app
  try {
    const r = app.findFirstRecordByData('pp_meta', 'key', key)
    const v = JSON.parse(r.getString('value'))
    return v === null || v === undefined ? fallback : v
  } catch (_) {
    return fallback
  }
}

const set = (key, value, app) => {
  app = app || $app
  let r
  try {
    r = app.findFirstRecordByData('pp_meta', 'key', key)
  } catch (_) {
    r = new Record(app.findCollectionByNameOrId('pp_meta'))
    r.set('key', key)
  }
  r.set('value', value)
  app.save(r)
  return value
}

/** Secret for signing unsubscribe links. Created on first use. */
const linkSecret = (app) => {
  const existing = get('link_secret', '', app)
  if (existing) return existing
  return set('link_secret', $security.randomString(48), app)
}

module.exports = { get, set, linkSecret }
