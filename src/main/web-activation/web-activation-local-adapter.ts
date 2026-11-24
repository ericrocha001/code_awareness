import type { ContextPickerService } from './context-picker-service'
import type { LocalChannelAdapter, LocalOperation } from '../local-agent-channel/local-channel-types'
import { operation } from '../local-agent-channel/local-channel-types'
import { object, text } from '../local-agent-channel/request-validation'
import type { ExtensionManagerService } from './extension-manager-service'
import type {
  EnrollManagedInstallationInput,
  MaintenanceCheckRequest,
  MaintenanceClaimRequest,
  MaintenanceReportRequest
} from './extension-manager-types'
import {
  WEB_MCP_BOOTSTRAP_PROTOCOL,
  type DesktopSkillsEndpointInfo
} from './web-activation-types'

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('INVALID_ARGUMENT')
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error('INVALID_ARGUMENT')
  return value
}

export class WebActivationLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'web_activation'
  readonly operations: LocalChannelAdapter['operations']

  constructor(
    private readonly ensureEndpoint: () => Promise<DesktopSkillsEndpointInfo>,
    private readonly extensionManager?: ExtensionManagerService,
    picker?: ContextPickerService
  ) {
    const ops: Record<string, LocalOperation> = {
      endpoint: operation(
        (input) => object(input, []),
        async () => {
          const info = await this.ensureEndpoint()
          return {
            protocol: WEB_MCP_BOOTSTRAP_PROTOCOL,
            ...info
          }
        }
      )
    }

    if (picker) ops.context_picker = operation(input => input, (input, context) => picker.execute(input, context.connected))

    if (extensionManager) {
      ops.status = operation(
        (input) => object(input, []),
        async () => extensionManager.getStatus()
      )

      ops.enroll = operation(
        (input) => {
          const obj = object(input, [
            'installationId',
            'extensionId',
            'installType',
            'profileId',
            'profileLabel',
            'unpackedPath',
            'hostInstallDir',
            'hostScriptPath',
            'sourceRepoPath',
            'nativeHostApplication',
            'replace'
          ])
          return {
            input: {
              installationId: optionalText(obj.installationId),
              extensionId: text(obj.extensionId),
              installType: optionalText(obj.installType),
              profileId: text(obj.profileId),
              profileLabel: optionalText(obj.profileLabel),
              unpackedPath: text(obj.unpackedPath),
              hostInstallDir: text(obj.hostInstallDir),
              hostScriptPath: text(obj.hostScriptPath),
              sourceRepoPath: text(obj.sourceRepoPath),
              nativeHostApplication: optionalText(obj.nativeHostApplication)
            } satisfies EnrollManagedInstallationInput,
            replace: optionalBoolean(obj.replace) ?? false
          }
        },
        async ({ input, replace }) => extensionManager.enrollInstallation(input, { replace })
      )

      ops.revoke = operation(
        (input) => object(input, []),
        async () => extensionManager.revokeInstallation()
      )

      ops.maintenance_check = operation(
        (input) => {
          const obj = object(input, [
            'installationId',
            'extensionId',
            'profileId',
            'bootId',
            'buildId',
            'manifestVersion',
            'installType',
            'hostBuildId',
            'hostApplication'
          ])
          return {
            installationId: text(obj.installationId),
            extensionId: text(obj.extensionId),
            profileId: text(obj.profileId),
            bootId: text(obj.bootId),
            buildId: text(obj.buildId),
            manifestVersion: text(obj.manifestVersion),
            installType: text(obj.installType),
            hostBuildId: optionalText(obj.hostBuildId),
            hostApplication: optionalText(obj.hostApplication)
          } satisfies MaintenanceCheckRequest
        },
        async (req) => extensionManager.handleMaintenanceCheck(req)
      )

      ops.maintenance_claim = operation(
        (input) => {
          const obj = object(input, [
            'operationId',
            'installationId',
            'extensionId',
            'profileId',
            'bootId',
            'buildId',
            'targetBuildId',
            'nonce',
            'epoch',
            'readyToReload',
            'activeBusyReason',
            'hostBuildId',
            'hostApplication'
          ])
          if (typeof obj.epoch !== 'number' || !Number.isSafeInteger(obj.epoch) || obj.epoch < 1) {
            throw new Error('INVALID_ARGUMENT')
          }
          if (typeof obj.readyToReload !== 'boolean') {
            throw new Error('INVALID_ARGUMENT')
          }
          return {
            operationId: text(obj.operationId),
            installationId: text(obj.installationId),
            extensionId: text(obj.extensionId),
            profileId: text(obj.profileId),
            bootId: text(obj.bootId),
            buildId: text(obj.buildId),
            targetBuildId: text(obj.targetBuildId),
            nonce: text(obj.nonce),
            epoch: obj.epoch,
            readyToReload: obj.readyToReload,
            activeBusyReason: optionalText(obj.activeBusyReason),
            hostBuildId: optionalText(obj.hostBuildId),
            hostApplication: optionalText(obj.hostApplication)
          } satisfies MaintenanceClaimRequest
        },
        async (req) => extensionManager.handleMaintenanceClaim(req)
      )

      ops.maintenance_report = operation(
        (input) => {
          const obj = object(input, ['phase', 'report'])
          const phase = text(obj.phase)
          if (phase !== 'BOOT_ATTESTATION' && phase !== 'REINJECT_RESULT' && phase !== 'QUIESCENCE_BLOCKED') {
            throw new Error('INVALID_ARGUMENT')
          }
          const reportObj = object(obj.report)
          return {
            phase,
            report: reportObj as unknown as MaintenanceReportRequest['report']
          } satisfies MaintenanceReportRequest
        },
        async (req) => extensionManager.handleMaintenanceReport(req)
      )
    }

    this.operations = ops
  }
}
