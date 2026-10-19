import { expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import type { GitHistoryNode } from '../../../../shared/types/git-management-types'
import { firstParentPath, layoutGitAtlas } from './atlas-layout'
import { layoutGitGraph } from './graph-layout'

const node = (sha: string, parents: string[], day: number): GitHistoryNode => ({ sha, parents, subject: sha, author: 'Author', timestamp: new Date(Date.UTC(2026, 9, day)).toISOString(), decorations: [] })
function page(nodes: GitHistoryNode[], tips: Record<string, string>): GitAtlasPage {
  const refs = Object.entries(tips).map(([name, sha]) => ({ ref: `refs/heads/${name}`, sha, name, kind: 'LOCAL' as const, upstream: null }))
  return { nodes, refs, snapshot: 'fixture', head: tips.trunk, branch: 'trunk', primaryRef: 'refs/heads/trunk', queriedAt: '2026-10-15T12:00:00Z', since: null, detachedHeads: [], detachedCoverage: 'COMPLETE', tags: [], pendingParents: [], boundary: [], coverage: 'COMPLETE_WINDOW', nextCursor: null }
}

it('draws only direct DAG parents, gives each SHA one identity and preserves first-parent meaning', () => {
  const nodes = [node('merge', ['main', 'topic'], 5), node('main', ['root'], 4), node('topic', ['root'], 3), node('root', [], 1)]
  const result = layoutGitAtlas(page(nodes, { trunk: 'merge', topic: 'topic', alias: 'topic' }))
  expect(result.points).toHaveLength(4)
  expect(new Set(result.points.map(point => point.node.sha)).size).toBe(4)
  expect(new Set(result.edges.map(edge => `${edge.child}:${edge.parent}`))).toEqual(new Set(['merge:main', 'merge:topic', 'main:root', 'topic:root']))
  expect([...firstParentPath(new Map(nodes.map(node => [node.sha, node])), 'merge')]).toEqual(['merge', 'main', 'root'])
  expect(result.edges.find(edge => edge.parent === 'topic')?.secondary).toBe(true)
  expect(result.tracks.find(track => track.ref === 'refs/heads/trunk')?.lane).toBe(0)
})

it('reuses non-overlapping lanes without drawing continuity between separate work', () => {
  const result = layoutGitAtlas(page([node('early', [], 1), node('late', [], 10)], { trunk: 'early', later: 'late' }))
  expect(result.tracks).toHaveLength(2)
  expect(result.tracks[0].lane).toBe(result.tracks[1].lane)
  expect(result.tracks[0].color).not.toBe(result.tracks[1].color)
  expect(result.edges).toEqual([])
  expect(result.laneCount).toBe(1)
})

it('keeps colliding trajectories apart including the horizontal spans of connectors', () => {
  const input = page([node('a', ['root'], 2), node('b', ['root'], 3), node('root', [], 1)], { trunk: 'a', parallel: 'b' })
  const result = layoutGitAtlas(input)
  expect(result.tracks[0].lane).not.toBe(result.tracks[1].lane)
  for (const left of result.tracks) for (const right of result.tracks) {
    if (left !== right && left.lane === right.lane) expect(left.end < right.start || right.end < left.start).toBe(true)
  }
  expect(layoutGitAtlas({ ...input, nodes: [...input.nodes].reverse(), refs: [...input.refs].reverse() })).toEqual(result)
})

it('shows boundary anchors, anonymous incorporated paths and inverted timestamps without fictitious edges', () => {
  const input = page([node('merge', ['prior', 'anonymous'], 2), node('anonymous', ['outside'], 4)], { trunk: 'merge', inactive: 'old' })
  const result = layoutGitAtlas(input)
  expect(result.anchors).toEqual([{ child: 'anonymous', parent: 'outside' }, { child: 'merge', parent: 'prior' }])
  expect(result.tracks.some(track => track.label === 'Trajetória incorporada')).toBe(true)
  expect(result.edges).toEqual([{ child: 'merge', parent: 'anonymous', secondary: true, skew: true }])
  expect(result.inactive.map(ref => ref.name)).toEqual(['inactive'])
  expect(layoutGitAtlas(page([], { trunk: 'old' })).points).toEqual([])
})

it('does not label FF or squash as topological integration and only renders the loaded window', () => {
  const input = page([node('squash', ['base'], 5), node('topic', ['base'], 4), node('base', [], 1)], { trunk: 'squash', topic: 'topic', fastAlias: 'base' })
  expect(layoutGitAtlas(input).edges.every(edge => !edge.secondary)).toBe(true)
  const small = layoutGitAtlas({ ...input, nodes: [input.nodes[0]] })
  expect(small.points.map(point => point.node.sha)).toEqual(['squash'])
  expect(small.anchors).toEqual([{ child: 'squash', parent: 'base' }])
})

it('retains lane positions for a small append and handles 120 refs with bounded projection work', () => {
  const nodes = [node('root', [], 1), ...Array.from({ length: 120 }, (_, i) => node(`n${i}`, ['root'], 2 + i % 10))]
  const input = page(nodes, { trunk: 'n0', ...Object.fromEntries(nodes.slice(2).map(node => [`branch-${node.sha}`, node.sha])) })
  const result = layoutGitAtlas(input)
  const previous = new Map(result.tracks.map(track => [track.id, track.lane]))
  const appended = layoutGitAtlas({ ...input, nodes: [...nodes, node('new', ['n0'], 15)], refs: input.refs.map(ref => ref.ref === 'refs/heads/trunk' ? { ...ref, sha: 'new' } : ref) }, undefined, previous)
  expect(appended.tracks.map(track => [track.id, track.lane])).toEqual(result.tracks.map(track => [track.id, track.lane]))
  const start = performance.now()
  for (let count = 0; count < 20; count++) layoutGitAtlas(input)
  const atlasMs = performance.now() - start
  const baseline = performance.now()
  for (let count = 0; count < 20; count++) layoutGitGraph(nodes)
  const baselineMs = performance.now() - baseline
  expect(atlasMs).toBeLessThan(1000)
  console.info(JSON.stringify({ atlasMs, baselineMs, nodes: nodes.length, refs: input.refs.length, iterations: 20 }))
})
