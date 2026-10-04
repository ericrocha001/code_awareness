const crypto = require('crypto')
const http = require('http')
const fs = require('fs')
const path = require('path')

const requiredEnv = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const ISSUER = requiredEnv('CODE_AWARENESS_AUTH0_ISSUER').replace(/\/?$/, '/')
const CLIENT_ID = requiredEnv('CODE_AWARENESS_AUTH0_CLIENT_ID')
const AUDIENCE = requiredEnv('CODE_AWARENESS_GATEWAY_AUDIENCE')
const SCOPE = process.env.CODE_AWARENESS_AUTH0_SCOPE?.trim() || 'openid code-awareness:read code-awareness:enroll'
const REDIRECT = process.env.CODE_AWARENESS_AUTH0_REDIRECT?.trim() || 'http://127.0.0.1:4321/callback'
const redirectUrl = new URL(REDIRECT)
if (redirectUrl.hostname !== '127.0.0.1' && redirectUrl.hostname !== 'localhost') {
  throw new Error('CODE_AWARENESS_AUTH0_REDIRECT must use a loopback host')
}
const PORT = Number(redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80))
const TOKEN_URL = new URL('oauth/token', ISSUER).toString()
const tokenFile = path.join(process.cwd(), '.auth0_token')

const verifier = crypto.randomBytes(64).toString('base64url').replace(/=+$/, '')
const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url').replace(/=+$/, '')
const state = crypto.randomBytes(16).toString('hex')

const params = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  scope: SCOPE,
  audience: AUDIENCE,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state
})
const authorizeUrl = `${ISSUER}authorize?${params}`

async function exchange(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier
  })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body
  })
  if (response.status !== 200) throw new Error(`TOKEN_ENDPOINT_${response.status}`)
  const data = await response.json()
  if (!data.access_token) throw new Error('ACCESS_TOKEN_MISSING')
  fs.writeFileSync(tokenFile, data.access_token + '\n', 'utf8')
  return data.access_token
}

function reportSanitized(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    console.log(`tokenExpired=${payload.exp ? (payload.exp < now ? 'true' : 'false') : 'n/a'}`)
    console.log(`issuerValid=${payload.iss === ISSUER ? 'true' : 'false'}`)
    console.log(`audienceValid=${Array.isArray(payload.aud) && payload.aud.includes(AUDIENCE) ? 'true' : 'false'}`)
    const scopes = (payload.scope || '').split(' ')
    console.log(`requiredScopePresent=${['code-awareness:read', 'code-awareness:enroll'].every((s) => scopes.includes(s)) ? 'true' : 'false'}`)
  } catch {
    console.log('tokenExpired=n/a')
    console.log('issuerValid=n/a')
    console.log('audienceValid=n/a')
    console.log('requiredScopePresent=n/a')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT)
  const code = url.searchParams.get('code')
  const gotState = url.searchParams.get('state')
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  if (!code || gotState !== state) { res.writeHead(400); res.end('invalid redirect'); return }
  res.writeHead(200)
  res.end('Login completado. Puedes cerrar esta pestanha.')
  server.close()
  try {
    const token = await exchange(code)
    reportSanitized(token)
    console.log('tokenRenovado=true')
  } catch (error) {
    console.log(`tokenRenovado=false motivo=${error.message}`)
  }
  process.exit(0)
})

server.listen(PORT, '127.0.0.1')
console.log(`AUTHORIZE_URL=${authorizeUrl}`)
console.log('ESPERANDO_LOGIN')