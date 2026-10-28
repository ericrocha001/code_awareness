import { z } from 'zod'
import { previewFingerprint, type PreviewProfile } from '../preview-profile'

export const standbyPolicySchema = z.object({
  idleMs: z.number().int().min(1000).max(1800000),
  maxPrivateBytes: z.number().int().min(1048576).max(64 * 1024 ** 3),
  maxWorkingSetBytes: z.number().int().min(1048576).max(64 * 1024 ** 3),
  maxCpuPercent: z.number().min(0.1).max(100),
  minAvailableBytes: z.number().int().min(0).max(64 * 1024 ** 3),
  sampleMs: z.number().int().min(1000).max(30000)
}).strict()
export type StandbyPolicy = z.infer<typeof standbyPolicySchema>

export function repositoryTrustScope(profile: PreviewProfile) {
  if (profile.runtime !== 'ELECTRON_DEV' || profile.bootstrap?.kind !== 'CODE_AWARENESS' || profile.adapter?.kind !== 'ELECTRON' ||
    profile.network.openNetworkConsent || profile.network.destinations.some(value => value !== `http://127.0.0.1:${profile.adapter!.port}`)) throw new Error('REPOSITORY_TRUST_SCOPE_UNSUPPORTED')
  return previewFingerprint({ repositoryId: profile.repositoryId, runtime: profile.runtime, runtimeVersion: profile.runtimeVersion,
    command: profile.command, env: profile.env, security: profile.security, bootstrap: profile.bootstrap, cooperation: profile.cooperation,
    resources: profile.resources, shutdown: profile.shutdown, network: { ...profile.network, destinations: ['SESSION_LOOPBACK'] },
    adapter: { ...profile.adapter, port: 0 }, abi: profile.dependencies.abi })
}

export const slotMetricsSchema = z.object({ at: z.string(), processes: z.number().int().nonnegative(),
  workingSetBytes: z.number().nonnegative(), privateWorkingSetBytes: z.number().nonnegative(), privateBytes: z.number().nonnegative(),
  cpuMs: z.number().nonnegative(), intervalMs: z.number().nonnegative(), cpuPercent: z.number().nonnegative(),
  peakPrivateBytes: z.number().nonnegative(), peakWorkingSetBytes: z.number().nonnegative(), availableBytes: z.number().nonnegative() }).strict()
export const standbySchema = z.object({ state: z.enum(['WARMING', 'QUIESCENT', 'RUNNING', 'EVICTED']), policy: standbyPolicySchema,
  expiresAt: z.string(), preparedAt: z.string().optional(), reason: z.string().optional(), metrics: slotMetricsSchema.optional(),
  observations: z.object({ state: z.enum(['CURRENT', 'SUSPECT', 'INVALID', 'UNVERIFIABLE']), epoch: z.number().int().nonnegative(), events: z.array(z.object({ origin: z.enum(['GIT', 'SOURCE', 'CORPUS']), event: z.string().max(64), path: z.string().max(240), epoch: z.number().int().nonnegative(), decision: z.enum(['NO_CHANGE', 'CHANGED', 'COVERAGE_LOST']).optional(), reason: z.string().max(128).optional() }).strict()).max(24) }).strict().optional(),
  guardMode: z.enum(['CONTINUOUS_OBSERVATION', 'FULL_RECHECK']).optional(),
  presentation: z.object({ stagesNs: z.record(z.string()).optional(), receivedNs: z.string(), guardedNs: z.string(), showNs: z.string(), functionalNs: z.string(), focusedNs: z.string(),
    durationMs: z.number().nonnegative() }).strict().optional() }).strict()
