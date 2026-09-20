import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Prisma, TaskExecutionStatus, WorkflowNodeType, WorkflowVersionStatus } from '@prisma/client'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { appendAuditLog, isGlobalL2, isL1, requireClaimTaskPublishPermission, requireGlobalPermission, requireProjectPermission, requireTaskPermission } from '../auth.js'
import { organizationIdFor, projectSummary, projectSummarySelect, serializeVersionForViewer, versionSelect } from './projects.js'
import { captureWorkflowAuditSnapshot } from '../workflowAudit.js'
import { appendPortfolioWorkflowAuditLog, normalizePortfolioWorkflow, portfolioWorkflowInput } from '../portfolioWorkflow.js'
import { deliverableObjectPath, safeDeliverableName } from '../deliverables/dingtalkDelivery.js'
import { isSpecialReleaseForVersion } from '../taskRelease.js'
import { canClaimIndependentTask, claimTaskScope } from '../claimTaskAccess.js'

type Tx = Prisma.TransactionClient
type ProjectParams = { projectId: string }
type PortfolioParams = { portfolioId: string }
type TaskParams = { taskId: string }
type ProjectMemberParams = { projectId: string; memberId: string }
type TaskAssigneeParams = { taskId: string; memberId: string }
type ClaimTaskParams = { claimTaskId: string }

type ProjectInput = {
  name?: string
  code?: string
  ownerMemberId?: string
  ownerName?: string
  departmentId?: string
  departmentName?: string
  portfolioId?: string | null
  plannedStart?: string
  plannedEnd?: string
}

type PortfolioInput = {
  name?: string
  code?: string
  description?: string | null
  ownerMemberId?: string
  ownerName?: string
  projectIds?: string[]
}

type DraftNodeInput = {
  id?: string
  type?: string
  nodeType?: string
  wbs?: string
  parentId?: string
  parentTaskId?: string
  name?: string
  ownerMemberId?: string
  owner?: string
  assigneeIds?: string[]
  duration?: number
  durationDays?: number
  effort?: number
  effortHours?: number
  description?: string | null
  closureCriteria?: string | null
  plannedStartOverride?: string | null
  plannedEndOverride?: string | null
  position?: { x?: number; y?: number }
  positionX?: number
  positionY?: number
  plannedStart?: string | null
  plannedEnd?: string | null
  schedule?: { plannedStart?: string; plannedEnd?: string; startOffset?: number; endOffset?: number; calendarSpan?: number }
  progress?: number
  status?: string
  actualStart?: string | null
  actualEnd?: string | null
  completionApprovalStatus?: string | null
  completionConfirmedAt?: string | null
  completionNote?: string | null
  overdueReason?: string | null
  closureChecks?: { id?: string; label: string; completed?: boolean }[]
  deliverables?: { id?: string; kind?: string; name: string; version?: string; versionLabel?: string; url?: string; objectKey?: string; mimeType?: string; size?: number; sizeBytes?: number; approvalProcessInstanceId?: string; approvalProcessCode?: string; approvalFileId?: string; approvalSpaceId?: string }[]
}

type DraftEdgeInput = { id?: string; source?: string; target?: string; sourceNodeId?: string; targetNodeId?: string; type?: string; dependencyType?: string; lagDays?: number }
type DraftInput = { baselineStart?: string; nodes?: DraftNodeInput[]; edges?: DraftEdgeInput[]; calendar?: { name?: string; mode?: string; weeklyWorkdays?: number[]; holidays?: string[]; customRestDays?: string[]; makeupWorkdays?: string[] } }

const executionStatusByLabel: Record<string, TaskExecutionStatus> = {
  '未开始': TaskExecutionStatus.NOT_STARTED,
  '进行中': TaskExecutionStatus.IN_PROGRESS,
  '受阻': TaskExecutionStatus.BLOCKED,
  '到期未完成': TaskExecutionStatus.DUE_UNFINISHED,
  '已完成': TaskExecutionStatus.COMPLETED,
  '提前结束': TaskExecutionStatus.EARLY_FINISHED,
  '如期结束': TaskExecutionStatus.ON_TIME_FINISHED,
  '超期结束': TaskExecutionStatus.OVERDUE_FINISHED,
}

const nodeTypeByLabel: Record<string, WorkflowNodeType> = {
  start: WorkflowNodeType.START,
  START: WorkflowNodeType.START,
  task: WorkflowNodeType.TASK,
  TASK: WorkflowNodeType.TASK,
  milestone: WorkflowNodeType.MILESTONE,
  MILESTONE: WorkflowNodeType.MILESTONE,
  end: WorkflowNodeType.END,
  END: WorkflowNodeType.END,
}

const deliverableKind = (value: string | undefined) => value?.toLowerCase() === 'link' ? 'LINK' : value?.toLowerCase() === 'dingtalk' ? 'DINGTALK' : 'FILE'
const completedExecutionStatuses = new Set<string>([TaskExecutionStatus.COMPLETED, TaskExecutionStatus.EARLY_FINISHED, TaskExecutionStatus.ON_TIME_FINISHED, TaskExecutionStatus.OVERDUE_FINISHED])

const dateValue = (value: string | null | undefined, fallback?: Date) => {
  if (!value) return fallback
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? fallback : date
}

const optionalDateValue = (value: string | null | undefined) => value === undefined ? undefined : value === null ? null : dateValue(value)

const completionApprovalStatus = (nextStatus: string) => completedExecutionStatuses.has(nextStatus) ? 'APPROVED' : 'PENDING'

