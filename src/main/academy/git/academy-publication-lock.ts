import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export async function withPublicationLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'publication.lock')
  const acquire = (target: string) => {
    const prepared = `${target}.${randomUUID()}`
    const file = openSync(prepared, 'wx')
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid })); fsyncSync(file)
      linkSync(prepared, target)
      return file
    } catch (error) { closeSync(file); throw error } finally { unlinkSync(prepared) }
  }
  const assertAbandoned = (target: string) => {
    const owner = JSON.parse(readFileSync(target, 'utf8')) as { pid: number }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('PUBLICATION_LOCK_UNVERIFIABLE')
    try { process.kill(owner.pid, 0); throw new Error('PUBLICATION_BUSY') } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
    }
  }
  const acquireRecoverable = (target: string, depth = 0): number => {
    if (depth > 8) throw new Error('PUBLICATION_LOCK_UNVERIFIABLE')
    try { return acquire(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const recoveryPath = `${target}.recovery`
      const recovery = acquireRecoverable(recoveryPath, depth + 1)
      try {
        try { assertAbandoned(target) } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe }
        const abandoned = `${target}.${randomUUID()}`
        try { renameSync(target, abandoned); unlinkSync(abandoned) } catch (move) { if ((move as NodeJS.ErrnoException).code !== 'ENOENT') throw move }
        return acquire(target)
      } finally { closeSync(recovery); unlinkSync(recoveryPath) }
    }
  }
  const descriptor = acquireRecoverable(path)
  try {
    return await operation()
  } finally { closeSync(descriptor); unlinkSync(path) }
}
