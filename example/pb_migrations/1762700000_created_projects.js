/// <reference path="../pb_data/types.d.ts" />
// The example host's own collection, used by pocketpistol.config.js.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId('users')
    const collection = new Collection({
      type: 'base',
      name: 'projects',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'owner', type: 'relation', collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      ],
    })
    return app.save(collection)
  },
  (app) => app.delete(app.findCollectionByNameOrId('projects'))
)
