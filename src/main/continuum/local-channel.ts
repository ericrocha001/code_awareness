import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { ContinuumLocalAdapter } from './local-adapter'
import type { RepositoryContinuumSession } from './project-continuum-session'
export { LOCAL_MAX_BYTES, LOCAL_TIMEOUT_MS } from '../local-agent-channel/local-channel-host'

export class ContinuumLocalChannel extends LocalChannelHost {
  constructor(session: RepositoryContinuumSession, profile: string) {
    super([new ContinuumLocalAdapter(session)], profile)
  }
}
