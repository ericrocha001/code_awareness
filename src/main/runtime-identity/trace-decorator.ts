import type { ChannelTraceEvent, ChannelTraceSink } from '../../shared/types/channel-types'
import type { RuntimeIdentityProvider } from './runtime-identity-provider'

export function createDecoratedTraceSink(
  sink: ChannelTraceSink,
  provider: RuntimeIdentityProvider
): ChannelTraceSink {
  return {
    record(event: ChannelTraceEvent): void {
      if (!event.runtimeInstanceId) {
        event.runtimeInstanceId = provider.getInstanceId()
      }
      sink.record(event)
    }
  }
}
