import React, { useEffect, useRef, useState } from 'react'
import { Plug, RefreshCw } from 'lucide-react'
import type { LocalMcpAction, LocalMcpClientId, LocalMcpClientState, LocalMcpPreview } from '../../../../shared/types/local-mcp-client-types'

const configuration = { ABSENT: 'Disponível para instalação', INSTALLED: 'Configurado', CONFLICT: 'Migração ou revisão necessária', ERROR: 'Requer atenção', UNSUPPORTED: 'Não suportado neste perfil' }
const groups: { name: string; ids: LocalMcpClientId[] }[] = [
  { name: 'Codex', ids: ['codex'] },
  { name: 'Antigravity', ids: ['antigravity', 'antigravity-settings'] },
  { name: 'Cline', ids: ['cline', 'cline-settings', 'cline-vscode'] }
]
const actionName = { connect: 'Conectar', repair: 'Reparar / atualizar', disconnect: 'Desconectar' }
const messages: Record<string, string> = {
  LOCAL_SETUP_UNAVAILABLE: 'Configuração local indisponível neste runtime.',
  CLIENT_PROFILE_NOT_IDENTIFIED: 'Perfil não identificado. Confira o arquivo consumido pelo cliente antes de configurar.',
  PACKAGED_NODE_RUNTIME_UNSUPPORTED: 'Este pacote ainda não inclui um runtime local compatível. A configuração automática está indisponível.',
  NODE_RUNTIME_UNAVAILABLE: 'Node.js compatível não encontrado. A configuração não foi alterada.',
  CONFIG_REVISION_CONFLICT: 'O arquivo mudou desde a prévia. Detecte novamente antes de confirmar.',
  PROFILE_OWNERSHIP_UNVERIFIED: 'Não foi possível confirmar que o destino pertence ao seu usuário.',
  CONFIG_LINK_NOT_ALLOWED: 'O destino usa um link ou junction. A escrita foi bloqueada.',
  INVALID_CLIENT_CONFIG: 'A configuração existente não pôde ser lida com segurança. Nenhuma entrada foi substituída.',
  UNSUPPORTED_TOML_LAYOUT: 'A organização deste TOML não permite edição automática segura.',
  MCP_SESSION_INVALIDATED: 'Sessão do cliente invalidada. Reconecte o cliente; não é necessário reescrever a configuração.',
  BOOTSTRAP_PROBE_FAILED: 'O launcher não respondeu. Confirme que o Desktop está em execução no perfil selecionado.',
  LEGACY_MIGRATION_AVAILABLE: 'Entrada gerenciada encontrada. A confirmação migrará a entrada sem manter dois servidores.',
  LEGACY_ENTRY_OWNERSHIP_UNVERIFIED: 'Há uma entrada manual cuja origem não foi confirmada. A migração foi bloqueada para preservar seu servidor.',
  PLUGIN_OWNERSHIP_UNVERIFIED: 'O plugin contém alterações não reconhecidas. Nenhum arquivo foi substituído.',
  PLUGIN_ALREADY_INSTALLED: 'Use o plugin já instalado para evitar dois registros do mesmo servidor.',
  INSTALLATION_RECOVERY_REQUIRED: 'Uma alteração concorrente impediu a recuperação automática. Revise o destino antes de continuar.'
}
const explain = (code: string) => messages[code] ?? 'A operação local requer atenção. Verifique o destino e as permissões antes de tentar novamente.'
const diagnostic = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return /[A-Z][A-Z_]{3,}/.exec(message)?.[0] ?? 'LOCAL_SETUP_UNAVAILABLE'
}

