// Runs in the browser inside the PocketBase superuser dashboard (/_/).
// `app` and `t` are globals provided by the admin UI. app.pb is already
// authenticated as the signed-in superuser.

document.head.appendChild(
  t.link({ rel: 'stylesheet', href: '/_/extensions/pocketpistol/style.css' })
)

app.store.headerLinks.push({
  href: '#/pocketpistol',
  icon: 'ri-mail-send-line',
  label: 'Pocketpistol',
})

app.routes.superuserOnly('#/pocketpistol', () => {
  const stats = t.p({ className: 'pp-stats' }, 'Loading…')

  const count = (name, filter) =>
    app.pb
      .collection(name)
      .getList(1, 1, { filter, fields: 'id', $autoCancel: false })
      .then((r) => r.totalItems)

  Promise.all([
    count('subscribers', 'status = "active"'),
    count('campaigns', ''),
  ])
    .then(([subscribers, campaigns]) => {
      stats.textContent = `${subscribers} active subscribers · ${campaigns} campaigns`
    })
    .catch((err) => {
      stats.textContent = `Couldn't load stats: ${err.message}`
    })

  return t.div(
    { className: 'page pp-page' },
    t.h1(null, 'Pocketpistol'),
    stats
  )
})
