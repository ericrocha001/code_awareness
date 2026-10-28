const { app } = require('electron')
const fs = require('node:fs')
app.setPath('userData', process.argv[4])
app.whenReady().then(() => {
  try { fs.writeFileSync(process.argv[5], JSON.stringify(require(process.argv[2]).readHistory(process.argv[3]))); app.exit(0) }
  catch (error) { console.error(error); app.exit(1) }
})
