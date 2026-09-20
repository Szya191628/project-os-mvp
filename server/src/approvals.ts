import { randomUUID } from 'node:crypto'
import { canDecideApprovalStep, expandSequentialApprovers } from './approvalRecipientAccess.js'
import { TaskExecutionStatus, type Prisma } from '@prisma/client'
import { config } from './config.js'
import { prisma } from './db.js'
import { sendDingTalkOtoMarkdown } from './dingtalk.js'
import { createDingTalkApprovalInstance, downloadApprovalAttachment, extractApprovalAttachment, extractApprovalAttachments, fetchDingTalkApprovalInstance, fetchRecentApprovalInstanceIds, type ApprovalAttachmentRef } from './dingtalkApproval.js'
import { persistFile, safeDeliverableName } from './deliverables/dingtalkDelivery.js'
import { completesTaskAfterApproval, parseDeliveryProgress, parseTaskApprovalPurpose, parseTaskDeliveryType, taskApprovalPurposeLabel, taskDeliveryTypeLabel, type TaskDeliveryType } from './approvalDelivery.js'
import { isApprovalPollDue } from './approvalPolling.js'
import { isSpecialReleaseForVersion, parseSpecialRelease, type SpecialReleaseSnapshot } from './taskRelease.js'
import { requireDingTalkIntegration, isDingTalkIntegrationEnabled } from './dingtalkPolicy.js'

const completedStatuses = new Set<TaskExecutionStatus>([TaskExecutionStatus.COMPLETED, TaskExecutionStatus.EARLY_FINISHED, TaskExecutionStatus.ON_TIME_FINISHED, TaskExecutionStatus.OVERDUE_FINISHED])

type WorkerLog = Pick<Console, 'info' | 'warn' | 'error'>

export type ApprovalSource = 'DINGTALK' | 'PROJECT_OS'
const projectOsApprovalProcessCode = 'PROJECT_OS_TASK_DELIVERY'

let lastApprovalPollAtMs: number | null = null
let lastApprovalDiscoveryAtMs: number | null = null

const dateOnly = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
const normalizeOverdueReason = (value: string | undefined) => {
  const reason = value?.trim()
  return reason && reason !== '无' ? reason : undefined
}

function jsonRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringIds(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))] : []
}

function mergeApprovalFormValues(previous: unknown, next: unknown, specialRelease?: SpecialReleaseSnapshot | null): Prisma.InputJsonValue | undefined {
  const previousRecord = jsonRecord(previous)
  const nextRecord = jsonRecord(next)
  const release = specialRelease ?? parseSpecialRelease(previousRecord?.specialRelease)
  if (nextRecord) return release ? { ...nextRecord, specialRelease: release } as Prisma.InputJsonValue : nextRecord as Prisma.InputJsonValue
  if (release) return { ...(previousRecord ?? {}), specialRelease: release } as Prisma.InputJsonValue
  return previous && typeof previous !== 'undefined' ? previous as Prisma.InputJsonValue : undefined
}

type SpecialReleaseContext = {
  task: {
    id: string
    projectId: string
    execution: { status: TaskExecutionStatus; progress: number; actualStart: Date | null; specialRelease: Prisma.JsonValue | null } | null
    project: { code: string; name: string; workflow: { publishedVersionId: string | null } | null }
    assignees: { memberId: string }[]
    node: { id: string; wbs: string; name: string; description: string | null; closureCriteria: string | null; plannedEnd: Date | null }
  }
  predecessors: { taskId: string; nodeId: string; wbs: string; name: string; status: string }[]
}

async function loadSpecialReleaseContext(organizationId: string, taskId: string): Promise<SpecialReleaseContext> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, archivedAt: null, project: { organizationId, archivedAt: null } },
    select: {
      id: true,
      projectId: true,
      execution: { select: { status: true, progress: true, actualStart: true, specialRelease: true } },
      project: { select: { code: true, name: true, workflow: { select: { publishedVersionId: true } } } },
      assignees: { where: { removedAt: null }, select: { memberId: true } },
    },
  })
  if (!task) throw new Error('task_not_found')
  const workflowVersionId = task.project.workflow?.publishedVersionId
  if (!workflowVersionId) throw new Error('workflow_not_published')
  const node = await prisma.workflowNode.findFirst({
    where: { workflowVersionId, taskId: task.id, nodeType: { in: ['TASK', 'MILESTONE'] } },
    select: { id: true, wbs: true, name: true, description: true, closureCriteria: true, schedules: { select: { plannedEnd: true }, take: 1 } },
  })
  if (!node) throw new Error('task_node_not_found')
  const edges = await prisma.workflowEdge.findMany({
    where: { workflowVersionId, targetNodeId: node.id },
    select: { sourceNode: { select: { id: true, nodeType: true, taskId: true, wbs: true, name: true, task: { select: { execution: { select: { status: true } } } } } } },
  })
  const predecessors = edges.flatMap(({ sourceNode }) => {
    if (sourceNode.nodeType === 'START' || !sourceNode.taskId || completedStatuses.has(sourceNode.task?.execution?.status ?? TaskExecutionStatus.NOT_STARTED)) return []
    return [{ taskId: sourceNode.taskId, nodeId: sourceNode.id, wbs: sourceNode.wbs, name: sourceNode.name, status: sourceNode.task?.execution?.status ?? TaskExecutionStatus.NOT_STARTED }]
  })
  return { task: { ...task, node: { ...node, plannedEnd: node.schedules[0]?.plannedEnd ?? null } }, predecessors }
}

async function dingTalkUserIdForMember(memberId: string) {
  const identity = await prisma.externalIdentity.findFirst({ where: { memberId, provider: 'DINGTALK', corpId: config.dingtalk.corpId, userId: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { userId: true } })
  return identity?.userId?.trim() || null
}

type ApprovalPolicyStepConfig = { stepNo: number; stage: 'L2' | 'ADMIN'; mode: 'ANY' | 'ALL'; minApprovals: number; approverMemberIds: string[]; ccMemberIds: string[] }

async function loadApprovalPolicy(projectId: string) {
  const policy = await prisma.approvalPolicy.findUnique({ where: { projectId }, include: { steps: { orderBy: { stepNo: 'asc' } } } })
  const steps: ApprovalPolicyStepConfig[] = policy?.enabled && policy.steps.length > 0
    ? policy.steps.map((step) => ({ stepNo: step.stepNo, stage: step.stage as 'L2' | 'ADMIN', mode: step.mode as 'ANY' | 'ALL', minApprovals: step.minApprovals, approverMemberIds: stringIds(step.approverMemberIds), ccMemberIds: stringIds(step.ccMemberIds) }))
    : [{ stepNo: 1, stage: 'L2' as const, mode: 'ANY' as const, minApprovals: 1, approverMemberIds: [], ccMemberIds: [] }]
  // Expand only new submissions; existing approval snapshots keep their original meaning.
  return { id: policy?.id, version: policy?.version ?? 0, steps: expandSequentialApprovers(steps) }
}

export function policyStepsFromSnapshot(value: unknown): ApprovalPolicyStepConfig[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const stepNo = typeof row.stepNo === 'number' ? Math.floor(row.stepNo) : Number(row.stepNo)
    const stage: 'L2' | 'ADMIN' | undefined = row.stage === 'ADMIN' ? 'ADMIN' : row.stage === 'L2' ? 'L2' : undefined
    const mode: 'ANY' | 'ALL' | undefined = row.mode === 'ALL' ? 'ALL' : row.mode === 'ANY' ? 'ANY' : undefined
    if (!Number.isFinite(stepNo) || stepNo < 1 || !stage || !mode) return []
    return [{ stepNo, stage, mode, minApprovals: Math.max(1, typeof row.minApprovals === 'number' ? Math.floor(row.minApprovals) : Number(row.minApprovals) || 1), approverMemberIds: stringIds(row.approverMemberIds), ccMemberIds: stringIds(row.ccMemberIds) }]
  }).sort((a, b) => a.stepNo - b.stepNo)
}

