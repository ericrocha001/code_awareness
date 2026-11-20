import { realpathSync } from 'node:fs'
import type { GitService } from '../core/git-service'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { IDevUpdateSupervisorClient } from './dev-update-supervisor-client'
import type {
  DevUpdateAvailability,
  DevUpdateRequest,
  DevUpdateResult
} from './dev-update-types'

export interface DevUpdateServiceOptions {
  runtimeIdentity: RuntimeIdentityProvider
  supervisor: IDevUpdateSupervisorClient
  gitService: GitService
  requestShutdown: () => void
  supervisorRoot?: string
  isPackaged?: () => boolean
  isPreview?: () => boolean
}

export class DevUpdateService {
  private lastResult: DevUpdateResult | null = null
  private inFlightOperationId: string | null = null

  constructor(private readonly options: DevUpdateServiceOptions) {}

  async getAvailability(): Promise<DevUpdateAvailability> {
    const isPackaged = this.options.isPackaged ? this.options.isPackaged() : false
    const isPreview = this.options.isPreview
      ? this.options.isPreview()
      : Boolean(process.env.CODE_AWARENESS_RUNTIME_PREVIEW)

    const runtime = this.options.runtimeIdentity.getRuntimeInfo()
    if (isPackaged || runtime.mode !== 'development') {
      return {
        available: false,
        reason: 'DevUpdate está disponível apenas em modo de desenvolvimento.',
        supervisorConnected: false
      }
    }

    if (isPreview) {
      return {
        available: false,
        reason: 'DevUpdate desativado em instâncias de Runtime Preview.',
        supervisorConnected: false
      }
    }

    const supervisorConnected = this.options.supervisor.isAvailable()
    if (!supervisorConnected) {
      return {
        available: false,
        reason: 'Dev Supervisor não conectado.',
        supervisorConnected: false
      }
    }

    await this.options.runtimeIdentity.sourceOriginReady
    const identity = this.options.runtimeIdentity.getIdentityPayload()
    const origin = identity.sourceOrigin

    if (origin.status !== 'GIT_WORKTREE' || !origin.worktree) {
      return {
        available: false,
        reason: 'A origem do runtime não é uma worktree Git válida.',
        supervisorConnected: true
      }
    }

    if (origin.worktree.detached || !origin.worktree.branch) {
      return {
        available: false,
        reason: 'HEAD está detached.',
        head: origin.worktree.head ?? undefined,
        supervisorConnected: true
      }
    }

    const supervisorRoot = this.options.supervisorRoot || process.env.CODE_AWARENESS_DEV_SUPERVISOR_ROOT
    if (supervisorRoot) {
      try {
        if (realpathSync(origin.worktree.rootPath) !== realpathSync(supervisorRoot)) {
          return {
            available: false,
            reason: 'A pasta raiz do runtime difere da pasta de inicialização do supervisor.',
            branch: origin.worktree.branch,
            head: origin.worktree.head ?? undefined,
            supervisorConnected: true
          }
        }
      } catch {
        // Ignora erro de resolução de caminho
      }
    }

    const lastSupervisorStatus = await this.options.supervisor.getStatus().catch(() => null)
    if (lastSupervisorStatus && lastSupervisorStatus.status === 'COMPLETED' && !this.lastResult) {
      this.lastResult = {
        operationId: lastSupervisorStatus.operationId,
        status: lastSupervisorStatus.status,
        head: lastSupervisorStatus.head,
        newInstanceId: lastSupervisorStatus.newInstanceId,
        message: `DevUpdate concluído com sucesso. HEAD: ${lastSupervisorStatus.head?.slice(0, 8)}`
      }
    }

    return {
      available: true,
      branch: origin.worktree.branch,
      head: origin.worktree.head ?? undefined,
      supervisorConnected: true,
      lastResult: this.lastResult
    }
  }

  getLastResult(): DevUpdateResult | null {
    return this.lastResult
  }

