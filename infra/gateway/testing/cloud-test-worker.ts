import { gatewayFor, relayUpgrade } from '../cloudflare/worker'
import type { RelayEnvironment } from '../cloudflare/installation-relay'
import type { VerifiedExternalIdentity } from '../domain/external-identity-resolver'
export { InstallationRelay } from '../cloudflare/installation-relay'

export default {
  async fetch(request: Request, env: RelayEnvironment): Promise<Response> {
    const relay = await relayUpgrade(request, env)
    if (relay) return relay
    return gatewayFor(env, `${new URL(request.url).origin}/mcp`, {
      async verify(assertion): Promise<VerifiedExternalIdentity> {
        if (!['user-a', 'user-b'].includes(assertion)) throw new Error('UNAUTHORIZED')
        return { issuer: 'https://test.cloudflareaccess.com', subject: assertion }
      }
    }).fetch(request)
  }
}
