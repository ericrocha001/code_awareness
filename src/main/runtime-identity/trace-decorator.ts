import type { CodeScopeTraceEvent, CodeScopeTraceSink } from '../mcp/code-scope-health'
import type { RuntimeIdentityProvider } from './runtime-identity-provider'

export function createDecoratedTraceSink(
  sink: CodeScopeTraceSink,
  provider: RuntimeIdentityProvider
): CodeScopeTraceSink {
  return {
    record(event: CodeScopeTraceEvent): void {
      if (!event.runtimeInstanceId) {
        event.runtimeInstanceId = provider.getInstanceId()
      }
      sink.record(event)
    }
  }
}
