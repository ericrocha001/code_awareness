export const messages = {
  picker: 'Contexto do Continuum', close: 'Fechar painel de contexto',
  search: 'Buscar documentos', tag: 'Tag', kind: 'Tipo', status: 'Status', any: 'Todos',
  loading: 'Buscando…', connecting: 'Conectando ao Continuum…', noResults: 'Nenhum documento encontrado.',
  more: 'Carregar mais', retry: 'Atualizar lista', remove: 'Remover', selection: 'Documentos selecionados',
  estimating: 'Calculando…', estimateUnavailable: 'Estimativa indisponível', media: 'Inclui WebP',
  copy: 'Copiar texto', insert: 'Inserir texto',
  attach: 'Anexar ao chat', download: 'Baixar arquivos', context: 'Contexto', destination: 'Destino',
  working: 'Processando…', copied: 'Texto copiado.', inserted: 'Texto inserido no rascunho.',
  attachUnavailable: 'Anexação indisponível nesta conversa. Baixe os arquivos para anexar manualmente.',
  attachPartial: 'Alguns arquivos apareceram no rascunho. Confira os pendentes antes de continuar.',
  attachFailed: 'O chat recusou os arquivos. Baixe os originais para anexar manualmente.',
  rejected: 'Recusados',
  attachUncertain: 'O chat não confirmou os anexos. Confira o rascunho antes de continuar.',
  attached: 'Arquivos anexados ao rascunho.', confirmed: 'Confirmados', pending: 'Pendentes',
  downloaded: 'Arquivos salvos em', manualAttach: 'Anexe os arquivos manualmente no chat.',
  PICKER_FILES_TOO_LARGE: 'Os arquivos excedem o limite de anexação direta. Baixe os originais.',
  PICKER_MEDIA_DOWNLOAD_REQUIRED: 'Baixe os originais para anexar Markdown e WebP manualmente.',
  DOWNLOADS_UNAVAILABLE: 'A pasta Downloads está indisponível.',
  generic: 'Não foi possível concluir. Tente novamente.',
  activate: 'Ativar', revoke: 'Revogar', newChat: 'Nova conversa',
  pendingSend: 'Envio pendente', confirming: 'Confirmando envio', unknownSend: 'Envio sem confirmação',
  sendFailed: 'Falha no envio', handlingFailed: 'Falha ao processar solicitação',
  project: 'Projeto', global: 'Global', settings: 'Code Awareness · MCP local', bridge: 'Conexão com o aplicativo',
  scope: 'Escopo ativo', activeChat: 'Chat ativo', session: 'Estado da sessão',
  consent: 'Acesso somente para leitura', metadata: 'Skills e metadados do repositório',
  literal: 'Código-fonte e arquivos de Skills', policy: 'Permissão por site e projeto. Gravações e comandos de terminal ficam bloqueados.',
  barPosition: 'Posição da barra flutuante', checking: 'Verificando…',
  topLeft: 'Superior esquerda', topRight: 'Superior direita', bottomLeft: 'Inferior esquerda', bottomRight: 'Inferior direita',
  inherit: 'Usar posição global', unsupportedTab: 'Aba sem ativação', offline: 'Desconectado',
  online: 'Conectado', unavailable: 'Indisponível', openDesktop: 'Abra o Code Awareness para conectar.',
  sessionProblem: 'A sessão precisa de atenção. Consulte os detalhes.',
  reactivate: 'Ative novamente para continuar.', verifyDraft: 'Confira o rascunho antes de tentar novamente.',
  awaitDelivery: 'Aguardando confirmação do chat.',
  PROJECT_CONTEXT_CHANGED: 'O projeto mudou. Atualize a lista para continuar.',
  NO_ACTIVE_PROJECT: 'Selecione um projeto no Code Awareness e atualize a lista.',
  BUNDLE_SNAPSHOT_STALE: 'Um documento mudou. Selecione a versão atual novamente.',
  REVISION_CONFLICT: 'Um documento mudou. Selecione a versão atual novamente.',
  PICKER_TEXT_TOO_LARGE: 'A seleção é grande demais para inserir. Use Copiar texto.',
  PICKER_INSERT_UNAVAILABLE: 'O compositor está indisponível. Use Copiar texto.',
  PICKER_SESSION_EXPIRED: 'Feche e reabra o painel de contexto para reconectar.',
  PICKER_SENDER_NOT_AUTHORIZED: 'Reabra o painel na conversa atual.',
  BUNDLE_LIMIT: 'A seleção excede o tamanho permitido. Selecione menos documentos.'
} as const

export const number = new Intl.NumberFormat('pt-BR')
export const tokens = (count: number) => `${number.format(count)} ${count === 1 ? 'token' : 'tokens'}`
export const selectedCount = (count: number) => `${number.format(count)} ${count === 1 ? 'selecionado' : 'selecionados'}`

const labels: Record<string, string> = {
  INACTIVE: 'Inativa', REVOKED: 'Revogada', UNAVAILABLE: 'Indisponível', READY: 'Pronta',
  RESUMING: 'Retomando', WAITING_TOOL: 'Aguardando ferramenta', ACTIVATING: 'Ativando',
  DOCUMENT: 'Documento', DECISION: 'Decisão', OBSERVATION: 'Observação',
  VISUAL_REFERENCE: 'Referência visual', EXECUTABLE_PLAN: 'Plano executável',
  IMPLEMENTATION_HANDOFF: 'Relato de implementação', WORK_ITEM: 'Item de trabalho',
  ARCHITECTURAL_DECISION: 'Decisão arquitetural', CAPABILITY_OPPORTUNITY: 'Oportunidade de capacidade',
  VALIDATION_PROOF: 'Prova de validação', FEATURE_IDEA: 'Ideia de funcionalidade',
  INVESTIGATION: 'Investigação', PENDING: 'Pendente', COMPLETED: 'Concluído',
  VALIDATED: 'Validado', BLOCKED: 'Bloqueado', CANCELLED: 'Cancelado', ACTIVE: 'Ativo',
  IMPLEMENTED: 'Implementado', NOT_IMPLEMENTED: 'A implementar'
}

export const labelFor = (key: string) => labels[key] ?? key
export const pickerError = (code: string) => {
  if (code === 'PICKER_INSERT_ALREADY_ATTEMPTED' || code === 'PICKER_ATTACH_ALREADY_ATTEMPTED') return messages.verifyDraft
  if (code === 'APP_UNAVAILABLE') return messages.openDesktop
  return code in messages ? messages[code as keyof typeof messages] : messages.generic
}

export function localize(document: Document): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-label]')) {
    element.textContent = messages[element.dataset.label as keyof typeof messages]
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-aria]')) {
    element.setAttribute('aria-label', messages[element.dataset.aria as keyof typeof messages])
  }
}