async function resolveApprovalApproverUserIds(projectId: string, requestedUserIds?: string[], stage: 'L2' | 'ADMIN' = 'L2', configuredMemberIds: string[] = []) {
  const [projectGrants, projectMembers, administrators] = await Promise.all([
    prisma.projectRoleGrant.findMany({ where: { projectId, roleCode: 'L2', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    prisma.projectMember.findMany({ where: { projectId, membershipRole: 'project_l2', member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    prisma.member.findMany({ where: { organizationId: config.dingtalk.organizationId, status: 'ACTIVE', memberRoles: { some: { role: { code: 'L1' } } } }, select: { id: true } }),
  ])
  const l2MemberIds = [...new Set([...projectGrants, ...projectMembers].map((item) => item.memberId))]
  const administratorIds = administrators.map((item) => item.id)
  const identities = await prisma.externalIdentity.findMany({
    where: { memberId: { in: [...new Set([...l2MemberIds, ...administratorIds])] }, provider: 'DINGTALK', corpId: config.dingtalk.corpId, userId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { memberId: true, userId: true },
  })
  const latestByMember = new Map<string, string>()
  for (const identity of identities) if (identity.userId?.trim() && !latestByMember.has(identity.memberId)) latestByMember.set(identity.memberId, identity.userId.trim())
  const l2UserIds = l2MemberIds.flatMap((memberId) => latestByMember.has(memberId) ? [latestByMember.get(memberId)!] : [])
  const administratorUserIds = administratorIds.flatMap((memberId) => latestByMember.has(memberId) ? [latestByMember.get(memberId)!] : [])
  const requested = [...new Set((requestedUserIds ?? []).map((userId) => userId.trim()).filter(Boolean))]
  if (requested.length > 0 && configuredMemberIds.length === 0) {
    const allowed = new Set([...l2UserIds, ...administratorUserIds])
    if (requested.some((userId) => !allowed.has(userId))) throw new Error('dingtalk_approver_not_allowed')
    return requested
  }
  const configured = stringIds(configuredMemberIds)
  if (configured.length > 0) {
    const eligibleMemberIds = new Set(stage === 'ADMIN' ? administratorIds : [...l2MemberIds, ...administratorIds])
    if (configured.some((memberId) => !eligibleMemberIds.has(memberId))) throw new Error('dingtalk_approver_not_allowed')
    if (configured.some((memberId) => !latestByMember.has(memberId))) throw new Error('dingtalk_approver_missing')
    return configured.map((memberId) => latestByMember.get(memberId)!)
  }
  const stageUserIds = stage === 'ADMIN' ? administratorUserIds : l2UserIds
  // 未配置项目 L2 时，默认兼容旧项目回退到组织管理员；显式 ADMIN 步骤不回退，避免误把管理员混入策略层级。
  const approvers = stageUserIds.length > 0 ? stageUserIds : stage === 'L2' ? administratorUserIds : []
  if (approvers.length === 0) throw new Error('dingtalk_approver_missing')
  return approvers
}

async function findApprovalByProcessInstanceId(processInstanceId: string) {
  const direct = await prisma.taskApproval.findUnique({ where: { processInstanceId }, select: { id: true } })
  if (direct) return direct
  const step = await prisma.taskApprovalStep.findUnique({ where: { processInstanceId }, select: { approvalId: true } })
  return step ? { id: step.approvalId } : null
}

/**
 * 任务负责人发起任务交付审批。默认兼容原有钉钉 OA；工作空间显式传入
 * PROJECT_OS 时走本地 OA，不创建钉钉实例，也不消耗钉钉审批接口额度。
 */
export async function submitTaskApproval(input: { organizationId: string; actorMemberId: string; actorName: string; taskId: string; note?: string; overdueReason?: string; approverUserIds?: string[]; progress?: number; deliveryType?: TaskDeliveryType; source?: ApprovalSource }) {
  if (input.source === 'PROJECT_OS') return submitProjectOsTaskApproval(input)
  const task = await prisma.task.findFirst({
    where: { id: input.taskId, archivedAt: null, project: { organizationId: input.organizationId, archivedAt: null } },
    select: {
      id: true,
      projectId: true,
      execution: { select: { status: true, overdueReason: true } },
      project: { select: { code: true, name: true, workflow: { select: { publishedVersionId: true } } } },
      nodes: { select: { id: true, wbs: true, name: true, description: true, closureCriteria: true } },
      assignees: { where: { removedAt: null }, select: { memberId: true } },
      deliverables: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } },
    },
  })
  if (!task) throw new Error('task_not_found')
  if (!task.project.workflow?.publishedVersionId) throw new Error('workflow_not_published')
  if (task.execution && completedStatuses.has(task.execution.status)) throw new Error('task_already_completed')
  // 文档 §5.3：审批进行中锁定当前审批包；补充材料需等当前审批出结果后重新发起。
  const pendingApproval = await prisma.taskApproval.findFirst({ where: { taskId: input.taskId, status: 'PENDING' }, select: { id: true } })
  if (pendingApproval) throw new Error('approval_pending_exists')
  const node = task.nodes[0]
  if (!node) throw new Error('task_node_not_found')
  await requireDingTalkIntegration(input.organizationId)
  if (!config.approval.enabled) throw new Error('dingtalk_approval_not_configured')
  const overdueReason = normalizeOverdueReason(input.overdueReason) ?? normalizeOverdueReason(task.execution?.overdueReason ?? undefined)

  // 上下游节点摘要：让审批人（部门主管/L2）在钉钉审批单里看到任务上下文。
  const neighbors = await prisma.workflowEdge.findMany({
    where: { workflowVersionId: task.project.workflow.publishedVersionId, OR: [{ sourceNodeId: node.id }, { targetNodeId: node.id }] },
    select: {
      sourceNodeId: true, targetNodeId: true,
      sourceNode: { select: { nodeType: true, wbs: true, name: true, ownerMember: { select: { name: true } }, schedules: { select: { plannedEnd: true }, take: 1 } } },
      targetNode: { select: { nodeType: true, wbs: true, name: true, ownerMember: { select: { name: true } } } },
    },
  })
  const neighborLabel = (candidate: { nodeType: string; wbs: string; name: string; ownerMember: { name: string } | null }, withDate?: Date | null) =>
    candidate.nodeType === 'END' ? '项目结束'
      : `${candidate.wbs} ${candidate.name}｜负责人：${candidate.ownerMember?.name ?? '待分配'}${withDate ? `｜交付时间：${withDate.toISOString().slice(0, 10)}` : ''}`
  const predecessorLabels = neighbors.filter((item) => item.targetNodeId === node.id && item.sourceNode.nodeType !== 'START')
    .map((item) => neighborLabel(item.sourceNode, item.sourceNode.schedules[0]?.plannedEnd ?? null))
  const successorLabels = neighbors.filter((item) => item.sourceNodeId === node.id && item.targetNode.nodeType !== 'START')
    .map((item) => neighborLabel(item.targetNode))

  // 提交人必须是任务负责人（负责人本人或 L2/L1 代提时兜底取第一位负责人的钉钉身份）。
  const submitterIsAssignee = task.assignees.some((item) => item.memberId === input.actorMemberId)
  const originatorMemberId = submitterIsAssignee ? input.actorMemberId : task.assignees[0]?.memberId
  if (!originatorMemberId) throw new Error('task_assignee_missing')
  const originatorUserId = await dingTalkUserIdForMember(originatorMemberId)
  if (!originatorUserId) throw new Error('dingtalk_identity_missing')
  const policy = await loadApprovalPolicy(task.projectId)
  const firstStep = policy.steps[0]!
  const resolvedApproverUserIds = await resolveApprovalApproverUserIds(task.projectId, input.approverUserIds, firstStep.stage, firstStep.approverMemberIds)

  const formComponentValues = [
    { name: '项目编号', value: task.project.code },
    { name: '任务编号', value: node.wbs },
    { name: '任务名称', value: node.name },
    { name: '进度', value: String(input.progress ?? 100) },
    { name: '交付类型', value: taskDeliveryTypeLabel(input.deliveryType ?? 'FINAL') },
    { name: '任务内容', value: node.description?.trim() || '无' },
    { name: '交付说明', value: (input.note ?? '').trim() || '无' },
    { name: '超期原因', value: overdueReason ?? '无' },
    { name: '交付标准', value: node.closureCriteria?.trim() || '无' },
    { name: '前置任务', value: predecessorLabels.length > 0 ? predecessorLabels.join('；') : '无（项目开始）' },
    { name: '后置任务', value: successorLabels.length > 0 ? successorLabels.join('；') : '无（项目结束）' },
    { name: '提交人', value: input.actorName },
  ]

  const { processInstanceId } = await createDingTalkApprovalInstance({
    processCode: config.approval.processCode,
    originatorUserId,
    formComponentValues,
    approverUserIds: resolvedApproverUserIds,
  })

  const approval = await prisma.$transaction(async (tx) => {
    await tx.taskExecution.updateMany({ where: { taskId: task.id, status: { notIn: [...completedStatuses] } }, data: { completionApprovalStatus: 'PENDING', overdueReason } })
    const created = await tx.taskApproval.create({
      data: {
        taskId: task.id,
        processInstanceId,
        processCode: config.approval.processCode,
        policyId: policy.id,
        policySnapshot: policy.steps as unknown as Prisma.InputJsonValue,
        currentStepNo: firstStep.stepNo,
        deliveryType: input.deliveryType ?? 'FINAL',
        status: 'PENDING',
        submitterMemberId: originatorMemberId,
        submitterName: input.actorName,
        submitterDingUserId: originatorUserId,
        formValues: { formComponentValues, submittedBy: input.actorMemberId },
      },
      select: { id: true, taskId: true, processInstanceId: true, processCode: true, deliveryType: true, status: true, createdAt: true },
    })
    await tx.taskApprovalStep.create({
      data: { approvalId: created.id, stepNo: firstStep.stepNo, stage: firstStep.stage, mode: firstStep.mode, minApprovals: firstStep.minApprovals, processInstanceId, approverUserIds: resolvedApproverUserIds as unknown as Prisma.InputJsonValue },
    })
    await tx.taskApprovalDeliverable.createMany({
      data: task.deliverables.map((deliverable) => ({ approvalId: created.id, deliverableId: deliverable.id })),
      skipDuplicates: true,
    })
    await tx.outboxEvent.create({
      data: {
        organizationId: input.organizationId,
        aggregateType: 'TASK_APPROVAL',
        aggregateId: created.id,
        eventType: 'TASK_APPROVAL_SUBMITTED',
        dedupeKey: `task-approval-submitted:${created.id}`,
        payload: { taskId: task.id, projectId: task.projectId, approvalId: created.id, processInstanceId, submitterMemberId: originatorMemberId, submitterName: input.actorName, submittedAt: new Date().toISOString(), stepNo: firstStep.stepNo, stage: firstStep.stage, deliveryType: input.deliveryType ?? 'FINAL', progress: input.progress ?? 100 },
      },
    })
    return created
  })
  await prisma.auditLog.create({
    data: { organizationId: input.organizationId, actorMemberId: input.actorMemberId, action: 'TASK_APPROVAL_SUBMITTED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId, processCode: config.approval.processCode } },
  })
  return approval
}

/**
 * Project OS 内部 OA 交付审批：L3 在工作空间提交当前交付包，L1/L2
 * 在管理中心直接处理。审批步骤沿用项目策略，但整个过程不依赖钉钉实例。
 */
async function submitProjectOsTaskApproval(input: { organizationId: string; actorMemberId: string; actorName: string; taskId: string; note?: string; overdueReason?: string; progress?: number; deliveryType?: TaskDeliveryType }) {
  const task = await prisma.task.findFirst({
    where: { id: input.taskId, archivedAt: null, project: { organizationId: input.organizationId, archivedAt: null } },
    select: {
      id: true,
      projectId: true,
      execution: { select: { status: true, overdueReason: true } },
      project: { select: { code: true, name: true, workflow: { select: { publishedVersionId: true } } } },
      nodes: { select: { id: true, wbs: true, name: true, description: true, closureCriteria: true } },
      assignees: { where: { removedAt: null }, select: { memberId: true } },
      deliverables: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } },
    },
  })
  if (!task) throw new Error('task_not_found')
  if (!task.project.workflow?.publishedVersionId) throw new Error('workflow_not_published')
  if (task.execution && completedStatuses.has(task.execution.status)) throw new Error('task_already_completed')
  const pendingApproval = await prisma.taskApproval.findFirst({ where: { taskId: input.taskId, status: 'PENDING' }, select: { id: true } })
  if (pendingApproval) throw new Error('approval_pending_exists')
  const node = task.nodes[0]
  if (!node) throw new Error('task_node_not_found')
  const overdueReason = normalizeOverdueReason(input.overdueReason) ?? normalizeOverdueReason(task.execution?.overdueReason ?? undefined)

  const submitterIsAssignee = task.assignees.some((item) => item.memberId === input.actorMemberId)
  const originatorMemberId = submitterIsAssignee ? input.actorMemberId : task.assignees[0]?.memberId
  if (!originatorMemberId) throw new Error('task_assignee_missing')
  const policy = await loadApprovalPolicy(task.projectId)
  const firstStep = policy.steps[0]!
  const formComponentValues = [
    { name: '项目编号', value: task.project.code },
    { name: '任务编号', value: node.wbs },
    { name: '任务名称', value: node.name },
    { name: '进度', value: String(input.progress ?? 100) },
    { name: '交付类型', value: taskDeliveryTypeLabel(input.deliveryType ?? 'FINAL') },
    { name: '任务内容', value: node.description?.trim() || '无' },
    { name: '交付说明', value: input.note?.trim() || '无' },
    { name: '超期原因', value: overdueReason ?? '无' },
    { name: '交付标准', value: node.closureCriteria?.trim() || '无' },
    { name: '交付物数量', value: String(task.deliverables.length) },
    { name: '提交人', value: input.actorName },
  ]
  const processInstanceId = `project-os:${randomUUID()}`
  const approval = await prisma.$transaction(async (tx) => {
    await tx.taskExecution.updateMany({ where: { taskId: task.id, status: { notIn: [...completedStatuses] } }, data: { completionApprovalStatus: 'PENDING', overdueReason } })
    const created = await tx.taskApproval.create({
      data: {
        taskId: task.id,
        processInstanceId,
        processCode: projectOsApprovalProcessCode,
        source: 'PROJECT_OS',
        policyId: policy.id,
        policySnapshot: policy.steps as unknown as Prisma.InputJsonValue,
        currentStepNo: firstStep.stepNo,
        deliveryType: input.deliveryType ?? 'FINAL',
        status: 'PENDING',
        submitterMemberId: originatorMemberId,
        submitterName: input.actorName,
        formValues: { formComponentValues, submittedBy: input.actorMemberId, source: 'PROJECT_OS' },
      },
      select: { id: true, taskId: true, processInstanceId: true, processCode: true, source: true, deliveryType: true, status: true, createdAt: true },
    })
    await tx.taskApprovalStep.create({
      data: { approvalId: created.id, stepNo: firstStep.stepNo, stage: firstStep.stage, mode: firstStep.mode, minApprovals: firstStep.minApprovals, processInstanceId, approverUserIds: [] as unknown as Prisma.InputJsonValue },
    })
    await tx.taskApprovalDeliverable.createMany({
      data: task.deliverables.map((deliverable) => ({ approvalId: created.id, deliverableId: deliverable.id })),
      skipDuplicates: true,
    })
    await tx.outboxEvent.create({
      data: {
        organizationId: input.organizationId,
        aggregateType: 'TASK_APPROVAL',
        aggregateId: created.id,
        eventType: 'TASK_APPROVAL_SUBMITTED',
        dedupeKey: `task-approval-submitted:${created.id}`,
        payload: { taskId: task.id, projectId: task.projectId, approvalId: created.id, processInstanceId, source: 'PROJECT_OS', submitterMemberId: originatorMemberId, submitterName: input.actorName, submittedAt: new Date().toISOString(), stepNo: firstStep.stepNo, stage: firstStep.stage, deliveryType: input.deliveryType ?? 'FINAL', progress: input.progress ?? 100 },
      },
    })
    return created
  })
  await prisma.auditLog.create({
    data: { organizationId: input.organizationId, actorMemberId: input.actorMemberId, action: 'TASK_APPROVAL_SUBMITTED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId, processCode: projectOsApprovalProcessCode, source: 'PROJECT_OS', deliverableCount: task.deliverables.length } },
  })
  return approval
}

/**
 * 特殊放行审批：允许负责人在前置任务未完成时申请启动当前任务，
 * 但不改变前置任务状态，也不把本次审批当作交付完成审批。
 */
export async function submitTaskSpecialReleaseApproval(input: { organizationId: string; actorMemberId: string; actorName: string; taskId: string; reason: string; approverUserIds?: string[]; source?: ApprovalSource }) {
  const context = await loadSpecialReleaseContext(input.organizationId, input.taskId)
  const currentStatus = context.task.execution?.status ?? TaskExecutionStatus.NOT_STARTED
  const workflowVersionId = context.task.project.workflow?.publishedVersionId
  if (!workflowVersionId) throw new Error('workflow_not_published')
  if (completedStatuses.has(currentStatus)) throw new Error('task_already_completed')
  if (isSpecialReleaseForVersion(context.task.execution?.specialRelease, workflowVersionId)) throw new Error('special_release_already_approved')
  if (context.predecessors.length === 0 || currentStatus === TaskExecutionStatus.IN_PROGRESS) throw new Error('special_release_not_needed')
  const reason = input.reason.trim()
  if (!reason) throw new Error('special_release_reason_required')
  const pendingApproval = await prisma.taskApproval.findFirst({ where: { taskId: input.taskId, status: 'PENDING' }, select: { id: true } })
  if (pendingApproval) throw new Error('approval_pending_exists')
  const projectOsApproval = input.source === 'PROJECT_OS'
  if (!projectOsApproval) {
    await requireDingTalkIntegration(input.organizationId)
    if (!config.approval.enabled) throw new Error('dingtalk_approval_not_configured')
  }

  const originatorMemberId = context.task.assignees.some((item) => item.memberId === input.actorMemberId) ? input.actorMemberId : context.task.assignees[0]?.memberId
  if (!originatorMemberId) throw new Error('task_assignee_missing')
  const originatorUserId = projectOsApproval ? undefined : await dingTalkUserIdForMember(originatorMemberId)
  if (!projectOsApproval && !originatorUserId) throw new Error('dingtalk_identity_missing')
  const policy = await loadApprovalPolicy(context.task.projectId)
  const firstStep = policy.steps[0]!
  const resolvedApproverUserIds = projectOsApproval ? [] : await resolveApprovalApproverUserIds(context.task.projectId, input.approverUserIds, firstStep.stage, firstStep.approverMemberIds)
  const snapshot: SpecialReleaseSnapshot = {
    workflowVersionId,
    targetNodeId: context.task.node.id,
    predecessorTaskIds: context.predecessors.map((item) => item.taskId),
    predecessors: context.predecessors,
    reason,
    requestedAt: new Date().toISOString(),
  }
  const formComponentValues = [
    { name: '项目编号', value: context.task.project.code },
    { name: '任务编号', value: context.task.node.wbs },
    { name: '任务名称', value: context.task.node.name },
    { name: '进度', value: String(context.task.execution?.progress ?? 0) },
    { name: '交付类型', value: taskApprovalPurposeLabel('BYPASS') },
    { name: '交付说明', value: reason },
    { name: '前置任务', value: context.predecessors.map((item) => `${item.wbs} ${item.name}（${item.status}）`).join('；') },
    { name: '提交人', value: input.actorName },
  ]
  const processCode = projectOsApproval ? projectOsApprovalProcessCode : config.approval.processCode
  const processInstanceId = projectOsApproval ? `project-os:${randomUUID()}` : (await createDingTalkApprovalInstance({ processCode, originatorUserId: originatorUserId!, formComponentValues, approverUserIds: resolvedApproverUserIds })).processInstanceId
  const approval = await prisma.$transaction(async (tx) => {
    await tx.taskExecution.updateMany({ where: { taskId: context.task.id, status: { notIn: [...completedStatuses] } }, data: { completionApprovalStatus: 'PENDING' } })
    const created = await tx.taskApproval.create({
      data: {
        taskId: context.task.id,
        processInstanceId,
        processCode,
        source: projectOsApproval ? 'PROJECT_OS' : 'DINGTALK',
        policyId: policy.id,
        policySnapshot: policy.steps as unknown as Prisma.InputJsonValue,
        currentStepNo: firstStep.stepNo,
        purpose: 'BYPASS',
        deliveryType: 'FINAL',
        status: 'PENDING',
        submitterMemberId: originatorMemberId,
        submitterName: input.actorName,
        submitterDingUserId: originatorUserId,
        formValues: { formComponentValues, specialRelease: snapshot, submittedBy: input.actorMemberId, ...(projectOsApproval ? { source: 'PROJECT_OS' } : {}) },
      },
      select: { id: true, taskId: true, processInstanceId: true, processCode: true, source: true, purpose: true, deliveryType: true, status: true, createdAt: true },
    })
    await tx.taskApprovalStep.create({
      data: { approvalId: created.id, stepNo: firstStep.stepNo, stage: firstStep.stage, mode: firstStep.mode, minApprovals: firstStep.minApprovals, processInstanceId, approverUserIds: resolvedApproverUserIds as unknown as Prisma.InputJsonValue },
    })
    await tx.outboxEvent.create({
      data: {
        organizationId: input.organizationId,
        aggregateType: 'TASK_APPROVAL',
        aggregateId: created.id,
        eventType: 'TASK_APPROVAL_SUBMITTED',
        dedupeKey: `task-approval-submitted:${created.id}`,
        payload: { taskId: context.task.id, projectId: context.task.projectId, approvalId: created.id, processInstanceId, source: projectOsApproval ? 'PROJECT_OS' : 'DINGTALK', submitterMemberId: originatorMemberId, submitterName: input.actorName, submittedAt: new Date().toISOString(), stepNo: firstStep.stepNo, stage: firstStep.stage, purpose: 'BYPASS', deliveryType: 'FINAL', progress: context.task.execution?.progress ?? 0, reason, predecessorTaskIds: snapshot.predecessorTaskIds },
      },
    })
    return created
  })
  await prisma.auditLog.create({
    data: { organizationId: input.organizationId, actorMemberId: input.actorMemberId, action: 'TASK_SPECIAL_RELEASE_SUBMITTED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: context.task.projectId, taskId: context.task.id, afterJson: { processInstanceId, processCode, source: projectOsApproval ? 'PROJECT_OS' : 'DINGTALK', reason, predecessorTaskIds: snapshot.predecessorTaskIds } },
  })
  return approval
}

function formComponentsFromDetail(detail: unknown) {
  const record = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : {}
  const components = Array.isArray(record.formComponentValues) ? record.formComponentValues : []
  return components.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const component = item as Record<string, unknown>
    const name = typeof component.name === 'string' ? component.name : typeof component.label === 'string' ? component.label : ''
    const value = typeof component.value === 'string' ? component.value : ''
    return name ? [{ name, value }] : []
  })
}

function detailString(detail: unknown, ...keys: string[]) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined
  const record = detail as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function formValue(components: { name: string; value: string }[], ...names: string[]) {
  const expected = new Set(names)
  return components.find((item) => expected.has(item.name))?.value.trim() || undefined
}

/**
 * 接收负责人直接在钉钉 OA 发起的同一审批模板：用项目编号 + 任务编号
 * 绑定任务，并把外部实例纳入本地审批表，后续沿用同一套同步、通知和完成链路。
 */
export async function ensureTaskApprovalForDingTalkSubmission(input: { processInstanceId: string; processCode?: string; detail?: Prisma.InputJsonValue; source?: string }) {
  await requireDingTalkIntegration(config.dingtalk.organizationId)
  const existingKey = await findApprovalByProcessInstanceId(input.processInstanceId)
  const existing = existingKey ? await prisma.taskApproval.findUnique({ where: { id: existingKey.id }, select: { id: true, taskId: true, status: true, processInstanceId: true } }) : null
  if (existing) {
    if (existing.status === 'PENDING' && existing.processInstanceId === input.processInstanceId) await syncTaskApprovalSubmission({ processInstanceId: input.processInstanceId, detail: input.detail, source: input.source })
    return existing
  }
  if (!config.approval.processCode) return

  let detail: Prisma.InputJsonValue | undefined = input.detail
  let components = formComponentsFromDetail(detail)
  let processCode = detailString(detail, 'processCode', 'process_code') ?? input.processCode
  if (!processCode || processCode === config.approval.processCode) {
    // 回调通常只有实例 ID；读取详情补齐表单字段，才能支持在钉钉 OA 中直接发起。
    if (components.length === 0 && config.approval.enabled) {
      try {
        const instance = await fetchDingTalkApprovalInstance(input.processInstanceId)
        detail = instance.raw as Prisma.InputJsonValue
        components = instance.formComponentValues
        processCode = detailString(detail, 'processCode', 'process_code') ?? processCode
      } catch {
        return
      }
    }
  }
  if (processCode && processCode !== config.approval.processCode) return

  const projectCode = formValue(components, '项目编号', 'projectCode', 'project_code')
  const taskWbs = formValue(components, '任务编号', '任务 WBS', 'taskWbs', 'task_wbs')
  const originatorUserId = detailString(detail, 'originatorUserId', 'originator_user_id', 'originator')
  if (!projectCode || !taskWbs || !originatorUserId || !config.dingtalk.organizationId) return

  const identity = await prisma.externalIdentity.findFirst({
    where: { provider: 'DINGTALK', corpId: config.dingtalk.corpId, userId: originatorUserId, member: { organizationId: config.dingtalk.organizationId, status: 'ACTIVE' } },
    select: { memberId: true, member: { select: { name: true } } },
  })
  if (!identity) return
  const project = await prisma.project.findFirst({
    where: { organizationId: config.dingtalk.organizationId, code: projectCode, archivedAt: null },
    select: { id: true, workflow: { select: { publishedVersionId: true } } },
  })
  const publishedVersionId = project?.workflow?.publishedVersionId
  if (!project || !publishedVersionId) return
  const task = await prisma.task.findFirst({
    where: { archivedAt: null, projectId: project.id, nodes: { some: { wbs: taskWbs, workflowVersionId: publishedVersionId } } },
    select: { id: true, projectId: true, assignees: { where: { removedAt: null }, select: { memberId: true } }, execution: { select: { status: true, progress: true, actualStart: true, specialRelease: true } }, deliverables: { where: { deletedAt: null }, select: { id: true } }, nodes: { where: { wbs: taskWbs, workflowVersionId: publishedVersionId }, take: 1, select: { id: true, name: true, schedules: { select: { plannedEnd: true }, take: 1 } } } },
  })
  if (!task || !task.assignees.some((item) => item.memberId === identity.memberId) || !task.nodes[0]) return
  const overdueReason = normalizeOverdueReason(formValue(components, '超期原因', 'overdueReason'))
  const purpose = parseTaskApprovalPurpose(formValue(components, '交付类型', 'deliveryType', '提交类型'))
  const deliveryType = parseTaskDeliveryType(formValue(components, '交付类型', 'deliveryType', '提交类型'))
  const submittedProgress = parseDeliveryProgress(formValue(components, '进度', '完成度', 'progress'))

  if (purpose === 'BYPASS') {
    let releaseContext: SpecialReleaseContext
    try {
      releaseContext = await loadSpecialReleaseContext(config.dingtalk.organizationId, task.id)
    } catch {
      return
    }
    if (completedStatuses.has(releaseContext.task.execution?.status ?? TaskExecutionStatus.NOT_STARTED) || releaseContext.predecessors.length === 0 || isSpecialReleaseForVersion(releaseContext.task.execution?.specialRelease, publishedVersionId)) return
    const pendingRelease = await prisma.taskApproval.findFirst({ where: { taskId: task.id, status: 'PENDING' }, select: { id: true } })
    if (pendingRelease) return
    const reason = formValue(components, '特殊放行原因', '跨节点原因', '放行原因', '交付说明')
    if (!reason || reason === '无') return
    const policy = await loadApprovalPolicy(task.projectId)
    const firstStep = policy.steps[0]!
    const approval = await prisma.$transaction(async (tx) => {
      await tx.taskExecution.updateMany({ where: { taskId: task.id, status: { notIn: [...completedStatuses] } }, data: { completionApprovalStatus: 'PENDING' } })
      const created = await tx.taskApproval.create({
        data: {
          taskId: task.id,
          processInstanceId: input.processInstanceId,
          processCode: config.approval.processCode,
          policyId: policy.id,
          policySnapshot: policy.steps as unknown as Prisma.InputJsonValue,
          currentStepNo: firstStep.stepNo,
          purpose: 'BYPASS',
          deliveryType: 'FINAL',
          status: 'PENDING',
          submitterMemberId: identity.memberId,
          submitterName: identity.member.name,
          submitterDingUserId: originatorUserId,
          formValues: { ...(jsonRecord(detail) ?? { formComponentValues: components }), specialRelease: { workflowVersionId: publishedVersionId, targetNodeId: releaseContext.task.node.id, predecessorTaskIds: releaseContext.predecessors.map((item) => item.taskId), predecessors: releaseContext.predecessors, reason, requestedAt: new Date().toISOString() } },
        },
        select: { id: true, taskId: true, status: true, purpose: true },
      })
      await tx.taskApprovalStep.create({
        data: { approvalId: created.id, stepNo: firstStep.stepNo, stage: firstStep.stage, mode: firstStep.mode, minApprovals: firstStep.minApprovals, processInstanceId: input.processInstanceId, approverUserIds: [] as unknown as Prisma.InputJsonValue },
      })
      await tx.outboxEvent.create({
        data: {
          organizationId: config.dingtalk.organizationId,
          aggregateType: 'TASK_APPROVAL',
          aggregateId: created.id,
          eventType: 'TASK_APPROVAL_SUBMITTED',
          dedupeKey: `task-approval-submitted:${created.id}`,
          payload: { taskId: task.id, projectId: task.projectId, approvalId: created.id, processInstanceId: input.processInstanceId, submitterMemberId: identity.memberId, submitterName: identity.member.name, submittedAt: new Date().toISOString(), source: input.source ?? 'dingtalk-oa', purpose: 'BYPASS', deliveryType: 'FINAL', progress: submittedProgress ?? task.execution?.progress ?? 0, reason, predecessorTaskIds: releaseContext.predecessors.map((item) => item.taskId) },
        },
      })
      return created
    })
    await prisma.auditLog.create({ data: { organizationId: config.dingtalk.organizationId, actorMemberId: identity.memberId, action: 'TASK_SPECIAL_RELEASE_SUBMITTED_FROM_DINGTALK', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId: input.processInstanceId, processCode: config.approval.processCode, source: input.source ?? 'dingtalk-oa', reason } } })
    return approval
  }

  const policy = await loadApprovalPolicy(task.projectId)
  const firstStep = policy.steps[0]!

  const approval = await prisma.$transaction(async (tx) => {
    const created = await tx.taskApproval.create({
      data: {
        taskId: task.id,
        processInstanceId: input.processInstanceId,
        processCode: config.approval.processCode,
        policyId: policy.id,
        policySnapshot: policy.steps as unknown as Prisma.InputJsonValue,
        currentStepNo: firstStep.stepNo,
        purpose,
        deliveryType,
        status: 'PENDING',
        submitterMemberId: identity.memberId,
        submitterName: identity.member.name,
        submitterDingUserId: originatorUserId,
        formValues: detail ?? { formComponentValues: components },
      },
      select: { id: true, taskId: true, status: true, purpose: true },
    })
    await tx.taskApprovalStep.create({
      data: { approvalId: created.id, stepNo: firstStep.stepNo, stage: firstStep.stage, mode: firstStep.mode, minApprovals: firstStep.minApprovals, processInstanceId: input.processInstanceId, approverUserIds: [] as unknown as Prisma.InputJsonValue },
    })
    // 最终交付审批需要把此前阶段提交的全部有效交付物一起纳入审批包；
    // 阶段交付只在 syncTaskApprovalSubmission 中关联本次 OA 的附件。
    if (deliveryType === 'FINAL') {
      await tx.taskApprovalDeliverable.createMany({
        data: task.deliverables.map((deliverable) => ({ approvalId: created.id, deliverableId: deliverable.id })),
        skipDuplicates: true,
      })
    }
    const currentStatus = task.execution?.status ?? TaskExecutionStatus.NOT_STARTED
    const nextStatus = completedStatuses.has(currentStatus) || currentStatus === TaskExecutionStatus.BLOCKED ? currentStatus : TaskExecutionStatus.IN_PROGRESS
    const actualStart = task.execution?.actualStart ?? new Date(`${dateOnly(new Date())}T00:00:00.000Z`)
    const nextProgress = submittedProgress ?? task.execution?.progress ?? 0
    await tx.taskExecution.upsert({
      where: { taskId: task.id },
      update: { status: nextStatus, progress: nextProgress, actualStart, completionApprovalStatus: 'PENDING', overdueReason, updatedById: identity.memberId },
      create: { taskId: task.id, status: nextStatus, progress: nextProgress, actualStart, completionApprovalStatus: 'PENDING', overdueReason, updatedById: identity.memberId },
    })
    if (currentStatus !== nextStatus || (submittedProgress !== undefined && submittedProgress !== (task.execution?.progress ?? 0))) {
      await tx.taskStatusHistory.create({ data: { taskId: task.id, fromStatus: task.execution?.status ?? null, toStatus: nextStatus, actualStart, reason: `钉钉 OA ${taskDeliveryTypeLabel(deliveryType)}提交进度 ${nextProgress}%`, changedById: identity.memberId } })
    }
    await tx.outboxEvent.create({
      data: {
        organizationId: config.dingtalk.organizationId,
        aggregateType: 'TASK_APPROVAL',
        aggregateId: created.id,
        eventType: 'TASK_APPROVAL_SUBMITTED',
        dedupeKey: `task-approval-submitted:${created.id}`,
        payload: { taskId: task.id, projectId: task.projectId, approvalId: created.id, processInstanceId: input.processInstanceId, submitterMemberId: identity.memberId, submitterName: identity.member.name, submittedAt: new Date().toISOString(), source: input.source ?? 'dingtalk-oa', purpose, deliveryType, progress: submittedProgress ?? task.execution?.progress ?? 0 },
      },
    })
    return created
  })
  await prisma.auditLog.create({ data: { organizationId: config.dingtalk.organizationId, actorMemberId: identity.memberId, action: 'TASK_APPROVAL_SUBMITTED_FROM_DINGTALK', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId: input.processInstanceId, processCode: config.approval.processCode, source: input.source ?? 'dingtalk-oa' } } })
  if (purpose === 'DELIVERY') await syncTaskApprovalSubmission({ processInstanceId: input.processInstanceId, detail, source: input.source ?? 'dingtalk-oa' })
  return approval
}

/**
 * OA 审批提交/进行中时同步交付物引用。文件仍由审批通过流程下载，
 * 但负责人提交后，任务详情先能看到钉钉交付物和审批中的状态。
 */
export async function syncTaskApprovalSubmission(input: { processInstanceId: string; detail?: Prisma.InputJsonValue; source?: string }) {
  const approvalKey = await findApprovalByProcessInstanceId(input.processInstanceId)
  const approval = approvalKey ? await prisma.taskApproval.findUnique({
    where: { id: approvalKey.id },
    select: {
      id: true,
      taskId: true,
      status: true,
      processInstanceId: true,
      processCode: true,
      submitterMemberId: true,
      approvalFileId: true,
      approvalSpaceId: true,
      approvalFileName: true,
      approvalMimeType: true,
       approvalSizeBytes: true,
       purpose: true,
       deliveryType: true,
       source: true,
       task: { select: { nodes: { select: { wbs: true, name: true }, take: 1 }, execution: { select: { status: true, progress: true, actualStart: true } }, project: { select: { organizationId: true } } } },
    },
  }) : null
  if (!approval || approval.status !== 'PENDING' || approval.processInstanceId !== input.processInstanceId) return
  if (approval.source !== 'PROJECT_OS') await requireDingTalkIntegration(approval.task.project.organizationId)
  if (approval.purpose === 'BYPASS') return { approvalId: approval.id, taskId: approval.taskId, deliverableIds: [], attachmentSynced: false, source: input.source ?? 'unknown' }

  const components = formComponentsFromDetail(input.detail)
  // 文档 §5.3：审批进行中即同步全部附件引用（多附件），L2 可提前在任务详情里看到交付物。
  const attachments = extractApprovalAttachments(components)
  const legacySingle = attachments.length === 0 ? extractApprovalAttachment(components) : null
  const refs = attachments.length > 0 ? attachments : legacySingle ? [legacySingle] : []
  const primary = refs[0]
  const packageRows: { deliverableId: string }[] = []
  for (const attachment of refs) {
    const externalId = attachment.fileId ? `${approval.processInstanceId}:${attachment.fileId}` : approval.processInstanceId
    const existing = await prisma.taskDeliverable.findFirst({
      where: { taskId: approval.taskId, externalProvider: 'DINGTALK_APPROVAL', externalId, deletedAt: null },
      select: { id: true },
    })
    const deliverableId = existing?.id ?? randomUUID()
    const deliverableData = {
      taskId: approval.taskId,
      kind: 'DINGTALK' as const,
      name: safeDeliverableName(attachment.name ?? `钉钉审批交付物 ${nodeLabel(approval.task.nodes[0]?.wbs, approval.task.nodes[0]?.name)}`),
      versionLabel: 'v1',
      uploaderMemberId: approval.submitterMemberId,
      externalProvider: 'DINGTALK_APPROVAL',
      externalId,
      approvalProcessInstanceId: approval.processInstanceId,
      approvalProcessCode: approval.processCode,
      approvalFileId: attachment.fileId ?? undefined,
      approvalSpaceId: attachment.spaceId ?? undefined,
    }
    await prisma.$transaction(async (tx) => {
      if (existing) await tx.taskDeliverable.update({ where: { id: existing.id }, data: deliverableData })
      else await tx.taskDeliverable.create({ data: { id: deliverableId, ...deliverableData } })
      await tx.taskApprovalDeliverable.createMany({ data: [{ approvalId: approval.id, deliverableId }], skipDuplicates: true })
      await tx.taskApproval.update({
        where: { id: approval.id },
        data: {
          ...(input.detail !== undefined ? { formValues: input.detail } : {}),
          ...(primary ? { approvalFileId: primary.fileId, approvalSpaceId: primary.spaceId, approvalFileName: primary.name, approvalMimeType: primary.mimeType, approvalSizeBytes: primary.size } : {}),
        },
      })
    })
    packageRows.push({ deliverableId })
  }
  if (refs.length === 0 && input.detail !== undefined) {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { formValues: input.detail } })
  }
  const deliveryType = parseTaskDeliveryType(approval.deliveryType)
  const submittedProgress = parseDeliveryProgress(formValue(components, '进度', '完成度', 'progress'))
  const currentExecution = approval.task.execution
  const currentStatus = currentExecution?.status ?? TaskExecutionStatus.NOT_STARTED
  const nextStatus = completedStatuses.has(currentStatus) || currentStatus === TaskExecutionStatus.BLOCKED ? currentStatus : TaskExecutionStatus.IN_PROGRESS
  const nextProgress = submittedProgress ?? currentExecution?.progress ?? 0
  const actualStart = currentExecution?.actualStart ?? new Date(`${dateOnly(new Date())}T00:00:00.000Z`)
  if (submittedProgress !== undefined || currentStatus === TaskExecutionStatus.NOT_STARTED) {
    await prisma.$transaction(async (tx) => {
      await tx.taskExecution.upsert({
        where: { taskId: approval.taskId },
        update: { status: nextStatus, progress: nextProgress, actualStart, completionApprovalStatus: 'PENDING', updatedById: approval.submitterMemberId },
        create: { taskId: approval.taskId, status: nextStatus, progress: nextProgress, actualStart, completionApprovalStatus: 'PENDING', updatedById: approval.submitterMemberId },
      })
      if (currentStatus !== nextStatus || submittedProgress !== undefined && submittedProgress !== (currentExecution?.progress ?? 0)) {
        await tx.taskStatusHistory.create({ data: { taskId: approval.taskId, fromStatus: currentExecution?.status ?? null, toStatus: nextStatus, actualStart, reason: `钉钉 OA ${taskDeliveryTypeLabel(deliveryType)}同步进度 ${nextProgress}%`, changedById: approval.submitterMemberId } })
      }
    })
  }
  return { approvalId: approval.id, taskId: approval.taskId, deliverableIds: packageRows.map((item) => item.deliverableId), attachmentSynced: refs.length > 0, source: input.source ?? 'unknown' }
}

