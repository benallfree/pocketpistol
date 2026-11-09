// Pocketpistol: drop-in bulk mail for an existing PocketBase.
//
// Install in the host app:
//   npm i github:benallfree/pocketpistol
//   echo "require('pocketpistol')" > pb_hooks/pocketpistol.pb.js
//
// Loaded from a *.pb.js file, this module registers Pocketpistol's hooks.
// PocketBase runs every handler in a separate runtime that can't see this
// file's variables, so each handler re-requires 'pocketpistol' and calls into
// it. Loaded inside a handler (where onBootstrap doesn't exist), it only
// exports the API.

const isInHandler = typeof onBootstrap === 'undefined'

if (!isInHandler) {
  // Schema: Pocketpistol's pp_* collections, imported on every boot. The import
  // is transactional and idempotent, and deleteMissing=false means it never
  // touches the host's collections. A conflict or failure disables Pocketpistol
  // instead of stopping the host (lib/install.js).
  onBootstrap((e) => {
    e.next()
    require('pocketpistol').installSchema(e.app)
  })

  // Admin UI extension: serves this package's admin/ at /_/extensions/pocketpistol/
  // $app.onServe().bindFunc runs in this loading runtime (not an isolated
  // handler runtime), so it can use this module's variables, and a bare
  // require('pocketpistol') here would resolve from the package's own folder.
  const adminDir = `${__dirname}/admin`
  $app.onServe().bindFunc((e) => {
    if (!e.uiExtensions) {
      console.warn('Pocketpistol: admin UI extensions need PocketBase 0.37+. Admin page disabled.')
      return e.next()
    }
    e.uiExtensions.push({ name: 'pocketpistol', fs: $os.dirFS(adminDir) })
    e.next()
  })

  // Source sync: mirror the host collections named in pocketpistol.config.js.
  // Hooks are bound to the collections present in the config at boot; restart
  // after adding a source.
  let collections = []
  try {
    const watched = require('./lib/sources.js').watchedCollections()
    collections = watched.direct.concat(watched.related.filter((c) => watched.direct.indexOf(c) < 0))
  } catch (err) {
    console.error(`Pocketpistol: source sync disabled, invalid pocketpistol.config.js: ${err}`)
  }
  if (collections.length > 0) {
    onRecordAfterCreateSuccess((e) => {
      e.next()
      require('pocketpistol').sources.onRecordEvent(e, 'save')
    }, ...collections)
    onRecordAfterUpdateSuccess((e) => {
      e.next()
      require('pocketpistol').sources.onRecordEvent(e, 'save')
    }, ...collections)
    onRecordAfterDeleteSuccess((e) => {
      e.next()
      require('pocketpistol').sources.onRecordEvent(e, 'delete')
    }, ...collections)
  }

  // Contact API for sources outside this app. Superuser auth for now; scoped
  // API tokens later. Errors come back as 400 with a message, and 503 while
  // Pocketpistol is disabled.
  routerAdd(
    'PUT',
    '/api/pocketpistol/contacts/{source}/{externalId}',
    (e) => {
      const { contacts, disabledReason } = require('pocketpistol')
      const off = disabledReason()
      if (off) return e.json(503, { message: `Pocketpistol is disabled: ${off}` })
      try {
        const out = contacts.upsertContact(
          $app,
          e.request.pathValue('source'),
          e.request.pathValue('externalId'),
          e.requestInfo().body
        )
        return e.json(200, out)
      } catch (err) {
        return e.json(400, { message: contacts.errorText(err) })
      }
    },
    $apis.requireSuperuserAuth()
  )

  routerAdd(
    'POST',
    '/api/pocketpistol/contacts/batch',
    (e) => {
      const { contacts, disabledReason } = require('pocketpistol')
      const off = disabledReason()
      if (off) return e.json(503, { message: `Pocketpistol is disabled: ${off}` })
      try {
        const body = e.requestInfo().body
        return e.json(200, contacts.upsertContacts(body.source, body.contacts))
      } catch (err) {
        return e.json(400, { message: contacts.errorText(err) })
      }
    },
    $apis.requireSuperuserAuth()
  )

  routerAdd(
    'DELETE',
    '/api/pocketpistol/contacts/{source}/{externalId}',
    (e) => {
      const { contacts, disabledReason } = require('pocketpistol')
      const off = disabledReason()
      if (off) return e.json(503, { message: `Pocketpistol is disabled: ${off}` })
      try {
        return e.json(200, contacts.deleteContact(e.request.pathValue('source'), e.request.pathValue('externalId')))
      } catch (err) {
        return e.json(400, { message: contacts.errorText(err) })
      }
    },
    $apis.requireSuperuserAuth()
  )

  // TODO: cron that drains the send queue
  // cronAdd('pocketpistol-send', '* * * * *', () => {
  //   require('pocketpistol').mailer.drainQueue()
  // })
}

const install = require('./lib/install.js')

module.exports = {
  ADMIN_DIR: `${__dirname}/admin`,
  installSchema: install.installSchema,
  disabledReason: install.disabledReason,
  mcpTools: (opts) => require('./lib/tools.js').mcpTools(opts),
  contacts: require('./lib/contacts.js'),
  sources: require('./lib/sources.js'),
  mailer: require('./lib/mailer.js'),
}
