import type { McpContent } from './mcp-types'

export function textContent(content: McpContent): string {
  if (content.type !== 'text') throw new Error('Expected textual MCP content')
  return content.text
}
