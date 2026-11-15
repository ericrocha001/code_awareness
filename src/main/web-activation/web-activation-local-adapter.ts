import type { LocalChannelAdapter } from '../local-agent-channel/local-channel-types'
import { operation } from '../local-agent-channel/local-channel-types'
import { object } from '../local-agent-channel/request-validation'
import {
  WEB_MCP_BOOTSTRAP_PROTOCOL,
  type DesktopSkillsEndpointInfo
} from './web-activation-types'

export class WebActivationLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'web_activation'
  readonly operations: LocalChannelAdapter['operations']

  constructor(private readonly ensureEndpoint: () => Promise<DesktopSkillsEndpointInfo>) {
    this.operations = {
      endpoint: operation(
        (input) => object(input, []),
        async () => {
          const info = await this.ensureEndpoint()
          return {
            protocol: WEB_MCP_BOOTSTRAP_PROTOCOL,
            ...info
          }
        }
      )
    }
  }
}
