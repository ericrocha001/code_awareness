import { useEffect, useState } from 'react'
import type { CodexArchiveReadiness, CodexArchiveState } from '../../../../shared/types/codex-archive-types'

const messages: Record<CodexArchiveState, string> = {
  NOT_CONFIGURED: 'Desconectado', UNAUTHORIZED: 'Autorização não concedida', EXECUTABLE_UNAVAILABLE: 'Executável ou perfil indisponível',
  PROTOCOL_UNSUPPORTED: 'O Codex selecionado não oferece o protocolo necessário', ACCOUNT_IDENTITY_UNAVAILABLE: 'Não foi possível confirmar a conta',
  PROVIDER_UNREACHABLE: 'Conexão encerrada ou indisponível', CONNECTING: 'Verificando conexão…', READY: 'Conectado'
}
export function CodexArchiveSettings() {
  const api = window.codeAwareness.codexArchive
  const [readiness, setReadiness] = useState<CodexArchiveReadiness>(), [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    const unsubscribe = api?.onChanged?.(value => { if (current) setReadiness(value) })
    if (api) void api.inspect().then(value => { if (current) setReadiness(value) }).catch(() => { if (current) setReadiness({ state: 'PROVIDER_UNREACHABLE' }) })
    return () => { current = false; unsubscribe?.() }
  }, [api])
  if (!api) return null
  const act = async (action: 'enable' | 'disable') => {
    setBusy(true)
    try { setReadiness(await api[action]()) } catch { setReadiness({ state: 'PROVIDER_UNREACHABLE' }) }
    finally { setBusy(false) }
  }
  const connected = readiness?.state === 'READY'
  return <section className="settings-codex" aria-labelledby="codex-archive-title">
    <div className="settings-intro"><h3 id="codex-archive-title">Histórico Codex</h3><p>Consulte metadados arquivados do perfil escolhido. A conexão é opcional e pede autorização; transcrições permanecem privadas.</p></div>
    <div className="settings-list"><div className="settings-row">
      <span className="settings-row-label" role="status">{readiness ? messages[readiness.state] : 'Carregando…'}{connected && readiness?.version ? ` · Codex ${readiness.version}` : ''}</span>
      <button type="button" disabled={busy || !readiness} onClick={() => void act(connected ? 'disable' : 'enable')}>{busy ? 'Aguardando…' : connected ? 'Desconectar' : 'Conectar ao Codex…'}</button>
    </div></div>
  </section>
}
