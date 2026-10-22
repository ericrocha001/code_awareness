import { z } from 'zod'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { previewDataPolicy } from './runtime-preview/context-contract'

const text = z.string().min(1).max(1024).refine(v => !/[\0\r\n]/.test(v))
const relativePath = text.refine(v => !isAbsolute(v) && !v.split(/[\\/]/).includes('..'))
export const previewProfileSchema = z.object({
  schemaVersion: z.literal(1), profileId: text, revision: z.number().int().positive(), repositoryId: text,
  runtime: z.enum(['WEB_DEV_SERVER', 'ELECTRON_DEV']), runtimeVersion: text,
  command: z.object({ executable: text.refine(isAbsolute), executableHash: z.string().regex(/^[a-f0-9]{64}$/), args: z.array(text).max(64), cwd: relativePath,
    inputs: z.array(z.object({ path: relativePath, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(32) }).strict(),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), text),
  resources: z.array(z.object({ name: text, strategy: z.enum(['SESSION_DIRECTORY', 'SESSION_ENDPOINT', 'DISABLED']) }).strict()).min(1).max(32),
  dependencies: z.object({ packageManager: z.literal('npm'), packageManagerVersion: text, manifest: relativePath, lockfile: relativePath,
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/), lockfileHash: z.string().regex(/^[a-f0-9]{64}$/),
    abi: text, materialization: relativePath }).strict(),
  cooperation: z.object({ manifest: relativePath, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  bootstrap: previewDataPolicy.optional(),
  adapter: z.object({ version: z.literal(1), kind: z.enum(['VITE_WEB', 'NODE_WEB', 'ELECTRON']),
    port: z.number().int().min(1024).max(65535),
    configFile: relativePath, runtimeExecutable: relativePath.optional(), runtimeExecutableHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    nativeModules: z.array(z.string().regex(/^(@[a-z0-9_-]+\/)?[a-z0-9_-]+$/)).max(16),
    artifacts: z.array(z.object({ component: z.enum(['WEB', 'ELECTRON_MAIN', 'ELECTRON_PRELOAD', 'ELECTRON_RENDERER']), path: relativePath }).strict()).min(1).max(12)
  }).strict().optional(),
  security: z.object({ mode: z.enum(['profile_only', 'container', 'VM']), requirements: z.array(z.object({
    capability: z.enum(['FILESYSTEM_WRITE_SEPARATION', 'NETWORK_EGRESS_RESTRICTION', 'SECRET_ISOLATION', 'PROCESS_PRIVILEGE_SEPARATION', 'SYSTEM_RESOURCE_RESTRICTION']), guarantee: text
  }).strict()).max(32) }).strict(),
  network: z.object({ destinations: z.array(text).max(32), openNetworkConsent: z.boolean(), credentials: z.literal('TARGET_OWN_TEST_PROFILE') }).strict(),
  probes: z.object({ readiness: z.object({ kind: z.enum(['HTTP', 'COOPERATIVE_IPC']), address: text, timeoutMs: z.number().int().positive().max(120000) }).strict(),
    liveness: z.enum(['READINESS', 'COOPERATIVE_IPC']), attestation: z.enum(['NONE', 'SERVED_ARTIFACT', 'COOPERATIVE_LOADED_ARTIFACT']) }).strict(),
  shutdown: z.object({ spawn: z.enum(['JOB_LIST_AT_CREATE', 'SUSPENDED_ASSIGN_RESUME']), breakaway: z.literal(false), killOnJobClose: z.literal(true),
    graceful: z.enum(['NONE', 'SESSION_EVENT']).optional(),
    graceMs: z.number().int().nonnegative().max(120000), forceMs: z.number().int().positive().max(120000) }).strict()
}).strict()
export type PreviewProfile = z.infer<typeof previewProfileSchema>
export const previewFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const bytesFingerprint = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
