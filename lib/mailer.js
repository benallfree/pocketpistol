// Server-side mail logic. Lives outside admin/ so it is never served publicly.

/** TODO: send queued `sends` rows in small batches. Called from cron. */
const drainQueue = () => {}

/** TODO: signed per-subscriber token for unsubscribe/preferences links. */
const signToken = (subscriberId) => {
  throw new Error('not implemented')
}

module.exports = { drainQueue, signToken }