const writeUploadedFile = async (file: { file: AsyncIterable<Buffer>; filename: string; mimetype?: string }) => {
  const temporaryDirectory = path.resolve(config.deliverables.storageDir, '.tmp')
  await mkdir(temporaryDirectory, { recursive: true })
  const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.upload`)
  const output = createWriteStream(temporaryPath, { flags: 'wx' })
  const hash = createHash('sha256')
  let sizeBytes = 0
  try {
    for await (const chunk of file.file) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      sizeBytes += bytes.byteLength
      if (sizeBytes > config.deliverables.maxSizeBytes) throw new Error('deliverable_file_too_large')
      hash.update(bytes)
      if (!output.write(bytes)) await once(output, 'drain')
    }
    if (file.file instanceof Object && 'truncated' in file.file && file.file.truncated) throw new Error('deliverable_file_too_large')
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject)
      output.end(() => resolve())
    })
    if (sizeBytes === 0) throw new Error('deliverable_file_empty')
    return { temporaryPath, sizeBytes, sha256: hash.digest('hex'), mimeType: file.mimetype?.trim() || undefined, name: safeDeliverableName(file.filename) }
  } catch (error) {
    output.destroy()
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function assertTaskCompletionApproved(tx: Pick<Tx, 'taskApproval'>, taskId: string) {
  const approval = await tx.taskApproval.findFirst({ where: { taskId, status: 'APPROVED', autoCompleteStatus: 'COMPLETED' }, select: { id: true } })
  if (!approval) throw new Error('task_approval_required')
}

const validUuid = (value: string | undefined) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
const uuidLike = (value: string | undefined) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + Math.max(0, days))
  return next
}

const hasCycle = (edges: Array<{ sourceNodeId: string; targetNodeId: string }>) => {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) adjacency.set(edge.sourceNodeId, [...(adjacency.get(edge.sourceNodeId) ?? []), edge.targetNodeId])
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    for (const next of adjacency.get(nodeId) ?? []) if (visit(next)) return true
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }
  return [...adjacency.keys()].some((nodeId) => visit(nodeId))
}

async function resolveMember(tx: Tx, organizationId: string, memberId?: string, memberName?: string) {
  if (memberId) return tx.member.findFirst({ where: { id: memberId, organizationId, status: 'ACTIVE' } })
  if (!memberName || ['待分配', '项目组'].includes(memberName.trim())) return null
  return tx.member.findFirst({ where: { organizationId, name: memberName.trim(), status: 'ACTIVE' } })
}

async function resolveDepartment(tx: Tx, organizationId: string, departmentId?: string, departmentName?: string) {
  if (departmentId) return tx.department.findFirst({ where: { id: departmentId, organizationId } })
  if (!departmentName?.trim()) return null
  const existing = await tx.department.findFirst({ where: { organizationId, parentId: null, name: departmentName.trim() } })
  return existing ?? tx.department.create({ data: { organizationId, name: departmentName.trim() } })
}

async function createEmptyWorkflow(tx: Tx, projectId: string, organizationId: string, baselineStart: Date, createdById?: string) {
  const calendar = await tx.workCalendar.create({
    data: {
      organizationId,
      projectId,
      name: '项目工作日历',
      mode: 'NATURAL',
      weekdays: { create: [1, 2, 3, 4, 5].map((weekday) => ({ weekday })) },
    },
  })
  const workflow = await tx.workflow.create({ data: { projectId } })
  const version = await tx.workflowVersion.create({ data: { workflowId: workflow.id, versionNo: 1, status: 'DRAFT', baselineStart, calendarId: calendar.id, createdById } })
  const startId = randomUUID()
  const endId = randomUUID()
  await tx.workflowNode.createMany({ data: [
    { id: startId, workflowVersionId: version.id, nodeType: 'START', wbs: '0', name: '项目开始', positionX: 80, positionY: 160 },
    { id: endId, workflowVersionId: version.id, nodeType: 'END', wbs: '2', name: '项目结束', positionX: 620, positionY: 160 },
  ] })
  await tx.workflowNodeSchedule.createMany({ data: [
    { workflowVersionId: version.id, nodeId: startId, plannedStart: baselineStart, plannedEnd: baselineStart, startOffset: 0, endOffset: 0, calendarSpan: 1 },
    { workflowVersionId: version.id, nodeId: endId, plannedStart: baselineStart, plannedEnd: baselineStart, startOffset: 0, endOffset: 0, calendarSpan: 1 },
  ] })
  await tx.workflow.update({ where: { id: workflow.id }, data: { draftVersionId: version.id } })
  return { workflow, version }
}

async function cloneVersion(tx: Tx, workflowId: string, sourceId: string, createdById?: string) {
  const source = await tx.workflowVersion.findUnique({ where: { id: sourceId }, include: { nodes: true, edges: true, schedules: true } })
  if (!source) throw new Error('workflow_version_not_found')
  const latest = await tx.workflowVersion.findFirst({ where: { workflowId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
  const version = await tx.workflowVersion.create({ data: { workflowId, versionNo: (latest?.versionNo ?? 0) + 1, status: 'DRAFT', baselineStart: source.baselineStart, calendarId: source.calendarId, createdById } })
  const idMap = new Map<string, string>()
  for (const node of source.nodes) {
    const id = randomUUID()
    idMap.set(node.id, id)
    await tx.workflowNode.create({ data: { id, workflowVersionId: version.id, taskId: node.taskId, nodeType: node.nodeType, wbs: node.wbs, parentTaskId: node.parentTaskId, name: node.name, ownerMemberId: node.ownerMemberId, durationDays: node.durationDays, effortHours: node.effortHours, description: node.description, closureCriteria: node.closureCriteria, plannedStartOverride: node.plannedStartOverride, plannedEndOverride: node.plannedEndOverride, positionX: node.positionX, positionY: node.positionY } })
  }
  for (const edge of source.edges) {
    const sourceNodeId = idMap.get(edge.sourceNodeId)
    const targetNodeId = idMap.get(edge.targetNodeId)
    if (sourceNodeId && targetNodeId) await tx.workflowEdge.create({ data: { workflowVersionId: version.id, sourceNodeId, targetNodeId, dependencyType: edge.dependencyType, lagDays: edge.lagDays } })
  }
  for (const schedule of source.schedules) {
    const nodeId = idMap.get(schedule.nodeId)
    if (nodeId) await tx.workflowNodeSchedule.create({ data: { workflowVersionId: version.id, nodeId, plannedStart: schedule.plannedStart, plannedEnd: schedule.plannedEnd, startOffset: schedule.startOffset, endOffset: schedule.endOffset, calendarSpan: schedule.calendarSpan } })
  }
  await tx.workflow.update({ where: { id: workflowId }, data: { draftVersionId: version.id } })
  return version
}

async function ensureDraft(tx: Tx, workflowId: string, draftVersionId: string | null, publishedVersionId: string | null, createdById?: string) {
  if (draftVersionId) {
    const draft = await tx.workflowVersion.findUnique({ where: { id: draftVersionId } })
    if (draft?.status === WorkflowVersionStatus.DRAFT) return draft
  }
  if (publishedVersionId) return cloneVersion(tx, workflowId, publishedVersionId, createdById)
  const latest = await tx.workflowVersion.findFirst({ where: { workflowId }, orderBy: { versionNo: 'desc' }, select: { baselineStart: true, calendarId: true, versionNo: true } })
  if (!latest) throw new Error('workflow_version_not_found')
  const draft = await tx.workflowVersion.create({ data: { workflowId, versionNo: latest.versionNo + 1, status: 'DRAFT', baselineStart: latest.baselineStart, calendarId: latest.calendarId, createdById } })
  await tx.workflow.update({ where: { id: workflowId }, data: { draftVersionId: draft.id } })
  return draft
}

const executableNodeTypes = [WorkflowNodeType.TASK, WorkflowNodeType.MILESTONE]

async function taskIdsForVersion(tx: Tx, versionId: string) {
  const nodes = await tx.workflowNode.findMany({ where: { workflowVersionId: versionId, nodeType: { in: executableNodeTypes }, taskId: { not: null } }, select: { taskId: true } })
  return new Set(nodes.flatMap((node) => node.taskId ? [node.taskId] : []))
}

async function assertPublishedWorkflowIntegrity(tx: Tx, versionId: string) {
  const nodes = await tx.workflowNode.findMany({
    where: { workflowVersionId: versionId, nodeType: { in: executableNodeTypes } },
    select: { id: true, wbs: true, taskId: true, task: { select: { archivedAt: true } } },
  })
  const invalidTaskNode = nodes.find((node) => !node.taskId || !node.task || node.task.archivedAt)
  if (invalidTaskNode) throw new Error('published_workflow_tasks_invalid')
  const seenWbs = new Set<string>()
  let duplicateWbs = false
  for (const node of nodes) {
    if (seenWbs.has(node.wbs)) duplicateWbs = true
    seenWbs.add(node.wbs)
  }
  if (duplicateWbs) throw new Error('published_workflow_wbs_duplicate')
}

async function archiveTasksRemovedFromPublishedVersion(tx: Tx, previousVersionId: string | null, nextVersionId: string) {
  if (!previousVersionId || previousVersionId === nextVersionId) return
  const previousTaskIds = await taskIdsForVersion(tx, previousVersionId)
  const nextTaskIds = await taskIdsForVersion(tx, nextVersionId)
  const removedTaskIds = [...previousTaskIds].filter((taskId) => !nextTaskIds.has(taskId))
  if (removedTaskIds.length > 0) await tx.task.updateMany({ where: { id: { in: removedTaskIds }, archivedAt: null }, data: { archivedAt: new Date() } })
}

async function saveGraph(tx: Tx, organizationId: string, projectId: string, versionId: string, input: DraftInput, actorMemberId?: string | null) {
  const version = await tx.workflowVersion.findUnique({ where: { id: versionId }, include: { nodes: true } })
  if (!version) throw new Error('workflow_version_not_found')
  const workflow = await tx.workflow.findUnique({ where: { id: version.workflowId }, select: { publishedVersionId: true } })
  const protectedPublishedTaskIds = workflow?.publishedVersionId && workflow.publishedVersionId !== versionId ? await taskIdsForVersion(tx, workflow.publishedVersionId) : new Set<string>()
  // 非完成 → 完成 的状态跃迁需要补发 TASK_COMPLETED 事件（与 PATCH /api/v1/tasks/:taskId 行为一致），
  // 否则经草稿保存/发布写入的完成状态不会触发后置任务的解锁/自动开始。
  const fireTaskCompletedOnTransition = (taskId: string, row: { updatedAt: Date; actualEnd: Date | null }, nextStatus: string, previousStatus: string | undefined) => {
    if (!completedExecutionStatuses.has(nextStatus) || completedExecutionStatuses.has(previousStatus ?? '')) return Promise.resolve()
    return tx.outboxEvent.create({ data: { organizationId, aggregateType: 'TASK', aggregateId: taskId, eventType: 'TASK_COMPLETED', dedupeKey: `task-completed:${taskId}:${row.updatedAt.toISOString()}`, payload: { taskId, projectId, completedAt: row.actualEnd?.toISOString() ?? new Date().toISOString(), completedById: actorMemberId ?? null } } })
  }
  const nodes = Array.isArray(input.nodes) ? input.nodes : []
  const existingById = new Map(version.nodes.map((node) => [node.id, node]))
  const idMap = new Map<string, string>()
  const desiredIds: string[] = []
  const schedules: { nodeId: string; plannedStart: Date; plannedEnd: Date; startOffset: number; endOffset: number; calendarSpan: number }[] = []

  for (const node of nodes) {
    const clientId = node.id ?? randomUUID()
    const existing = validUuid(clientId) ? existingById.get(clientId) : version.nodes.find((candidate) => candidate.wbs === node.wbs)
    const id = existing?.id ?? randomUUID()
    idMap.set(clientId, id)
    desiredIds.push(id)
    const nodeType = nodeTypeByLabel[node.nodeType ?? node.type ?? 'task'] ?? WorkflowNodeType.TASK
    const owner = await resolveMember(tx, organizationId, node.ownerMemberId, node.owner)
    const explicitAssigneeIds = node.assigneeIds === undefined ? undefined : [...new Set(node.assigneeIds.filter(uuidLike))]
    if (node.assigneeIds !== undefined && (!explicitAssigneeIds || node.assigneeIds.some((memberId) => !uuidLike(memberId)))) throw new Error('assignee_not_in_project')
    const assigneeMembers = explicitAssigneeIds && explicitAssigneeIds.length > 0
      ? await tx.member.findMany({ where: { id: { in: explicitAssigneeIds }, organizationId, status: 'ACTIVE' }, select: { id: true, name: true } })
      : []
    if (explicitAssigneeIds && assigneeMembers.length !== explicitAssigneeIds.length) throw new Error('assignee_not_in_organization')
    let taskId = existing?.taskId ?? null
    const activeAssignments = taskId ? await tx.taskAssignee.findMany({ where: { taskId, removedAt: null }, select: { memberId: true } }) : []
    const desiredAssigneeIds = explicitAssigneeIds ?? (activeAssignments.length > 0 ? activeAssignments.map((assignment) => assignment.memberId) : owner?.id ? [owner.id] : [])
    if (explicitAssigneeIds && explicitAssigneeIds.length === 0 && activeAssignments.length > 0) throw new Error('last_task_assignee')
    const desiredAssigneeMembers = desiredAssigneeIds.length > 0
      ? await tx.member.findMany({ where: { id: { in: desiredAssigneeIds }, organizationId, status: 'ACTIVE' }, select: { id: true, name: true } })
      : []
    const assigneeById = new Map(desiredAssigneeMembers.map((member) => [member.id, member]))
    const effectiveOwner = desiredAssigneeIds.map((memberId) => assigneeById.get(memberId)).find((member): member is { id: string; name: string } => Boolean(member)) ?? owner
    const fallbackStart = dateValue(node.plannedStart ?? node.schedule?.plannedStart, version.baselineStart) ?? version.baselineStart
    const duration = Math.max(0, node.durationDays ?? node.duration ?? 0)
    const plannedEnd = dateValue(node.plannedEnd ?? node.schedule?.plannedEnd, addDays(fallbackStart, Math.max(0, duration - 1))) ?? fallbackStart
    if (nodeType === WorkflowNodeType.TASK || nodeType === WorkflowNodeType.MILESTONE) {
      const nextStatus = executionStatusByLabel[node.status ?? '未开始'] ?? TaskExecutionStatus.NOT_STARTED
      if (!taskId) {
        // 状态继承：新建任务行时，从同工作流其他版本里同 wbs 的最近任务继承执行状态，
        // 避免"旧版本已完成/进行中的任务在画布重建、版本切换后丢失执行状态"（仅当旧执行非默认态时生效）
        let inherited: { status: TaskExecutionStatus; progress: number; actualStart: Date | null; actualEnd: Date | null; completionApprovalStatus: string; completionConfirmedAt: Date | null; completionNote: string | null; overdueReason: string | null; specialRelease: Prisma.JsonValue | null } | null = null
        if (node.wbs) {
          const donorNodes = await tx.workflowNode.findMany({
            where: { workflowVersionId: { not: versionId }, wbs: node.wbs, nodeType, taskId: { not: null }, workflowVersion: { workflowId: version.workflowId } },
            include: { task: { include: { execution: true } }, workflowVersion: { select: { versionNo: true } } },
          })
          const donor = donorNodes
            .sort((a, b) => b.workflowVersion.versionNo - a.workflowVersion.versionNo)
            .map((candidate) => candidate.task?.execution ?? null)
            .find((execution) => Boolean(execution)) ?? null
          if (donor && (donor.status !== 'NOT_STARTED' || donor.progress > 0 || donor.actualStart || donor.actualEnd || donor.completionConfirmedAt || donor.completionNote)) {
            inherited = { status: donor.status, progress: donor.progress, actualStart: donor.actualStart, actualEnd: donor.actualEnd, completionApprovalStatus: donor.completionApprovalStatus, completionConfirmedAt: donor.completionConfirmedAt, completionNote: donor.completionNote, overdueReason: donor.overdueReason, specialRelease: donor.specialRelease }
          }
        }
        if (!inherited && completedExecutionStatuses.has(nextStatus)) {
          throw new Error('task_approval_required')
        }
        const task = await tx.task.create({ data: { projectId, createdInVersionId: versionId, taskType: nodeType } })
        taskId = task.id
        const initialStatus = inherited?.status ?? nextStatus
        const created = await tx.taskExecution.create({ data: {
          taskId,
          progress: inherited ? inherited.progress : Math.max(0, Math.min(100, node.progress ?? 0)),
          status: initialStatus,
          actualStart: inherited ? inherited.actualStart : optionalDateValue(node.actualStart),
          actualEnd: inherited ? inherited.actualEnd : optionalDateValue(node.actualEnd),
          completionApprovalStatus: inherited?.completionApprovalStatus ?? completionApprovalStatus(String(initialStatus)),
          completionConfirmedAt: inherited ? inherited.completionConfirmedAt : optionalDateValue(node.completionConfirmedAt),
          completionNote: inherited ? inherited.completionNote : node.completionNote,
          overdueReason: inherited ? inherited.overdueReason : node.overdueReason,
          specialRelease: inherited?.specialRelease as Prisma.InputJsonValue | undefined,
        } })
        await fireTaskCompletedOnTransition(taskId, created, String(created.status), undefined)
      } else if (node.progress !== undefined || node.status) {
        const before = await tx.taskExecution.findUnique({ where: { taskId }, select: { status: true, completionApprovalStatus: true, overdueReason: true } })
        if (completedExecutionStatuses.has(nextStatus) && !completedExecutionStatuses.has(before?.status ?? '') && before?.status === TaskExecutionStatus.DUE_UNFINISHED && !(node.overdueReason?.trim() || before?.overdueReason?.trim())) throw new Error('overdue_reason_required')
        if (completedExecutionStatuses.has(nextStatus) && (!completedExecutionStatuses.has(before?.status ?? '') || before?.completionApprovalStatus !== 'APPROVED')) await assertTaskCompletionApproved(tx, taskId)
        const updated = await tx.taskExecution.upsert({
          where: { taskId },
          update: {
            progress: Math.max(0, Math.min(100, node.progress ?? 0)),
            status: nextStatus,
            actualStart: optionalDateValue(node.actualStart),
            actualEnd: optionalDateValue(node.actualEnd),
            completionApprovalStatus: completionApprovalStatus(String(nextStatus)),
            completionConfirmedAt: optionalDateValue(node.completionConfirmedAt),
            completionNote: node.completionNote,
            overdueReason: node.overdueReason === undefined ? undefined : node.overdueReason?.trim() || null,
          },
          create: {
            taskId,
            progress: Math.max(0, Math.min(100, node.progress ?? 0)),
            status: nextStatus,
            actualStart: optionalDateValue(node.actualStart),
            actualEnd: optionalDateValue(node.actualEnd),
            completionApprovalStatus: completionApprovalStatus(String(nextStatus)),
            completionConfirmedAt: optionalDateValue(node.completionConfirmedAt),
            completionNote: node.completionNote,
            overdueReason: node.overdueReason === undefined ? undefined : node.overdueReason?.trim() || null,
          },
        })
        await fireTaskCompletedOnTransition(taskId, updated, nextStatus, before?.status)
      }
      if (node.closureChecks) {
        await tx.taskClosureCheck.deleteMany({ where: { taskId } })
        if (node.closureChecks.length > 0) await tx.taskClosureCheck.createMany({ data: node.closureChecks.map((check, index) => ({ taskId: taskId as string, label: check.label, completed: Boolean(check.completed), sortOrder: index })) })
      }
      if (node.deliverables) {
        const existingDeliverables = await tx.taskDeliverable.findMany({ where: { taskId }, select: { id: true } })
        const desiredExistingIds = node.deliverables.map((item) => item.id).filter((id): id is string => Boolean(id && validUuid(id)))
        await tx.taskDeliverable.updateMany({ where: { taskId, deletedAt: null, ...(desiredExistingIds.length > 0 ? { id: { notIn: desiredExistingIds } } : {}) }, data: { deletedAt: new Date() } })
        const existingIds = new Set(existingDeliverables.map((item) => item.id))
        for (const item of node.deliverables) {
          const data = { kind: deliverableKind(item.kind) as 'FILE' | 'LINK' | 'DINGTALK', name: item.name, versionLabel: item.versionLabel ?? item.version ?? 'v1', url: item.url ?? null, objectKey: item.objectKey, mimeType: item.mimeType, sizeBytes: item.sizeBytes ?? item.size ?? undefined, approvalProcessInstanceId: item.approvalProcessInstanceId, approvalProcessCode: item.approvalProcessCode, approvalFileId: item.approvalFileId, approvalSpaceId: item.approvalSpaceId, deletedAt: null }
          if (item.id && existingIds.has(item.id)) await tx.taskDeliverable.update({ where: { id: item.id }, data })
          else await tx.taskDeliverable.create({ data: { taskId: taskId as string, ...data } })
        }
      }
    }
    const parentTaskId = node.parentTaskId ?? (node.parentId && validUuid(node.parentId) ? node.parentId : null)
    const data = { workflowVersionId: versionId, taskId, nodeType, wbs: node.wbs ?? (nodeType === WorkflowNodeType.START ? '0' : nodeType === WorkflowNodeType.END ? '2' : `1.${desiredIds.length}`), parentTaskId, name: node.name?.trim() || '待填写任务', ownerMemberId: effectiveOwner?.id ?? null, durationDays: Math.max(0, node.durationDays ?? node.duration ?? 0), effortHours: Math.max(0, node.effortHours ?? node.effort ?? 0), description: node.description ?? null, closureCriteria: node.closureCriteria ?? null, plannedStartOverride: optionalDateValue(node.plannedStartOverride), plannedEndOverride: optionalDateValue(node.plannedEndOverride), positionX: node.positionX ?? node.position?.x ?? 0, positionY: node.positionY ?? node.position?.y ?? 0 }
    if (existing) await tx.workflowNode.update({ where: { id }, data })
    else await tx.workflowNode.create({ data: { id, ...data } })

    if (taskId && (node.assigneeIds !== undefined || activeAssignments.length === 0)) {
      const desired = new Set(desiredAssigneeIds)
      await tx.taskAssignee.updateMany({ where: { taskId, removedAt: null, ...(desired.size > 0 ? { memberId: { notIn: [...desired] } } : {}) }, data: { removedAt: new Date() } })
      for (const memberId of desired) {
        const active = await tx.taskAssignee.findFirst({ where: { taskId, memberId, removedAt: null }, select: { id: true } })
        if (active) continue
        const historical = await tx.taskAssignee.findFirst({ where: { taskId, memberId }, orderBy: { assignedAt: 'desc' }, select: { id: true } })
        if (historical) await tx.taskAssignee.update({ where: { id: historical.id }, data: { removedAt: null, assignedById: null } })
        else await tx.taskAssignee.create({ data: { taskId, memberId } })
      }
    }

    schedules.push({ nodeId: id, plannedStart: fallbackStart, plannedEnd, startOffset: node.schedule?.startOffset ?? 0, endOffset: node.schedule?.endOffset ?? Math.max(0, duration - 1), calendarSpan: node.schedule?.calendarSpan ?? Math.max(1, duration) })
  }

  const staleNodes = version.nodes.filter((node) => !desiredIds.includes(node.id))
  for (const node of staleNodes) {
    if (node.taskId && !protectedPublishedTaskIds.has(node.taskId)) await tx.task.update({ where: { id: node.taskId }, data: { archivedAt: new Date() } })
    await tx.workflowNode.update({ where: { id: node.id }, data: { taskId: null } })
    await tx.workflowNode.delete({ where: { id: node.id } })
  }

  // 草稿保存只改变草稿；当前已发布版本必须始终保持可执行。
  if (workflow?.publishedVersionId && workflow.publishedVersionId !== versionId) await assertPublishedWorkflowIntegrity(tx, workflow.publishedVersionId)

  await tx.workflowEdge.deleteMany({ where: { workflowVersionId: versionId } })
  const edges = Array.isArray(input.edges) ? input.edges : []
  for (const edge of edges) {
    const source = idMap.get(edge.source ?? edge.sourceNodeId ?? '') ?? (validUuid(edge.source ?? edge.sourceNodeId) ? edge.source ?? edge.sourceNodeId : undefined)
    const target = idMap.get(edge.target ?? edge.targetNodeId ?? '') ?? (validUuid(edge.target ?? edge.targetNodeId) ? edge.target ?? edge.targetNodeId : undefined)
    if (!source || !target || source === target) continue
    await tx.workflowEdge.create({ data: { workflowVersionId: versionId, sourceNodeId: source, targetNodeId: target, dependencyType: 'FS', lagDays: edge.lagDays ?? 0 } })
  }
  if (version.status === WorkflowVersionStatus.PUBLISHED) {
    const startedNodes = await tx.workflowNode.findMany({
      where: { workflowVersionId: versionId, nodeType: { in: [WorkflowNodeType.TASK, WorkflowNodeType.MILESTONE] } },
      select: { id: true, task: { select: { execution: { select: { status: true, specialRelease: true } } } }, targetEdges: { select: { sourceNode: { select: { nodeType: true, task: { select: { execution: { select: { status: true } } } } } } } } },
    })
    const invalidStart = startedNodes.some((node) => {
      if (node.task?.execution?.status !== TaskExecutionStatus.IN_PROGRESS || isSpecialReleaseForVersion(node.task.execution.specialRelease, versionId)) return false
      return node.targetEdges.some((edge) => edge.sourceNode.nodeType !== WorkflowNodeType.START && !completedExecutionStatuses.has(edge.sourceNode.task?.execution?.status ?? ''))
    })
    if (invalidStart) throw new Error('predecessors_not_completed')
  }
  await tx.workflowNodeSchedule.deleteMany({ where: { workflowVersionId: versionId } })
  if (schedules.length > 0) await tx.workflowNodeSchedule.createMany({ data: schedules.map((schedule) => ({ ...schedule, workflowVersionId: versionId })) })

  if (input.baselineStart) await tx.workflowVersion.update({ where: { id: versionId }, data: { baselineStart: dateValue(input.baselineStart, version.baselineStart) } })
  if (version.status === WorkflowVersionStatus.PUBLISHED) await assertPublishedWorkflowIntegrity(tx, versionId)
  return versionId
}

async function projectWithSummary(tx: Tx, projectId: string, organizationId: string) {
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId, archivedAt: null }, select: projectSummarySelect })
  return project ? projectSummary(project) : null
}

export async function registerWriteRoutes(app: FastifyInstance) {
  app.post<{ Body: PortfolioInput }>('/api/v1/project-portfolios', async (request, reply) => {
    if (!await requireGlobalPermission(request, reply, 'portfolio.manage')) return
    const organizationId = organizationIdFor(request)
    const name = request.body?.name?.trim()
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    if (!name) return reply.code(400).send({ error: 'portfolio_name_required' })
    const result = await prisma.$transaction(async (tx) => {
      const owner = await resolveMember(tx, organizationId, request.body.ownerMemberId, request.body.ownerName)
      const code = request.body.code?.trim() || `PORT-${String((await tx.projectPortfolio.count({ where: { organizationId } })) + 1).padStart(3, '0')}`
      const portfolio = await tx.projectPortfolio.create({ data: { organizationId, code, name, description: request.body.description?.trim() || null, ownerMemberId: owner?.id } })
      const requestedProjectIds = [...new Set((request.body.projectIds ?? []).filter(uuidLike))]
      const selectedProjects = requestedProjectIds.length > 0 ? await tx.project.findMany({ where: { organizationId, archivedAt: null, id: { in: requestedProjectIds } }, select: { id: true } }) : []
      const projectIds = selectedProjects.map((project) => project.id)
      if (projectIds.length > 0) await tx.project.updateMany({ where: { organizationId, archivedAt: null, id: { in: projectIds } }, data: { portfolioId: portfolio.id } })
      const portfolioOwner = portfolio.ownerMemberId ? await tx.member.findUnique({ where: { id: portfolio.ownerMemberId }, select: { id: true, name: true } }) : null
      return { ...portfolio, owner: portfolioOwner, projectIds }
    })
    return reply.code(201).send({ data: result })
  })

  app.put<{ Params: PortfolioParams }>('/api/v1/project-portfolios/:portfolioId/workflow', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'portfolio.manage')
    if (!actor) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const input = portfolioWorkflowInput(request.body)
    if (!input) return reply.code(400).send({ error: 'portfolio_workflow_invalid' })
    try {
      const result = await prisma.$transaction(async (tx) => {
        const portfolio = await tx.projectPortfolio.findFirst({
          where: { id: request.params.portfolioId, organizationId, archivedAt: null },
          select: {
            id: true,
            workflowSnapshot: true,
            projects: {
              where: { archivedAt: null },
              orderBy: { code: 'asc' },
              select: { id: true, code: true, name: true, status: true, plannedStart: true, plannedEnd: true, owner: { select: { name: true } }, tasks: { where: { archivedAt: null }, select: { execution: { select: { progress: true } } } } },
            },
          },
        })
        if (!portfolio) throw new Error('portfolio_not_found')
        const current = portfolio.workflowSnapshot && typeof portfolio.workflowSnapshot === 'object' && !Array.isArray(portfolio.workflowSnapshot) ? portfolio.workflowSnapshot as { version?: unknown; auditLogs?: unknown } : null
        const normalized = normalizePortfolioWorkflow(portfolio.id, portfolio.projects, { ...input, auditLogs: current?.auditLogs })
        const currentVersion = typeof current?.version === 'number' && Number.isFinite(current.version) ? Math.round(current.version) : 0
        normalized.version = Math.max(normalized.version, currentVersion + 1)
        const actorMember = await tx.member.findUnique({ where: { id: actor.memberId }, select: { name: true } })
        appendPortfolioWorkflowAuditLog(current, normalized, actorMember?.name ?? '系统')
        await tx.projectPortfolio.update({ where: { id: portfolio.id }, data: { workflowSnapshot: normalized as unknown as Prisma.InputJsonValue } })
        return normalized
      })
      return { data: { version: result.version, status: result.status, publishedLayout: result.publishedLayout, auditLogs: result.auditLogs ?? [] } }
    } catch (error) {
      if (error instanceof Error && error.message === 'portfolio_not_found') return reply.code(404).send({ error: error.message })
      app.log.error(error, 'portfolio_workflow_save_failed')
      return reply.code(400).send({ error: 'portfolio_workflow_save_failed' })
    }
  })

  app.delete<{ Params: PortfolioParams }>('/api/v1/project-portfolios/:portfolioId', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'portfolio.manage')
    if (!actor) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const portfolio = await prisma.projectPortfolio.findFirst({ where: { id: request.params.portfolioId, organizationId, archivedAt: null }, select: { id: true, code: true, name: true, description: true, ownerMemberId: true, archivedAt: true } })
    if (!portfolio) return reply.code(404).send({ error: 'portfolio_not_found' })
    const archivedAt = new Date()
    const projectCount = await prisma.project.count({ where: { organizationId, portfolioId: portfolio.id, archivedAt: null } })
    await prisma.$transaction(async (tx) => {
      await tx.project.updateMany({ where: { organizationId, portfolioId: portfolio.id }, data: { portfolioId: null } })
      await tx.projectPortfolio.update({ where: { id: portfolio.id }, data: { archivedAt } })
    })
    await appendAuditLog({ request, action: 'PROJECT_PORTFOLIO_DELETED', resourceType: 'PROJECT_PORTFOLIO', resourceId: portfolio.id, beforeJson: portfolio, afterJson: { archivedAt: archivedAt.toISOString(), ungroupedProjectCount: projectCount } })
    return { data: { portfolioId: portfolio.id, archived: true, ungroupedProjectCount: projectCount } }
  })

  app.post<{ Body: ProjectInput }>('/api/v1/projects', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'project.create')
    if (!actor) return
    const organizationId = organizationIdFor(request)
    const name = request.body?.name?.trim()
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    if (!name) return reply.code(400).send({ error: 'project_name_required' })
    if (request.body.portfolioId && !isL1(actor)) return reply.code(403).send({ error: 'portfolio_assignment_forbidden' })
    const plannedStart = dateValue(request.body.plannedStart, new Date()) as Date
    try {
      const project = await prisma.$transaction(async (tx) => {
      const owner = await resolveMember(tx, organizationId, request.body.ownerMemberId, request.body.ownerName)
      const creator = await tx.member.findFirst({ where: { id: actor.memberId, organizationId, status: 'ACTIVE' }, select: { id: true } })
      const projectOwner = owner ?? (isGlobalL2(actor) ? creator : null)
      const department = await resolveDepartment(tx, organizationId, request.body.departmentId, request.body.departmentName)
      const code = request.body.code?.trim() || `PRJ-${String((await tx.project.count({ where: { organizationId } })) + 1).padStart(3, '0')}`
      let portfolioId: string | null = null
      if (request.body.portfolioId) {
        const portfolio = await tx.projectPortfolio.findFirst({ where: { id: request.body.portfolioId, organizationId, archivedAt: null }, select: { id: true } })
        if (!portfolio) throw new Error('portfolio_not_found')
        portfolioId = portfolio.id
      }
      const created = await tx.project.create({ data: { organizationId, code, name, portfolioId, departmentId: department?.id, ownerMemberId: projectOwner?.id, createdById: actor.memberId, plannedStart, plannedEnd: dateValue(request.body.plannedEnd, plannedStart), status: 'PLANNED', health: 'HEALTHY', approvalAutoStart: true } })
      const firstMember = owner ?? creator ?? await tx.member.findFirst({ where: { organizationId }, select: { id: true } })
      if (firstMember) await tx.projectMember.create({ data: { projectId: created.id, memberId: firstMember.id, organizationId, membershipRole: projectOwner?.id === firstMember.id ? 'owner' : 'member' } })
      if (creator && firstMember?.id !== creator.id) await tx.projectMember.create({ data: { projectId: created.id, memberId: creator.id, organizationId, membershipRole: 'project_l2' } })
      if (isGlobalL2(actor)) await tx.projectRoleGrant.create({ data: { projectId: created.id, memberId: actor.memberId, roleCode: 'L2', grantedById: actor.memberId } })
      await createEmptyWorkflow(tx, created.id, organizationId, plannedStart, actor.memberId)
      return created
      })
      const summary = await projectWithSummary(prisma, project.id, organizationId)
      return reply.code(201).send({ data: summary })
    } catch (error) {
      if (error instanceof Error && error.message === 'portfolio_not_found') return reply.code(404).send({ error: error.message })
      app.log.error(error)
      return reply.code(400).send({ error: 'project_create_failed' })
    }
  })

  app.delete<{ Params: ProjectParams }>('/api/v1/projects/:projectId', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'project.delete')
    if (!actor) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { id: true, code: true, name: true, portfolioId: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    await prisma.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } })
    await appendAuditLog({ request, action: 'PROJECT_DELETED', resourceType: 'PROJECT', resourceId: project.id, projectId: project.id, beforeJson: project, afterJson: { archivedAt: true } })
    return { data: { projectId: project.id, archived: true } }
  })

  app.put<{ Params: ProjectParams; Body: { portfolioId?: string | null } }>('/api/v1/projects/:projectId/portfolio', async (request, reply) => {
    const portfolioId = request.body?.portfolioId ?? null
    if (portfolioId === null) {
      const projectAccessGuard = await requireProjectPermission(request, reply, request.params.projectId, 'portfolio.manage')
      if (!projectAccessGuard) return
    } else if (!await requireGlobalPermission(request, reply, 'portfolio.manage')) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    try {
      const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { id: true } })
      if (!project) throw new Error('project_not_found')
      if (portfolioId) {
        const portfolio = await tx.projectPortfolio.findFirst({ where: { id: portfolioId, organizationId, archivedAt: null }, select: { id: true } })
        if (!portfolio) throw new Error('portfolio_not_found')
      }
      await tx.project.update({ where: { id: project.id }, data: { portfolioId } })
      return projectWithSummary(tx, project.id, organizationId)
      })
      if (!result) return reply.code(404).send({ error: 'project_not_found' })
      return { data: result }
    } catch (error) {
      if (error instanceof Error && ['project_not_found', 'portfolio_not_found'].includes(error.message)) return reply.code(404).send({ error: error.message })
      app.log.error(error)
      return reply.code(400).send({ error: 'project_portfolio_update_failed' })
    }
  })

  app.put<{ Params: ProjectParams; Body: DraftInput }>('/api/v1/projects/:projectId/workflow/draft', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.edit')
    if (!guard) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    try {
      const result = await prisma.$transaction(async (tx) => {
        const project = await tx.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { id: true, workflow: { select: { id: true, draftVersionId: true, publishedVersionId: true } } } })
        if (!project) throw new Error('project_not_found')
        if (!project.workflow) throw new Error('workflow_not_found')
        const beforeVersionId = project.workflow.draftVersionId ?? project.workflow.publishedVersionId
        const before = beforeVersionId ? await captureWorkflowAuditSnapshot(tx, beforeVersionId) : null
        const draft = await ensureDraft(tx, project.workflow.id, project.workflow.draftVersionId, project.workflow.publishedVersionId)
        const versionId = await saveGraph(tx, organizationId, project.id, draft.id, request.body ?? {}, guard.actor.memberId)
        const after = await captureWorkflowAuditSnapshot(tx, versionId)
        return { versionId, before, after }
      })
      await appendAuditLog({ request, action: 'WORKFLOW_DRAFT_SAVED', resourceType: 'WORKFLOW_VERSION', resourceId: result.versionId, projectId: request.params.projectId, beforeJson: result.before, afterJson: result.after })
      return { data: { versionId: result.versionId, status: 'DRAFT' } }
    } catch (error) {
      if (error instanceof Error && ['project_not_found', 'workflow_not_found'].includes(error.message)) return reply.code(404).send({ error: error.message })
      if (error instanceof Error && ['assignee_not_in_project', 'assignee_not_in_organization', 'last_task_assignee', 'task_approval_required', 'predecessors_not_completed', 'published_workflow_tasks_invalid', 'published_workflow_wbs_duplicate'].includes(error.message)) return reply.code(409).send({ error: error.message })
      app.log.error(error, 'workflow_draft_save_failed')
      return reply.code(400).send({ error: 'workflow_draft_save_failed' })
    }
  })

  app.put<{ Params: ProjectParams; Body: DraftInput }>('/api/v1/projects/:projectId/workflow/published', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.edit')
    if (!guard) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    try {
      const result = await prisma.$transaction(async (tx) => {
        const project = await tx.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { id: true, workflow: { select: { publishedVersionId: true } } } })
        if (!project) throw new Error('project_not_found')
        if (!project.workflow?.publishedVersionId) throw new Error('published_workflow_not_found')
        const before = await captureWorkflowAuditSnapshot(tx, project.workflow.publishedVersionId)
        const versionId = await saveGraph(tx, organizationId, project.id, project.workflow.publishedVersionId, request.body ?? {}, guard.actor.memberId)
        const after = await captureWorkflowAuditSnapshot(tx, versionId)
        return { versionId, before, after }
      })
      await appendAuditLog({ request, action: 'WORKFLOW_PUBLISHED_UPDATED', resourceType: 'WORKFLOW_VERSION', resourceId: result.versionId, projectId: request.params.projectId, beforeJson: result.before, afterJson: result.after })
      return { data: { versionId: result.versionId, status: 'PUBLISHED' } }
    } catch (error) {
      if (error instanceof Error && ['project_not_found', 'published_workflow_not_found'].includes(error.message)) return reply.code(404).send({ error: error.message })
      if (error instanceof Error && ['assignee_not_in_project', 'assignee_not_in_organization', 'last_task_assignee', 'task_approval_required', 'predecessors_not_completed', 'published_workflow_tasks_invalid', 'published_workflow_wbs_duplicate'].includes(error.message)) return reply.code(409).send({ error: error.message })
      app.log.error(error)
      return reply.code(400).send({ error: 'published_workflow_save_failed' })
    }
  })

  app.post<{ Params: ProjectParams }>('/api/v1/projects/:projectId/workflow/publish', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.publish')
    if (!guard) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    try {
      const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { id: true, workflow: { select: { id: true, draftVersionId: true, publishedVersionId: true } } } })
      if (!project) return null
      if (!project.workflow?.draftVersionId) return { invalid: true as const }
      const draftVersionId = project.workflow.draftVersionId
      const previousVersionId = project.workflow.publishedVersionId
      await assertPublishedWorkflowIntegrity(tx, draftVersionId)
      const before = await captureWorkflowAuditSnapshot(tx, draftVersionId)
      const version = await tx.workflowVersion.update({ where: { id: draftVersionId }, data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: guard.actor.memberId } })
      const after = await captureWorkflowAuditSnapshot(tx, version.id)
      await tx.workflow.update({ where: { id: project.workflow.id }, data: { publishedVersionId: version.id, draftVersionId: null } })
      await archiveTasksRemovedFromPublishedVersion(tx, previousVersionId, version.id)
      await tx.outboxEvent.create({
        data: {
          organizationId,
          aggregateType: 'WORKFLOW_VERSION',
          aggregateId: version.id,
          eventType: 'WORKFLOW_PUBLISHED',
          dedupeKey: `workflow-published:${version.id}`,
          payload: { projectId: project.id, versionId: version.id, previousVersionId: project.workflow.publishedVersionId, publishedById: guard.actor.memberId, publisherLevel: guard.access.level, publishedAt: version.publishedAt?.toISOString() ?? null },
        },
      })
      if (project.workflow.publishedVersionId) {
        await tx.outboxEvent.create({
          data: {
            organizationId,
            aggregateType: 'WORKFLOW_VERSION',
            aggregateId: version.id,
            eventType: 'WORKFLOW_SCHEDULE_CHANGED',
            dedupeKey: `workflow-schedule-changed:${version.id}`,
            payload: { projectId: project.id, versionId: version.id, previousVersionId: project.workflow.publishedVersionId, changedById: guard.actor.memberId },
          },
        })
      }
      return { versionId: version.id, versionNo: version.versionNo, publishedAt: version.publishedAt, before, after }
      })
      if (!result) return reply.code(404).send({ error: 'project_not_found' })
      if ('invalid' in result) return reply.code(400).send({ error: 'draft_required' })
      await appendAuditLog({ request, action: 'WORKFLOW_PUBLISHED', resourceType: 'WORKFLOW_VERSION', resourceId: result.versionId, projectId: request.params.projectId, beforeJson: result.before, afterJson: result.after })
      return { data: { versionId: result.versionId, versionNo: result.versionNo, publishedAt: result.publishedAt } }
    } catch (error) {
      if (error instanceof Error && ['published_workflow_tasks_invalid', 'published_workflow_wbs_duplicate'].includes(error.message)) return reply.code(409).send({ error: error.message })
      app.log.error(error, 'workflow_publish_failed')
      return reply.code(400).send({ error: 'workflow_publish_failed' })
    }
  })

  app.post<{ Body: { name?: string; duration?: number; effort?: number; description?: string; closureCriteria?: string; departmentIds?: string[] } }>('/api/v1/claim-tasks', async (request, reply) => {
    const actor = await requireClaimTaskPublishPermission(request, reply)
    if (!actor) return
    const rawDepartments = request.body?.departmentIds ?? []
    if (!Array.isArray(rawDepartments) || rawDepartments.some((id) => typeof id !== 'string' || !validUuid(id))) return reply.code(400).send({ error: 'claim_task_departments_invalid' })
    const departmentIds = [...new Set(rawDepartments)]
    if (departmentIds.length && await prisma.department.count({ where: { id: { in: departmentIds }, organizationId: actor.organizationId, status: 'ACTIVE' } }) !== departmentIds.length) return reply.code(400).send({ error: 'claim_task_departments_invalid' })
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
    if (!name) return reply.code(400).send({ error: 'claim_task_name_required' })
    const duration = Number.isFinite(request.body?.duration) ? Math.max(0, Math.floor(request.body?.duration ?? 1)) : 1
    const effort = Number.isFinite(request.body?.effort) ? Math.max(0, Math.floor(request.body?.effort ?? 8)) : 8
    const task = await prisma.claimTask.create({ data: { organizationId: actor.organizationId, publisherMemberId: actor.memberId, name, departmentIds, durationDays: duration, effortHours: effort, description: request.body?.description?.trim() || undefined, closureCriteria: request.body?.closureCriteria?.trim() || undefined } })
    await appendAuditLog({ request, action: 'CLAIM_TASK_PUBLISHED', resourceType: 'CLAIM_TASK', resourceId: task.id, afterJson: { name: task.name, departmentIds, duration: task.durationDays, effort: task.effortHours, description: task.description, closureCriteria: task.closureCriteria } })
    return reply.code(201).send({ data: { claimTaskId: task.id, name: task.name, published: true } })
  })

  app.put<{ Params: ClaimTaskParams; Body: { name?: string; duration?: number; effort?: number; description?: string; closureCriteria?: string; departmentIds?: string[] } }>('/api/v1/claim-tasks/:claimTaskId', async (request, reply) => {
    const actor = await requireClaimTaskPublishPermission(request, reply)
    if (!actor) return
    const existing = await prisma.claimTask.findFirst({ where: { id: request.params.claimTaskId, organizationId: actor.organizationId, archivedAt: null }, select: { id: true, name: true, departmentIds: true, description: true, closureCriteria: true, durationDays: true, effortHours: true } })
    if (!existing) return reply.code(404).send({ error: 'claim_task_not_found' })
    const rawDepartments = request.body?.departmentIds ?? existing.departmentIds
    if (!Array.isArray(rawDepartments) || rawDepartments.some((id) => typeof id !== 'string' || !validUuid(id))) return reply.code(400).send({ error: 'claim_task_departments_invalid' })
    const departmentIds = [...new Set(rawDepartments)]
    if (departmentIds.length && await prisma.department.count({ where: { id: { in: departmentIds }, organizationId: actor.organizationId, status: 'ACTIVE' } }) !== departmentIds.length) return reply.code(400).send({ error: 'claim_task_departments_invalid' })
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : existing.name
    if (!name) return reply.code(400).send({ error: 'claim_task_name_required' })
    const duration = Number.isFinite(request.body?.duration) ? Math.max(0, Math.floor(request.body?.duration ?? existing.durationDays)) : existing.durationDays
    const effort = Number.isFinite(request.body?.effort) ? Math.max(0, Math.floor(request.body?.effort ?? existing.effortHours)) : existing.effortHours
    const description = typeof request.body?.description === 'string' ? request.body.description.trim() || null : existing.description
    const closureCriteria = typeof request.body?.closureCriteria === 'string' ? request.body.closureCriteria.trim() || null : existing.closureCriteria
    const updated = await prisma.claimTask.update({ where: { id: existing.id }, data: { name, departmentIds, durationDays: duration, effortHours: effort, description, closureCriteria } })
    await appendAuditLog({ request, action: 'CLAIM_TASK_UPDATED', resourceType: 'CLAIM_TASK', resourceId: updated.id, beforeJson: { name: existing.name, departmentIds: existing.departmentIds, duration: existing.durationDays, effort: existing.effortHours, description: existing.description, closureCriteria: existing.closureCriteria }, afterJson: { name: updated.name, departmentIds: updated.departmentIds, duration: updated.durationDays, effort: updated.effortHours, description: updated.description, closureCriteria: updated.closureCriteria } })
    return { data: { claimTaskId: updated.id, name: updated.name, updated: true } }
  })

  app.post<{ Params: ClaimTaskParams }>('/api/v1/claim-tasks/:claimTaskId/claim', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    if (!canClaimIndependentTask(actor)) return reply.code(403).send({ error: 'claim_task_l3_required' })
    const result = await prisma.$transaction(async (tx) => {
      const scope = await claimTaskScope(tx, actor)
      const claimTask = await tx.claimTask.findFirst({ where: { id: request.params.claimTaskId, organizationId: actor.organizationId, archivedAt: null, claimedByMemberId: null, ...scope }, select: { id: true, name: true } })
      if (!claimTask) return { kind: 'not_claimable' as const }
      const updated = await tx.claimTask.updateMany({ where: { id: claimTask.id, organizationId: actor.organizationId, archivedAt: null, claimedByMemberId: null, ...scope }, data: { claimedByMemberId: actor.memberId, claimedAt: new Date(), status: TaskExecutionStatus.IN_PROGRESS } })
      if (updated.count === 0) return { kind: 'already_claimed' as const }
      return { kind: 'claimed' as const, id: claimTask.id, name: claimTask.name }
    })
    if (result.kind === 'not_claimable') return reply.code(409).send({ error: 'claim_task_not_claimable' })
    if (result.kind === 'already_claimed') return reply.code(409).send({ error: 'claim_task_already_claimed' })
    await appendAuditLog({ request, action: 'CLAIM_TASK_CLAIMED', resourceType: 'CLAIM_TASK', resourceId: result.id, afterJson: { claimTaskId: result.id, memberId: actor.memberId } })
    return reply.code(201).send({ data: { claimTaskId: result.id, memberId: actor.memberId, claimed: true } })
  })

  app.post<{ Params: ProjectParams; Body: { name?: string; wbs?: string; duration?: number; effort?: number; ownerMemberId?: string; description?: string; closureCriteria?: string } }>('/api/v1/projects/:projectId/tasks', async (request, reply) => {
    if (!await requireProjectPermission(request, reply, request.params.projectId, 'task.configure')) return
    const organizationId = organizationIdFor(request)
    const taskName = request.body?.name?.trim()
    if (!organizationId || !taskName) return reply.code(400).send({ error: organizationId ? 'task_name_required' : 'organization_required' })
    if (request.body.ownerMemberId) {
      const owner = await prisma.member.findFirst({ where: { id: request.body.ownerMemberId, organizationId, status: 'ACTIVE' }, select: { id: true } })
      if (!owner) return reply.code(409).send({ error: 'owner_not_in_organization' })
    }
    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { id: true, plannedStart: true, workflow: { select: { id: true, draftVersionId: true, publishedVersionId: true } } } })
      if (!project?.workflow) return null
      const version = await ensureDraft(tx, project.workflow.id, project.workflow.draftVersionId, project.workflow.publishedVersionId)
      const existingNodes = await tx.workflowNode.findMany({ where: { workflowVersionId: version.id }, select: { wbs: true } })
      const usedWbs = new Set(existingNodes.map((node) => node.wbs))
      const nextTaskIndex = existingNodes.reduce((maximum, node) => {
        const match = /^1\.(\d+)$/.exec(node.wbs)
        return match ? Math.max(maximum, Number(match[1])) : maximum
      }, 0) + 1
      let taskWbs = request.body.wbs?.trim() || `1.${nextTaskIndex}`
      let fallbackIndex = nextTaskIndex
      while (usedWbs.has(taskWbs)) {
        fallbackIndex += 1
        taskWbs = `1.${fallbackIndex}`
      }
      const owner = await resolveMember(tx, organizationId, request.body.ownerMemberId)
      const task = await tx.task.create({ data: { projectId: project.id, createdInVersionId: version.id, taskType: 'TASK', execution: { create: { status: 'NOT_STARTED', progress: 0 } } } })
      const node = await tx.workflowNode.create({ data: { workflowVersionId: version.id, taskId: task.id, nodeType: 'TASK', wbs: taskWbs, name: taskName, ownerMemberId: owner?.id, durationDays: Math.max(0, request.body.duration ?? 1), effortHours: Math.max(0, request.body.effort ?? 8), description: request.body.description, closureCriteria: request.body.closureCriteria, positionX: 300, positionY: 160 } })
      if (owner) await tx.taskAssignee.create({ data: { taskId: task.id, memberId: owner.id, assignedById: request.actor?.memberId } })
      return { taskId: task.id, nodeId: node.id, versionId: version.id }
    })
    if (!result) return reply.code(404).send({ error: 'project_not_found' })
    return reply.code(201).send({ data: result })
  })

  app.patch<{ Params: TaskParams; Body: { name?: string; duration?: number; effort?: number; description?: string | null; closureCriteria?: string | null; status?: string; progress?: number; actualStart?: string | null; actualEnd?: string | null; completionApprovalStatus?: string | null; completionConfirmedAt?: string | null; completionNote?: string | null; overdueReason?: string | null; forceStart?: boolean } }>('/api/v1/tasks/:taskId', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const body = request.body ?? {}
    const hasStructureFields = ['name', 'duration', 'effort', 'description', 'closureCriteria'].some((field) => Object.prototype.hasOwnProperty.call(body, field))
    const requiredPermission = hasStructureFields ? 'task.configure' as const : 'task.execute.own' as const
    const guard = await requireTaskPermission(request, reply, request.params.taskId, requiredPermission)
    if (!guard) return
    if (guard.access.level === 'L3') {
      const allowedFields = new Set(['status', 'progress', 'actualStart', 'actualEnd', 'completionApprovalStatus', 'completionNote', 'overdueReason'])
      const unexpectedField = Object.keys(body).find((field) => !allowedFields.has(field))
      if (unexpectedField) return reply.code(403).send({ error: 'forbidden', permission: 'task.execute.own', field: unexpectedField })
    }
    const organizationId = actor.organizationId
    const task = await prisma.task.findFirst({ where: { id: request.params.taskId, project: { organizationId } }, include: { nodes: { take: 1 }, execution: true } })
    if (!task) return reply.code(404).send({ error: 'task_not_found' })
    const node = task.nodes[0]
    const nextStatus = executionStatusByLabel[body.status ?? ''] ?? task.execution?.status ?? TaskExecutionStatus.NOT_STARTED
    const directStartRequested = body.forceStart === true
    if (directStartRequested) {
      if (guard.access.level !== 'L1' && guard.access.level !== 'L2') return reply.code(403).send({ error: 'forbidden', permission: 'task.execute.all' })
      if (nextStatus !== TaskExecutionStatus.IN_PROGRESS) return reply.code(400).send({ error: 'direct_start_status_required' })
      if (task.execution?.status && task.execution.status !== TaskExecutionStatus.NOT_STARTED) return reply.code(409).send({ error: 'task_not_startable' })
    }
    const startRequested = nextStatus === TaskExecutionStatus.IN_PROGRESS && task.execution?.status !== TaskExecutionStatus.IN_PROGRESS
    const completionRequested = completedExecutionStatuses.has(nextStatus) && (!completedExecutionStatuses.has(task.execution?.status ?? '') || task.execution?.completionApprovalStatus !== 'APPROVED')
    let graphVersionId: string | null = null
    let graphNodeId: string | undefined = node?.id
    if (completedExecutionStatuses.has(nextStatus) || startRequested) {
      const workflow = await prisma.workflow.findUnique({ where: { projectId: task.projectId }, select: { publishedVersionId: true, draftVersionId: true } })
      graphVersionId = directStartRequested ? workflow?.publishedVersionId ?? null : workflow?.publishedVersionId ?? workflow?.draftVersionId ?? null
      const nodeForTask = graphVersionId ? await prisma.workflowNode.findFirst({ where: { taskId: task.id, workflowVersionId: graphVersionId }, select: { id: true } }) : null
      graphNodeId = nodeForTask?.id ?? graphNodeId
      if (directStartRequested && (!workflow?.publishedVersionId || !nodeForTask)) return reply.code(409).send({ error: 'task_not_published' })
      if (completedExecutionStatuses.has(nextStatus)) {
        const overdueReason = body.overdueReason === undefined ? task.execution?.overdueReason : body.overdueReason
        if (completionRequested && task.execution?.status === TaskExecutionStatus.DUE_UNFINISHED && !overdueReason?.trim()) return reply.code(409).send({ error: 'overdue_reason_required' })
      }
    }
    if (completionRequested) {
      const approval = await prisma.taskApproval.findFirst({ where: { taskId: task.id, status: 'APPROVED', autoCompleteStatus: 'COMPLETED' }, select: { id: true } })
      if (!approval) return reply.code(409).send({ error: 'task_approval_required' })
    }
    // 校验1：完成时间不得早于开始时间
    const directStartAt = directStartRequested ? dateValue(new Date().toISOString().slice(0, 10)) : undefined
    const finalStart = directStartRequested ? directStartAt ?? null : body.actualStart === undefined ? task.execution?.actualStart ?? null : optionalDateValue(body.actualStart)
    const finalEnd = body.actualEnd === undefined ? task.execution?.actualEnd ?? null : optionalDateValue(body.actualEnd)
    if (finalStart && finalEnd && finalEnd < finalStart) return reply.code(400).send({ error: 'invalid_execution_dates' })
    // 校验2：开始或完成前都必须满足前置依赖；只有已批准的特殊放行可以跳过开始校验。
    if ((startRequested || completedExecutionStatuses.has(nextStatus)) && !completedExecutionStatuses.has(task.execution?.status ?? '')) {
      if (graphVersionId && graphNodeId) {
        const predecessors = await prisma.workflowEdge.findMany({ where: { workflowVersionId: graphVersionId, targetNodeId: graphNodeId }, select: { sourceNode: { select: { nodeType: true, task: { select: { execution: { select: { status: true } } } } } } } })
        const unmet = predecessors.filter((candidate) => candidate.sourceNode.nodeType !== 'START' && candidate.sourceNode.task && !completedExecutionStatuses.has(candidate.sourceNode.task.execution?.status ?? ''))
        if (unmet.length > 0 && !directStartRequested && (!startRequested || !isSpecialReleaseForVersion(task.execution?.specialRelease, graphVersionId))) return reply.code(409).send({ error: 'predecessors_not_completed' })
      }
    }
    const execution = await prisma.$transaction(async (tx) => {
      if (node) await tx.workflowNode.update({ where: { id: node.id }, data: { name: body.name?.trim() || undefined, durationDays: body.duration === undefined ? undefined : Math.max(0, body.duration), effortHours: body.effort === undefined ? undefined : Math.max(0, body.effort), description: body.description, closureCriteria: body.closureCriteria } })
      const updated = await tx.taskExecution.upsert({ where: { taskId: task.id }, update: { status: nextStatus, progress: body.progress === undefined ? undefined : Math.max(0, Math.min(100, body.progress)), actualStart: directStartRequested ? directStartAt : optionalDateValue(body.actualStart), actualEnd: optionalDateValue(body.actualEnd), readyAt: directStartRequested ? directStartAt : undefined, completionApprovalStatus: completionApprovalStatus(String(nextStatus)), completionConfirmedAt: optionalDateValue(body.completionConfirmedAt), completionNote: body.completionNote, overdueReason: body.overdueReason === undefined ? undefined : body.overdueReason?.trim() || null, updatedById: actor.memberId }, create: { taskId: task.id, status: nextStatus, progress: body.progress ?? 0, actualStart: directStartRequested ? directStartAt : optionalDateValue(body.actualStart), actualEnd: optionalDateValue(body.actualEnd), readyAt: directStartRequested ? directStartAt : undefined, completionApprovalStatus: completionApprovalStatus(String(nextStatus)), completionConfirmedAt: optionalDateValue(body.completionConfirmedAt), completionNote: body.completionNote, overdueReason: body.overdueReason?.trim() || undefined, updatedById: actor.memberId } })
      if (directStartRequested) await tx.taskStatusHistory.create({ data: { taskId: task.id, fromStatus: task.execution?.status ?? null, toStatus: TaskExecutionStatus.IN_PROGRESS, actualStart: directStartAt, reason: '管理员直接开启任务', changedById: actor.memberId } })
      if (completedExecutionStatuses.has(nextStatus) && !completedExecutionStatuses.has(task.execution?.status ?? '')) {
        await tx.outboxEvent.create({ data: { organizationId, aggregateType: 'TASK', aggregateId: task.id, eventType: 'TASK_COMPLETED', dedupeKey: `task-completed:${task.id}:${updated.updatedAt.toISOString()}`, payload: { taskId: task.id, projectId: task.projectId, completedAt: updated.actualEnd?.toISOString() ?? new Date().toISOString(), completedById: actor.memberId } } })
      }
      return updated
    })
    await appendAuditLog({ request, action: directStartRequested ? 'TASK_DIRECT_STARTED' : 'TASK_UPDATED', resourceType: 'TASK', resourceId: task.id, projectId: task.projectId, taskId: task.id, beforeJson: directStartRequested ? { status: task.execution?.status ?? TaskExecutionStatus.NOT_STARTED } : undefined, afterJson: directStartRequested ? { status: execution.status, actualStart: execution.actualStart, readyAt: execution.readyAt, reason: '管理员直接开启任务' } : { ...body, nodeId: node?.id ?? null } })
    return { data: { taskId: task.id, nodeId: node?.id ?? null, execution } }
  })

  app.post<{ Params: TaskParams; Body: { name?: string; kind?: string; versionLabel?: string; url?: string; mimeType?: string; sizeBytes?: number; externalProvider?: string; externalId?: string; approvalProcessInstanceId?: string; approvalProcessCode?: string; approvalFileId?: string; approvalSpaceId?: string } }>('/api/v1/tasks/:taskId/deliverables', async (request, reply) => {
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'deliverable.manage.own')
    if (!guard) return
    const body = request.body ?? {}
    const name = body.name?.trim()
    const url = body.url?.trim()
    const externalId = body.externalId?.trim()
    if (!name) return reply.code(400).send({ error: 'deliverable_name_required' })
    if (!url && !externalId) return reply.code(400).send({ error: 'deliverable_reference_required' })
    const sizeBytes = body.sizeBytes === undefined || body.sizeBytes === null ? undefined : Math.max(0, Math.floor(body.sizeBytes))
    // 文档 §6.1：交付物保存与 TASK_DELIVERABLE_SUBMITTED 事件在同一事务内落库，
    // 由通知 Worker 发给 项目 L2 / 管理员 / 提交人直属主管（普通提交不触发完成）。
    const submitter = await prisma.member.findUnique({ where: { id: guard.actor.memberId }, select: { name: true } })
    const execution = await prisma.taskExecution.findUnique({ where: { taskId: guard.task.id }, select: { progress: true } })
    const deliverable = await prisma.$transaction(async (tx) => {
      const created = await tx.taskDeliverable.create({
        data: {
          taskId: guard.task.id,
          kind: deliverableKind(body.kind),
          name,
          versionLabel: body.versionLabel?.trim() || 'v1',
          url: url || undefined,
          mimeType: body.mimeType?.trim() || undefined,
          sizeBytes,
          uploaderMemberId: guard.actor.memberId,
          externalProvider: body.externalProvider?.trim() || undefined,
          externalId: externalId || undefined,
          approvalProcessInstanceId: body.approvalProcessInstanceId?.trim() || undefined,
          approvalProcessCode: body.approvalProcessCode?.trim() || undefined,
          approvalFileId: body.approvalFileId?.trim() || undefined,
          approvalSpaceId: body.approvalSpaceId?.trim() || undefined,
        },
        select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, mimeType: true, sizeBytes: true, uploaderMemberId: true, externalProvider: true, externalId: true, approvalProcessInstanceId: true, approvalProcessCode: true, approvalFileId: true, approvalSpaceId: true, createdAt: true },
      })
      await tx.outboxEvent.create({
        data: {
          organizationId: guard.actor.organizationId,
          aggregateType: 'TASK_DELIVERABLE',
          aggregateId: created.id,
          eventType: 'TASK_DELIVERABLE_SUBMITTED',
          dedupeKey: `task-deliverable-submitted:${created.id}`,
          payload: { taskId: guard.task.id, projectId: guard.task.projectId, deliverableId: created.id, deliverableName: created.name, submitterMemberId: guard.actor.memberId, submitterName: submitter?.name ?? '任务负责人', progress: execution?.progress ?? 0 },
        },
      })
      return created
    })
    await appendAuditLog({ request, action: 'TASK_DELIVERABLE_ADDED', resourceType: 'TASK_DELIVERABLE', resourceId: deliverable.id, projectId: guard.task.projectId, taskId: guard.task.id, afterJson: { ...deliverable, sizeBytes: deliverable.sizeBytes === null ? null : Number(deliverable.sizeBytes) } })
    return reply.code(201).send({ data: { ...deliverable, sizeBytes: deliverable.sizeBytes === null ? null : Number(deliverable.sizeBytes) } })
  })

  // Web 本地文件上传：文件内容先写入受控存储目录，再与交付物记录及通知事件同事务落库。
  app.post<{ Params: TaskParams }>('/api/v1/tasks/:taskId/deliverables/upload', async (request, reply) => {
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'deliverable.manage.own')
    if (!guard) return
    let uploaded: Awaited<ReturnType<typeof writeUploadedFile>> | null = null
    const fields: Record<string, string> = {}
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (uploaded || !part.filename?.trim()) {
            for await (const chunk of part.file) { void chunk /* consume rejected extra file */ }
            continue
          }
          uploaded = await writeUploadedFile(part)
        } else {
          fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '')
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'deliverable_upload_failed'
      const status = message === 'deliverable_file_too_large' ? 413 : message === 'deliverable_file_empty' ? 400 : 400
      return reply.code(status).send({ error: message })
    }
    if (!uploaded) return reply.code(400).send({ error: 'deliverable_file_required' })

    const deliverableId = randomUUID()
    const objectKey = `${deliverableId}/${uploaded.name}`
    const targetPath = deliverableObjectPath(objectKey)
    await mkdir(path.dirname(targetPath), { recursive: true })
    try {
      await rename(uploaded.temporaryPath, targetPath)
    } catch (error) {
      await rm(uploaded.temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }

    try {
      const submitter = await prisma.member.findUnique({ where: { id: guard.actor.memberId }, select: { name: true } })
      const execution = await prisma.taskExecution.findUnique({ where: { taskId: guard.task.id }, select: { progress: true } })
      const name = safeDeliverableName(fields.name?.trim() || uploaded.name)
      const versionLabel = fields.versionLabel?.trim() || 'v1'
      const deliverable = await prisma.$transaction(async (tx) => {
        const created = await tx.taskDeliverable.create({
          data: { id: deliverableId, taskId: guard.task.id, kind: 'FILE', name, versionLabel, url: `/api/v1/deliverables/${deliverableId}/download`, objectKey, mimeType: fields.mimeType?.trim() || uploaded.mimeType, sizeBytes: uploaded.sizeBytes, uploaderMemberId: guard.actor.memberId, approvalProcessInstanceId: fields.approvalProcessInstanceId?.trim() || undefined, approvalProcessCode: fields.approvalProcessCode?.trim() || undefined, approvalFileId: fields.approvalFileId?.trim() || undefined, approvalSpaceId: fields.approvalSpaceId?.trim() || undefined },
          select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, uploaderMemberId: true, uploader: { select: { name: true } }, externalProvider: true, externalId: true, approvalProcessInstanceId: true, approvalProcessCode: true, approvalFileId: true, approvalSpaceId: true, createdAt: true },
        })
        await tx.outboxEvent.create({
          data: { organizationId: guard.actor.organizationId, aggregateType: 'TASK_DELIVERABLE', aggregateId: created.id, eventType: 'TASK_DELIVERABLE_SUBMITTED', dedupeKey: `task-deliverable-submitted:${created.id}`, payload: { taskId: guard.task.id, projectId: guard.task.projectId, deliverableId: created.id, deliverableName: created.name, submitterMemberId: guard.actor.memberId, submitterName: submitter?.name ?? '任务负责人', progress: execution?.progress ?? 0, source: 'web-upload' } },
        })
        return created
      })
      await appendAuditLog({ request, action: 'TASK_DELIVERABLE_UPLOADED', resourceType: 'TASK_DELIVERABLE', resourceId: deliverable.id, projectId: guard.task.projectId, taskId: guard.task.id, afterJson: { ...deliverable, sizeBytes: deliverable.sizeBytes === null ? null : Number(deliverable.sizeBytes), sha256: uploaded.sha256, source: 'web-upload' } })
      return reply.code(201).send({ data: { ...deliverable, sizeBytes: deliverable.sizeBytes === null ? null : Number(deliverable.sizeBytes) } })
    } catch (error) {
      await rm(path.dirname(targetPath), { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  })

  app.post<{ Params: ProjectParams; Body: { memberId?: string } }>('/api/v1/projects/:projectId/members', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'project.member.manage')
    if (!guard) return
    const memberId = request.body?.memberId
    if (!memberId) return reply.code(400).send({ error: 'member_required' })
    const member = await prisma.member.findFirst({ where: { id: memberId, organizationId: guard.actor.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return reply.code(404).send({ error: 'member_not_found' })
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const membership = await prisma.projectMember.upsert({ where: { projectId_memberId: { projectId: project.id, memberId } }, update: {}, create: { projectId: project.id, memberId, organizationId: guard.actor.organizationId, membershipRole: 'member' }, select: { projectId: true, memberId: true, membershipRole: true } })
    await appendAuditLog({ request, action: 'PROJECT_MEMBER_ADDED', resourceType: 'PROJECT_MEMBER', resourceId: project.id, projectId: project.id, afterJson: membership })
    return reply.code(201).send({ data: membership })
  })

  app.delete<{ Params: ProjectMemberParams }>('/api/v1/projects/:projectId/members/:memberId', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'project.member.manage')
    if (!guard) return
    const membership = await prisma.projectMember.findUnique({ where: { projectId_memberId: { projectId: request.params.projectId, memberId: request.params.memberId } }, select: { projectId: true, memberId: true, membershipRole: true } })
    if (!membership) return reply.code(404).send({ error: 'project_member_not_found' })
    const tasks = await prisma.task.findMany({ where: { projectId: request.params.projectId, archivedAt: null, OR: [{ assignees: { some: { memberId: request.params.memberId, removedAt: null } } }, { nodes: { some: { ownerMemberId: request.params.memberId } } }] }, select: { id: true, assignees: { where: { removedAt: null }, select: { memberId: true } }, nodes: { select: { ownerMemberId: true } } } })
    const blockedTasks = tasks.filter((task) => {
      const owners = new Set(task.assignees.map((assignee) => assignee.memberId))
      if (owners.size === 0) task.nodes.forEach((node) => { if (node.ownerMemberId) owners.add(node.ownerMemberId) })
      return owners.size === 1 && owners.has(request.params.memberId)
    }).map((task) => task.id)
    if (blockedTasks.length > 0) return reply.code(409).send({ error: 'last_task_assignee', taskIds: blockedTasks })
    const removed = await prisma.$transaction(async (tx) => {
      await tx.taskAssignee.updateMany({ where: { memberId: request.params.memberId, removedAt: null, task: { projectId: request.params.projectId } }, data: { removedAt: new Date() } })
      return tx.projectMember.delete({ where: { projectId_memberId: { projectId: request.params.projectId, memberId: request.params.memberId } }, select: { projectId: true, memberId: true, membershipRole: true } })
    })
    await appendAuditLog({ request, action: 'PROJECT_MEMBER_REMOVED', resourceType: 'PROJECT_MEMBER', resourceId: removed.projectId, projectId: removed.projectId, beforeJson: removed })
    return { data: { ...removed, removed: true } }
  })

  app.post<{ Params: TaskParams; Body: { memberId?: string } }>('/api/v1/tasks/:taskId/assignees', async (request, reply) => {
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.assign')
    if (!guard) return
    const memberId = request.body?.memberId
    if (!memberId) return reply.code(400).send({ error: 'member_required' })
    const member = await prisma.member.findFirst({ where: { id: memberId, organizationId: guard.actor.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return reply.code(409).send({ error: 'member_not_in_organization' })
    const assignmentResult = await prisma.$transaction(async (tx) => {
      const current = await tx.taskAssignee.findMany({ where: { taskId: guard.task.id, removedAt: null }, select: { memberId: true } })
      if (current.length === 0) {
        const node = await tx.workflowNode.findFirst({ where: { taskId: guard.task.id, ownerMemberId: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { ownerMemberId: true } })
        if (node?.ownerMemberId) await tx.taskAssignee.create({ data: { taskId: guard.task.id, memberId: node.ownerMemberId, assignedById: guard.actor.memberId } })
      }
      const existing = await tx.taskAssignee.findFirst({ where: { taskId: guard.task.id, memberId, removedAt: null }, select: { id: true, taskId: true, memberId: true, assignedById: true, assignedAt: true } })
      if (existing) return { assignment: existing, changed: false }
      const created = await tx.taskAssignee.create({ data: { taskId: guard.task.id, memberId, assignedById: guard.actor.memberId }, select: { id: true, taskId: true, memberId: true, assignedById: true, assignedAt: true } })
      return { assignment: created, changed: true }
    })
    const assigned = assignmentResult.assignment
    if (assignmentResult.changed) await prisma.outboxEvent.create({ data: { organizationId: guard.actor.organizationId, aggregateType: 'TASK', aggregateId: guard.task.id, eventType: 'TASK_ASSIGNEE_CHANGED', dedupeKey: `task-assignee:${guard.task.id}:${assigned.memberId}:${assigned.id}:added`, payload: { taskId: guard.task.id, projectId: guard.task.projectId, memberId: assigned.memberId, assignmentId: assigned.id, actorName: guard.actor.memberId, action: 'add' } } })
    await appendAuditLog({ request, action: 'TASK_ASSIGNEE_ADDED', resourceType: 'TASK_ASSIGNEE', resourceId: assigned.id, projectId: guard.task.projectId, taskId: guard.task.id, afterJson: assigned })
    return reply.code(201).send({ data: assigned })
  })

  app.post<{ Params: TaskParams }>('/api/v1/tasks/:taskId/claim', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })

    try {
      const result = await prisma.$transaction(async (tx) => {
        const task = await tx.task.findFirst({
          where: { id: request.params.taskId, archivedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } },
          select: { id: true, projectId: true, execution: { select: { status: true } }, project: { select: { workflow: { select: { publishedVersionId: true } } } } },
        })
        if (!task || !task.project.workflow?.publishedVersionId) return { kind: 'not_claimable' as const }
        if (completedExecutionStatuses.has(task.execution?.status ?? '')) return { kind: 'not_claimable' as const }

        const node = await tx.workflowNode.findFirst({
          where: { workflowVersionId: task.project.workflow.publishedVersionId, taskId: task.id, nodeType: { in: [WorkflowNodeType.TASK, WorkflowNodeType.MILESTONE] }, ownerMemberId: null },
          select: { id: true },
        })
        if (!node) return { kind: 'not_claimable' as const }

        const currentAssignment = await tx.taskAssignee.findFirst({ where: { taskId: task.id, removedAt: null }, select: { id: true } })
        if (currentAssignment) return { kind: 'already_claimed' as const }

        const assignment = await tx.taskAssignee.create({ data: { taskId: task.id, memberId: actor.memberId, assignedById: actor.memberId }, select: { id: true, taskId: true, memberId: true, assignedById: true, assignedAt: true } })
        return { kind: 'claimed' as const, assignment, projectId: task.projectId }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      if (result.kind === 'not_claimable') return reply.code(409).send({ error: 'task_not_claimable' })
      if (result.kind === 'already_claimed') return reply.code(409).send({ error: 'task_already_claimed' })

      await prisma.outboxEvent.create({ data: { organizationId: actor.organizationId, aggregateType: 'TASK', aggregateId: request.params.taskId, eventType: 'TASK_ASSIGNEE_CHANGED', dedupeKey: `task-claim:${request.params.taskId}:${result.assignment.id}`, payload: { taskId: request.params.taskId, projectId: result.projectId, memberId: actor.memberId, assignmentId: result.assignment.id, actorName: actor.memberId, action: 'add' } } })
      await appendAuditLog({ request, action: 'TASK_CLAIMED', resourceType: 'TASK_ASSIGNEE', resourceId: result.assignment.id, projectId: result.projectId, taskId: request.params.taskId, afterJson: result.assignment })
      return reply.code(201).send({ data: { taskId: request.params.taskId, projectId: result.projectId, memberId: actor.memberId, assignmentId: result.assignment.id, claimed: true } })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return reply.code(409).send({ error: 'task_already_claimed' })
      throw error
    }
  })

  app.delete<{ Params: TaskAssigneeParams }>('/api/v1/tasks/:taskId/assignees/:memberId', async (request, reply) => {
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.assign')
    if (!guard) return
    const assignments = await prisma.taskAssignee.findMany({ where: { taskId: guard.task.id, removedAt: null }, select: { id: true, memberId: true } })
    const assignment = assignments.find((item) => item.memberId === request.params.memberId)
    if (!assignment) return reply.code(404).send({ error: 'task_assignee_not_found' })
    if (assignments.length <= 1) return reply.code(409).send({ error: 'last_task_assignee' })
    const removed = await prisma.taskAssignee.update({ where: { id: assignment.id }, data: { removedAt: new Date() }, select: { id: true, taskId: true, memberId: true, removedAt: true } })
    await prisma.outboxEvent.create({ data: { organizationId: guard.actor.organizationId, aggregateType: 'TASK', aggregateId: guard.task.id, eventType: 'TASK_ASSIGNEE_CHANGED', dedupeKey: `task-assignee:${guard.task.id}:${removed.memberId}:${removed.id}:removed:${removed.removedAt?.toISOString() ?? Date.now()}`, payload: { taskId: guard.task.id, projectId: guard.task.projectId, memberId: removed.memberId, assignmentId: removed.id, actorName: guard.actor.memberId, action: 'remove' } } })
    await appendAuditLog({ request, action: 'TASK_ASSIGNEE_REMOVED', resourceType: 'TASK_ASSIGNEE', resourceId: removed.id, projectId: guard.task.projectId, taskId: guard.task.id, beforeJson: assignment, afterJson: removed })
    return { data: removed }
  })

  app.delete<{ Params: TaskParams }>('/api/v1/tasks/:taskId', async (request, reply) => {
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.delete')
    if (!guard) return
    const project = await prisma.project.findFirst({ where: { id: guard.task.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true, workflow: { select: { draftVersionId: true, publishedVersionId: true } } } })
    const versionIds = [project?.workflow?.draftVersionId, project?.workflow?.publishedVersionId].filter((id): id is string => Boolean(id))
    const snapshot = await prisma.$transaction(async (tx) => {
      const nodes = versionIds.length === 0 ? [] : await tx.workflowNode.findMany({ where: { taskId: guard.task.id, workflowVersionId: { in: versionIds } }, select: { id: true, workflowVersionId: true, taskId: true, nodeType: true, wbs: true, parentTaskId: true, name: true, ownerMemberId: true, durationDays: true, effortHours: true, description: true, closureCriteria: true, positionX: true, positionY: true, schedules: { select: { workflowVersionId: true, nodeId: true, plannedStart: true, plannedEnd: true, startOffset: true, endOffset: true, calendarSpan: true } } } })
      const nodeIds = nodes.map((node) => node.id)
      const edges = nodeIds.length === 0 ? [] : await tx.workflowEdge.findMany({ where: { workflowVersionId: { in: versionIds }, OR: [{ sourceNodeId: { in: nodeIds } }, { targetNodeId: { in: nodeIds } }] }, select: { id: true, workflowVersionId: true, sourceNodeId: true, targetNodeId: true, dependencyType: true, lagDays: true } })
      if (edges.length > 0) await tx.workflowEdge.deleteMany({ where: { id: { in: edges.map((edge) => edge.id) } } })
      if (nodeIds.length > 0) await tx.workflowNode.deleteMany({ where: { id: { in: nodeIds } } })
      await tx.task.update({ where: { id: guard.task.id }, data: { archivedAt: new Date() } })
      return { taskId: guard.task.id, projectId: guard.task.projectId, nodes, edges }
    })
    await appendAuditLog({ request, action: 'TASK_DELETED', resourceType: 'TASK', resourceId: guard.task.id, projectId: guard.task.projectId, taskId: guard.task.id, beforeJson: snapshot, afterJson: { archivedAt: true } })
    return { data: { taskId: guard.task.id, archived: true, affectedEdgeCount: snapshot.edges.length } }
  })

  app.post<{ Params: TaskParams }>('/api/v1/tasks/:taskId/restore', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const archived = await prisma.task.findFirst({ where: { id: request.params.taskId, project: { organizationId: actor.organizationId, archivedAt: null } }, select: { id: true, projectId: true, archivedAt: true } })
    if (!archived) return reply.code(404).send({ error: 'task_not_found' })
    const guard = await requireProjectPermission(request, reply, archived.projectId, 'task.restore')
    if (!guard) return
    if (!archived.archivedAt) return reply.code(409).send({ error: 'task_not_deleted' })
    const deletion = await prisma.auditLog.findFirst({ where: { resourceType: 'TASK', resourceId: archived.id, action: 'TASK_DELETED', organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' }, select: { beforeJson: true } })
    const snapshot = deletion?.beforeJson as { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> } | null
    const project = await prisma.project.findFirst({ where: { id: archived.projectId, organizationId: actor.organizationId, archivedAt: null }, select: { workflow: { select: { draftVersionId: true, publishedVersionId: true } } } })
    const versionIds = [project?.workflow?.draftVersionId, project?.workflow?.publishedVersionId].filter((id): id is string => Boolean(id))
    let restored: { taskId: string; unconnected: number }
    try {
      restored = await prisma.$transaction(async (tx) => {
      const existingNodes = versionIds.length === 0 ? [] : await tx.workflowNode.findMany({ where: { workflowVersionId: { in: versionIds } }, select: { id: true, workflowVersionId: true } })
      const existingNodeIds = new Set(existingNodes.map((node) => node.id))
      const existingNodeKeys = new Set(existingNodes.map((node) => `${node.workflowVersionId}:${node.id}`))
      const existingEdges = versionIds.length === 0 ? [] : await tx.workflowEdge.findMany({ where: { workflowVersionId: { in: versionIds } }, select: { workflowVersionId: true, sourceNodeId: true, targetNodeId: true } })
      const restoredNodeIds = new Map<string, string>()
      for (const rawNode of snapshot?.nodes ?? []) {
        const versionId = typeof rawNode.workflowVersionId === 'string' ? rawNode.workflowVersionId : ''
        if (!versionIds.includes(versionId)) continue
        const originalId = typeof rawNode.id === 'string' ? rawNode.id : undefined
        const id = originalId && !existingNodeIds.has(originalId) ? originalId : randomUUID()
        const node = await tx.workflowNode.create({ data: { ...(id ? { id } : {}), workflowVersionId: versionId, taskId: archived.id, nodeType: rawNode.nodeType as never, wbs: String(rawNode.wbs ?? '1.1'), parentTaskId: typeof rawNode.parentTaskId === 'string' ? rawNode.parentTaskId : null, name: String(rawNode.name ?? '待填写任务'), ownerMemberId: typeof rawNode.ownerMemberId === 'string' ? rawNode.ownerMemberId : null, durationDays: Number(rawNode.durationDays ?? 0), effortHours: Number(rawNode.effortHours ?? 0), description: typeof rawNode.description === 'string' ? rawNode.description : null, closureCriteria: typeof rawNode.closureCriteria === 'string' ? rawNode.closureCriteria : null, positionX: Number(rawNode.positionX ?? 0), positionY: Number(rawNode.positionY ?? 0) } })
        existingNodeIds.add(node.id)
        existingNodeKeys.add(`${versionId}:${node.id}`)
        if (originalId) restoredNodeIds.set(`${versionId}:${originalId}`, node.id)
        const schedules = Array.isArray(rawNode.schedules) ? rawNode.schedules as Array<Record<string, unknown>> : []
        for (const schedule of schedules) {
          const start = typeof schedule.plannedStart === 'string' ? new Date(schedule.plannedStart) : null
          const end = typeof schedule.plannedEnd === 'string' ? new Date(schedule.plannedEnd) : null
          if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue
          await tx.workflowNodeSchedule.create({ data: { workflowVersionId: versionId, nodeId: node.id, plannedStart: start, plannedEnd: end, startOffset: Number(schedule.startOffset ?? 0), endOffset: Number(schedule.endOffset ?? 0), calendarSpan: Number(schedule.calendarSpan ?? 1) } })
        }
      }
      let unconnected = 0
      const candidateEdges: Array<{ versionId: string; sourceNodeId: string; targetNodeId: string; dependencyType: unknown; lagDays: number }> = []
      for (const rawEdge of snapshot?.edges ?? []) {
        const versionId = typeof rawEdge.workflowVersionId === 'string' ? rawEdge.workflowVersionId : ''
        if (!versionIds.includes(versionId)) continue
        const rawSourceNodeId = typeof rawEdge.sourceNodeId === 'string' ? rawEdge.sourceNodeId : ''
        const rawTargetNodeId = typeof rawEdge.targetNodeId === 'string' ? rawEdge.targetNodeId : ''
        const sourceNodeId = restoredNodeIds.get(`${versionId}:${rawSourceNodeId}`) ?? rawSourceNodeId
        const targetNodeId = restoredNodeIds.get(`${versionId}:${rawTargetNodeId}`) ?? rawTargetNodeId
        if (!existingNodeKeys.has(`${versionId}:${sourceNodeId}`) || !existingNodeKeys.has(`${versionId}:${targetNodeId}`)) { unconnected += 1; continue }
        candidateEdges.push({ versionId, sourceNodeId, targetNodeId, dependencyType: rawEdge.dependencyType, lagDays: Number(rawEdge.lagDays ?? 0) })
      }
      for (const versionId of versionIds) {
        const graphEdges = [
          ...existingEdges.filter((edge) => edge.workflowVersionId === versionId),
          ...candidateEdges.filter((edge) => edge.versionId === versionId),
        ]
        if (hasCycle(graphEdges)) throw new Error('restore_cycle_detected')
      }
      await tx.task.update({ where: { id: archived.id }, data: { archivedAt: null } })
      for (const edge of candidateEdges) {
        await tx.workflowEdge.create({ data: { workflowVersionId: edge.versionId, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, dependencyType: edge.dependencyType as never, lagDays: edge.lagDays } }).catch(() => undefined)
      }
      return { taskId: archived.id, unconnected }
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'restore_cycle_detected') return reply.code(409).send({ error: 'restore_cycle_detected' })
      throw error
    }
    await appendAuditLog({ request, action: 'TASK_RESTORED', resourceType: 'TASK', resourceId: archived.id, projectId: archived.projectId, taskId: archived.id, afterJson: restored })
    return { data: restored }
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/workflow/raw', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.read')
    if (!guard) return
    const organizationId = organizationIdFor(request)
    const project = organizationId ? await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId, archivedAt: null }, select: { workflow: { select: { draftVersionId: true, publishedVersionId: true } } } }) : null
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const versionId = guard.access.level === 'SUPERVISOR' || guard.access.level === 'L3'
      ? (project.workflow?.publishedVersionId ?? project.workflow?.draftVersionId)
      : (project.workflow?.draftVersionId ?? project.workflow?.publishedVersionId)
    const version = versionId ? await prisma.workflowVersion.findUnique({ where: { id: versionId }, select: versionSelect }) : null
    return { data: serializeVersionForViewer(version, guard.actor, guard.access.level) }
  })
}