export function LocalMcpSetup() {
  const [clients, setClients] = useState<LocalMcpClientState[]>([])
  const [selection, setSelection] = useState<Record<string, LocalMcpClientId>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<LocalMcpPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [replace, setReplace] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const active = useRef(true)
  const pending = useRef(false)
  const api = window.codeAwareness.localMcpClients
  async function run(work: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try { await work() } catch (caught) { if (active.current) setError(diagnostic(caught)) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  useEffect(() => {
    active.current = true
    void run(async () => {
      if (!api) throw new Error('LOCAL_SETUP_UNAVAILABLE')
      const result = await api.detect()
      if (active.current) setClients(result)
    })
    return () => { active.current = false }
  }, [])
  function update(next: LocalMcpClientState) { if (active.current) setClients(previous => previous.map(row => row.id === next.id ? next : row)) }
  function prepare(id: LocalMcpClientId, action: LocalMcpAction) {
    void run(async () => {
      const result = await api.preview(id, action)
      if (active.current) { setPreview(result); setConfirmed(false); setReplace(false); setNotice(null) }
    })
  }
  return <section className="channel-panel local-mcp-setup" aria-labelledby="local-mcp-title" aria-busy={busy}>
    <div className="channel-section-heading"><h2 id="local-mcp-title"><Plug size={19} aria-hidden="true" />Configurar MCP Local</h2>
      <button type="button" className="channel-action" disabled={busy || !api} onClick={() => void run(async () => { const rows = await api.detect(); if (active.current) { setClients(rows); setPreview(null) } })}><RefreshCw size={14} aria-hidden="true" />Detectar</button></div>
    <p className="channel-note">Conecte seus clientes ao Desktop neste computador. MCP Local e MCP Online têm configurações independentes.</p>
    {error && <p className="channel-error" role="alert" title={error}>{explain(error)}</p>}
    {notice && <p className="channel-note" role="status">{notice}</p>}
    <div className="local-mcp-clients">{groups.map(group => {
      const variants = clients.filter(client => group.ids.includes(client.id))
      const client = variants.find(row => row.id === selection[group.name]) ?? variants[0]
      if (!client) return null
      return <article className="local-mcp-client" key={group.name} aria-label={group.name}>
      <div><h3>{group.name}</h3><span className={`channel-badge channel-tone-${client.configuration === 'INSTALLED' ? 'healthy' : 'neutral'}`}>{configuration[client.configuration]}</span></div>
      {variants.length > 1 ? <label className="local-mcp-variant">Destino<select aria-label={`Destino ${group.name}`} value={client.id} disabled={busy || !!preview} onChange={event => setSelection(previous => ({ ...previous, [group.name]: event.target.value as LocalMcpClientId }))}>{variants.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label> : client.id !== 'codex' && <p className="channel-note">{client.name}</p>}
      <p className="channel-note">{client.mechanism === 'PLUGIN' ? 'Plugin local · reconhecimento pendente' : client.mechanism === 'CODEX_CLI' ? 'Registro oficial Codex' : 'Configuração de fallback'} · Reconexão: pendente</p>
      <p className="local-mcp-path">{client.path}</p>
      <p className="channel-note">Launcher: {client.launcherPresent ? 'presente' : 'ausente'} · Bootstrap: {client.bootstrap === 'RESPONDS' ? 'responde' : client.bootstrap === 'ERROR' ? 'falhou' : 'não verificado'} · Uso pelo cliente: não confirmado</p>
      {client.diagnostic && <p className="channel-note" role="status" title={client.diagnostic}>{explain(client.diagnostic)}</p>}
      <div className="local-mcp-actions"><button type="button" className="channel-action" disabled={busy || !!preview} onClick={() => void run(async () => update(await api.verify(client.id)))}>Verificar</button>
        <button type="button" className="channel-action" disabled={busy || !!preview || !client.detected || client.configuration === 'ERROR'} onClick={() => prepare(client.id, client.configuration === 'ABSENT' ? 'connect' : 'repair')}>{client.configuration === 'ABSENT' ? 'Conectar' : 'Reparar / atualizar'}</button>
        {client.configuration !== 'ABSENT' && client.configuration !== 'UNSUPPORTED' && <button type="button" className="channel-action" disabled={busy || !!preview || client.configuration === 'ERROR'} onClick={() => prepare(client.id, 'disconnect')}>Desconectar</button>}</div>
    </article>})}</div>
    {busy && <p className="channel-note" role="status">Verificando configuração local…</p>}
    {preview && <div className="local-mcp-preview" aria-label="Prévia da configuração">
      <h3>{actionName[preview.action]} · {clients.find(row => row.id === preview.client)?.name}</h3>
      <p className="local-mcp-path">Destino: {preview.path}</p><p className="local-mcp-path">Launcher gerenciado: {preview.launcherPath}</p>
      <div className="local-mcp-diff"><div><h4>Antes</h4><pre>{preview.before}</pre></div><div><h4>Depois</h4><pre>{preview.after}</pre></div></div>
      <p className="channel-note">{preview.changes ? preview.migration ? 'Migrar o servidor gerenciado para o plugin, removendo somente sua entrada antiga. Reinicie ou reconecte o cliente após confirmar.' : 'Somente os arquivos gerenciados deste destino serão alterados. Reinicie ou reconecte o cliente após confirmar.' : 'Configuração atualizada. Nenhuma alteração necessária.'} A gravação não confirma uso pelo cliente.</p>
      {preview.conflict && <label><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} />Substituir explicitamente a entrada divergente Code Awareness</label>}
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Confirmo a operação neste destino</label>
      <div className="local-mcp-actions"><button type="button" className="channel-action" disabled={busy || !confirmed || preview.conflict && !replace} onClick={() => void run(async () => {
        update(await api.apply(preview.token, true, replace))
        if (active.current) { setPreview(null); setNotice('Configuração processada. Reconecte o cliente e execute as ferramentas de leitura para confirmar o uso.') }
      })}>Confirmar {actionName[preview.action].toLowerCase()}</button><button type="button" className="channel-action" disabled={busy} onClick={() => setPreview(null)}>Cancelar</button></div>
    </div>}
  </section>
}
