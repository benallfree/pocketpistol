// Mirrors this app's users into Pocketpistol, tagged by what they've built.
module.exports = {
  sources: {
    users: {
      collection: 'users',
      contact: (user, app) => {
        const projects = app.countRecords('projects', $dbx.hashExp({ owner: user.id }))
        return {
          email: user.email(),
          name: user.getString('name'),
          suppressed: !user.verified(),
          tags: projects > 0 ? ['has-projects'] : ['no-projects'],
          attributes: { projects },
        }
      },
      // A project changing can change its owner's tags.
      related: {
        projects: (project) => project.getString('owner'),
      },
    },
  },
}
