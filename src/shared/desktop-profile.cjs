const { join } = require('node:path')

const DESKTOP_APP_NAME = 'code-awareness'

function desktopUserData(appData) {
  return join(appData, DESKTOP_APP_NAME)
}

module.exports = { DESKTOP_APP_NAME, desktopUserData }
