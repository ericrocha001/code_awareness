import { expect, it } from 'vitest'
import { layoutGitGraph } from './graph-layout'

it('keeps every real parent edge and marks only missing parents as pending', () => {
  const nodes = [
    ['merge', 'left', 'right'],
    ['left', 'root'],
    ['right', 'root'],
    ['root', 'outside']
  ].map(([sha, ...parents]) => ({
    sha,
    parents,
    author: 'Author',
    timestamp: '',
    subject: sha,
    decorations: []
  }))
  const graph = layoutGitGraph(nodes)
  expect(graph.edges.map((edge) => [edge.from, edge.to])).toEqual([
    ['merge', 'left'],
    ['merge', 'right'],
    ['left', 'root'],
    ['right', 'root'],
    ['root', 'outside']
  ])
  expect(
    graph.edges.filter((edge) => edge.pending).map((edge) => edge.to)
  ).toEqual(['outside'])
  expect(graph.points[1].lane).not.toBe(graph.points[2].lane)
  expect(graph.edges.find((edge) => edge.from === 'right')?.toLane).toBe(
    graph.points[3].lane
  )
})
