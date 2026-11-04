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
    const unsubscribe = api?.onChanged?.(value => {
      if (!current) return
      setReadiness(previous => ({ ...value, discovery: previous?.discovery }))
      if (value.state === 'NOT_CONFIGURED') void api.inspect().then(next => { if (current) setReadiness(next) }).catch(() => {})
    })
    if (api) void api.inspect().then(value => { if (current) setReadiness(value) }).catch(() => { if (current) setReadiness({ state: 'PROVIDER_UNREACHABLE' }) })
    return () => { current = false; unsubscribe?.() }
  }, [api])
  if (!api) return null
  const act = async (action: 'enable' | 'disable' | 'chooseAdvanced', candidateId?: string) => {
    setBusy(true)
    try { setReadiness(await (candidateId ? api.select(candidateId) : api[action]())) } catch { setReadiness(previous => ({ ...previous, state: 'PROVIDER_UNREACHABLE' })) }
    finally { setBusy(false) }
  }
  const connected = readiness?.state === 'READY'
  const discovery = readiness?.discovery, selected = discovery?.candidates.find(candidate => candidate.id === discovery.selectedId)
  const discoveryMessage = discovery?.reason === 'CANCELED' ? 'Seleção cancelada. Nenhuma conexão foi iniciada.'
    : discovery?.reason === 'PROFILE_MISSING' ? 'Perfil Codex ausente. Abra o Codex com seu perfil local antes de tentar novamente.'
    : discovery?.reason === 'CANDIDATE_CHANGED' ? 'A instalação ou o perfil mudou. Feche e reabra as configurações para verificar novamente.'
      : discovery?.state === 'INVALID' ? 'Não foi possível validar a instalação e o perfil locais.'
        : discovery?.state === 'NOT_FOUND' ? 'Codex não encontrado nas instalações locais conhecidas. Instale o CLI oficial ou selecione uma instalação em Avançado.'
          : discovery?.state === 'AMBIGUOUS' && !selected ? 'Múltiplas instalações encontradas. Escolha uma para autorizar.' : undefined
  return <section className="settings-codex" aria-labelledby="codex-archive-title">
    <div className="settings-intro"><h3 id="codex-archive-title">Histórico Codex</h3><p>Conectar ao Codex local para consultar metadados de sessões arquivadas (sem ler transcrições).</p>
      <p>Ao conectar, você autoriza a execução local e a verificação da conta deste perfil para o repositório ativo. Não faz login nem ativa captura. A conta identifica a conexão, sem comprovar autoria histórica.</p>
      {selected && <p className="settings-codex-location">Perfil: {selected.profile}<br />Codex: {selected.executable}</p>}
      {discoveryMessage && <p role="note">{discoveryMessage}</p>}
      {discovery?.state === 'AMBIGUOUS' && <label>Instalação Codex <select aria-label="Instalação Codex" disabled={busy || connected} value={discovery.selectedId ?? ''} onChange={event => void act('enable', event.target.value)}><option value="" disabled>Escolha uma instalação</option>{discovery.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.executable} · {candidate.profile}</option>)}</select></label>}
    </div>
    <div className="settings-list"><div className="settings-row">
      <span className="settings-row-label" role="status">{readiness ? readiness.state === 'NOT_CONFIGURED' && selected ? 'Pronto para conectar' : messages[readiness.state] : 'Detectando Codex…'}{connected && readiness?.version ? ` · Codex ${readiness.version}` : ''}</span>
      <button type="button" disabled={busy || !readiness || (!connected && !selected)} onClick={() => void act(connected ? 'disable' : 'enable')}>{busy ? 'Aguardando…' : connected ? 'Desconectar' : 'Conectar ao Codex'}</button>
    </div></div>
    {!connected && <details><summary>Avançado</summary><button type="button" disabled={busy} onClick={() => void act('chooseAdvanced')}>Selecionar instalação e perfil manualmente</button><p>A seleção será exibida antes de você autorizar a conexão.</p></details>}
  </section>
}
