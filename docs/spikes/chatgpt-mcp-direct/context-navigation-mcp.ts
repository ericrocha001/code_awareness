import {
  ContextNavigationError,
  type DiscoverRepositoryResult,
  type InspectScopeResult,
  type ReadCodeResult
} from '../../../src/shared/types/context-navigation-types'
import type { ContextNavigationPort } from '../../../src/main/core/context/context-navigation-port'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}

export const contextNavigationTools: McpToolDefinition[] = [
  {
    name: 'ping',
    description: 'Check whether Code Awareness is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'discover_repository',
    description:
      'Use to gain initial structural awareness of the current repository, including its structure and relationships. From this map, determine which files form the relevant scope of the investigation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'inspect_scope',
    description:
      'Use after identifying from the repository map which files belong to the investigation scope. Returns the structural anatomy only of those files, including elements and available CodeTargets, without loading source bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        relativePaths: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          uniqueItems: true
        }
      },
      required: ['relativePaths'],
      additionalProperties: false
    }
  },
  {
    name: 'read_code',
    description:
      'Use when you know exactly which CodeTargets you need to observe. Returns only the literal code for the requested targets, without neighboring code, whole files, or related context.',
    inputSchema: {
      type: 'object',
      properties: {
        targetIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          uniqueItems: true
        }
      },
      required: ['targetIds'],
      additionalProperties: false
    }
  }
]

function requireStringArray(args: unknown, property: 'relativePaths' | 'targetIds'): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ContextNavigationError(
      property === 'relativePaths' ? 'EMPTY_SCOPE' : 'EMPTY_TARGETS',
      `Expected an object containing ${property}`
    )
  }

  const value = (args as Record<string, unknown>)[property]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ContextNavigationError(
      property === 'relativePaths' ? 'EMPTY_SCOPE' : 'EMPTY_TARGETS',
      `${property} must be an array of strings`
    )
  }

  return value
}

function success(payload: DiscoverRepositoryResult | InspectScopeResult | ReadCodeResult[] | string): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload)
      }
    ]
  }
}

function failure(error: unknown): McpToolResult {
  const details = error instanceof ContextNavigationError
    ? { name: error.name, code: error.code, message: error.message, reference: error.reference }
    : { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }

  return {
    content: [{ type: 'text', text: JSON.stringify({ error: details }) }],
    isError: true
  }
}

export class ContextNavigationMcpAdapter {
  constructor(
    private readonly navigation: ContextNavigationPort,
    private readonly repoPath: string
  ) {}

  listTools(): McpToolDefinition[] {
    return contextNavigationTools
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    try {
      switch (name) {
        case 'ping':
          return success('Code Awareness reachable')
        case 'discover_repository':
          return success(await this.navigation.discoverRepository(this.repoPath))
        case 'inspect_scope':
          return success(await this.navigation.inspectScope(this.repoPath, requireStringArray(args, 'relativePaths')))
        case 'read_code':
          return success(await this.navigation.readCode(this.repoPath, requireStringArray(args, 'targetIds')))
        default:
          return failure(new Error(`Unknown tool: ${name}`))
      }
    } catch (error) {
      return failure(error)
    }
  }
}
