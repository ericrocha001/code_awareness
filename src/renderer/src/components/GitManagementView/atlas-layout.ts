import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import type { GitHistoryNode } from '../../../../shared/types/git-management-types'

export interface AtlasTrack {
  id: string
  label: string
  ref: string | null
  shas: string[]
  lane: number
  start: number
  end: number
  color: number
  detached: boolean
  references: GitAtlasPage['refs']
}
export interface AtlasPoint { node: GitHistoryNode; x: number; lane: number; track: string }
export interface AtlasEdge { child: string; parent: string; secondary: boolean; skew: boolean; receivingTrack: string }
export interface AtlasLayout {
  tracks: AtlasTrack[]
  points: AtlasPoint[]
  edges: AtlasEdge[]
  anchors: { child: string; parent: string }[]
  inactive: GitAtlasPage['refs']
  laneCount: number
  width: number
}
function causalOrder(nodes: Map<string, GitHistoryNode>): GitHistoryNode[] {
  const ordered: GitHistoryNode[] = [], visited = new Set<string>()
  const seeds = [...nodes.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sha.localeCompare(b.sha))
  for (const seed of seeds) {
    const stack: Array<{ node: GitHistoryNode; expanded: boolean }> = [{ node: seed, expanded: false }]
    while (stack.length) {
      const item = stack.pop()!
      if (item.expanded) { ordered.push(item.node); continue }
      if (visited.has(item.node.sha)) continue
      visited.add(item.node.sha)
      stack.push({ node: item.node, expanded: true })
      for (const sha of [...item.node.parents].reverse()) {
        const parent = nodes.get(sha)
        if (parent && !visited.has(sha)) stack.push({ node: parent, expanded: false })
      }
    }
  }
  return ordered
}

export function firstParentPath(nodes: Map<string, GitHistoryNode>, tip?: string): Set<string> {
  const path = new Set<string>()
  let sha = tip
  while (sha && nodes.has(sha) && !path.has(sha)) { path.add(sha); sha = nodes.get(sha)!.parents[0] }
  return path
}

export function layoutGitAtlas(page: GitAtlasPage | null, baseRef?: string, previous: ReadonlyMap<string, number> = new Map()): AtlasLayout {
  if (!page) return { tracks: [], points: [], edges: [], anchors: [], inactive: [], laneCount: 1, width: 800 }
  const nodes = new Map(page.nodes.map(node => [node.sha, node]))
  const chronological = causalOrder(nodes)
  const positions = new Map<string, number>()
  let last = 32
  for (const node of chronological) {
    last += 56
    positions.set(node.sha, last)
  }
  const owner = new Map<string, string>(), tracks: AtlasTrack[] = []
  const primary = baseRef || page.primaryRef
  const refs = [...page.refs].sort((a, b) => Number(b.ref === primary) - Number(a.ref === primary) || Number(a.kind === 'HEAD') - Number(b.kind === 'HEAD') || a.ref.localeCompare(b.ref))
  const continuation = new Map<string, string>()
  const referenceTips = new Set<string>()
  const preferFirstParent = (tip: string) => {
    let node = nodes.get(tip)
    while (node) {
      const parent = node.parents[0]
      if (!nodes.has(parent) || continuation.has(parent) || referenceTips.has(parent)) break
      continuation.set(parent, node.sha)
      node = nodes.get(parent)
    }
  }
  for (const ref of refs) { preferFirstParent(ref.sha); referenceTips.add(ref.sha) }
  for (const detached of page.detachedHeads) { preferFirstParent(detached.sha); referenceTips.add(detached.sha) }
  for (const node of [...chronological].reverse()) preferFirstParent(node.sha)
  const secondaryTips = new Set(chronological.flatMap(node => node.parents.slice(1)))
  for (const seed of chronological) {
    if (owner.has(seed.sha)) continue
    const shas: string[] = []
    let sha: string | undefined = seed.sha
    while (sha && nodes.has(sha) && !owner.has(sha)) {
      shas.push(sha)
      sha = continuation.get(sha)
    }
    const members = new Set(shas)
    const references = refs.filter(ref => members.has(ref.sha))
    const reference = references[0]
    const detached = page.detachedHeads.find(head => members.has(head.sha))
    const tip = shas[shas.length - 1]
    const id = reference?.ref ?? (detached ? `detached:${tip}` : `segment:${tip}`)
    const label = reference?.name ?? (detached ? `HEAD detached · ${detached.name}` : secondaryTips.has(tip) ? 'Trecho de contribuição' : 'Trecho do histórico')
    for (const member of shas) owner.set(member, id)
    tracks.push({ id, label, ref: reference?.ref ?? null, references, shas: shas.reverse(), lane: 0, start: 0, end: 0, color: 0, detached: !!detached })
  }
  const edges: AtlasEdge[] = [], anchors: AtlasLayout['anchors'] = []
  for (const node of [...nodes.values()].sort((a, b) => a.sha.localeCompare(b.sha))) node.parents.forEach((parent, index) => {
    if (nodes.has(parent)) edges.push({ child: node.sha, parent, secondary: index > 0, skew: Date.parse(nodes.get(parent)!.timestamp) > Date.parse(node.timestamp), receivingTrack: owner.get(node.sha)! })
    else anchors.push({ child: node.sha, parent })
  })
  const spans = new Map(tracks.map(track => [track.id, track.shas.map(sha => positions.get(sha)!)]))
  for (const edge of edges) {
    spans.get(owner.get(edge.child)!)!.push(positions.get(edge.parent)!)
    spans.get(owner.get(edge.parent)!)!.push(positions.get(edge.child)!)
  }
  const occupied: Array<Array<[number, number]>> = []
  for (const track of tracks) {
    const values = spans.get(track.id)!
    track.start = values.reduce((a, b) => Math.min(a, b), Infinity) - 20
    track.end = values.reduce((a, b) => Math.max(a, b), -Infinity) + 20
  }
  tracks.sort((a, b) => Number(b.ref === primary) - Number(a.ref === primary) || a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))
  for (const track of tracks) {
    const fits = (lane: number) => !occupied[lane]?.some(([start, end]) => track.start <= end && track.end >= start)
    const preferred = track.ref === primary ? 0 : previous.get(track.id)
    let lane = preferred !== undefined && preferred < tracks.length && fits(preferred) ? preferred : 0
    while (!fits(lane)) lane++
    track.lane = lane
    ;(occupied[lane] ??= []).push([track.start, track.end])
  }
  const lanes = new Map(tracks.map(track => [track.id, track.lane]))
  return {
    tracks, edges, anchors,
    points: chronological.map(node => ({ node, x: positions.get(node.sha)!, track: owner.get(node.sha)!, lane: lanes.get(owner.get(node.sha)!)! })),
    inactive: page.refs.filter(ref => ref.kind !== 'HEAD' && !nodes.has(ref.sha)).sort((a, b) => a.ref.localeCompare(b.ref)),
    laneCount: Math.max(1, occupied.length), width: Math.max(800, last + 120)
  }
}
