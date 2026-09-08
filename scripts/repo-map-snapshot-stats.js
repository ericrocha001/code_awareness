const { app } = require('electron')
const Database = require('better-sqlite3')
const { join } = require('path')

app.whenReady().then(() => {
  const database = new Database(join(process.cwd(), 'code_awareness', 'repository_model.db'), { readonly: true })
  const count = (table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  const statuses = database.prepare('SELECT status, COUNT(*) AS count FROM files GROUP BY status').all()
  const extensions = database.prepare('SELECT extension, COUNT(*) AS count FROM files GROUP BY extension ORDER BY count DESC').all()
  console.log(JSON.stringify({ files: count('files'), elements: count('elements'), relationships: count('relationships'), statuses, extensions }))
  database.close()
  app.quit()
})
