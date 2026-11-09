import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ChannelUsageStore } from './channel-usage-store'

mkdirSync(dirname(workerData.path), { recursive: true })
const store = new ChannelUsageStore(workerData.path)
parentPort!.on('message', message => {
  try {
    if (message.type === 'query') store.touch(message.runId, message.asOf)
    const value = message.type === 'write' ? store.write(message.batch) : store.query(message.query, message.asOf)
    parentPort!.postMessage({ id: message.id, value })
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error && /^USAGE_[A-Z_]+$/.test(error.message) ? error.message : 'USAGE_STORAGE_UNAVAILABLE' })
  }
})
