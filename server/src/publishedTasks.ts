import { PrismaClient } from '@prisma/client'
import { isSpecialReleaseForVersion } from './taskRelease.js'

type PublishedTaskDb = Pick<PrismaClient, 'project' | 'workflowNode' | 'workflowEdge'>

const completedStatuses = new Set(['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'])

export type PublishedTaskCandidate = {
  nodeId: string
  versionId: string
  versionNo: number
  versionStatus: string
  taskId: string | null
  taskArchivedAt: Date | null
  nodeType: string
  projectId: string
  projectCode: string
  projectName: string
  projectStatus: string
  wbs: string
  name: string
  ownerMemberId: string | null
  ownerName: string | null
  ownerActive: boolean
  activeAssigneeIds: string[]
  status: string | null
  progress: number | null
  effortHours: number
  plannedStart: Date | null
  plannedEnd: Date | null
  actualStart: Date | null
  actualEnd: Date | null
  description: string | null
  closureCriteria: string | null
  specialRelease: boolean
  blockedBy: string[]
  deliverableCount: number
  closureCheckCount: number
  completedClosureCheckCount: number
}

export type PublishedWorkflowTask = {
  id: string
  nodeId: string
  versionId: string
  versionNo: number
  workflowStatus: 'published'
  projectId: string
  projectCode: string
  projectName: string
  projectStatus: string
  wbs: string
  name: string
  owner: string
  ownerMemberId: string | null
  assigneeIds: string[]
  status: string
  progress: number
  effort: number
  plannedStart: string | null
  plannedEnd: string | null
  actualStart: string | null
  actualEnd: string | null
  blockedBy: string[]
  overdue: boolean
  milestone: boolean
  description: string | null
  closureCriteria: string | null
  deliverableCount: number
  closureCheckCount: number
  completedClosureCheckCount: number
}

export function resolvePublishedTaskAssignees(input: { ownerMemberId: string | null; ownerActive: boolean; activeAssigneeIds: string[] }) {
  const assigneeIds = [...new Set(input.activeAssigneeIds)]
  return assigneeIds.length > 0 ? assigneeIds : input.ownerActive && input.ownerMemberId ? [input.ownerMemberId] : []
}

export function projectPublishedTasks(candidates: PublishedTaskCandidate[], today = new Date().toISOString().slice(0, 10)): PublishedWorkflowTask[] {
  const unique = new Map<string, PublishedWorkflowTask>()
  const orderedCandidates = [...candidates].sort((left, right) => left.projectCode.localeCompare(right.projectCode, 'zh-CN') || left.wbs.localeCompare(right.wbs, undefined, { numeric: true }) || left.taskId?.localeCompare(right.taskId ?? '') || 0)
  for (const candidate of orderedCandidates) {
    if (candidate.versionStatus !== 'PUBLISHED' || !candidate.taskId || candidate.taskArchivedAt || (candidate.nodeType !== 'TASK' && candidate.nodeType !== 'MILESTONE')) continue
    const plannedEnd = dateOnly(candidate.plannedEnd)
    const executionStatus = candidate.status ?? 'NOT_STARTED'
    const effectiveBlockedBy = candidate.specialRelease ? [] : candidate.blockedBy
    const status = effectiveBlockedBy.length > 0 && !completedStatuses.has(executionStatus) ? 'BLOCKED' : executionStatus
    const task: PublishedWorkflowTask = {
      id: candidate.taskId,
      nodeId: candidate.nodeId,
      versionId: candidate.versionId,
      versionNo: candidate.versionNo,
      workflowStatus: 'published',
      projectId: candidate.projectId,
      projectCode: candidate.projectCode,
      projectName: candidate.projectName,
      projectStatus: candidate.projectStatus,
      wbs: candidate.wbs,
      name: candidate.name,
      owner: candidate.ownerName ?? '待分配',
      ownerMemberId: candidate.ownerMemberId,
      assigneeIds: resolvePublishedTaskAssignees(candidate),
      status,
      progress: candidate.progress ?? 0,
      effort: candidate.effortHours,
      plannedStart: dateOnly(candidate.plannedStart),
      plannedEnd,
      actualStart: dateOnly(candidate.actualStart),
      actualEnd: dateOnly(candidate.actualEnd),
      blockedBy: effectiveBlockedBy,
      overdue: Boolean(plannedEnd && plannedEnd < today && !completedStatuses.has(status)),
      milestone: candidate.nodeType === 'MILESTONE',
      description: candidate.description,
      closureCriteria: candidate.closureCriteria,
      deliverableCount: candidate.deliverableCount,
      closureCheckCount: candidate.closureCheckCount,
      completedClosureCheckCount: candidate.completedClosureCheckCount,
    }
    const key = `${task.projectId}:${task.wbs}`
    const existing = unique.get(key)
    if (!existing || task.versionNo > existing.versionNo) unique.set(key, task)
  }
  return [...unique.values()]
}

