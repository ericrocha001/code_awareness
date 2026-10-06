export interface McpOAuthSecurityScheme {
  type: 'oauth2'
  scopes: string[]
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  securitySchemes: McpOAuthSecurityScheme[]
  _meta?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
  postResponse?: () => void | Promise<void>
}
