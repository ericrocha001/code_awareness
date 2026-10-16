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
}
export interface AtlasPoint { node: GitHistoryNode; x: number; lane: number; track: string }
export interface AtlasEdge { child: string; parent: string; secondary: boolean; skew: boolean }
export interface AtlasLayout {
  tracks: AtlasTrack[]
  points: AtlasPoint[]
  edges: AtlasEdge[]
  anchors: { child: string; parent: string }[]
  inactive: GitAtlasPage['refs']
  laneCount: number
  width: number
}
const hash = (value: string) => { let result = 0; for (const character of value) result = (result * 31 + character.charCodeAt(0)) >>> 0; return result }

export function firstParentPath(nodes: Map<string, GitHistoryNode>, tip?: string): Set<string> {
  const path = new Set<string>()
  let sha = tip
  while (sha && nodes.has(sha) && !path.has(sha)) { path.add(sha); sha = nodes.get(sha)!.parents[0] }
  return path
}

export function layoutGitAtlas(page: GitAtlasPage | null, baseRef?: string, previous: ReadonlyMap<string, number> = new Map()): AtlasLayout {
  if (!page) return { tracks: [], points: [], edges: [], anchors: [], inactive: [], laneCount: 1, width: 800 }
  const nodes = new Map(page.nodes.map(node => [node.sha, node]))
  const chronological = [...nodes.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sha.localeCompare(b.sha))
  const positions = new Map<string, number>()
  const earliest = chronological.length ? Date.parse(chronological[0].timestamp) : 0
  let last = 32
  for (const node of chronological) {
    const real = 64 + (Date.parse(node.timestamp) - earliest) / 86400000 * 32
    last = Math.max(last + 38, real)
    positions.set(node.sha, last)
  }
  const owner = new Map<string, string>(), tracks: AtlasTrack[] = []
  const primary = baseRef || page.primaryRef
  const refs = [...page.refs].sort((a, b) => Number(b.ref === primary) - Number(a.ref === primary) || Number(a.kind === 'HEAD') - Number(b.kind === 'HEAD') || a.ref.localeCompare(b.ref))
  const walk = (tip: string, id: string, label: string, ref: string | null, detached = false) => {
    const shas: string[] = []
    let sha: string | undefined = tip
    while (sha && nodes.has(sha) && !owner.has(sha)) {
      shas.push(sha); owner.set(sha, id); sha = nodes.get(sha)!.parents[0]
    }
    if (shas.length) tracks.push({ id, label, ref, shas, lane: 0, start: 0, end: 0, color: hash(id) % 6, detached })
  }
  for (const ref of refs) walk(ref.sha, ref.ref, ref.kind === 'HEAD' ? ref.name : ref.name, ref.ref)
  for (const detached of page.detachedHeads) walk(detached.sha, `detached:${detached.sha}`, `HEAD detached · ${detached.name}`, null, true)
  for (const node of [...nodes.values()].sort((a, b) => a.sha.localeCompare(b.sha))) {
    for (const parent of node.parents.slice(1)) walk(parent, `incorporated:${node.sha}:${parent}`, 'Trajetória incorporada', null)
  }
  for (const node of [...nodes.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.sha.localeCompare(b.sha))) walk(node.sha, `segment:${node.sha}`, 'Trecho do histórico', null)
  const edges: AtlasEdge[] = [], anchors: AtlasLayout['anchors'] = []
  for (const node of [...nodes.values()].sort((a, b) => a.sha.localeCompare(b.sha))) node.parents.forEach((parent, index) => {
    if (nodes.has(parent)) edges.push({ child: node.sha, parent, secondary: index > 0, skew: Date.parse(nodes.get(parent)!.timestamp) > Date.parse(node.timestamp) })
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
    track.start = Math.min(...values) - 20; track.end = Math.max(...values) + 20
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
