// Schema install with a guard: Pocketpistol must never stop the host app from
// starting. Before importing, check that no host collection uses one of our
// collection names or ids. On a conflict or a failed import, log why and
// disable Pocketpistol (sync hooks, routes and tools refuse to run); the host
// keeps running.
//
// The reason is kept in $app.store(), which every runtime shares.

const STORE_KEY = 'pocketpistol:disabled'

/** Host collections that clash with ours, as readable messages. */
const findConflicts = (app, ours) => {
  const ourIdToName = {}
  const ourNameToId = {}
  ours.forEach((c) => {
    ourIdToName[c.id] = c.name
    ourNameToId[c.name] = c.id
  })
  const conflicts = []
  app.findAllCollections().forEach((c) => {
    const id = c.id
    const name = c.name
    if (ourIdToName[id] === name) return // one of ours, already installed
    if (ourIdToName[id] !== undefined) conflicts.push(`collection "${name}" uses Pocketpistol's id "${id}"`)
    if (ourNameToId[name] !== undefined) conflicts.push(`collection "${name}" (id "${id}") uses Pocketpistol's name "${name}"`)
    if (ourIdToName[name] !== undefined) conflicts.push(`collection "${name}" is named like Pocketpistol's id "${name}"`)
    if (ourNameToId[id] !== undefined) conflicts.push(`collection "${name}" has an id equal to Pocketpistol's name "${id}"`)
  })
  return conflicts
}

/** Import the schema. Returns null on success, or the reason Pocketpistol is disabled. */
const installSchema = (app) => {
  const { collections } = require('./schema.js')
  let reason = null
  try {
    const conflicts = findConflicts(app, collections)
    if (conflicts.length > 0) {
      reason = `schema conflict: ${conflicts.join('; ')}. Rename or remove those collections, then restart.`
    } else {
      app.importCollections(collections, false)
    }
  } catch (err) {
    reason = `schema import failed: ${(err && err.message) || err}`
  }
  if (reason) {
    app.store().set(STORE_KEY, reason)
    app.logger().error(`pocketpistol: disabled, ${reason}`)
    console.error(`Pocketpistol is disabled: ${reason}`)
  } else {
    app.store().remove(STORE_KEY)
  }
  return reason
}

/** Why Pocketpistol is disabled, or null when it's working. */
const disabledReason = (app) => {
  const v = (app || $app).store().get(STORE_KEY)
  return v ? `${v}` : null
}

/** Throw if Pocketpistol is disabled. */
const assertEnabled = (app) => {
  const reason = disabledReason(app)
  if (reason) throw new Error(`Pocketpistol is disabled: ${reason}`)
}

module.exports = { installSchema, disabledReason, assertEnabled, findConflicts }
