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
export type McpTextContent = { type: 'text'; text: string }
export type McpImageContent = { type: 'image'; mimeType: 'image/webp'; data: string }
export type McpContent = McpTextContent | McpImageContent
export type McpMultimodalToolResult = McpToolResult<McpContent>
export interface McpToolResult<Content = McpTextContent> {
  content: Content[]
  isError?: true
  postResponse?: () => void | Promise<void>
}
