import { BrowserWindow, dialog } from 'electron'
import type { CliApprovalRequest } from './cli-execution-types'
import { detectRisks } from './cli-command-resolver'
import type { CliMode, CliTrustScope } from '../../shared/types/cli-policy-types'
import type { CliLocalContext } from './cli-trust-policy'

export async function confirmCliAutonomy(window: BrowserWindow | null, mode: CliMode, context: CliLocalContext, scope: CliTrustScope = 'ACTIVE_CHECKOUT_ONLY'): Promise<boolean> {
  if (!window || window.isDestroyed()) return false
  const worktreesYolo = mode === 'AUTONOMOUS_TRUSTED' && scope === 'REPOSITORY_WORKTREES'
  const message = worktreesYolo
    ? 'Permitir modo YOLO para este repositório e todas as suas Worktrees verificadas?'
    : mode === 'AUTONOMOUS_TRUSTED'
      ? 'Permitir CLI geral sem aprovação por comando?'
      : 'Permitir consultas elegíveis sem aprovação por comando?'
  const capabilitySummary = worktreesYolo
    ? 'Comandos gerais, scripts, shells, gerenciadores de pacotes e BuildX/Grok poderão executar código neste checkout e em qualquer Worktree verificada deste repositório sem novos diálogos ou whitelist.'
    : mode === 'AUTONOMOUS_TRUSTED'
      ? 'Comandos gerais, scripts, shells e gerenciadores de pacotes poderão executar código neste checkout ativo sem novos diálogos.'
      : 'Somente whoami.exe e hostname.exe reais do Windows, sem argumentos, são elegíveis nesta política inicial. Outros comandos exigem selecionar o modo supervisionado.'
  const scopeLine = worktreesYolo
    ? 'Escopo: Este repositório e todas as suas Worktrees verificadas (atuais e futuras).\nA delegação autoriza execução CLI, mas NÃO concede posse exclusiva Git (lock) sobre Worktrees.\n'
    : 'Escopo: Apenas o checkout ativo.\n'
  const response = await dialog.showMessageBox(window, {
    type: 'warning', title: 'Autorizar autonomia CLI neste repositório',
    message,
    detail: `Repositório: ${context.repositoryId}\nCheckout: ${context.path}\n${scopeLine}\n${capabilitySummary}\n\nTodo cliente autenticado com acesso à capacidade CLI poderá usar este modo. Não há isolamento por agente ou sessionId.\n\nO processo usará os direitos e credenciais da conta Windows atual. O diretório de trabalho NÃO limita acesso a arquivos ou rede. Job Object supervisiona processos; NÃO é sandbox. Não há elevação de privilégios. Erros e prompt injection continuam possíveis.\n\nA confiança persistirá somente neste perfil local e neste repositório/escopo até revogação, desativação ou perda de identidade. Você pode desativar a autonomia e interromper a execução no Channel.`,
    buttons: ['Manter modo atual', 'Autorizar este modo'], defaultId: 0, cancelId: 0, noLink: true
  })
  return response.response === 1
}

export async function confirmCliExecution(
  window: BrowserWindow | null,
  request: CliApprovalRequest
): Promise<boolean> {
  if (!window || window.isDestroyed()) {
    return false
  }

  const { command, repositoryDirectory, repositoryId, risks, operationId } = request
  const riskDetails = risks.length ? `\nRiscos identificados: ${risks.join(', ')}` : ''

  const detailLines = [
    `Operação: ${operationId}`,
    `Repositório: ${repositoryId ?? repositoryDirectory}`,
    ...(request.worktree ? [
      `Checkout ativo preservado: ${request.activeCheckoutDirectory}`,
      `Worktree alvo: ${request.worktree.worktreeId}`,
      `Geração: ${request.worktree.generation}`,
      `Branch: ${request.worktree.branch ?? 'detached HEAD'}`,
      `HEAD: ${request.worktree.head ?? 'sem commit'}`,
      `Índice: ${request.worktree.indexRevision}`,
      'CLI geral na Worktree selecionada. Esta aprovação autoriza somente este comando e não concede lease Git.',
      'Antes de autorizar escrita, coordene e pause outros executores que utilizem esta Worktree.'
    ] : []),
    ...(request.commands ?? [command]).flatMap((item, index) => [
      `Comando ${index + 1} · CWD: ${item.cwd}`,
      `Executável resolvido: ${item.executable}`,
      `Linha de comando completa: ${item.displayCommandLine}`,
      `Argumentos (argv): ${JSON.stringify(item.args)}`,
      `Riscos: ${detectRisks(item.executable, item.originalExecutable, item.args).join(', ')}`
    ]),
    ...(request.manifestHash ? [`Manifesto: ${request.manifestHash}`, `Orçamentos: ${JSON.stringify(request.budgets)}`] : []),
    riskDetails,
    '',
    'AVISO DE SEGURANÇA E PRIVACIDADE:',
    '- O processo executará com as credenciais do usuário na máquina local.',
    '- A saída (stdout/stderr) e o código de retorno poderão ser lidos pelo agente MCP.',
    '- O diretório de trabalho NÃO confina o acesso do processo ao filesystem ou à rede.'
  ].filter(Boolean)

  try {
    const response = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Autorização Nativa — Execução de Comando CLI',
      message: request.commands ? `Executar os ${request.commands.length} comandos deste manifesto, em ordem?` : request.worktree ? 'Executar comando CLI na Worktree selecionada?' : 'Solicitação de execução de comando CLI no checkout ativo',
      detail: detailLines.join('\n'),
      buttons: ['Recusar comando', 'Autorizar e executar'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    return response.response === 1
  } catch {
    return false
  }
}
