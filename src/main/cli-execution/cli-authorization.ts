import { BrowserWindow, dialog } from 'electron'
import type { CliApprovalRequest } from './cli-execution-types'

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
    `Diretório de trabalho (cwd): ${command.cwd} (${command.relativeCwd})`,
    `Executável resolvido: ${command.executable}`,
    `Linha de comando completa: ${command.displayCommandLine}`,
    `Argumentos: ${command.args.length ? command.args.join(' ') : '(nenhum)'}`,
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
      message: `Solicitação de execução de comando CLI no checkout ativo`,
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
