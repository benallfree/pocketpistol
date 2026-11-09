// Sources: host collections mirrored into pp_subscribers, configured in the
// host's pb_hooks/pocketpistol.config.js:
//
//   module.exports = {
//     sources: {
//       users: {                                  // source name (stored on each contact)
//         collection: 'users',
//         contact: (record, app) => ({            // or null to leave this record out
//           email, name, tags: [...], attributes: {...}, suppressed: false,
//         }),
//         related: {                              // optional: re-sync the owner when these change
//           projects: (record) => record.getString('owner'),
//         },
//       },
//     },
//   }
//
// index.js registers after-success record hooks for every source and related
// collection. Hooks run in isolated runtimes, so the handlers re-read the config
// here instead of closing over it. A sync failure is logged and never fails the
// host's own save.

const contacts = require('./contacts.js')

const CONFIG_FILE = 'pocketpistol.config.js'

const configPath = () => `${__hooks}/${CONFIG_FILE}`

/** The host's config, or an empty one when there's no config file. */
const loadConfig = () => {
  try {
    $os.stat(configPath())
  } catch (_) {
    return { sources: {} }
  }
  const cfg = require(configPath()) || {}
  return { ...cfg, sources: cfg.sources || {} }
}

/** [name, source] pairs, validated. Throws on a broken config. */
const listSources = () => {
  const { sources } = loadConfig()
  return Object.keys(sources).map((name) => {
    const src = sources[name] || {}
    if (!src.collection) throw new Error(`Pocketpistol source "${name}": "collection" is required.`)
    if (typeof src.contact !== 'function') throw new Error(`Pocketpistol source "${name}": "contact" must be a function.`)
    return [name, src]
  })
}

/** Collection names whose record hooks Pocketpistol needs. Read at load time. */
const watchedCollections = () => {
  const direct = {}
  const related = {}
  listSources().forEach(([, src]) => {
    direct[src.collection] = true
    Object.keys(src.related || {}).forEach((c) => (related[c] = true))
  })
  return { direct: Object.keys(direct), related: Object.keys(related) }
}

const logError = (app, msg, err, data) => {
  app.logger().error(`pocketpistol: ${msg}`, 'error', contacts.errorText(err), ...(data || []))
}

/**
 * Sync one host record into its contact. Returns 'upserted', 'removed' or
 * 'excluded' (contact() returned null and there was no contact to remove).
 */
const syncRecord = (app, name, src, record) => {
  const data = src.contact(record, app)
  if (!data) {
    return contacts.deleteContact(name, record.id, app).deleted ? 'removed' : 'excluded'
  }
  contacts.upsertContact(app, name, record.id, data)
  return 'upserted'
}

/** Find a record by id, or null. */
const findById = (app, collection, id) => {
  if (!id) return null
  try {
    return app.findRecordById(collection, id)
  } catch (_) {
    return null
  }
}

/**
 * Handler for after-success create/update/delete on any watched collection.
 * `kind` is 'save' or 'delete'.
 */
const onRecordEvent = (e, kind) => {
  const app = e.app
  if (require('./install.js').disabledReason(app)) return // logged at boot
  const record = e.record
  const collection = record.collection().name

  let sources
  try {
    sources = listSources()
  } catch (err) {
    return logError(app, 'invalid config', err)
  }

  sources.forEach(([name, src]) => {
    // The record itself is a source record.
    if (src.collection === collection) {
      try {
        if (kind === 'delete') contacts.deleteContact(name, record.id, app)
        else syncRecord(app, name, src, record)
      } catch (err) {
        logError(app, `sync failed for ${collection}/${record.id}`, err, ['source', name])
      }
    }

    // The record is related to a source record: re-sync its owner(s).
    const ownerOf = src.related && src.related[collection]
    if (typeof ownerOf === 'function') {
      const owners = {}
      try {
        owners[ownerOf(record)] = true
        const original = kind === 'save' ? record.original() : null
        if (original && original.id) owners[ownerOf(original)] = true // owner changed
      } catch (err) {
        return logError(app, `related lookup failed for ${collection}/${record.id}`, err, ['source', name])
      }
      Object.keys(owners).forEach((ownerId) => {
        const owner = findById(app, src.collection, ownerId)
        if (!owner) return
        try {
          syncRecord(app, name, src, owner)
        } catch (err) {
          logError(app, `sync failed for ${src.collection}/${ownerId}`, err, ['source', name])
        }
      })
    }
  })
}

const PAGE = 500

/**
 * Re-sync every record of one source (or all sources), and remove contacts
 * whose source record no longer exists. Use after changing the config.
 */
const resync = (app, only) => {
  app = app || $app
  require('./install.js').assertEnabled(app)
  const results = []
  listSources().forEach(([name, src]) => {
    if (only && only !== name) return
    const out = { source: name, upserted: 0, removed: 0, excluded: 0, failed: [] }
    const seen = {}
    for (let offset = 0; ; offset += PAGE) {
      const page = app.findRecordsByFilter(src.collection, '', 'id', PAGE, offset)
      page.forEach((record) => {
        seen[record.id] = true
        try {
          out[syncRecord(app, name, src, record)]++
        } catch (err) {
          if (out.failed.length < 50) out.failed.push({ id: record.id, error: contacts.errorText(err) })
        }
      })
      if (page.length < PAGE) break
    }
    // Contacts left over from deleted source records.
    app.findRecordsByFilter('pp_subscribers', 'source = {:source}', '', 0, 0, { source: name }).forEach((r) => {
      if (seen[r.getString('external_id')]) return
      app.delete(r)
      out.removed++
    })
    results.push(out)
  })
  if (only && results.length === 0) throw new Error(`No source named "${only}" in ${CONFIG_FILE}.`)
  return results
}

module.exports = { CONFIG_FILE, loadConfig, listSources, watchedCollections, onRecordEvent, resync }