  async executeDevUpdate(request: DevUpdateRequest): Promise<DevUpdateResult> {
    if (this.inFlightOperationId && this.inFlightOperationId !== request.operationId) {
      return {
        operationId: request.operationId,
        status: 'BUSY',
        message: 'Uma operação DevUpdate já está em andamento nesta instância.'
      }
    }

    // 1. Verificar idempotência via supervisor
    const existingReceipt = await this.options.supervisor.getStatus(request.operationId).catch(() => null)
    if (existingReceipt) {
      return {
        operationId: existingReceipt.operationId,
        status: existingReceipt.status,
        head: existingReceipt.head ?? existingReceipt.expectedHead,
        oldInstanceId: existingReceipt.oldInstanceId,
        newInstanceId: existingReceipt.newInstanceId,
        message: existingReceipt.status === 'COMPLETED'
          ? 'Operação já concluída anteriormente.'
          : 'Operação já agendada ou em processamento.'
      }
    }

    // 2. Pré-requisitos de runtime e modo
    const isPackaged = this.options.isPackaged ? this.options.isPackaged() : false
    const isPreview = this.options.isPreview
      ? this.options.isPreview()
      : Boolean(process.env.CODE_AWARENESS_RUNTIME_PREVIEW)
    const runtime = this.options.runtimeIdentity.getRuntimeInfo()

    if (isPackaged || runtime.mode !== 'development') {
      return {
        operationId: request.operationId,
        status: 'UNSUPPORTED',
        message: 'DevUpdate está disponível apenas em modo de desenvolvimento.'
      }
    }

    if (isPreview) {
      return {
        operationId: request.operationId,
        status: 'UNSUPPORTED',
        message: 'DevUpdate desativado em instâncias de Runtime Preview.'
      }
    }

    if (!this.options.supervisor.isAvailable()) {
      return {
        operationId: request.operationId,
        status: 'UNSUPPORTED',
        message: 'Dev Supervisor não está acessível.'
      }
    }

    if (request.expectedInstanceId !== runtime.instanceId) {
      return {
        operationId: request.operationId,
        status: 'INSTANCE_MISMATCH',
        oldInstanceId: runtime.instanceId,
        message: 'A instância informada diverge da instância do runtime atual.'
      }
    }

    await this.options.runtimeIdentity.sourceOriginReady
    const identity = this.options.runtimeIdentity.getIdentityPayload()
    const origin = identity.sourceOrigin

    if (origin.status !== 'GIT_WORKTREE' || !origin.worktree) {
      return {
        operationId: request.operationId,
        status: 'UNSUPPORTED',
        message: 'A origem do runtime não é uma worktree Git válida.'
      }
    }

    if (origin.worktree.detached || !origin.worktree.branch) {
      return {
        operationId: request.operationId,
        status: 'DETACHED_HEAD',
        message: 'DevUpdate exige uma branch ativa; HEAD está detached.'
      }
    }

    const rootPath = origin.worktree.rootPath
    const branch = origin.worktree.branch

    const supervisorRoot = this.options.supervisorRoot || process.env.CODE_AWARENESS_DEV_SUPERVISOR_ROOT
    if (supervisorRoot) {
      try {
        if (realpathSync(rootPath) !== realpathSync(supervisorRoot)) {
          return {
            operationId: request.operationId,
            status: 'UNSUPPORTED',
            message: 'A pasta raiz da worktree difere da pasta de inicialização do supervisor.'
          }
        }
      } catch {
        // prossegue caso não seja possível resolver realpath
      }
    }

    // 3. Verificar estado limpo do repositório
    const modifiedFiles = await this.options.gitService.getModifiedFiles(rootPath)
    if (modifiedFiles.length > 0) {
      return {
        operationId: request.operationId,
        status: 'DIRTY_WORKTREE',
        message: `Checkout possui ${modifiedFiles.length} arquivo(s) modificados ou não rastreados. DevUpdate requer worktree limpa.`
      }
    }

    // 4. Verificar upstream configurado
    const upstream = await this.options.gitService.getUpstreamReference(rootPath)
    if (!upstream) {
      return {
        operationId: request.operationId,
        status: 'UPSTREAM_UNAVAILABLE',
        message: `A branch '${branch}' não possui upstream remoto configurado.`
      }
    }

    const expectedRef = `refs/heads/${branch}`
    if (upstream.ref !== expectedRef) {
      return {
        operationId: request.operationId,
        status: 'ASYMMETRIC_TRACKING_UNSUPPORTED',
        message: `Tracking assimétrico ('${branch}' aponta para '${upstream.ref}') não é suportado pelo DevUpdate.`
      }
    }

    // 5. Adquirir reserva com supervisor (single-flight)
    const reserved = await this.options.supervisor.reserve(request.operationId)
    if (!reserved) {
      return {
        operationId: request.operationId,
        status: 'BUSY',
        message: 'Outra operação de atualização ou reinício já está reservada no supervisor.'
      }
    }

    this.inFlightOperationId = request.operationId

    try {
      // 6. Passo 1: FETCH
      try {
        await this.options.gitService.fetchRemote(rootPath, upstream.remote)
      } catch (fetchError) {
        await this.options.supervisor.cancel(request.operationId)
        this.inFlightOperationId = null
        const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError)
        return {
          operationId: request.operationId,
          status: 'FAILED',
          message: `Falha ao executar fetch no remoto '${upstream.remote}': ${errorMsg}`
        }
      }

      // 7. Revalidar estado limpo após fetch
      const postFetchModified = await this.options.gitService.getModifiedFiles(rootPath)
      if (postFetchModified.length > 0) {
        await this.options.supervisor.cancel(request.operationId)
        this.inFlightOperationId = null
        return {
          operationId: request.operationId,
          status: 'DIRTY_WORKTREE',
          message: 'Worktree tornou-se suja durante a operação de fetch.'
        }
      }

      // 8. Obter HEAD atual e HEAD upstream
      const currentHead = await this.options.gitService.getCurrentCommitHash(rootPath)
      if (!currentHead) {
        await this.options.supervisor.cancel(request.operationId)
        this.inFlightOperationId = null
        return {
          operationId: request.operationId,
          status: 'FAILED',
          message: 'Não foi possível ler o HEAD atual.'
        }
      }

      const upstreamHead = (await this.options.gitService.getUpstreamReference(rootPath))?.trackingHead
      if (!upstreamHead) {
        await this.options.supervisor.cancel(request.operationId)
        this.inFlightOperationId = null
        return {
          operationId: request.operationId,
          status: 'FAILED',
          message: 'Não foi possível ler o HEAD da branch upstream após o fetch.'
        }
      }

      // 9. Se expectedIntegratedCommit foi passado, verificar se está alcançável no upstream
      if (request.expectedIntegratedCommit) {
        const reachable = await this.options.gitService.isCommitReachable(
          rootPath,
          request.expectedIntegratedCommit,
          upstreamHead
        )
        if (!reachable) {
          await this.options.supervisor.cancel(request.operationId)
          this.inFlightOperationId = null
          return {
            operationId: request.operationId,
            status: 'EXPECTED_COMMIT_NOT_INTEGRATED',
            message: `O commit integrado esperado '${request.expectedIntegratedCommit}' não está presente no upstream '${upstream.remote}/${branch}'.`
          }
        }
      }

      // 10. Avaliar relação Git (ahead / behind / in-sync)
      let targetHead = currentHead

      if (currentHead === upstreamHead) {
        const freshness = this.options.runtimeIdentity.evaluateFreshness()
        if (request.caller === 'MCP' && freshness.freshness.state === 'MATCH') {
          await this.options.supervisor.cancel(request.operationId)
          this.inFlightOperationId = null
          return {
            operationId: request.operationId,
            status: 'ALREADY_CURRENT',
            head: currentHead,
            oldInstanceId: runtime.instanceId,
            message: 'O checkout já está atualizado com o upstream e o código em execução é idêntico.'
          }
        }
        // Se chamado via UI ou se houver divergência no runtime, prossegue com renovação do runtime
        targetHead = currentHead
      } else {
        const comparison = await this.options.gitService.compareCommits(rootPath, currentHead, upstreamHead)
        if (!comparison || comparison.ahead > 0) {
          await this.options.supervisor.cancel(request.operationId)
          this.inFlightOperationId = null
          return {
            operationId: request.operationId,
            status: 'AHEAD_OR_DIVERGED',
            details: comparison ? { ahead: comparison.ahead, behind: comparison.behind } : undefined,
            message: `A branch local possui commits ahead (${comparison?.ahead ?? '?'}) em relação ao upstream. DevUpdate aceita apenas avanço fast-forward.`
          }
        }

        // comparison.behind > 0 e ahead === 0 -> Passo 2: PULL_FF_ONLY
        try {
          await this.options.gitService.pullFastForward(rootPath, upstream.remote, branch)
        } catch (pullError) {
          await this.options.supervisor.cancel(request.operationId)
          this.inFlightOperationId = null
          const errorMsg = pullError instanceof Error ? pullError.message : String(pullError)
          return {
            operationId: request.operationId,
            status: 'FAILED',
            message: `Falha ao executar pull fast-forward: ${errorMsg}`
          }
        }

        const newHead = await this.options.gitService.getCurrentCommitHash(rootPath)
        if (newHead !== upstreamHead) {
          await this.options.supervisor.cancel(request.operationId)
          this.inFlightOperationId = null
          return {
            operationId: request.operationId,
            status: 'PARTIAL',
            message: `Pull concluído, mas o HEAD obtido (${newHead?.slice(0, 8)}) diverge do upstream observado (${upstreamHead.slice(0, 8)}).`
          }
        }
        targetHead = newHead
      }

      // 11. Confirmar com o supervisor (COMMIT)
      const committed = await this.options.supervisor.commit({
        operationId: request.operationId,
        origin: { rootPath, branch },
        expectedHead: targetHead,
        oldInstanceId: runtime.instanceId
      })

      if (!committed) {
        await this.options.supervisor.cancel(request.operationId)
        this.inFlightOperationId = null
        return {
          operationId: request.operationId,
          status: 'FAILED',
          message: 'Falha ao confirmar agendamento com o Dev Supervisor.'
        }
      }

      const scheduledResult: DevUpdateResult = {
        operationId: request.operationId,
        status: 'SCHEDULED',
        head: targetHead,
        oldInstanceId: runtime.instanceId,
        message: 'DevUpdate agendado com sucesso. Reiniciando o runtime de desenvolvimento...',
        postResponse: async () => {
          this.options.requestShutdown()
        }
      }

      this.lastResult = scheduledResult
      this.inFlightOperationId = null
      return scheduledResult
    } catch (err) {
      await this.options.supervisor.cancel(request.operationId).catch(() => {})
      this.inFlightOperationId = null
      const errorMsg = err instanceof Error ? err.message : String(err)
      return {
        operationId: request.operationId,
        status: 'FAILED',
        message: `Erro inesperado durante DevUpdate: ${errorMsg}`
      }
    }
  }
}
