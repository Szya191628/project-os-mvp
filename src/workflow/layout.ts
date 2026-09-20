import type { Workflow, WorkflowNode, WorkflowPosition } from '../types'

export const FLOW_NODE_WIDTH = 184
export const FLOW_NODE_HEIGHT = 88
export const FLOW_COLUMN_GAP = 56
export const FLOW_ROW_GAP = 24

/**
 * Arrange only node coordinates. The graph, task fields and dependency edges
 * remain untouched so this function is safe to use for an explicit layout-only
 * action.
 */
export function arrangeWorkflowNodes(workflow: Workflow) {
  const nodes = workflow.nodes
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const predecessors = new Map<string, string[]>()
  const successors = new Map<string, string[]>()
  for (const node of nodes) {
    predecessors.set(node.id, [])
    successors.set(node.id, [])
  }
  for (const edge of workflow.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue
    predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), edge.source])
    successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target])
  }

  const depths = calculateDepths(nodes, predecessors)
  const columns = calculateColumns(nodes, predecessors, depths)
  const maxColumn = Math.max(...columns.values(), 0)
  const layers = new Map<number, WorkflowNode[]>()
  for (const node of nodes) {
    const column = columns.get(node.id) ?? 0
    layers.set(column, [...(layers.get(column) ?? []), node])
  }

  const orderedLayers = new Map<number, WorkflowNode[]>()
  for (let column = 0; column <= maxColumn; column += 1) {
    const layer = layers.get(column) ?? []
    const ordered = [...layer].sort(compareByPosition)
    orderedLayers.set(column, ordered)
  }

  // Barycenter ordering keeps branches aligned with their predecessors and
  // reduces crossings without changing the dependency graph.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let column = 1; column <= maxColumn; column += 1) {
      const previous = orderedLayers.get(column - 1) ?? []
      const previousIndex = new Map(previous.map((node, index) => [node.id, index]))
      const current = orderedLayers.get(column) ?? []
      orderedLayers.set(column, [...current].sort((first, second) => {
        const firstParents = (predecessors.get(first.id) ?? []).map((id) => previousIndex.get(id)).filter((value): value is number => value !== undefined)
        const secondParents = (predecessors.get(second.id) ?? []).map((id) => previousIndex.get(id)).filter((value): value is number => value !== undefined)
        const firstCenter = firstParents.length > 0 ? average(firstParents) : Number.POSITIVE_INFINITY
        const secondCenter = secondParents.length > 0 ? average(secondParents) : Number.POSITIVE_INFINITY
        return firstCenter - secondCenter || compareByPosition(first, second)
      }))
    }
    for (let column = maxColumn - 1; column >= 0; column -= 1) {
      const next = orderedLayers.get(column + 1) ?? []
      const nextIndex = new Map(next.map((node, index) => [node.id, index]))
      const current = orderedLayers.get(column) ?? []
      orderedLayers.set(column, [...current].sort((first, second) => {
        const firstChildren = (successors.get(first.id) ?? []).map((id) => nextIndex.get(id)).filter((value): value is number => value !== undefined)
        const secondChildren = (successors.get(second.id) ?? []).map((id) => nextIndex.get(id)).filter((value): value is number => value !== undefined)
        const firstCenter = firstChildren.length > 0 ? average(firstChildren) : Number.POSITIVE_INFINITY
        const secondCenter = secondChildren.length > 0 ? average(secondChildren) : Number.POSITIVE_INFINITY
        return firstCenter - secondCenter || compareByPosition(first, second)
      }))
    }
  }

  const rowCount = Math.max(...[...orderedLayers.values()].map((layer) => layer.length), 1)
  const positions: Record<string, WorkflowPosition> = {}
  for (let column = 0; column <= maxColumn; column += 1) {
    const layer = orderedLayers.get(column) ?? []
    const offset = (rowCount - layer.length) * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP) / 2
    layer.forEach((node, index) => {
      positions[node.id] = {
        x: 64 + column * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP),
        y: Math.round(64 + offset + index * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP)),
      }
    })
  }
  return positions
}

export interface SerialWorkflowAlignmentResult {
  positions: Record<string, WorkflowPosition>
  alignedNodeIds: string[]
  movedNodeIds: string[]
}

export type SerialAlignmentNode = {
  id: string
  type: string
  position: WorkflowPosition
}

export type SerialAlignmentEdge = {
  source: string
  target: string
}

/**
 * Align each serial node chain to one horizontal row without changing the
 * dependency graph. Branch and merge nodes are left in place so the layout
 * continues to communicate where the workflow forks and joins.
 */
