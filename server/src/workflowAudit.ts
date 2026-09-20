import type { Prisma } from '@prisma/client'

export type WorkflowAuditSnapshot = {
  versionId: string
  versionNo: number
  status: string
  baselineStart: string
  nodes: {
    id: string
    wbs: string
    nodeType: string
    name: string
    ownerMemberId: string | null
    durationDays: number
    effortHours: number
    description: string | null
    closureCriteria: string | null
    positionX: number
    positionY: number
    plannedStart: string | null
    plannedEnd: string | null
  }[]
  edges: {
    source: string
    target: string
    dependencyType: string
    lagDays: number
  }[]
}

export type WorkflowAuditSummary = {
  headline: string
  details: string[]
  nodeAddedCount: number
  nodeRemovedCount: number
  nodeUpdatedCount: number
  layoutChangedCount: number
  dependencyAddedCount: number
  dependencyRemovedCount: number
  scheduleChangedCount: number
}

export type WorkflowAuditAction = 'WORKFLOW_DRAFT_SAVED' | 'WORKFLOW_PUBLISHED_UPDATED' | 'WORKFLOW_PUBLISHED'

export async function captureWorkflowAuditSnapshot(tx: Prisma.TransactionClient, versionId: string): Promise<WorkflowAuditSnapshot | null> {
  const version = await tx.workflowVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      versionNo: true,
      status: true,
      baselineStart: true,
      nodes: {
        orderBy: { wbs: 'asc' },
        select: {
          id: true,
          wbs: true,
          nodeType: true,
          name: true,
          ownerMemberId: true,
          durationDays: true,
          effortHours: true,
          description: true,
          closureCriteria: true,
          positionX: true,
          positionY: true,
          schedules: { select: { plannedStart: true, plannedEnd: true } },
        },
      },
      edges: { select: { sourceNodeId: true, targetNodeId: true, dependencyType: true, lagDays: true } },
    },
  })
  if (!version) return null
  const nodeById = new Map(version.nodes.map((node) => [node.id, node]))
  return {
    versionId: version.id,
    versionNo: version.versionNo,
    status: version.status,
    baselineStart: version.baselineStart.toISOString().slice(0, 10),
    nodes: version.nodes.map((node) => ({
      id: node.id,
      wbs: node.wbs,
      nodeType: node.nodeType,
      name: node.name,
      ownerMemberId: node.ownerMemberId,
      durationDays: node.durationDays,
      effortHours: node.effortHours,
      description: node.description,
      closureCriteria: node.closureCriteria,
      positionX: node.positionX,
      positionY: node.positionY,
      plannedStart: node.schedules[0]?.plannedStart.toISOString().slice(0, 10) ?? null,
      plannedEnd: node.schedules[0]?.plannedEnd.toISOString().slice(0, 10) ?? null,
    })),
    edges: version.edges.map((edge) => ({
      source: nodeById.get(edge.sourceNodeId)?.wbs ?? edge.sourceNodeId,
      target: nodeById.get(edge.targetNodeId)?.wbs ?? edge.targetNodeId,
      dependencyType: edge.dependencyType,
      lagDays: edge.lagDays,
    })),
  }
}

const asSnapshot = (value: unknown): WorkflowAuditSnapshot | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WorkflowAuditSnapshot>
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges) ? value as WorkflowAuditSnapshot : null
}

const nodeLabel = (node: WorkflowAuditSnapshot['nodes'][number]) => `${node.wbs} ${node.name}`.trim()
const nodeFields = ['nodeType', 'name', 'ownerMemberId', 'durationDays', 'effortHours', 'description', 'closureCriteria'] as const
const edgeKey = (edge: WorkflowAuditSnapshot['edges'][number]) => `${edge.source}->${edge.target} ${edge.dependencyType} lag${edge.lagDays}`

