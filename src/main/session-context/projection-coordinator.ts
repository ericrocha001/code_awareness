import type { McpToolResult } from '../mcp/mcp-types'

export class SessionProjectionCoordinator {
  private stopped = false
  private running = false
  private requested = false
  private failures = 0
  private continuing = false
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly reconcile: () => Promise<McpToolResult>, private readonly current: () => boolean) {}
  request = (): void => {
    if (this.stopped || !this.current()) return
    this.requested = true
    if (!this.running && !this.timer) { this.failures = 0; this.schedule(0) }
  }
  stop = (): void => {
    this.stopped = true
    this.requested = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, delay)
  }
  private async run(): Promise<void> {
    if (this.stopped || !this.current()) return
    this.running = true
    if (!this.continuing) this.requested = false
    let drainable = false
    try {
      const result = await this.reconcile()
      if (result.isError) throw new Error('PROJECTION_DEFERRED')
      const body = result.content.find(item => item.type === 'text')
      drainable = body?.type === 'text' && JSON.parse(body.text).backlog?.drainable === true
      this.failures = 0
    } catch { this.failures++ }
    finally {
      this.running = false
      if (!this.stopped && this.current() && (this.requested || drainable || this.failures > 0 && this.failures <= 3)) {
        this.continuing = drainable
        this.schedule(this.failures ? Math.min(30000, 1000 * 2 ** this.failures) : 50)
      }
    }
  }
}
