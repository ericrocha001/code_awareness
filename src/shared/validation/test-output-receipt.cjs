const { createHash } = require('node:crypto')

function receiptDigest(receipt) {
  const { digest, registration, ...execution } = receipt
  return createHash('sha256').update(JSON.stringify(execution)).digest('hex')
}

module.exports = { receiptDigest }
