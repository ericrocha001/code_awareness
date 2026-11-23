import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ActiveProjectService } from '../core/active-project-service'
import {
  dismissSessionSourceOnboarding,
  grantSessionSourceAccess,
  inspectSessionSourceGrants,
  revokeSessionSourceAccess,
  updateLexicalIndexAccess,
  type ResolveGrantProfilesOptions
} from '../session-context/session-source-grants'

export interface SessionSourceGrantsHandlerOptions {
  baseProfile: string
  activeProjectService: Pick<ActiveProjectService, 'getState'>
  profileOptions?: ResolveGrantProfilesOptions
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registerSessionSourceGrantsHandlers(
  options: SessionSourceGrantsHandlerOptions,
  trustedUrl: string
): void {
  const trusted = (url: string) => {
    try { return new URL(url).href.split('#')[0] === new URL(trustedUrl).href.split('#')[0] }
    catch { return false }
  }

  const assertActiveRepository = (repositoryId: unknown, mutating: boolean) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('INVALID_SESSION_GRANTS_REQUEST')
    const active = options.activeProjectService.getState()
    if (!active.project || active.project.id !== repositoryId) throw new Error('REPOSITORY_MISMATCH')
    const readOnly = options.profileOptions?.readOnly === true || active.context?.mode === 'PREVIEW'
    if (mutating && readOnly) throw new Error('STORE_READ_ONLY')
    return { readOnly }
  }

  const bind = (channel: string, validateCount: (count: number) => boolean, callback: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url
      if (!validateCount(args.length) || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() || !url || !trusted(url)) {
        throw new Error('INVALID_SESSION_GRANTS_REQUEST')
      }
      return callback(...args)
    })
  }

  bind('session-grants:status', c => c >= 1 && c <= 2, (repositoryId: unknown, worktreeRoot?: unknown) => {
    if (worktreeRoot !== undefined && typeof worktreeRoot !== 'string') throw new Error('INVALID_SESSION_GRANTS_REQUEST')
    const { readOnly } = assertActiveRepository(repositoryId, false)
    return inspectSessionSourceGrants(options.baseProfile, repositoryId as string, { ...options.profileOptions, readOnly })
  })

  bind('session-grants:enable', c => c === 1, (raw: unknown) => {
    if (!isPlainObject(raw)) throw new Error('INVALID_SESSION_GRANTS_REQUEST')
    assertActiveRepository(raw.repositoryId, true)
    return grantSessionSourceAccess({
      baseProfile: options.baseProfile,
      repositoryId: raw.repositoryId as string,
      allowLexicalIndex: raw.allowLexicalIndex === true,
      ...(typeof raw.selectedCodexAccountHash === 'string' ? { selectedCodexAccountHash: raw.selectedCodexAccountHash } : {}),
      options: options.profileOptions
    })
  })

  bind('session-grants:revoke', c => c === 1, (raw: unknown) => {
    if (!isPlainObject(raw)) throw new Error('INVALID_SESSION_GRANTS_REQUEST')
    assertActiveRepository(raw.repositoryId, true)
    const provider = raw.provider === 'antigravityApp' || raw.provider === 'codex' || raw.provider === 'all' ? raw.provider : 'all'
    return revokeSessionSourceAccess({
      baseProfile: options.baseProfile,
      repositoryId: raw.repositoryId as string,
      provider,
      options: options.profileOptions
    })
  })

  bind('session-grants:set-lexical', c => c === 1, (raw: unknown) => {
    if (!isPlainObject(raw) || typeof raw.allowLexicalIndex !== 'boolean') throw new Error('INVALID_SESSION_GRANTS_REQUEST')
    assertActiveRepository(raw.repositoryId, true)
    return updateLexicalIndexAccess({
      baseProfile: options.baseProfile,
      repositoryId: raw.repositoryId as string,
      allowLexicalIndex: raw.allowLexicalIndex,
      options: options.profileOptions
    })
  })

  bind('session-grants:dismiss', c => c === 1, (raw: unknown) => {
    if (!isPlainObject(raw)) throw new Error('INVALID_SESSION_GRANTS_REQUEST')
    assertActiveRepository(raw.repositoryId, true)
    return dismissSessionSourceOnboarding({
      baseProfile: options.baseProfile,
      repositoryId: raw.repositoryId as string,
      options: options.profileOptions
    })
  })
}
