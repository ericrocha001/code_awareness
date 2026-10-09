import type { DashExecutionResult, DashResolutionReport } from '../../../shared/types/dash-types'
import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'
import {
  materializeDashPacket,
  serializeDashPacket,
  type DashPacketSerializer
} from './dash-context-packet'
import type { DashMapPort } from './dash-map-port'
import { DashQueryResolver } from './dash-query-resolver'
import { parseDashRequest } from './dash-request-parser'
import { DashError, validateDashRequest } from './dash-request-validator'

export class DashService {
  constructor(
    private readonly map: DashMapPort,
    private readonly tokenizer: TokenizerPort = getCanonicalTokenizer(),
    private readonly serialize: DashPacketSerializer = serializeDashPacket
  ) {}
  async execute(input: string, repo: string): Promise<DashExecutionResult> {
    const report: DashResolutionReport = { steps: [] }
    try {
      const parsed = parseDashRequest(input)
      if (!parsed.success) throw new DashError('INVALID_JSON', parsed.error)
      const validated = validateDashRequest(parsed.request)
      if (!validated.success) throw new DashError(validated.code, validated.error)
      const request = validated.request
      const resolver = new DashQueryResolver(this.map, repo)
      const sets = await resolver.resolve(request, report)
      const packet = await materializeDashPacket(request, sets, resolver, this.map, repo)
      const context = this.serialize(packet)
      const tokenCount = this.tokenizer.count(context)
      report.tokenCount = tokenCount
      if (request.limits && tokenCount > request.limits.maxTokens)
        throw new DashError(
          'BUDGET_EXCEEDED',
          `Context requires ${tokenCount} tokens; limit is ${request.limits.maxTokens}`
        )
      return { success: true, context, tokenCount, report }
    } catch (error) {
      const failure =
        error instanceof DashError
          ? error
          : new DashError(
              'EXACT_SOURCE_UNAVAILABLE',
              error instanceof Error ? error.message : 'Code Map unavailable'
            )
      report.error = {
        code: failure.code,
        message: failure.message,
        ...(failure.step ? { step: failure.step } : {})
      }
      return { success: false, report }
    }
  }
}