type SpecialReleaseApproval = {
  id: string
  taskId: string
  processInstanceId: string
  submitterMemberId: string | null
  submitterDingUserId: string | null
  formValues: Prisma.JsonValue | null
}

async function applySpecialReleaseApproval(input: { detail?: Prisma.InputJsonValue; source?: string }, approval: SpecialReleaseApproval) {
  const formRecord = jsonRecord(approval.formValues)
  const requestedRelease = parseSpecialRelease(formRecord?.specialRelease)
  const fail = async (error: string) => {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'SPECIAL_RELEASE_FAILED', error, formValues: mergeApprovalFormValues(approval.formValues, input.detail) } })
    return { taskId: approval.taskId, status: 'APPROVED', specialRelease: false, error }
  }
  if (!requestedRelease) return fail('special_release_snapshot_missing')

  const task = await prisma.task.findFirst({
    where: { id: approval.taskId, archivedAt: null },
    select: {
      id: true,
      projectId: true,
      project: { select: { organizationId: true, workflow: { select: { publishedVersionId: true } } } },
      execution: { select: { status: true, progress: true, actualStart: true, specialRelease: true } },
    },
  })
  if (!task) return fail('task_not_found')
  if (!task.project.workflow?.publishedVersionId || task.project.workflow.publishedVersionId !== requestedRelease.workflowVersionId) return fail('workflow_version_changed')
  if (completedStatuses.has(task.execution?.status ?? TaskExecutionStatus.NOT_STARTED)) return fail('task_already_completed')
  if (isSpecialReleaseForVersion(task.execution?.specialRelease, requestedRelease.workflowVersionId)) return fail('special_release_already_approved')

  const components = formComponentsFromDetail(input.detail).length > 0 ? formComponentsFromDetail(input.detail) : formComponentsFromDetail(approval.formValues)
  const nextProgress = parseDeliveryProgress(formValue(components, '进度', '完成度', 'progress')) ?? task.execution?.progress ?? 0
  const startedAt = task.execution?.actualStart ?? new Date(`${dateOnly(new Date())}T00:00:00.000Z`)
  const approvedAt = new Date()
  const release: SpecialReleaseSnapshot = { ...requestedRelease, approvalId: approval.id, approvedAt: approvedAt.toISOString() }
  const note = `特殊放行审批通过：${requestedRelease.reason}`
  const execution = await prisma.$transaction(async (tx) => {
    const updated = await tx.taskExecution.upsert({
      where: { taskId: task.id },
      update: { status: TaskExecutionStatus.IN_PROGRESS, progress: nextProgress, actualStart: startedAt, readyAt: startedAt, specialRelease: release as unknown as Prisma.InputJsonValue, completionApprovalStatus: 'PENDING', completionConfirmedAt: null, completionNote: note, updatedById: approval.submitterMemberId },
      create: { taskId: task.id, status: TaskExecutionStatus.IN_PROGRESS, progress: nextProgress, actualStart: startedAt, readyAt: startedAt, specialRelease: release as unknown as Prisma.InputJsonValue, completionApprovalStatus: 'PENDING', completionNote: note, updatedById: approval.submitterMemberId },
    })
    if (task.execution?.status !== TaskExecutionStatus.IN_PROGRESS) await tx.taskStatusHistory.create({ data: { taskId: task.id, fromStatus: task.execution?.status ?? null, toStatus: TaskExecutionStatus.IN_PROGRESS, actualStart: startedAt, reason: `${note}；前置任务待补做`, changedById: approval.submitterMemberId } })
    await tx.taskApprovalStep.updateMany({ where: { approvalId: approval.id, processInstanceId: approval.processInstanceId, status: 'PENDING' }, data: { status: 'APPROVED', decidedAt: approvedAt, error: null } })
    await tx.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: approvedAt, autoCompleteStatus: 'SPECIAL_RELEASED', error: null, formValues: mergeApprovalFormValues(approval.formValues, input.detail, release) } })
    await tx.auditLog.create({ data: { organizationId: task.project.organizationId, actorMemberId: approval.submitterMemberId, action: 'TASK_SPECIAL_RELEASE_APPROVED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId: approval.processInstanceId, predecessorTaskIds: release.predecessorTaskIds, reason: release.reason, approvedAt: approvedAt.toISOString() } } })
    return updated
  })
  await notifySubmitter(approval.submitterDingUserId, '特殊放行已通过', `任务已进入进行中：${note}。前置任务仍保持原状态，后续需要补做；本次审批不代表交付完成。`, task.project.organizationId).catch(() => undefined)
  return { taskId: task.id, status: execution.status, specialRelease: true, predecessorTaskIds: release.predecessorTaskIds }
}

