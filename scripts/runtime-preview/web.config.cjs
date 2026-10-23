const path = require('node:path')
const { vitePreviewPlugin } = require('./cooperation.cjs')
module.exports = { root: path.join(__dirname, 'fixtures/web'), plugins: [vitePreviewPlugin()] }
