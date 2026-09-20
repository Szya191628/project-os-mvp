export type SpecialReleasePredecessor = {
  taskId: string
  nodeId: string
  wbs: string
  name: string
  status: string
}

export type SpecialReleaseSnapshot = {
  workflowVersionId: string
  targetNodeId: string
  predecessorTaskIds: string[]
  predecessors: SpecialReleasePredecessor[]
  reason: string
  approvalId?: string
  requestedAt?: string
  approvedAt?: string
}

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function parseSpecialRelease(value: unknown): SpecialReleaseSnapshot | null {
  const record = recordValue(value)
  const workflowVersionId = textValue(record?.workflowVersionId)
  const targetNodeId = textValue(record?.targetNodeId)
  const reason = textValue(record?.reason)
  const predecessorTaskIds = Array.isArray(record?.predecessorTaskIds) ? record.predecessorTaskIds.flatMap((item) => textValue(item) ? [textValue(item)!] : []) : []
  const predecessors = Array.isArray(record?.predecessors) ? record.predecessors.flatMap((item) => {
    const predecessor = recordValue(item)
    const taskId = textValue(predecessor?.taskId)
    const nodeId = textValue(predecessor?.nodeId)
    const wbs = textValue(predecessor?.wbs)
    const name = textValue(predecessor?.name)
    const status = textValue(predecessor?.status)
    return taskId && nodeId && wbs && name && status ? [{ taskId, nodeId, wbs, name, status }] : []
  }) : []
  if (!workflowVersionId || !targetNodeId || !reason || predecessorTaskIds.length === 0 || predecessors.length === 0) return null
  return {
    workflowVersionId,
    targetNodeId,
    predecessorTaskIds,
    predecessors,
    reason,
    ...(textValue(record?.approvalId) ? { approvalId: textValue(record?.approvalId) } : {}),
    ...(textValue(record?.requestedAt) ? { requestedAt: textValue(record?.requestedAt) } : {}),
    ...(textValue(record?.approvedAt) ? { approvedAt: textValue(record?.approvedAt) } : {}),
  }
}

export function isSpecialReleaseForVersion(value: unknown, workflowVersionId: string) {
  const release = parseSpecialRelease(value)
  return release?.workflowVersionId === workflowVersionId ? release : null
}