export function summarizeWorkflowAudit(action: WorkflowAuditAction, beforeJson: unknown, afterJson: unknown): WorkflowAuditSummary {
  const before = asSnapshot(beforeJson)
  const after = asSnapshot(afterJson)
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.wbs, node]))
  const afterNodes = new Map((after?.nodes ?? []).map((node) => [node.wbs, node]))
  const addedNodes = [...afterNodes.values()].filter((node) => !beforeNodes.has(node.wbs))
  const removedNodes = [...beforeNodes.values()].filter((node) => !afterNodes.has(node.wbs))
  const updatedNodes = [...afterNodes.values()].filter((node) => {
    const previous = beforeNodes.get(node.wbs)
    return previous && nodeFields.some((field) => previous[field] !== node[field])
  })
  const layoutChangedNodes = [...afterNodes.values()].filter((node) => {
    const previous = beforeNodes.get(node.wbs)
    return Boolean(previous && (previous.positionX !== node.positionX || previous.positionY !== node.positionY))
  })
  const scheduleChangedNodes = [...afterNodes.values()].filter((node) => {
    const previous = beforeNodes.get(node.wbs)
    return Boolean(previous && (previous.plannedStart !== node.plannedStart || previous.plannedEnd !== node.plannedEnd))
  })
  const beforeEdges = new Map((before?.edges ?? []).map((edge) => [edgeKey(edge), edge]))
  const afterEdges = new Map((after?.edges ?? []).map((edge) => [edgeKey(edge), edge]))
  const addedEdges = [...afterEdges.values()].filter((edge) => !beforeEdges.has(edgeKey(edge)))
  const removedEdges = [...beforeEdges.values()].filter((edge) => !afterEdges.has(edgeKey(edge)))
  const details: string[] = []
  const addDetails = (label: string, items: string[]) => {
    if (items.length === 0) return
    const visible = items.slice(0, 6)
    details.push(`${label}：${visible.join('、')}${items.length > visible.length ? ` 等 ${items.length} 项` : ''}`)
  }

  addDetails('新增节点', addedNodes.map(nodeLabel))
  addDetails('移除节点', removedNodes.map(nodeLabel))
  addDetails('修改节点', updatedNodes.map(nodeLabel))
  addDetails('布局调整', layoutChangedNodes.map(nodeLabel))
  addDetails('排期调整', scheduleChangedNodes.map((node) => `${nodeLabel(node)} ${beforeNodes.get(node.wbs)?.plannedStart ?? '—'}→${node.plannedStart ?? '—'}，${beforeNodes.get(node.wbs)?.plannedEnd ?? '—'}→${node.plannedEnd ?? '—'}`))
  addDetails('新增依赖', addedEdges.map((edge) => `${edge.source} → ${edge.target}`))
  addDetails('移除依赖', removedEdges.map((edge) => `${edge.source} → ${edge.target}`))

  if (action === 'WORKFLOW_PUBLISHED') details.unshift(`发布流程版本 v${after?.versionNo ?? '—'}`)
  if (details.length === 0) details.push(action === 'WORKFLOW_PUBLISHED' ? '流程状态已更新为已发布' : action === 'WORKFLOW_PUBLISHED_UPDATED' ? '更新已发布流程，未检测到结构变化' : '保存流程草稿，未检测到结构变化')
  return {
    headline: action === 'WORKFLOW_PUBLISHED' ? `发布流程版本 v${after?.versionNo ?? '—'}` : action === 'WORKFLOW_PUBLISHED_UPDATED' ? `更新已发布流程 v${after?.versionNo ?? '—'}` : `保存流程草稿 v${after?.versionNo ?? '—'}`,
    details,
    nodeAddedCount: addedNodes.length,
    nodeRemovedCount: removedNodes.length,
    nodeUpdatedCount: updatedNodes.length,
    layoutChangedCount: layoutChangedNodes.length,
    dependencyAddedCount: addedEdges.length,
    dependencyRemovedCount: removedEdges.length,
    scheduleChangedCount: scheduleChangedNodes.length,
  }
}

export function hasWorkflowAuditChanges(beforeJson: unknown, afterJson: unknown) {
  const summary = summarizeWorkflowAudit('WORKFLOW_DRAFT_SAVED', beforeJson, afterJson)
  return summary.nodeAddedCount > 0
    || summary.nodeRemovedCount > 0
    || summary.nodeUpdatedCount > 0
    || summary.dependencyAddedCount > 0
    || summary.dependencyRemovedCount > 0
    || summary.scheduleChangedCount > 0
}
