import { EventEmitter } from 'node:events'
import type { App } from 'electron'
import { expect, it, vi } from 'vitest'
import { registerApplicationShutdown } from './application-shutdown'

it('awaits cleanup once before allowing Electron to quit', async () => {
  const events = new EventEmitter()
  const finalEvent = { preventDefault: vi.fn() }
  const app = Object.assign(events, { quit: vi.fn(() => events.emit('before-quit', finalEvent)) })
  let complete!: () => void
  const dispose = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
  registerApplicationShutdown(app as unknown as App, dispose)
  const event = { preventDefault: vi.fn() }
  events.emit('before-quit', event)
  events.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(app.quit).not.toHaveBeenCalled()
  complete()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  expect(finalEvent.preventDefault).not.toHaveBeenCalled()
})
