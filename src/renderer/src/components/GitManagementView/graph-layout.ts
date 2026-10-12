import type { GitHistoryNode } from '../../../../shared/types/git-management-types'

export interface GraphEdge {
  from: string
  to: string
  fromLane: number
  toLane: number
  fromRow: number
  toRow: number
  pending: boolean
}
export function layoutGitGraph(nodes: GitHistoryNode[]) {
  const lanes: Array<string | null> = []
  const rows = new Map(nodes.map((node, row) => [node.sha, row]))
  const points = nodes.map((node, row) => {
    let lane = lanes.indexOf(node.sha)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
      lanes[lane] = node.sha
    }
    lanes[lane] = null
    const parents = node.parents.map((parent, index) => {
      let target = lanes.indexOf(parent)
      if (target < 0) {
        target =
          index === 0 && lanes[lane] === null ? lane : lanes.indexOf(null)
        if (target < 0) target = lanes.length
        lanes[target] = parent
      }
      return { parent, lane: target }
    })
    return { node, row, lane, parents }
  })
  const edges: GraphEdge[] = points.flatMap((point) =>
    point.parents.map((parent) => {
      const targetRow = rows.get(parent.parent)
      return {
        from: point.node.sha,
        to: parent.parent,
        fromLane: point.lane,
        toLane: parent.lane,
        fromRow: point.row,
        toRow: targetRow ?? nodes.length,
        pending: targetRow === undefined
      }
    })
  )
  return {
    points,
    edges,
    laneCount: Math.max(
      1,
      ...points.map((point) =>
        Math.max(
          point.lane + 1,
          ...point.parents.map((parent) => parent.lane + 1)
        )
      )
    )
  }
}
