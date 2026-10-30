import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const bootstrapFailurePhase = z.enum(['ELECTRON_BOOTSTRAP', 'CONTEXT_ACTIVATION'])
export type BootstrapFailurePhase = z.infer<typeof bootstrapFailurePhase>
export const bootstrapFailure = z.object({ sessionId: z.string().uuid(), code: z.string().regex(/^PREVIEW_[A-Z_]{1,120}$/), phase: bootstrapFailurePhase.optional() }).strict()
export async function readBootstrapFailure(directory: string, sessionId: string) {
  try {
    const file = join(directory, 'bootstrap-failure.json'), before = await lstat(file)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) return
    const handle = await open(file, 'r')
    try {
      const actual = await handle.stat()
      if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) return
      const buffer = Buffer.alloc(1025), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 1024) return
      const result = bootstrapFailure.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
      if (result.success && result.data.sessionId === sessionId) return result.data
    } finally { await handle.close() }
  } catch { }
}