export async function loadPublishedWorkflowTasks(db: PublishedTaskDb, input: { organizationId: string; projectIds?: Iterable<string> | null; memberId?: string }, today = new Date().toISOString().slice(0, 10)) {
  const projectIds = input.projectIds === undefined || input.projectIds === null ? undefined : [...input.projectIds]
  if (projectIds?.length === 0) return []

  const projects = await db.project.findMany({
    where: { organizationId: input.organizationId, archivedAt: null, ...(projectIds ? { id: { in: projectIds } } : {}) },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      workflow: { select: { publishedVersion: { select: { id: true, versionNo: true } } } },
    },
  })
  const projectByVersion = new Map<string, (typeof projects)[number]>()
  for (const project of projects) {
    const version = project.workflow?.publishedVersion
    if (version) projectByVersion.set(version.id, project)
  }
  const versionIds = [...projectByVersion.keys()]
  if (versionIds.length === 0) return []

  const nodes = await db.workflowNode.findMany({
    where: { workflowVersionId: { in: versionIds }, nodeType: { in: ['TASK', 'MILESTONE'] }, taskId: { not: null }, task: { archivedAt: null } },
    orderBy: [{ workflowVersionId: 'asc' }, { wbs: 'asc' }],
    select: {
      id: true,
      workflowVersionId: true,
      taskId: true,
      nodeType: true,
      wbs: true,
      name: true,
      ownerMemberId: true,
      ownerMember: { select: { id: true, name: true, status: true } },
      effortHours: true,
      description: true,
      closureCriteria: true,
      schedules: { orderBy: { computedAt: 'desc' }, take: 1, select: { plannedStart: true, plannedEnd: true } },
      task: {
        select: {
          archivedAt: true,
          execution: { select: { status: true, progress: true, actualStart: true, actualEnd: true, specialRelease: true } },
          assignees: { where: { removedAt: null, member: { status: 'ACTIVE' } }, orderBy: { assignedAt: 'asc' }, select: { memberId: true } },
          closureChecks: { select: { completed: true } },
          deliverables: { where: { deletedAt: null }, select: { id: true } },
        },
      },
    },
  })
  const edges = await db.workflowEdge.findMany({
    where: { workflowVersionId: { in: versionIds } },
    select: { workflowVersionId: true, targetNodeId: true, sourceNode: { select: { nodeType: true, name: true, task: { select: { execution: { select: { status: true } } } } } } },
  })
  const blockedBy = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.sourceNode.nodeType === 'START' || edge.sourceNode.nodeType === 'END' || completedStatuses.has(String(edge.sourceNode.task?.execution?.status ?? 'NOT_STARTED'))) continue
    const key = `${edge.workflowVersionId}:${edge.targetNodeId}`
    blockedBy.set(key, [...(blockedBy.get(key) ?? []), edge.sourceNode.name])
  }

  const candidates: PublishedTaskCandidate[] = nodes.flatMap((node) => {
    const project = projectByVersion.get(node.workflowVersionId)
    if (!project || !node.taskId) return []
    const version = project.workflow?.publishedVersion
    const task = node.task
    return [{
      nodeId: node.id,
      versionId: node.workflowVersionId,
      versionNo: version?.versionNo ?? 0,
      versionStatus: 'PUBLISHED',
      taskId: node.taskId,
      taskArchivedAt: task?.archivedAt ?? null,
      nodeType: String(node.nodeType),
      projectId: project.id,
      projectCode: project.code,
      projectName: project.name,
      projectStatus: String(project.status),
      wbs: node.wbs,
      name: node.name,
      ownerMemberId: node.ownerMemberId,
      ownerName: node.ownerMember?.name ?? null,
      ownerActive: node.ownerMember?.status === 'ACTIVE',
      activeAssigneeIds: task?.assignees.map((assignee) => assignee.memberId) ?? [],
      status: task?.execution?.status ? String(task.execution.status) : null,
      progress: task?.execution?.progress ?? null,
      effortHours: node.effortHours,
      plannedStart: node.schedules[0]?.plannedStart ?? null,
      plannedEnd: node.schedules[0]?.plannedEnd ?? null,
      actualStart: task?.execution?.actualStart ?? null,
      actualEnd: task?.execution?.actualEnd ?? null,
      description: node.description,
      closureCriteria: node.closureCriteria,
      specialRelease: Boolean(isSpecialReleaseForVersion(task?.execution?.specialRelease, node.workflowVersionId)),
      blockedBy: blockedBy.get(`${node.workflowVersionId}:${node.id}`) ?? [],
      deliverableCount: task?.deliverables.length ?? 0,
      closureCheckCount: task?.closureChecks.length ?? 0,
      completedClosureCheckCount: task?.closureChecks.filter((check) => check.completed).length ?? 0,
    }]
  })
  const projected = projectPublishedTasks(candidates, today)
  return input.memberId ? projected.filter((task) => task.assigneeIds.includes(input.memberId!)) : projected
}

function dateOnly(value: Date | null | undefined) {
  return value?.toISOString().slice(0, 10) ?? null
}
