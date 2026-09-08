import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'

export interface PathBranch {
  prefix: string
  paths: string[]
  flatCost: number
  trieCost: number
  winner: 'flat' | 'trie'
  savings: number
}

export interface AdaptivePathReport {
  branches: PathBranch[]
  totalFlatCost: number
  totalTrieCost: number
  totalAdaptiveCost: number
  totalSavings: number
  savingsPercent: number
}

interface TrieNode {
  directories: Map<string, TrieNode>
  files: string[]
}

function buildTrie(paths: string[]): TrieNode {
  const root: TrieNode = { directories: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    for (const directory of parts.slice(0, -1)) {
      let child = node.directories.get(directory)
      if (!child) {
        child = { directories: new Map(), files: [] }
        node.directories.set(directory, child)
      }
      node = child
    }
    node.files.push(parts.at(-1)!)
  }
  return root
}

function serializeFlat(paths: string[]): string[] {
  return paths
}

function serializeTrie(node: TrieNode, depth = 0): string[] {
  const prefix = '\t'.repeat(depth)
  const lines: string[] = []
  const sortedDirs = [...node.directories].sort(([a], [b]) => a.localeCompare(b, 'en'))
  for (const [name, child] of sortedDirs) {
    lines.push(`${prefix}${name}/`)
    lines.push(...serializeTrie(child, depth + 1))
  }
  const sortedFiles = [...node.files].sort((a, b) => a.localeCompare(b, 'en'))
  for (const file of sortedFiles) {
    lines.push(`${prefix}${file}`)
  }
  return lines
}

function collectAllPaths(node: TrieNode, prefix: string): string[] {
  const result: string[] = []
  for (const file of node.files) {
    result.push(`${prefix}${file}`)
  }
  for (const [name, child] of node.directories) {
    result.push(...collectAllPaths(child, `${prefix}${name}/`))
  }
  return result
}

function extractBranches(node: TrieNode, prefix = ''): Array<{ prefix: string; paths: string[] }> {
  const branches: Array<{ prefix: string; paths: string[] }> = []
  const allPaths = collectAllPaths(node, prefix)
  if (allPaths.length > 0) {
    branches.push({ prefix, paths: allPaths })
  }
  for (const [name, child] of node.directories) {
    const childPath = `${prefix}${name}/`
    branches.push(...extractBranches(child, childPath))
  }
  return branches
}

export function analyzeAdaptivePaths(paths: string[], tokenizer: TokenizerPort = getCanonicalTokenizer()): AdaptivePathReport {
  const root = buildTrie(paths)
  const branches = extractBranches(root)

  const analyzedBranches: PathBranch[] = branches.map((branch) => {
    const flatContent = serializeFlat(branch.paths).join('\n')
    const trieContent = serializeTrie(buildTrie(branch.paths)).join('\n')
    const flatCost = tokenizer.count(flatContent)
    const trieCost = tokenizer.count(trieContent)
    const winner = trieCost < flatCost ? 'trie' : 'flat'
    const savings = Math.abs(flatCost - trieCost)
    return { ...branch, flatCost, trieCost, winner, savings }
  })

  const totalFlatCost = analyzedBranches.reduce((sum, b) => sum + b.flatCost, 0)
  const totalTrieCost = analyzedBranches.reduce((sum, b) => sum + b.trieCost, 0)
  const totalAdaptiveCost = analyzedBranches.reduce((sum, b) => sum + (b.winner === 'trie' ? b.trieCost : b.flatCost), 0)
  const totalSavings = totalFlatCost - totalAdaptiveCost
  const savingsPercent = totalFlatCost > 0 ? (totalSavings / totalFlatCost) * 100 : 0

  return {
    branches: analyzedBranches,
    totalFlatCost,
    totalTrieCost,
    totalAdaptiveCost,
    totalSavings,
    savingsPercent
  }
}

export function generateAdaptivePathReport(report: AdaptivePathReport): string {
  const lines: string[] = []
  lines.push('# Adaptive Path Encoding Report')
  lines.push('')
  lines.push('## Summary')
  lines.push(`- Flat cost: ${report.totalFlatCost} tokens`)
  lines.push(`- Trie cost: ${report.totalTrieCost} tokens`)
  lines.push(`- Adaptive cost: ${report.totalAdaptiveCost} tokens`)
  lines.push(`- Savings: ${report.totalSavings} tokens (${report.savingsPercent.toFixed(1)}%)`)
  lines.push('')
  lines.push('## Branches')
  lines.push('| Prefix | Paths | Flat | Trie | Winner | Savings |')
  lines.push('|--------|-------|------|------|--------|---------|')
  for (const branch of report.branches.slice(0, 20)) {
    lines.push(`| ${branch.prefix} | ${branch.paths.length} | ${branch.flatCost} | ${branch.trieCost} | ${branch.winner} | ${branch.savings} |`)
  }
  if (report.branches.length > 20) {
    lines.push(`| ... | ... | ... | ... | ... | ... |`)
    lines.push(`*${report.branches.length - 20} more branches*`)
  }
  return lines.join('\n')
}
