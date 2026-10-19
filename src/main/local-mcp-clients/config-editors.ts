import { parseForESLint, getStaticTOMLValue } from 'toml-eslint-parser'
import { parseTree, getNodeValue, findNodeAtLocation, modify, applyEdits, type Node } from 'jsonc-parser'

export interface McpEntry { command: string; args: string[]; env?: Record<string, string>; disabled?: boolean; autoApprove?: string[]; type?: 'stdio' }
const fail = (): never => { throw new Error('INVALID_CLIENT_CONFIG') }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function jsonTree(source: string): Node {
  const errors: import('jsonc-parser').ParseError[] = []
  const tree = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false })
  if (!tree || tree.type !== 'object' || errors.length) return fail()
  function unique(node: Node) {
    if (node.type === 'object') {
      const keys = node.children?.map(child => child.children![0].value) ?? []
      if (new Set(keys).size !== keys.length) fail()
    }
    node.children?.forEach(unique)
  }
  unique(tree)
  const servers = findNodeAtLocation(tree, ['mcpServers'])
  if (servers && servers.type !== 'object') fail()
  return tree
}

export function readEntry(source: string | null, toml: boolean, key: string): unknown {
  if (source === null) return undefined
  if (!toml) {
    const node = findNodeAtLocation(jsonTree(source), ['mcpServers', key])
    return node ? getNodeValue(node) : undefined
  }
  const ast = parseForESLint(source).ast
  const value = getStaticTOMLValue(ast) as Record<string, unknown>
  if (value.mcp_servers !== undefined && !record(value.mcp_servers)) fail()
  return (value.mcp_servers as Record<string, unknown> | undefined)?.[key]
}

export function editEntry(source: string | null, toml: boolean, key: string, entry: McpEntry | undefined): string {
  readEntry(source, toml, key)
  const text = source ?? (toml ? '' : '{}\n')
  if (!toml) {
    const result = applyEdits(text, modify(text, ['mcpServers', key], entry, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' }
    }))
    jsonTree(result)
    return result
  }
  const ast = parseForESLint(text).ast
  const tables = ast.body[0].body.filter(node => node.type === 'TOMLTable')
  const target = tables.filter(node => node.resolvedKey[0] === 'mcp_servers' && node.resolvedKey[1] === key)
  const existing = readEntry(source, true, key)
  if (target.length > 1 || target.some(node => node.resolvedKey.length !== 2) || existing !== undefined && target.length !== 1) throw new Error('UNSUPPORTED_TOML_LAYOUT')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const replacement = entry ? `[mcp_servers.${key}]${eol}command = ${JSON.stringify(entry.command)}${eol}args = ${JSON.stringify(entry.args)}${eol}${entry.env ? `env = { ${Object.entries(entry.env).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }${eol}` : ''}` : ''
  const table = target[0]
  const comments = table ? ast.comments.filter(comment => comment.range[0] >= table.range[0] && comment.range[1] <= table.range[1]).map(comment => text.slice(...comment.range)) : []
  const preserved = comments.length ? comments.join(eol) + eol : ''
  const result = table ? text.slice(0, table.range[0]) + preserved + replacement + text.slice(table.range[1]) : text + (text.endsWith('\n') || !text ? '' : eol) + eol + replacement
  parseForESLint(result)
  return result
}

export function sameEntry(a: unknown, b: McpEntry): boolean {
  if (!record(a)) return false
  return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => JSON.stringify(a[key]) === JSON.stringify(b[key as keyof McpEntry]))
}