export function alignSerialNodes(nodes: readonly SerialAlignmentNode[], edges: readonly SerialAlignmentEdge[], isEligible: (node: SerialAlignmentNode) => boolean = (node) => node.type !== 'start' && node.type !== 'end'): SerialWorkflowAlignmentResult {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  }

  const serialIds = new Set(nodes
    .filter(isEligible)
    .filter((node) => (incoming.get(node.id) ?? []).length === 1 && (outgoing.get(node.id) ?? []).length === 1)
    .map((node) => node.id))
  const serialNeighbors = new Map<string, string[]>([...serialIds].map((id) => [id, []]))
  for (const id of serialIds) {
    for (const neighbor of [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])]) {
      if (serialIds.has(neighbor)) serialNeighbors.set(id, [...(serialNeighbors.get(id) ?? []), neighbor])
    }
  }

  const positions = Object.fromEntries(nodes.map((node) => [node.id, { ...node.position }]))
  const alignedNodeIds: string[] = []
  const visited = new Set<string>()
  for (const node of nodes) {
    if (!serialIds.has(node.id) || visited.has(node.id)) continue
    const component: SerialAlignmentNode[] = []
    const queue = [node.id]
    visited.add(node.id)
    while (queue.length > 0) {
      const currentId = queue.shift()!
      const current = nodeById.get(currentId)
      if (current) component.push(current)
      for (const neighbor of serialNeighbors.get(currentId) ?? []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
    if (component.length < 2) continue
    const rows = component.map((current) => current.position.y).sort((first, second) => first - second)
    const middle = Math.floor(rows.length / 2)
    const targetY = rows.length % 2 === 0 ? Math.round((rows[middle - 1] + rows[middle]) / 2) : rows[middle]
    for (const current of component) {
      alignedNodeIds.push(current.id)
      positions[current.id] = { ...current.position, y: targetY }
    }
  }

  const movedNodeIds = nodes
    .filter((node) => positions[node.id].x !== node.position.x || positions[node.id].y !== node.position.y)
    .map((node) => node.id)
  return { positions, alignedNodeIds, movedNodeIds }
}

export function alignSerialWorkflowNodes(workflow: Workflow): SerialWorkflowAlignmentResult {
  return alignSerialNodes(workflow.nodes, workflow.edges)
}

function calculateColumns(
  nodes: WorkflowNode[],
  predecessors: Map<string, string[]>,
  depths: Map<string, number>,
) {
  const columns = new Map(nodes.map((node) => [node.id, 0]))
  const maxDepth = Math.max(...depths.values(), 0)

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (const node of nodes) {
      if ((depths.get(node.id) ?? 0) !== depth || node.type === 'start') continue
      const parentColumns = (predecessors.get(node.id) ?? []).map((parentId) => columns.get(parentId) ?? 0)
      const dependencyColumn = parentColumns.length > 0 ? Math.max(...parentColumns) + 1 : 0
      columns.set(node.id, dependencyColumn)
    }
  }

  return columns
}

function calculateDepths(nodes: WorkflowNode[], predecessors: Map<string, string[]>) {
  const depths = new Map<string, number>()
  const startNodes = nodes.filter((node) => node.type === 'start')
  for (const node of startNodes) depths.set(node.id, 0)
  for (const node of nodes) if (node.type !== 'start' && (predecessors.get(node.id) ?? []).length === 0) depths.set(node.id, node.type === 'end' ? 1 : 1)

  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false
    for (const node of nodes) {
      if (node.type === 'start') continue
      const parentDepths = (predecessors.get(node.id) ?? []).map((id) => depths.get(id)).filter((value): value is number => value !== undefined)
      if (parentDepths.length !== (predecessors.get(node.id) ?? []).length || parentDepths.length === 0) continue
      const nextDepth = Math.max(...parentDepths) + 1
      if (depths.get(node.id) !== nextDepth) {
        depths.set(node.id, nextDepth)
        changed = true
      }
    }
    if (!changed) break
  }

  const fallbackDepth = Math.max(...depths.values(), 0) + 1
  for (const node of nodes) if (!depths.has(node.id)) depths.set(node.id, Math.max(1, Math.round(node.position.x / (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP))))
  const endNodes = nodes.filter((node) => node.type === 'end')
  for (const node of endNodes) depths.set(node.id, Math.max(depths.get(node.id) ?? fallbackDepth, fallbackDepth))
  return depths
}

function compareByPosition(first: WorkflowNode, second: WorkflowNode) {
  return first.position.y - second.position.y
    || first.wbs.localeCompare(second.wbs, 'zh-CN')
    || first.id.localeCompare(second.id)
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function buildOrthogonalPath(start: WorkflowPosition, end: WorkflowPosition, alignedRouteX?: number) {
  if (Math.abs(start.y - end.y) < 1) return `M ${start.x} ${start.y} H ${end.x}`
  const middleX = alignedRouteX ?? (start.x <= end.x ? Math.round((start.x + end.x) / 2) : Math.max(start.x, end.x) + 32)
  return `M ${start.x} ${start.y} H ${middleX} V ${end.y} H ${end.x}`
}
