import type { ChannelActivityState, ChannelFunctionalHealth } from './channel-types'

export type ChannelAvailability = 'DISABLED' | 'SETUP_REQUIRED' | 'WAITING_FOR_PROJECT' | 'CONNECTING' | 'READY' | 'OFFLINE' | 'ERROR'

export interface ChannelState {
  revision: number
  availability: ChannelAvailability
  remoteAccessEnabled: boolean
  installationConfigured: boolean
  transport: 'relay' | 'ngrok'
  connectionStatus: string
  mcpStatus: string
  activeProject: { id: string; name: string } | null
  lastError: string | null
  functionalHealth: ChannelFunctionalHealth
  activity: ChannelActivityState
}