export type ApprovalOutcome = 'APPROVED' | 'REJECTED' | 'TERMINATED'

/**
 * 审批结果落地：同意 → 保存附件引用（默认首次查看时再下载）；最终交付才自动完成任务
 * （按计划完成日落提前/如期/超期结束）并触发 TASK_COMPLETED，阶段交付只记录成果和进度。
 * 拒绝/终止 → 仅记录结果并通知提交人。
 */
export async function applyApprovalOutcome(input: { processInstanceId: string; outcome: ApprovalOutcome; detail?: Prisma.InputJsonValue; source?: string; actorMemberId?: string }) {
  const approvalKey = await findApprovalByProcessInstanceId(input.processInstanceId)
  const approval = approvalKey ? await prisma.taskApproval.findUnique({
    where: { id: approvalKey.id },
    include: {
      steps: { orderBy: { stepNo: 'asc' } },
      packageLinks: {
        where: { deliverable: { deletedAt: null } },
        select: {
          deliverable: {
            select: {
              id: true,
              taskId: true,
              kind: true,
              name: true,
              versionLabel: true,
              url: true,
              objectKey: true,
              mimeType: true,
              sizeBytes: true,
              uploaderMemberId: true,
              externalProvider: true,
              externalId: true,
              approvalProcessInstanceId: true,
              approvalProcessCode: true,
              approvalFileId: true,
              approvalSpaceId: true,
            },
          },
        },
      },
      task: { select: { project: { select: { organizationId: true } } } },
    },
  }) : null
  if (!approval || approval.status !== 'PENDING' || approval.processInstanceId !== input.processInstanceId) return
  if (approval.source !== 'PROJECT_OS') await requireDingTalkIntegration(approval.task.project.organizationId)

  if (input.outcome !== 'APPROVED') {
    const updated = await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: input.outcome, completedAt: new Date(), formValues: mergeApprovalFormValues(approval.formValues, input.detail) }, select: { id: true, taskId: true, status: true } })
    await prisma.taskApprovalStep.updateMany({ where: { approvalId: approval.id, processInstanceId: input.processInstanceId, status: 'PENDING' }, data: { status: input.outcome, decidedAt: new Date() } })
    const owner = await prisma.task.findUnique({ where: { id: updated.taskId }, select: { projectId: true, project: { select: { organizationId: true } } } })
    await prisma.auditLog.create({ data: { organizationId: owner?.project.organizationId ?? '', actorMemberId: input.actorMemberId ?? null, action: `TASK_APPROVAL_${input.outcome}`, resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: owner?.projectId, taskId: approval.taskId, afterJson: { outcome: input.outcome, source: input.source ?? 'unknown' } } })
    const title = approval.purpose === 'BYPASS' ? '特殊放行审批未通过' : '交付物审批未通过'
    const body = approval.purpose === 'BYPASS'
      ? `您的特殊放行申请已被${input.outcome === 'REJECTED' ? '拒绝' : '终止'}，任务仍需等待前置任务完成后才能开始。`
      : `您提交的交付物审批已被${input.outcome === 'REJECTED' ? '拒绝' : '终止'}，请在${approval.source === 'PROJECT_OS' ? 'Project OS 的“我的任务”' : '钉钉审批'}查看处理结果。`
    await notifySubmitter(approval.submitterDingUserId, title, body, owner?.project.organizationId).catch(() => undefined)
    return
  }

  // 多级策略：当前步骤通过后只创建下一步骤的钉钉实例；最后一步才允许进入任务自动完成链路。
  const policySteps = policyStepsFromSnapshot(approval.policySnapshot)
  const currentStepNo = approval.steps.find((step) => step.processInstanceId === input.processInstanceId)?.stepNo ?? approval.currentStepNo
  const nextStep = policySteps.find((step) => step.stepNo > currentStepNo)
  if (nextStep) {
    if (approval.source === 'PROJECT_OS') {
      const nextProcessInstanceId = `project-os:${randomUUID()}`
      const nextComponents = formComponentsFromDetail(approval.formValues)
      const task = await prisma.task.findUnique({ where: { id: approval.taskId }, select: { projectId: true, project: { select: { organizationId: true } } } })
      await prisma.$transaction(async (tx) => {
        await tx.taskApprovalStep.updateMany({ where: { approvalId: approval.id, processInstanceId: input.processInstanceId, status: 'PENDING' }, data: { status: 'APPROVED', decidedAt: new Date(), error: null } })
        await tx.taskApprovalStep.create({ data: { approvalId: approval.id, stepNo: nextStep.stepNo, stage: nextStep.stage, mode: nextStep.mode, minApprovals: nextStep.minApprovals, processInstanceId: nextProcessInstanceId, approverUserIds: [] as unknown as Prisma.InputJsonValue } })
        await tx.taskApproval.update({ where: { id: approval.id }, data: { processInstanceId: nextProcessInstanceId, currentStepNo: nextStep.stepNo, formValues: mergeApprovalFormValues(approval.formValues, input.detail), error: null } })
        if (task) await tx.outboxEvent.create({ data: { organizationId: task.project.organizationId, aggregateType: 'TASK_APPROVAL', aggregateId: approval.id, eventType: 'TASK_APPROVAL_SUBMITTED', dedupeKey: `task-approval-step-submitted:${approval.id}:${nextStep.stepNo}`, payload: { taskId: approval.taskId, projectId: task.projectId, approvalId: approval.id, processInstanceId: nextProcessInstanceId, source: 'PROJECT_OS', stepNo: nextStep.stepNo, stage: nextStep.stage, purpose: approval.purpose, deliveryType: approval.deliveryType, progress: parseDeliveryProgress(formValue(nextComponents, '进度', '完成度', 'progress')) ?? null, submitterMemberId: approval.submitterMemberId, submitterName: approval.submitterName, submittedAt: new Date().toISOString() } } })
      })
      return { taskId: approval.taskId, status: 'PENDING', processInstanceId: nextProcessInstanceId, nextStep: nextStep.stepNo }
    }
    if (!approval.submitterDingUserId) {
      await prisma.taskApproval.update({ where: { id: approval.id }, data: { error: 'dingtalk_originator_missing' } })
      return
    }
    const nextApproverUserIds = await resolveApprovalApproverUserIds(approval.taskId ? (await prisma.task.findUnique({ where: { id: approval.taskId }, select: { projectId: true } }))?.projectId ?? '' : '', undefined, nextStep.stage, nextStep.approverMemberIds)
    if (nextApproverUserIds.length === 0) throw new Error('dingtalk_approver_missing')
    const nextComponents = formComponentsFromDetail(input.detail ?? approval.formValues)
    const nextInstance = await createDingTalkApprovalInstance({ processCode: approval.processCode, originatorUserId: approval.submitterDingUserId, formComponentValues: nextComponents.length > 0 ? nextComponents : [{ name: '审批包', value: '详见上一审批步骤' }], approverUserIds: nextApproverUserIds })
    const task = await prisma.task.findUnique({ where: { id: approval.taskId }, select: { projectId: true, project: { select: { organizationId: true } } } })
    await prisma.$transaction(async (tx) => {
      await tx.taskApprovalStep.updateMany({ where: { approvalId: approval.id, processInstanceId: input.processInstanceId, status: 'PENDING' }, data: { status: 'APPROVED', decidedAt: new Date(), error: null } })
      await tx.taskApprovalStep.create({ data: { approvalId: approval.id, stepNo: nextStep.stepNo, stage: nextStep.stage, mode: nextStep.mode, minApprovals: nextStep.minApprovals, processInstanceId: nextInstance.processInstanceId, approverUserIds: nextApproverUserIds as unknown as Prisma.InputJsonValue } })
      await tx.taskApproval.update({ where: { id: approval.id }, data: { processInstanceId: nextInstance.processInstanceId, currentStepNo: nextStep.stepNo, formValues: mergeApprovalFormValues(approval.formValues, input.detail), error: null } })
      if (task) await tx.outboxEvent.create({ data: { organizationId: task.project.organizationId, aggregateType: 'TASK_APPROVAL', aggregateId: approval.id, eventType: 'TASK_APPROVAL_SUBMITTED', dedupeKey: `task-approval-step-submitted:${approval.id}:${nextStep.stepNo}`, payload: { taskId: approval.taskId, projectId: task.projectId, approvalId: approval.id, processInstanceId: nextInstance.processInstanceId, stepNo: nextStep.stepNo, stage: nextStep.stage, purpose: approval.purpose, deliveryType: approval.deliveryType, progress: parseDeliveryProgress(formValue(nextComponents, '进度', '完成度', 'progress')) ?? null, submitterMemberId: approval.submitterMemberId, submitterName: approval.submitterName, submittedAt: new Date().toISOString() } } })
    })
    return { taskId: approval.taskId, status: 'PENDING', processInstanceId: nextInstance.processInstanceId, nextStep: nextStep.stepNo }
  }

  if (approval.purpose === 'BYPASS') return applySpecialReleaseApproval({ detail: input.detail, source: input.source }, approval)

  const approvalChannel = approval.source === 'PROJECT_OS' ? 'Project OS OA' : '钉钉 OA'

  const task = await prisma.task.findFirst({
    where: { id: approval.taskId, archivedAt: null },
    select: {
      id: true,
      projectId: true,
      project: { select: { organizationId: true, code: true, name: true, approvalAutoStart: true, workflow: { select: { publishedVersionId: true } } } },
      execution: { select: { status: true, progress: true, actualStart: true, overdueReason: true } },
      nodes: { select: { id: true, wbs: true, name: true, schedules: { select: { plannedEnd: true }, take: 1 } } },
      assignees: { where: { removedAt: null }, select: { memberId: true } },
    },
  })
  if (!task) {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'FAILED', error: 'task_not_found' } })
    return
  }
  const organizationId = task.project.organizationId
  const submittedComponents = formComponentsFromDetail(input.detail)
  const components = submittedComponents.length > 0 ? submittedComponents : formComponentsFromDetail(approval.formValues)

  // 校验：提交人是否仍为该任务负责人（审批通过时的防串改校验）。
  const isAssignee = approval.submitterMemberId ? task.assignees.some((item) => item.memberId === approval.submitterMemberId) : false
  if (!isAssignee) {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'FAILED', error: 'submitter_not_assignee', formValues: mergeApprovalFormValues(approval.formValues, input.detail) } })
    await prisma.auditLog.create({ data: { organizationId, action: 'TASK_APPROVAL_VALIDATION_FAILED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { reason: 'submitter_not_assignee', submitterMemberId: approval.submitterMemberId } } })
    return
  }
  // 校验：任务已被其它途径完成 → 记录幂等结果，不再重复完成。
  if (task.execution && completedStatuses.has(task.execution.status)) {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'COMPLETED', error: 'task_already_completed' } })
    return
  }

  const todayText = dateOnly(new Date())
  const actualEnd = new Date(`${todayText}T00:00:00.000Z`)
  const plannedEnd = task.nodes[0]?.schedules[0]?.plannedEnd ?? null
  const overdueReason = normalizeOverdueReason(task.execution?.overdueReason ?? undefined) ?? normalizeOverdueReason(formValue(components, '超期原因', 'overdueReason'))
  if (task.execution?.status === TaskExecutionStatus.DUE_UNFINISHED && !overdueReason) {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'FAILED', error: 'overdue_reason_required', formValues: mergeApprovalFormValues(approval.formValues, input.detail) } })
    await prisma.auditLog.create({ data: { organizationId, actorMemberId: null, action: 'TASK_APPROVAL_VALIDATION_FAILED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { reason: 'overdue_reason_required' } } })
    return
  }

  // 附件：从审批表单提取全部交付物附件（文档 §5.3 多附件审批包）。
  // 默认只保存引用，首次查看/下载时再取回；兼容开关打开时保留审批通过即下载的旧行为。
  const fallbackRef: ApprovalAttachmentRef | null = approval.approvalFileId ? {
    fileId: approval.approvalFileId,
    spaceId: approval.approvalSpaceId ?? undefined,
    name: approval.approvalFileName ?? '钉钉审批附件',
    mimeType: approval.approvalMimeType ?? undefined,
    size: typeof approval.approvalSizeBytes === 'bigint' ? Number(approval.approvalSizeBytes) : undefined,
  } : null
  const attachments = extractApprovalAttachments(components)
  if (attachments.length === 0 && fallbackRef) attachments.push(fallbackRef)

  type PackageItem = { id: string; name: string; data: Prisma.TaskDeliverableUncheckedCreateInput; existed: boolean }
  // 之前通过机器人、Web 或 OA 进行中的同步已经属于本次任务交付包；
  // 先放入这些记录，再合并当前审批详情中的新附件，避免 D1/D2 在最终审批时丢失。
  const linkedApprovalFileIds = new Set<string>()
  const packageItems: PackageItem[] = approval.packageLinks.flatMap(({ deliverable }) => {
    if (deliverable.approvalFileId && linkedApprovalFileIds.has(deliverable.approvalFileId)) return []
    if (deliverable.approvalFileId) linkedApprovalFileIds.add(deliverable.approvalFileId)
    return [{
      id: deliverable.id,
      name: deliverable.name,
      existed: true,
      data: {
        taskId: deliverable.taskId,
        kind: deliverable.kind,
        name: deliverable.name,
        versionLabel: deliverable.versionLabel,
        url: deliverable.url ?? undefined,
        objectKey: deliverable.objectKey ?? undefined,
        mimeType: deliverable.mimeType ?? undefined,
        sizeBytes: deliverable.sizeBytes ?? undefined,
        uploaderMemberId: deliverable.uploaderMemberId ?? undefined,
        externalProvider: deliverable.externalProvider ?? undefined,
        externalId: deliverable.externalId ?? undefined,
        approvalProcessInstanceId: deliverable.approvalProcessInstanceId ?? undefined,
        approvalProcessCode: deliverable.approvalProcessCode ?? undefined,
        approvalFileId: deliverable.approvalFileId ?? undefined,
        approvalSpaceId: deliverable.approvalSpaceId ?? undefined,
      },
    }]
  })
  let attachmentError: string | null = null
  for (const attachment of attachments) {
    const linkedAttachment = packageItems.find((item) => item.data.approvalFileId === attachment.fileId)
    if (linkedAttachment) continue
    const externalId = `${approval.processInstanceId}:${attachment.fileId}`
    const existing = await prisma.taskDeliverable.findFirst({
      where: { taskId: task.id, externalProvider: 'DINGTALK_APPROVAL', externalId, deletedAt: null },
      select: { id: true },
    })
    const deliverableId = existing?.id ?? randomUUID()
    let storedFile: { objectKey: string; name: string; mimeType?: string; sizeBytes: number } | null = null
    if (attachment.fileId && config.approval.downloadAttachmentsOnApproval) {
      try {
        const file = await downloadApprovalAttachment({ processInstanceId: approval.processInstanceId, attachment, fetchImpl: fetch })
        // 下载函数会对文件名做安全化处理，用返回值里的名字落盘保证一致。
        const objectKey = `${deliverableId}/${file.name}`
        await persistFile(objectKey, file)
        storedFile = { objectKey, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes }
      } catch (error) {
        attachmentError = attachmentError ? `${attachmentError}; ${error instanceof Error ? error.message : 'download_failed'}` : error instanceof Error ? error.message : 'attachment_download_failed'
      }
    }
    const nextItem: PackageItem = {
      id: deliverableId,
      name: safeDeliverableName(storedFile?.name ?? attachment.name),
      existed: Boolean(existing),
      data: {
        taskId: task.id,
        kind: storedFile ? 'FILE' as const : 'DINGTALK' as const,
        name: safeDeliverableName(storedFile?.name ?? attachment.name),
        versionLabel: 'v1',
        url: storedFile ? `/api/v1/deliverables/${deliverableId}/download` : undefined,
        objectKey: storedFile?.objectKey,
        mimeType: storedFile?.mimeType,
        sizeBytes: storedFile?.sizeBytes,
        uploaderMemberId: approval.submitterMemberId,
        externalProvider: 'DINGTALK_APPROVAL',
        externalId,
        approvalProcessInstanceId: approval.processInstanceId,
        approvalProcessCode: approval.processCode,
        approvalFileId: attachment.fileId,
        approvalSpaceId: attachment.spaceId,
      },
    }
    const existingPackageIndex = packageItems.findIndex((item) => item.id === deliverableId)
    if (existingPackageIndex >= 0) packageItems[existingPackageIndex] = nextItem
    else packageItems.push(nextItem)
  }
  if (packageItems.length === 0 && fallbackRef) {
    // 完全没有附件引用（异常表单）：至少保留一条引用型交付物，避免审批包为空。
    packageItems.push({
      id: randomUUID(),
      name: safeDeliverableName(`钉钉审批交付物 ${nodeLabel(task.nodes[0]?.wbs, task.nodes[0]?.name)}`),
      existed: false,
      data: {
        taskId: task.id,
        kind: 'DINGTALK' as const,
        name: safeDeliverableName(`钉钉审批交付物 ${nodeLabel(task.nodes[0]?.wbs, task.nodes[0]?.name)}`),
        versionLabel: 'v1',
        uploaderMemberId: approval.submitterMemberId,
        externalProvider: 'DINGTALK_APPROVAL',
        externalId: approval.processInstanceId,
        approvalProcessInstanceId: approval.processInstanceId,
        approvalProcessCode: approval.processCode,
      },
    })
  }
  if (attachmentError) {
    await prisma.taskApproval.update({ where: { id: approval.id }, data: { error: attachmentError.slice(0, 500) } }).catch(() => undefined)
  }

  const deliveryType = parseTaskDeliveryType(approval.deliveryType)
  if (!completesTaskAfterApproval(deliveryType)) {
    // 阶段交付审批通过只确认本批材料，不写 TASK_COMPLETED，也不解锁下游任务。
    const currentStatus = task.execution?.status ?? TaskExecutionStatus.NOT_STARTED
    const nextExecutionStatus = completedStatuses.has(currentStatus) || currentStatus === TaskExecutionStatus.BLOCKED ? currentStatus : TaskExecutionStatus.IN_PROGRESS
    const submittedProgress = parseDeliveryProgress(formValue(components, '进度', '完成度', 'progress'))
    const nextProgress = submittedProgress ?? task.execution?.progress ?? 0
    const actualStart = task.execution?.actualStart ?? new Date(`${dateOnly(new Date())}T00:00:00.000Z`)
    const stageNote = `${approvalChannel}阶段交付审批通过（实例 ${approval.processInstanceId.slice(0, 18)}…，交付物 ${packageItems.length} 件）`
    const execution = await prisma.$transaction(async (tx) => {
      for (const item of packageItems) {
        if (item.existed) await tx.taskDeliverable.update({ where: { id: item.id }, data: item.data, select: { id: true } })
        else await tx.taskDeliverable.create({ data: { id: item.id, ...item.data }, select: { id: true } })
      }
      await tx.taskApprovalDeliverable.createMany({
        data: packageItems.map((item) => ({ approvalId: approval.id, deliverableId: item.id })),
        skipDuplicates: true,
      })
      const updated = await tx.taskExecution.upsert({
        where: { taskId: task.id },
        update: { status: nextExecutionStatus, progress: nextProgress, actualStart, completionApprovalStatus: 'PENDING', completionConfirmedAt: null, completionNote: stageNote, updatedById: approval.submitterMemberId },
        create: { taskId: task.id, status: nextExecutionStatus, progress: nextProgress, actualStart, completionApprovalStatus: 'PENDING', completionNote: stageNote, updatedById: approval.submitterMemberId },
      })
      if (currentStatus !== nextExecutionStatus || submittedProgress !== undefined && submittedProgress !== (task.execution?.progress ?? 0)) {
        await tx.taskStatusHistory.create({ data: { taskId: task.id, fromStatus: task.execution?.status ?? null, toStatus: nextExecutionStatus, actualStart, reason: `${stageNote}，进度 ${nextProgress}%`, changedById: approval.submitterMemberId } })
      }
      await tx.taskApprovalStep.updateMany({ where: { approvalId: approval.id, processInstanceId: input.processInstanceId, status: 'PENDING' }, data: { status: 'APPROVED', decidedAt: new Date(), error: attachmentError } })
      await tx.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'STAGE_RECORDED', error: attachmentError, formValues: mergeApprovalFormValues(approval.formValues, input.detail) } })
      await tx.auditLog.create({ data: { organizationId, actorMemberId: approval.submitterMemberId, action: 'TASK_APPROVAL_STAGE_RECORDED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId: approval.processInstanceId, deliverableIds: packageItems.map((item) => item.id), progress: nextProgress, attachmentError } } })
      return updated
    })
    await notifySubmitter(approval.submitterDingUserId, '阶段交付已同步', `您的阶段交付已审批通过，已同步 ${packageItems.length} 件交付物；任务仍在进行中，提交最终交付后才会申请完成。`, organizationId).catch(() => undefined)
    return { taskId: task.id, status: execution.status, deliveryType, taskCompleted: false, deliverableIds: packageItems.map((item) => item.id) }
  }

  const nextStatus = !plannedEnd || actualEnd.getTime() === new Date(`${dateOnly(plannedEnd)}T00:00:00.000Z`).getTime()
    ? 'ON_TIME_FINISHED'
    : actualEnd < new Date(`${dateOnly(plannedEnd)}T00:00:00.000Z`) ? 'EARLY_FINISHED' : 'OVERDUE_FINISHED'
  const actualStart = task.execution?.actualStart ?? actualEnd
  const approvalNote = `${approvalChannel}审批通过（实例 ${approval.processInstanceId.slice(0, 18)}…，交付物 ${packageItems.length} 件）`
  const primary = packageItems[0]

  const execution = await prisma.$transaction(async (tx) => {
    for (const item of packageItems) {
      if (item.existed) await tx.taskDeliverable.update({ where: { id: item.id }, data: item.data, select: { id: true } })
      else await tx.taskDeliverable.create({ data: { id: item.id, ...item.data }, select: { id: true } })
    }
    // 审批包关联（文档 §5.2）：记录本次审批最终包含的全部交付物。
    await tx.taskApprovalDeliverable.createMany({
      data: packageItems.map((item) => ({ approvalId: approval.id, deliverableId: item.id })),
      skipDuplicates: true,
    })
    const updated = await tx.taskExecution.upsert({
      where: { taskId: task.id },
      update: { status: nextStatus, progress: 100, actualEnd, completionApprovalStatus: 'APPROVED', completionConfirmedAt: actualEnd, completionNote: approvalNote, overdueReason, updatedById: approval.submitterMemberId },
      create: { taskId: task.id, status: nextStatus, progress: 100, actualStart, actualEnd, completionApprovalStatus: 'APPROVED', completionConfirmedAt: actualEnd, completionNote: approvalNote, overdueReason, updatedById: approval.submitterMemberId },
    })
    await tx.taskStatusHistory.create({
      data: { taskId: task.id, fromStatus: task.execution?.status ?? null, toStatus: nextStatus, actualStart, actualEnd, reason: approvalNote, changedById: approval.submitterMemberId },
    })
    await tx.outboxEvent.create({
      data: { organizationId, aggregateType: 'TASK', aggregateId: task.id, eventType: 'TASK_COMPLETED', dedupeKey: `task-completed:${task.id}:${updated.updatedAt.toISOString()}`, payload: { taskId: task.id, projectId: task.projectId, completedAt: actualEnd.toISOString(), completedById: approval.submitterMemberId, viaApproval: true, approvalId: approval.id } },
    })
    await tx.auditLog.create({
      data: { organizationId, actorMemberId: approval.submitterMemberId, action: 'TASK_APPROVAL_COMPLETED', resourceType: 'TASK_APPROVAL', resourceId: approval.id, projectId: task.projectId, taskId: task.id, afterJson: { processInstanceId: approval.processInstanceId, deliverableIds: packageItems.map((item) => item.id), status: nextStatus, overdueReason: overdueReason ?? null, attachmentError } },
    })
    return updated
  })

  await prisma.taskApprovalStep.updateMany({ where: { approvalId: approval.id, processInstanceId: input.processInstanceId, status: 'PENDING' }, data: { status: 'APPROVED', decidedAt: new Date(), error: attachmentError } })
  await prisma.taskApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', completedAt: new Date(), autoCompleteStatus: 'COMPLETED', error: attachmentError, approvalFileId: primary?.data.approvalFileId as string | undefined ?? null, approvalSpaceId: primary?.data.approvalSpaceId as string | undefined ?? null, approvalFileName: primary?.name ?? null, formValues: mergeApprovalFormValues(approval.formValues, input.detail) } })
  return { taskId: task.id, status: execution.status, deliverableIds: packageItems.map((item) => item.id) }
}

/** Project OS OA 审批中心的同意/拒绝入口。只允许处理内部审批，避免误改钉钉外部实例。 */
export async function decideProjectOsApproval(input: { organizationId: string; approvalId: string; actorMemberId: string; outcome: 'APPROVED' | 'REJECTED'; comment?: string }) {
  const approval = await prisma.taskApproval.findFirst({
    where: { id: input.approvalId, source: 'PROJECT_OS', task: { project: { organizationId: input.organizationId, archivedAt: null } } },
    select: {
      id: true,
      processInstanceId: true,
      status: true,
      currentStepNo: true,
      policySnapshot: true,
      steps: { where: { status: 'PENDING' }, orderBy: { stepNo: 'asc' }, take: 1, select: { stepNo: true, stage: true } },
    },
  })
  if (!approval) throw new Error('approval_not_found')
  if (approval.status !== 'PENDING') throw new Error('approval_not_pending')
  const currentStep = approval.steps[0]
  const policyStep = policyStepsFromSnapshot(approval.policySnapshot).find((step) => step.stepNo === (currentStep?.stepNo ?? approval.currentStepNo))
  const actorMember = await prisma.member.findFirst({ where: { id: input.actorMemberId, organizationId: input.organizationId, status: 'ACTIVE' }, select: { memberRoles: { select: { role: { select: { code: true } } } } } })
  const actorIsL1 = actorMember?.memberRoles.some(({ role }) => role.code === 'L1') ?? false
  if (currentStep?.stage === 'ADMIN' && !actorIsL1) throw new Error('approval_admin_stage_required')
  if (!actorMember || !canDecideApprovalStep(input.actorMemberId, actorIsL1, { stage: currentStep?.stage, approverMemberIds: policyStep?.approverMemberIds ?? [], ccMemberIds: policyStep?.ccMemberIds ?? [] })) throw new Error('approval_approver_required')
  const comment = input.comment?.trim()
  await applyApprovalOutcome({ processInstanceId: approval.processInstanceId, outcome: input.outcome, source: 'project-os', actorMemberId: input.actorMemberId, detail: comment ? { decisionComment: comment } : undefined })
  const updated = await prisma.taskApproval.findUnique({ where: { id: approval.id }, select: { id: true, status: true, processInstanceId: true, currentStepNo: true } })
  return { approvalId: approval.id, status: updated?.status ?? input.outcome, processInstanceId: updated?.processInstanceId ?? approval.processInstanceId, currentStepNo: updated?.currentStepNo ?? 1 }
}

function nodeLabel(wbs: string | undefined, name: string | undefined) {
  return [wbs, name].filter(Boolean).join(' ') || '未命名'
}

async function notifySubmitter(userId: string | null | undefined, title: string, body: string, organizationId?: string) {
  if (!userId) return
  await sendDingTalkOtoMarkdown(userId, title, body, organizationId)
}

/**
 * 外部审批实例补偿发现（文档 §8）：主动按模板 processCode 拉取近窗口内
 * 的钉钉实例列表，L3 直接在钉钉 OA 发起、或回调丢失时补建本地审批记录。
 * 幂等：按 processInstanceId 唯一键；窗口固定回扫（默认 24h），天然重叠。
 */
export async function discoverExternalApprovals(log: WorkerLog = console) {
  if (!config.approval.enabled || !config.approval.pollEnabled || !config.approval.discoveryEnabled) return 0
  if (!(await isDingTalkIntegrationEnabled(config.dingtalk.organizationId))) return 0
  // 保护放在审批函数内部，避免未来新增调用方时重新继承 5 秒通知间隔。
  const nowMs = Date.now()
  if (!isApprovalPollDue(nowMs, lastApprovalDiscoveryAtMs, config.approval.discoveryIntervalMs)) return 0
  lastApprovalDiscoveryAtMs = nowMs
  const startTimeMs = Date.now() - Math.max(5 * 60 * 1000, config.approval.discoveryWindowMs)
  let instanceIds: string[]
  try {
    instanceIds = await fetchRecentApprovalInstanceIds({ startTimeMs })
  } catch (error) {
    log.warn(`[Approvals] discovery list failed: ${error instanceof Error ? error.message : error}`)
    return 0
  }
  if (instanceIds.length === 0) return 0
  const [knownApprovals, knownSteps] = await Promise.all([
    prisma.taskApproval.findMany({ where: { processInstanceId: { in: instanceIds } }, select: { processInstanceId: true } }),
    prisma.taskApprovalStep.findMany({ where: { processInstanceId: { in: instanceIds } }, select: { processInstanceId: true } }),
  ])
  const knownSet = new Set([...knownApprovals, ...knownSteps].map((item) => item.processInstanceId))
  const missing = instanceIds.filter((id) => !knownSet.has(id))
  let created = 0
  for (const processInstanceId of missing) {
    try {
      const approval = await ensureTaskApprovalForDingTalkSubmission({ processInstanceId, source: 'discovery' })
      if (approval) created += 1
    } catch (error) {
      // 未匹配任务的实例进入告警日志（异常记录），不直接丢弃。
      log.warn(`[Approvals] discovery ${processInstanceId} unmatched: ${error instanceof Error ? error.message : error}`)
    }
  }
  if (created > 0) log.info(`[Approvals] discovery补建 ${created} 条外部审批实例`)
  return created
}

/**
 * 轮询兜底：本机开发环境收不到钉钉事件回调（127.0.0.1），worker 每轮
 * 拉取 PENDING 审批实例的最新状态；生产环境配置了事件订阅时同样幂等。
 */
export async function pollPendingApprovals(log: WorkerLog = console) {
  if (!config.approval.enabled || !config.approval.pollEnabled) return 0
  if (!(await isDingTalkIntegrationEnabled(config.dingtalk.organizationId))) return 0
  // 保护放在审批函数内部，而不是只依赖 notificationWorker 的调用频率。
  const nowMs = Date.now()
  if (!isApprovalPollDue(nowMs, lastApprovalPollAtMs, config.approval.pollIntervalMs)) return 0
  lastApprovalPollAtMs = nowMs
  // 先做外部实例补偿发现（回调丢失 / OA 直接提交场景），再同步已知 PENDING 实例。
  await discoverExternalApprovals(log).catch(() => undefined)
  const pending = await prisma.taskApproval.findMany({
    // Project OS 内部审批没有钉钉实例，绝不能进入外部状态轮询。
    where: { source: 'DINGTALK', status: 'PENDING', updatedAt: { lt: new Date(Date.now() - 5000) } },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, config.approval.pollBatchSize),
    select: { id: true, processInstanceId: true },
  })
  if (pending.length === 0) return 0
  let processed = 0
  for (const item of pending) {
    try {
      const instance = await fetchDingTalkApprovalInstance(item.processInstanceId)
      if (instance.status === 'RUNNING') {
        await syncTaskApprovalSubmission({ processInstanceId: item.processInstanceId, detail: instance.raw as Prisma.InputJsonValue, source: 'poll' })
        continue
      }
      if (instance.status === 'UNKNOWN') continue
      const outcome: ApprovalOutcome = instance.status === 'COMPLETED' ? (instance.result === 'refuse' ? 'REJECTED' : 'APPROVED') : 'TERMINATED'
      await applyApprovalOutcome({ processInstanceId: item.processInstanceId, outcome, detail: instance.raw as Prisma.InputJsonValue, source: 'poll' })
      processed += 1
      log.info(`[Approvals] ${item.processInstanceId} → ${outcome}`)
    } catch (error) {
      log.warn(`[Approvals] poll ${item.processInstanceId} failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  return processed
}

export async function refreshTaskApproval(input: { organizationId: string; approvalId: string }) {
  const approval = await prisma.taskApproval.findFirst({ where: { id: input.approvalId, task: { project: { organizationId: input.organizationId } } }, select: { processInstanceId: true, source: true, status: true } })
  if (!approval) throw new Error('approval_not_found')
  if (approval.status !== 'PENDING') return { status: approval.status }
  if (approval.source === 'PROJECT_OS') throw new Error('project_os_approval_requires_manager')
  await requireDingTalkIntegration(input.organizationId)
  if (!config.approval.enabled) throw new Error('dingtalk_approval_not_configured')
  const instance = await fetchDingTalkApprovalInstance(approval.processInstanceId)
  if (instance.status === 'RUNNING') {
    await syncTaskApprovalSubmission({ processInstanceId: approval.processInstanceId, detail: instance.raw as Prisma.InputJsonValue, source: 'manual-refresh' })
    return { status: 'PENDING' as const }
  }
  if (instance.status === 'UNKNOWN') return { status: 'PENDING' as const }
  const outcome: ApprovalOutcome = instance.status === 'COMPLETED' ? (instance.result === 'refuse' ? 'REJECTED' : 'APPROVED') : 'TERMINATED'
  await applyApprovalOutcome({ processInstanceId: approval.processInstanceId, outcome, detail: instance.raw as Prisma.InputJsonValue, source: 'manual-refresh' })
  return { status: outcome }
}
