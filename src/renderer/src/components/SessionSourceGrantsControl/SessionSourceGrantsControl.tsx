import { useEffect, useState } from 'react'
import type { SessionSourceGrantsStatus } from '../../../../shared/types/session-source-grants-types'

interface SessionSourceGrantsControlProps {
  repositoryId: string
  worktreeRoot?: string
  mode: 'banner' | 'settings'
}

export function SessionSourceGrantsControl({ repositoryId, worktreeRoot, mode }: SessionSourceGrantsControlProps) {
  const [status, setStatus] = useState<SessionSourceGrantsStatus | null>(null)
  const [allowLexical, setAllowLexical] = useState(false)
  const [selectedCodexHash, setSelectedCodexHash] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    setError('')
    setNotice('')
    window.codeAwareness.sessionSourceGrants?.status(repositoryId, worktreeRoot).then(res => {
      if (!active) return
      setStatus(res)
      setAllowLexical(res.allowLexicalIndex)
      const candidates = res.providers.codex.accountCandidates
      if (candidates && candidates.length > 0) setSelectedCodexHash(candidates[0].accountHash)
    }).catch(() => {
      if (active) setError('Não foi possível consultar a prontidão de leitura de sessões.')
    })
    return () => { active = false }
  }, [repositoryId, worktreeRoot])

  if (!status || status.readOnly) return null
  if (mode === 'banner' && !status.needsOnboarding) return null

  const { antigravityApp, codex } = status.providers
  const anyReady = antigravityApp.state === 'READY' || codex.state === 'READY'
  const eligibleNames = [
    antigravityApp.eligible ? 'Antigravity' : null,
    codex.eligible || codex.accountSelectionRequired ? 'Codex' : null
  ].filter(Boolean)

  const handleEnable = async () => {
    if (!window.codeAwareness.sessionSourceGrants) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await window.codeAwareness.sessionSourceGrants.enable({
        repositoryId,
        worktreeRoot,
        allowLexicalIndex: allowLexical,
        ...(codex.accountSelectionRequired && selectedCodexHash ? { selectedCodexAccountHash: selectedCodexHash } : {})
      })
      setStatus(updated)
      setAllowLexical(updated.allowLexicalIndex)
      setNotice(updated.partialSuccess
        ? 'Leitura habilitada parcialmente; verifique o provedor pendente.'
        : 'Leitura local de sessões habilitada para este repositório.')
    } catch {
      setError('Não foi possível habilitar a leitura de sessões.')
    } finally {
      setBusy(false)
    }
  }

  const handleRevoke = async () => {
    if (!window.codeAwareness.sessionSourceGrants) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await window.codeAwareness.sessionSourceGrants.revoke({
        repositoryId,
        provider: 'all',
        worktreeRoot
      })
      setStatus(updated)
      setAllowLexical(false)
      setNotice('Acesso local de sessões revogado e índices derivados removidos.')
    } catch {
      setError('Não foi possível revogar o acesso às sessões.')
    } finally {
      setBusy(false)
    }
  }

  const handleToggleLexical = async (nextVal: boolean) => {
    setAllowLexical(nextVal)
    if (!anyReady || !window.codeAwareness.sessionSourceGrants) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await window.codeAwareness.sessionSourceGrants.setLexicalIndex({
        repositoryId,
        allowLexicalIndex: nextVal,
        worktreeRoot
      })
      setStatus(updated)
      setAllowLexical(updated.allowLexicalIndex)
      setNotice(nextVal ? 'Índice lexical FTS5 habilitado para este projeto.' : 'Índice lexical FTS5 desativado e limpo.')
    } catch {
      setError('Não foi possível atualizar o índice lexical.')
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = async () => {
    if (!window.codeAwareness.sessionSourceGrants) return
    setBusy(true)
    try {
      const updated = await window.codeAwareness.sessionSourceGrants.dismiss({ repositoryId, worktreeRoot })
      setStatus(updated)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={mode === 'banner' ? 'runtime-preview-banner' : 'settings-codex'} role="region" aria-label="Leitura de sessões neste projeto">
      <div>
        <strong>Leitura local de sessões ({eligibleNames.join(' · ') || 'nenhum provedor elegível'})</strong>
        <p>
          Autoriza leitura seletiva e sob demanda de transcrições locais apenas para este repositório, sem copiar corpos.
          {' '}Antigravity: <strong>{antigravityApp.state}</strong> · Codex: <strong>{codex.state}</strong>.
        </p>
        {codex.accountSelectionRequired && codex.accountCandidates && (
          <label>
            Conta Codex:{' '}
            <select value={selectedCodexHash} onChange={e => setSelectedCodexHash(e.target.value)} disabled={busy}>
              {codex.accountCandidates.map(c => (
                <option key={c.accountHash} value={c.accountHash}>{c.label}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={allowLexical}
            onChange={e => void handleToggleLexical(e.target.checked)}
            disabled={busy}
          />
          {' '}Índice lexical FTS5 (opcional, desativado por padrão)
        </label>
      </div>
      <div>
        {(!anyReady || antigravityApp.state === 'MISSING' || codex.state === 'MISSING') && (
          <button type="button" onClick={() => void handleEnable()} disabled={busy || eligibleNames.length === 0}>
            Habilitar leitura de sessões neste projeto
          </button>
        )}
        {anyReady && (
          <button type="button" onClick={() => void handleRevoke()} disabled={busy}>
            Revogar leitura de sessões
          </button>
        )}
        {mode === 'banner' && (
          <button type="button" onClick={() => void handleDismiss()} disabled={busy}>
            Agora não
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
