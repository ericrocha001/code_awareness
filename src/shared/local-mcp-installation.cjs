const { realpathSync, existsSync } = require('node:fs')
const { resolve, dirname, parse } = require('node:path')
function stableDestination(destination) {
  let ancestor = resolve(destination)
  while (!existsSync(ancestor)) {
    if (ancestor === parse(ancestor).root) throw new Error('INSTALL_DESTINATION_INVALID')
    ancestor = dirname(ancestor)
  }
  for (const candidate of [resolve(destination), realpathSync(ancestor)]) {
    if (/[\\/]worktrees?[\\/]/i.test(candidate)) throw new Error('INSTALL_DESTINATION_EPHEMERAL')
  }
  return resolve(destination)
}
module.exports = { stableDestination }
