import type { NotificationEventType as PrismaNotificationEventType, Prisma, TaskExecutionStatus as PrismaTaskExecutionStatus } from '@prisma/client'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { sendDingTalkOtoMarkdown } from '../dingtalk.js'
import { buildPublishedTaskNotices, findMiddleInsertedTaskIds, type PublishedTaskNode } from './taskPublished.js'
import { DEFAULT_NOTIFICATION_TEMPLATES, dateOnly, renderNotificationTemplate, type NotificationEvent, type TaskNotificationContext } from './taskEvents.js'
import { policyStepsFromSnapshot, pollPendingApprovals } from '../approvals.js'
import { createDeliverableViewLink } from '../deliverables/viewLink.js'
import { isRetryableDingTalkError } from './dingtalkRetry.js'
import { isSpecialReleaseForVersion } from '../taskRelease.js'
import { DINGTALK_INTEGRATION_DISABLED, isDingTalkIntegrationEnabled } from '../dingtalkPolicy.js'

type WorkerLog = Pick<Console, 'info' | 'warn' | 'error'>
type EventPayload = Record<string, unknown>
const OUTBOX_EVENT_TYPES = ['WORKFLOW_PUBLISHED', 'TASK_COMPLETED', 'TASK_ASSIGNEE_CHANGED', 'WORKFLOW_SCHEDULE_CHANGED', 'TASK_APPROVAL_SUBMITTED', 'TASK_DELIVERABLE_SUBMITTED']
const workflowNoticeEvents: PrismaNotificationEventType[] = ['TASK_PUBLISHED', 'TASK_READY', 'TASK_DUE_SOON', 'TASK_OVERDUE', 'TASK_ASSIGNEE_CHANGED', 'TASK_SCHEDULE_CHANGED']
const taskReminderEvents: PrismaNotificationEventType[] = ['TASK_DUE_SOON', 'TASK_OVERDUE']
const completedTaskStatuses: PrismaTaskExecutionStatus[] = ['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED']
const completedStatuses = new Set<string>(completedTaskStatuses)

function asRecord(value: Prisma.JsonValue): EventPayload { return value && typeof value === 'object' && !Array.isArray(value) ? value as EventPayload : {} }
function stringValue(value: unknown) { return typeof value === 'string' && value.trim() ? value : undefined }
function retryAt(attempt: number) { const delays = [60_000, 5 * 60_000, 30 * 60_000]; return new Date(Date.now() + (delays[Math.min(attempt - 1, delays.length - 1)] ?? delays.at(-1)!)) }

async function configuredTemplate(organizationId: string, eventType: NotificationEvent) {
  const custom = await prisma.notificationTemplate.findFirst({ where: { organizationId, eventType: eventType as PrismaNotificationEventType, channel: 'DINGTALK' } })
  if (custom && !custom.enabled) return null
  return custom ?? DEFAULT_NOTIFICATION_TEMPLATES[eventType]
}

type CreateNotificationInput = { organizationId: string; projectId: string; taskId: string; eventType: NotificationEvent; eventKey: string; dueDate?: Date | null; recipientMemberIds: string[]; context: TaskNotificationContext; title?: string; body?: string; sendDingTalk?: boolean }

async function createNotification(input: CreateNotificationInput) {
  const recipientMemberIds = [...new Set(input.recipientMemberIds.filter(Boolean))]
  if (recipientMemberIds.length === 0) return
  const template = await configuredTemplate(input.organizationId, input.eventType)
  if (!template) return
  const title = input.title ?? renderNotificationTemplate(template.titleTemplate, input.context)
  const body = input.body ?? renderNotificationTemplate(template.bodyTemplate, input.context)
  const notification = await prisma.notification.upsert({ where: { organizationId_eventKey: { organizationId: input.organizationId, eventKey: input.eventKey } }, update: { title, body, dueDate: input.dueDate ?? null }, create: { organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId, eventType: input.eventType as PrismaNotificationEventType, eventKey: input.eventKey, title, body, dueDate: input.dueDate ?? null }, select: { id: true } })
  await prisma.notificationRecipient.createMany({ data: recipientMemberIds.map((memberId) => ({ notificationId: notification.id, memberId })), skipDuplicates: true })
  if (input.sendDingTalk !== false && await isDingTalkIntegrationEnabled(input.organizationId)) await prisma.notificationDelivery.createMany({ data: recipientMemberIds.map((memberId) => ({ notificationId: notification.id, memberId, channel: 'DINGTALK' })), skipDuplicates: true })
}

async function materializeWorkflowPublishedNotifications(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new Error('outbox_event_not_found')
  const payload = asRecord(event.payload)
  const projectId = stringValue(payload.projectId)
  const versionId = stringValue(payload.versionId)
  if (!projectId || !versionId) throw new Error('workflow_published_payload_invalid')
  const version = await prisma.workflowVersion.findFirst({ where: { id: versionId, workflow: { project: { id: projectId, organizationId: event.organizationId } } }, select: { id: true, publishedBy: { select: { name: true } }, workflow: { select: { project: { select: { id: true, code: true, name: true } } } }, nodes: { orderBy: { wbs: 'asc' }, select: { id: true, taskId: true, nodeType: true, wbs: true, name: true, description: true, closureCriteria: true, ownerMember: { select: { id: true, name: true, manager: { select: { id: true, name: true } } } }, schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 }, task: { select: { execution: { select: { status: true } }, assignees: { where: { removedAt: null, member: { status: 'ACTIVE' } }, select: { member: { select: { id: true, name: true, manager: { select: { id: true, name: true } } } } } }, closureChecks: { orderBy: { sortOrder: 'asc' }, select: { label: true } } } } } }, edges: { select: { sourceNodeId: true, targetNodeId: true } } } })
  if (!version) throw new Error('published_workflow_not_found')
  const previousVersionId = stringValue(payload.previousVersionId)
  const previous = previousVersionId ? await prisma.workflowVersion.findFirst({ where: { id: previousVersionId, workflow: { project: { id: projectId, organizationId: event.organizationId } } }, select: { nodes: { where: { taskId: { not: null }, nodeType: { in: ['TASK', 'MILESTONE'] } }, select: { taskId: true } } } }) : null
  const project = version.workflow.project
  const nodes: PublishedTaskNode[] = version.nodes.map((node) => {
    const assigneeMembers = node.task?.assignees.map((item) => item.member) ?? []
    const responsibleMembers = assigneeMembers.length > 0 ? assigneeMembers : node.ownerMember ? [node.ownerMember] : []
    const managerMembers = new Map<string, { id: string; name: string }>()
    for (const member of responsibleMembers) if (member.manager) managerMembers.set(member.manager.id, member.manager)
    return { id: node.id, taskId: node.taskId, nodeType: node.nodeType, executionStatus: node.task?.execution?.status ?? null, wbs: node.wbs, name: node.name, description: node.description, closureCriteria: node.closureCriteria, ownerMember: node.ownerMember ? { id: node.ownerMember.id, name: node.ownerMember.name } : null, assignees: assigneeMembers.map((member) => ({ id: member.id, name: member.name })), managerMembers: [...managerMembers.values()], closureChecks: node.task?.closureChecks.map((item) => item.label) ?? [], plannedStart: node.schedules[0]?.plannedStart ?? null, plannedEnd: node.schedules[0]?.plannedEnd ?? null }
  })
  const previousTaskIds = new Set(previous?.nodes.flatMap((node) => node.taskId ? [node.taskId] : []) ?? [])
  const managerTaskIds = findMiddleInsertedTaskIds(nodes, version.edges, previousTaskIds)
  const notices = buildPublishedTaskNotices({ organizationId: event.organizationId, projectId: project.id, projectCode: project.code, projectName: project.name, versionId: version.id, publisherName: version.publishedBy?.name ?? '项目管理员', publisherLevel: payload.publisherLevel === 'L1' ? 'L1' : 'L2', nodes, edges: version.edges, managerTaskIds })
  for (const notice of notices) {
    const node = nodes.find((candidate) => candidate.taskId === notice.taskId)
    if (!node) continue
    await createNotification({ organizationId: event.organizationId, projectId: notice.projectId, taskId: notice.taskId, eventType: 'TASK_PUBLISHED', eventKey: notice.eventKey, dueDate: notice.dueDate, recipientMemberIds: notice.recipientMemberIds, context: { projectCode: project.code, projectName: project.name, taskWbs: node.wbs, taskName: node.name }, title: notice.title, body: notice.body })
  }
  await autoStartReadyTasks(version.id)
}

function addDays(value: Date, days: number) { const result = new Date(value); result.setUTCDate(result.getUTCDate() + days); return result }
function businessDate(value = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value) }
type ScheduledNode = { id: string; taskId: string | null; wbs: string; name: string; description: string | null; closureCriteria: string | null; ownerMember: { id: string; name: string } | null; schedules: { plannedStart: Date; plannedEnd: Date }[]; task: { execution: { status: string; progress: number; specialRelease?: unknown } | null; assignees: { member: { id: string; name: string } }[] } | null }
function recipients(node: ScheduledNode) { const ids = node.task?.assignees.map((item) => item.member.id) ?? []; return ids.length > 0 ? ids : node.ownerMember ? [node.ownerMember.id] : [] }
function contextFor(project: { code: string; name: string }, node: ScheduledNode, extra: Partial<TaskNotificationContext> = {}): TaskNotificationContext { return { projectCode: project.code, projectName: project.name, taskWbs: node.wbs, taskName: node.name, description: node.description, plannedStart: dateOnly(node.schedules[0]?.plannedStart), plannedEnd: dateOnly(node.schedules[0]?.plannedEnd), ...extra } }

async function publishedWorkflows() {
  return prisma.workflow.findMany({
    where: { publishedVersionId: { not: null } },
    select: {
      project: { select: { id: true, organizationId: true, code: true, name: true } },
      publishedVersion: {
        select: {
          id: true,
          nodes: {
            where: { taskId: { not: null }, nodeType: { in: ['TASK', 'MILESTONE'] } },
            select: {
              id: true, taskId: true, wbs: true, name: true, description: true, closureCriteria: true,
              ownerMember: { select: { id: true, name: true } },
              schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 },
              task: {
                select: {
                  execution: { select: { status: true, progress: true } },
                  assignees: { where: { removedAt: null, member: { status: 'ACTIVE' } }, select: { member: { select: { id: true, name: true } } } },
                },
              },
            },
          },
        },
      },
    },
  })
}

async function materializeScheduledNotifications() {
  const todayText = businessDate()
  const reminderEndText = dateOnly(addDays(new Date(`${todayText}T00:00:00.000Z`), 3)) ?? todayText
  const workflows = await publishedWorkflows()
  for (const workflow of workflows) {
    if (!workflow.publishedVersion) continue
    for (const raw of workflow.publishedVersion.nodes) {
      const node = raw as ScheduledNode
      if (!node.taskId || !node.schedules[0]) continue
      const start = dateOnly(node.schedules[0].plannedStart)
      if (start && start >= todayText && start <= reminderEndText && !completedStatuses.has(node.task?.execution?.status ?? '')) await createNotification({ organizationId: workflow.project.organizationId, projectId: workflow.project.id, taskId: node.taskId, eventType: 'TASK_DUE_SOON', eventKey: `task-due-soon:${node.taskId}:${start}`, dueDate: node.schedules[0].plannedStart, recipientMemberIds: recipients(node), context: contextFor(workflow.project, node) })
      if ((dateOnly(node.schedules[0].plannedEnd) ?? '') < todayText && !completedStatuses.has(node.task?.execution?.status ?? '')) await createNotification({ organizationId: workflow.project.organizationId, projectId: workflow.project.id, taskId: node.taskId, eventType: 'TASK_OVERDUE', eventKey: `task-overdue:${node.taskId}:${dateOnly(node.schedules[0].plannedEnd)}`, dueDate: node.schedules[0].plannedEnd, recipientMemberIds: recipients(node), context: contextFor(workflow.project, node) })
    }
  }
}

// 发布时自动开始：所有前置已满足（前置节点为 START 或已完成）且仍为未开始的任务，
// 直接置为进行中 —— 配合"无需手动点击开始任务"的产品行为（覆盖 START 直接后继等
// 没有 TASK_COMPLETED 事件可触发的场景）。
async function autoStartReadyTasks(versionId: string) {
  const nodes = await prisma.workflowNode.findMany({
    where: { workflowVersionId: versionId, nodeType: { in: ['TASK', 'MILESTONE'] } },
    include: {
      task: { select: { execution: { select: { status: true, specialRelease: true } } } },
      targetEdges: { select: { sourceNode: { select: { nodeType: true, task: { select: { execution: { select: { status: true } } } } } } } },
    },
  })
  const unlockedAt = new Date(`${dateOnly(new Date())}T00:00:00.000Z`)
  for (const node of nodes) {
    if (!node.taskId || node.task?.execution?.status !== 'NOT_STARTED') continue
    const ready = Boolean(isSpecialReleaseForVersion(node.task?.execution?.specialRelease, versionId)) || node.targetEdges.every((edge) => edge.sourceNode.nodeType === 'START' || !edge.sourceNode.task || completedStatuses.has(edge.sourceNode.task.execution?.status ?? ''))
    if (!ready) continue
    await prisma.taskExecution.updateMany({ where: { taskId: node.taskId, status: 'NOT_STARTED' }, data: { status: 'IN_PROGRESS', actualStart: unlockedAt, readyAt: unlockedAt } })
  }
}

async function materializeTaskCompleted(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } }); if (!event) throw new Error('outbox_event_not_found')
  const payload = asRecord(event.payload); const taskId = stringValue(payload.taskId); if (!taskId) throw new Error('task_completed_payload_invalid')
  const task = await prisma.task.findFirst({ where: { id: taskId, project: { organizationId: event.organizationId, archivedAt: null } }, select: { id: true, projectId: true, project: { select: { code: true, name: true, approvalAutoStart: true, workflow: { select: { publishedVersionId: true } } } } } })
  if (!task?.project.workflow?.publishedVersionId) return
  // 审批驱动的完成：默认自动启动下游任务；项目开关关闭时退化为只解锁并通知负责人。
  const approvalDriven = payload.viaApproval === true || Boolean(await prisma.taskApproval.findFirst({ where: { taskId, status: 'APPROVED', autoCompleteStatus: 'COMPLETED' }, select: { id: true } }))
  const source = await prisma.workflowNode.findFirst({ where: { taskId, workflowVersionId: task.project.workflow.publishedVersionId }, select: { id: true, workflowVersionId: true } }); if (!source) return
  // 已完成的节点本身（作为 TASK_READY 通知里的"上一个任务节点"）
  const completedNode = await prisma.workflowNode.findFirst({
    where: { id: source.id },
    select: { wbs: true, name: true, ownerMember: { select: { name: true } }, task: { select: { execution: { select: { actualEnd: true } } } } },
  })
  const successors = await prisma.workflowEdge.findMany({
    where: { workflowVersionId: source.workflowVersionId, sourceNodeId: source.id },
    select: {
      targetNode: {
        select: {
          id: true, taskId: true, wbs: true, name: true, description: true, closureCriteria: true,
          ownerMember: { select: { id: true, name: true } },
          schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 },
          task: {
            select: {
              execution: { select: { status: true, progress: true, specialRelease: true } },
              assignees: { where: { removedAt: null, member: { status: 'ACTIVE' } }, select: { member: { select: { id: true, name: true } } } },
            },
          },
        },
      },
    },
  })
  for (const edge of successors) {
    const node = edge.targetNode as ScheduledNode
    if (!node.taskId || completedStatuses.has(node.task?.execution?.status ?? '')) continue
    const predecessors = await prisma.workflowEdge.findMany({ where: { workflowVersionId: source.workflowVersionId, targetNodeId: node.id }, select: { sourceNode: { select: { nodeType: true, task: { select: { execution: { select: { status: true } } } } } } } })
    const ready = Boolean(isSpecialReleaseForVersion(node.task?.execution?.specialRelease, source.workflowVersionId)) || predecessors.every((candidate) => candidate.sourceNode.nodeType === 'START' || completedStatuses.has(candidate.sourceNode.task?.execution?.status ?? ''))
    if (!ready) continue
    // 前置任务全部完成 → 后置任务自动开始：置为进行中，actualStart/readyAt = 解锁日。
    // 仅在当前仍是 NOT_STARTED 时推进（幂等，且不覆盖已开始/已完成/受阻重放的事件）。
    // 审批驱动的完成默认直接进入进行中；关闭项目开关时仅记录 readyAt。
    if (node.task?.execution?.status === 'NOT_STARTED') {
      const unlockedAt = new Date(`${dateOnly(new Date())}T00:00:00.000Z`)
      if (approvalDriven && !task.project.approvalAutoStart) {
        await prisma.taskExecution.updateMany({ where: { taskId: node.taskId, status: 'NOT_STARTED' }, data: { readyAt: unlockedAt } })
      } else {
        await prisma.taskExecution.updateMany({ where: { taskId: node.taskId, status: 'NOT_STARTED' }, data: { status: 'IN_PROGRESS', actualStart: unlockedAt, readyAt: unlockedAt } })
      }
    }
    // 通知里带上交付标准与上下游节点：上一个=刚完成的任务，下一个=本节点的后继。
    const nextNodes = await prisma.workflowEdge.findMany({
      where: { workflowVersionId: source.workflowVersionId, sourceNodeId: edge.targetNode.id },
      select: { targetNode: { select: { nodeType: true, wbs: true, name: true, ownerMember: { select: { name: true } } } } },
    })
    const nextTasks = nextNodes
      .filter((item) => item.targetNode.nodeType !== 'START')
      .map((item) => item.targetNode.nodeType === 'END' ? '项目结束' : `${item.targetNode.wbs} ${item.targetNode.name}｜负责人：${item.targetNode.ownerMember?.name ?? '待分配'}`)
      .join('；') || '无（项目结束）'
    await createNotification({ organizationId: event.organizationId, projectId: task.projectId, taskId: node.taskId, eventType: 'TASK_READY', eventKey: `task-ready:${taskId}:${node.taskId}:${stringValue(payload.completedAt) ?? dateOnly(new Date())}`, recipientMemberIds: recipients(node), context: contextFor(task.project, node, {
      closureCriteria: node.closureCriteria,
      previousTaskName: completedNode ? `${completedNode.wbs} ${completedNode.name}` : undefined,
      previousTaskOwner: completedNode?.ownerMember?.name ?? undefined,
      previousTaskEnd: dateOnly(completedNode?.task?.execution?.actualEnd ?? new Date(`${stringValue(payload.completedAt) ?? dateOnly(new Date())}T00:00:00.000Z`)),
      nextTasks,
    }) })
  }
}

async function materializeAssigneeChanged(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } }); if (!event) throw new Error('outbox_event_not_found')
  const payload = asRecord(event.payload); const taskId = stringValue(payload.taskId); const memberId = stringValue(payload.memberId)
  if (!taskId || !memberId) return
  const task = await prisma.task.findFirst({ where: { id: taskId, project: { organizationId: event.organizationId, archivedAt: null } }, select: { id: true, projectId: true, project: { select: { code: true, name: true, workflow: { select: { publishedVersionId: true } } } } } })
  if (!task?.project.workflow?.publishedVersionId) return
  const rawNode = await prisma.workflowNode.findFirst({ where: { taskId, workflowVersionId: task.project.workflow.publishedVersionId }, select: { id: true, taskId: true, wbs: true, name: true, description: true, closureCriteria: true, schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 }, ownerMember: { select: { id: true, name: true } }, task: { select: { execution: { select: { status: true, progress: true } }, assignees: { where: { removedAt: null }, select: { member: { select: { id: true, name: true } } } } } } } })
  const node = rawNode as ScheduledNode | null; if (!node) return
  const removed = payload.action === 'remove'
  await createNotification({ organizationId: event.organizationId, projectId: task.projectId, taskId, eventType: 'TASK_ASSIGNEE_CHANGED', eventKey: `task-assignee:${taskId}:${memberId}:${stringValue(payload.assignmentId) ?? event.id}:${removed ? 'removed' : 'added'}`, recipientMemberIds: [memberId], context: contextFor(task.project, node, { actorName: stringValue(payload.actorName) }), ...(removed ? { title: `任务负责人已变更：${node.wbs} ${node.name}`, body: `项目：${task.project.code} · ${task.project.name}\n任务：${node.wbs} ${node.name}\n你已不再是该任务负责人。如有疑问，请联系项目经理。` } : {}) })
}

async function materializeApprovalSubmitted(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new Error('outbox_event_not_found')
  const payload = asRecord(event.payload)
  const taskId = stringValue(payload.taskId)
  const approvalId = stringValue(payload.approvalId)
  if (!taskId || !approvalId) throw new Error('task_approval_submitted_payload_invalid')
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { organizationId: event.organizationId, archivedAt: null } },
    select: {
      id: true,
      projectId: true,
      project: { select: { code: true, name: true } },
      nodes: { where: { workflowVersion: { status: 'PUBLISHED' } }, take: 1, select: { wbs: true, name: true, ownerMember: { select: { manager: { select: { id: true, status: true } } } } } },
      assignees: { where: { removedAt: null, member: { status: 'ACTIVE' } }, select: { member: { select: { id: true, manager: { select: { id: true, status: true } } } } } },
    },
  })
  if (!task) return

  const [approval, projectGrants, projectMembers, administrators] = await Promise.all([
    prisma.taskApproval.findUnique({ where: { id: approvalId }, select: { currentStepNo: true, policySnapshot: true } }),
    prisma.projectRoleGrant.findMany({ where: { projectId: task.projectId, roleCode: 'L2', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    prisma.projectMember.findMany({ where: { projectId: task.projectId, membershipRole: 'project_l2', member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    prisma.member.findMany({ where: { organizationId: event.organizationId, status: 'ACTIVE', memberRoles: { some: { role: { code: 'L1' } } } }, select: { id: true } }),
  ])
  const l2MemberIds = [...projectGrants, ...projectMembers].map((item) => item.memberId)
  const approvalStage = stringValue(payload.stage) === 'ADMIN' ? 'ADMIN' : 'L2'
  const payloadStepNo = typeof payload.stepNo === 'number' ? Math.floor(payload.stepNo) : Number(stringValue(payload.stepNo))
  const stepNo = Number.isFinite(payloadStepNo) && payloadStepNo > 0 ? payloadStepNo : approval?.currentStepNo ?? 1
  const configuredStep = policyStepsFromSnapshot(approval?.policySnapshot).find((step) => step.stepNo === stepNo)
  const approvalRecipientIds = configuredStep?.approverMemberIds.length
    ? configuredStep.approverMemberIds
    : approvalStage === 'ADMIN' ? administrators.map((item) => item.id) : l2MemberIds.length > 0 ? l2MemberIds : administrators.map((item) => item.id)
  const managerIds = [
    ...task.assignees.flatMap((item) => item.member.manager?.status === 'ACTIVE' ? [item.member.manager.id] : []),
    ...task.nodes.flatMap((item) => item.ownerMember?.manager?.status === 'ACTIVE' ? [item.ownerMember.manager.id] : []),
  ]
  const submitterMemberId = stringValue(payload.submitterMemberId)
  const approvalRecipientSet = new Set(approvalRecipientIds)
  const approverRecipientIds = [...new Set(approvalRecipientIds)].filter((memberId) => memberId !== submitterMemberId)
  const supervisorRecipientIds = [...new Set([...managerIds, ...(configuredStep?.ccMemberIds ?? [])])].filter((memberId) => memberId !== submitterMemberId && !approvalRecipientSet.has(memberId))
  const node = task.nodes[0]
  if (!node || (approverRecipientIds.length === 0 && supervisorRecipientIds.length === 0)) return
  const specialRelease = stringValue(payload.purpose) === 'BYPASS'
  const projectOsApproval = stringValue(payload.source) === 'PROJECT_OS'
  const specialReleaseReason = stringValue(payload.reason)
  const progressValue = typeof payload.progress === 'number' ? payload.progress : Number(stringValue(payload.progress))
  const context = { projectCode: task.project.code, projectName: task.project.name, taskWbs: node.wbs, taskName: node.name, submitterName: stringValue(payload.submitterName), deliveryType: specialRelease ? '特殊放行' : stringValue(payload.deliveryType) === 'STAGE' ? '阶段交付' : '最终交付', progress: Number.isFinite(progressValue) ? `${Math.round(progressValue)}%` : undefined }
  if (approverRecipientIds.length > 0) await createNotification({
    organizationId: event.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    eventType: 'TASK_APPROVAL_SUBMITTED',
    eventKey: `task-approval-submitted:${approvalId}:approvers`,
    recipientMemberIds: approverRecipientIds,
    context,
    ...(projectOsApproval ? {
      title: `待处理 OA 审批：${node.wbs} ${node.name}`,
      body: `项目：${task.project.code} · ${task.project.name}\n任务：${node.wbs} ${node.name}\n提交人：${stringValue(payload.submitterName) ?? '任务负责人'}\n交付类型：${stringValue(payload.deliveryType) === 'STAGE' ? '阶段交付' : '最终交付'}\n请在 Project OS 的“管理 → OA审批”处理。`
    } : specialRelease ? {
      title: `待审批特殊放行：${node.wbs} ${node.name}`,
      body: `项目：${task.project.code} · ${task.project.name}\n任务：${node.wbs} ${node.name}\n提交人：${stringValue(payload.submitterName) ?? '任务负责人'}\n放行原因：${specialReleaseReason ?? '未填写'}\n请按项目审批策略处理；审批通过后任务将开始，前置任务仍需补做。`,
    } : {}),
    // 钉钉 OA 会直接通知审批人；这里仅保留 Project OS 站内记录，避免重复主动消息。
    sendDingTalk: false,
  })
  if (supervisorRecipientIds.length > 0) await createNotification({
    organizationId: event.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    eventType: 'TASK_APPROVAL_VIEWED',
    eventKey: `task-approval-submitted:${approvalId}:supervisors`,
    recipientMemberIds: supervisorRecipientIds,
    context,
    ...(projectOsApproval ? {
      title: `OA 审批已提交：${node.wbs} ${node.name}`,
      body: `项目：${task.project.code} · ${task.project.name}\n任务：${node.wbs} ${node.name}\n提交人：${stringValue(payload.submitterName) ?? '任务负责人'}\n本通知仅供查看，审批由 L1/L2 在 Project OS 的“管理 → OA审批”处理。`,
    } : specialRelease ? {
      title: `特殊放行申请已提交：${node.wbs} ${node.name}`,
      body: `项目：${task.project.code} · ${task.project.name}\n任务：${node.wbs} ${node.name}\n提交人：${stringValue(payload.submitterName) ?? '任务负责人'}\n放行原因：${specialReleaseReason ?? '未填写'}\n本通知仅供查看，审批由 L2/管理员处理；你没有审批权限。`,
    } : {}),
  })
}

/**
 * 普通交付物提交通知（文档 §6）：每次交付物保存后通知 项目 L2 / 管理员 /
 * 提交人的直属主管；主管文案明确"仅供查看，审批由 L2/管理员处理"。
 * 查看链接按收件人单独签名（短期令牌），不生成永久公开地址。
 */
async function materializeDeliverableSubmitted(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new Error('outbox_event_not_found')
  const payload = asRecord(event.payload)
  const taskId = stringValue(payload.taskId)
  const deliverableId = stringValue(payload.deliverableId)
  if (!taskId || !deliverableId) throw new Error('task_deliverable_submitted_payload_invalid')
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { organizationId: event.organizationId, archivedAt: null } },
    select: {
      id: true,
      projectId: true,
      project: { select: { code: true, name: true } },
      nodes: { take: 1, select: { wbs: true, name: true } },
      execution: { select: { progress: true } },
    },
  })
  if (!task || !task.nodes[0]) return
  const node = task.nodes[0]

  const [projectGrants, projectMembers, administrators, submitter] = await Promise.all([
    prisma.projectRoleGrant.findMany({ where: { projectId: task.projectId, roleCode: 'L2', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    prisma.projectMember.findMany({ where: { projectId: task.projectId, membershipRole: 'project_l2', member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    prisma.member.findMany({ where: { organizationId: event.organizationId, status: 'ACTIVE', memberRoles: { some: { role: { code: 'L1' } } } }, select: { id: true } }),
    prisma.member.findUnique({ where: { id: stringValue(payload.submitterMemberId) ?? '' }, select: { id: true, name: true, manager: { select: { id: true, status: true } } } }),
  ])
  const submitterMemberId = stringValue(payload.submitterMemberId)
  const approverIds = [...new Set([...projectGrants, ...projectMembers].map((item) => item.memberId))]
  const approverRecipientIds = (approverIds.length > 0 ? approverIds : administrators.map((item) => item.id)).filter((id) => id !== submitterMemberId)
  const supervisorIds = new Set<string>()
  if (submitter?.manager?.status === 'ACTIVE') supervisorIds.add(submitter.manager.id)
  supervisorIds.delete(submitterMemberId ?? '')
  approverRecipientIds.forEach((id) => supervisorIds.delete(id))

  const baseContext = {
    projectCode: task.project.code,
    projectName: task.project.name,
    taskWbs: node.wbs,
    taskName: node.name,
    submitterName: stringValue(payload.submitterName) ?? submitter?.name,
    deliverableName: stringValue(payload.deliverableName),
    progress: task.execution?.progress !== undefined && task.execution?.progress !== null ? `${Math.round(task.execution.progress)}%` : undefined,
  }

  // 链接按收件人签名 → 每人一条通知（收件人数量小：L2/管理员 + 1 名主管）。
  for (const memberId of approverRecipientIds) {
    await createNotification({
      organizationId: event.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      eventType: 'TASK_DELIVERABLE_SUBMITTED',
      eventKey: `task-deliverable-submitted:${deliverableId}:approver:${memberId}`,
      recipientMemberIds: [memberId],
      context: { ...baseContext, deliverableLink: createDeliverableViewLink(deliverableId, memberId) },
    })
  }
  for (const memberId of supervisorIds) {
    await createNotification({
      organizationId: event.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      eventType: 'TASK_DELIVERABLE_SUBMITTED',
      eventKey: `task-deliverable-submitted:${deliverableId}:supervisor:${memberId}`,
      recipientMemberIds: [memberId],
      context: { ...baseContext, deliverableLink: createDeliverableViewLink(deliverableId, memberId) },
      body: `${renderNotificationTemplate(DEFAULT_NOTIFICATION_TEMPLATES.TASK_DELIVERABLE_SUBMITTED.bodyTemplate, { ...baseContext, deliverableLink: createDeliverableViewLink(deliverableId, memberId) })}\n本通知仅供查看，审批由 L2/管理员处理。`,
    })
  }
}

async function materializeScheduleChanged(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } }); if (!event) throw new Error('outbox_event_not_found')
  const payload = asRecord(event.payload); const versionId = stringValue(payload.versionId); const previousVersionId = stringValue(payload.previousVersionId); if (!versionId || !previousVersionId) return
  const [current, previous] = await Promise.all([
    prisma.workflowVersion.findUnique({ where: { id: versionId }, select: { nodes: { where: { taskId: { not: null }, nodeType: { in: ['TASK', 'MILESTONE'] } }, select: { taskId: true, wbs: true, name: true, description: true, ownerMember: { select: { id: true, name: true } }, schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 }, task: { select: { assignees: { where: { removedAt: null }, select: { member: { select: { id: true, name: true } } } } } } } }, workflow: { select: { project: { select: { id: true, organizationId: true, code: true, name: true } } } } } }),
    prisma.workflowVersion.findUnique({ where: { id: previousVersionId }, select: { nodes: { where: { taskId: { not: null }, nodeType: { in: ['TASK', 'MILESTONE'] } }, select: { taskId: true, schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 } } } } }),
  ])
  if (!current?.workflow.project || !previous) return
  const previousByTask = new Map(previous.nodes.map((node) => [node.taskId, node]))
  for (const node of current.nodes) {
    const old = previousByTask.get(node.taskId); const oldStart = dateOnly(old?.schedules[0]?.plannedStart); const oldEnd = dateOnly(old?.schedules[0]?.plannedEnd); const newStart = dateOnly(node.schedules[0]?.plannedStart); const newEnd = dateOnly(node.schedules[0]?.plannedEnd)
    if (!old || (oldStart === newStart && oldEnd === newEnd) || !node.taskId) continue
    await createNotification({ organizationId: current.workflow.project.organizationId, projectId: current.workflow.project.id, taskId: node.taskId, eventType: 'TASK_SCHEDULE_CHANGED', eventKey: `task-schedule:${versionId}:${node.taskId}`, recipientMemberIds: node.task?.assignees.map((item) => item.member.id) ?? (node.ownerMember ? [node.ownerMember.id] : []), context: { projectCode: current.workflow.project.code, projectName: current.workflow.project.name, taskWbs: node.wbs, taskName: node.name, description: node.description, plannedStart: newStart, plannedEnd: newEnd, previousPlannedStart: oldStart, previousPlannedEnd: oldEnd } })
  }
}

async function processOutboxBatch(log: WorkerLog) {
  const now = new Date(); const events = await prisma.outboxEvent.findMany({ where: { eventType: { in: OUTBOX_EVENT_TYPES }, OR: [{ status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, { status: 'FAILED', attemptCount: { lt: config.notifications.maxAttempts }, nextAttemptAt: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: 20 })
  for (const event of events) {
    const claimed = await prisma.outboxEvent.updateMany({ where: { id: event.id, status: event.status }, data: { status: 'PROCESSING', attemptCount: { increment: 1 }, nextAttemptAt: null } }); if (claimed.count === 0) continue
    const attempt = event.attemptCount + 1
    try {
      if (event.eventType === 'WORKFLOW_PUBLISHED') await materializeWorkflowPublishedNotifications(event.id)
      else if (event.eventType === 'TASK_COMPLETED') await materializeTaskCompleted(event.id)
      else if (event.eventType === 'TASK_ASSIGNEE_CHANGED') await materializeAssigneeChanged(event.id)
      else if (event.eventType === 'WORKFLOW_SCHEDULE_CHANGED') await materializeScheduleChanged(event.id)
      else if (event.eventType === 'TASK_APPROVAL_SUBMITTED') await materializeApprovalSubmitted(event.id)
      else if (event.eventType === 'TASK_DELIVERABLE_SUBMITTED') await materializeDeliverableSubmitted(event.id)
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'PROCESSED', processedAt: new Date(), lastError: null } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'notification_materialize_failed'; await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED', lastError: message.slice(0, 500), nextAttemptAt: attempt < config.notifications.maxAttempts ? retryAt(attempt) : null } }); log.warn(`[Notifications] outbox ${event.id} failed: ${message}`)
    }
  }
}

type DeliveryForBatch = {
  id: string
  notificationId: string
  memberId: string
  attemptCount: number
  notification: { organizationId: string; title: string; body: string; eventType: string; projectId: string | null; eventKey: string }
}

type BatchRecipient = { delivery: DeliveryForBatch; userId: string; attempt: number }

function publishedDigestKey(delivery: DeliveryForBatch) {
  if (delivery.notification.eventType !== 'TASK_PUBLISHED' || !delivery.notification.projectId) return null
  const versionId = /^task-published:([^:]+):/u.exec(delivery.notification.eventKey)?.[1]
  return versionId ? `published:${delivery.memberId}:${delivery.notification.projectId}:${versionId}` : null
}

function splitPublishedDigest(recipients: BatchRecipient[]) {
  const header = `### 项目发布了 ${recipients.length} 个新任务`
  const chunks: BatchRecipient[][] = []
  let current: BatchRecipient[] = []
  let currentLength = header.length
  for (const recipient of recipients) {
    const sectionLength = recipient.delivery.notification.body.length + 8
    if (current.length > 0 && currentLength + sectionLength > 3800) {
      chunks.push(current)
      current = []
      currentLength = header.length
    }
    current.push(recipient)
    currentLength += sectionLength
  }
  if (current.length > 0) chunks.push(current)
  return chunks.map((chunk, index) => ({
    title: chunks.length > 1 ? `项目任务发布提醒（${index + 1}/${chunks.length}）` : `项目任务发布提醒（${chunk.length}项）`,
    body: [header, ...chunk.map((recipient) => recipient.delivery.notification.body)].join('\n\n---\n\n'),
    recipients: chunk,
  }))
}

async function processDeliveryBatch(log: WorkerLog) {
  const now = new Date()
  const deliveries = await prisma.notificationDelivery.findMany({ where: { channel: 'DINGTALK', notification: { AND: [{ OR: [{ eventType: { notIn: workflowNoticeEvents } }, { eventType: { in: workflowNoticeEvents }, task: { archivedAt: null } }] }, { OR: [{ eventType: { notIn: taskReminderEvents } }, { eventType: { in: taskReminderEvents }, task: { execution: { status: { notIn: completedTaskStatuses } } } }] }] }, OR: [{ status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, { status: 'FAILED', attemptCount: { lt: config.notifications.maxAttempts }, nextAttemptAt: { lte: now } }] }, select: { id: true, notificationId: true, memberId: true, attemptCount: true, notification: { select: { organizationId: true, title: true, body: true, eventType: true, projectId: true, eventKey: true } } }, orderBy: { id: 'asc' }, take: 100 })
  const groups = new Map<string, DeliveryForBatch[]>()
  for (const delivery of deliveries) {
    const key = publishedDigestKey(delivery) ?? `notification:${delivery.notificationId}`
    const group = groups.get(key) ?? []
    group.push(delivery)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    const organizationId = group[0]?.notification.organizationId
    if (!organizationId || !(await isDingTalkIntegrationEnabled(organizationId))) {
      await prisma.notificationDelivery.updateMany({ where: { id: { in: group.map((delivery) => delivery.id) }, channel: 'DINGTALK', status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'FAILED', nextAttemptAt: null, lastError: DINGTALK_INTEGRATION_DISABLED } })
      continue
    }
    const recipients: BatchRecipient[] = []
    for (const delivery of group) {
      const identity = await prisma.externalIdentity.findFirst({ where: { memberId: delivery.memberId, provider: 'DINGTALK', corpId: config.dingtalk.corpId, userId: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { userId: true } })
      const userId = identity?.userId?.trim()
      if (!userId) {
        await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', nextAttemptAt: addDays(new Date(), 1), lastError: 'dingtalk_identity_missing' } })
        continue
      }
      recipients.push({ delivery, userId, attempt: delivery.attemptCount + 1 })
    }
    if (recipients.length === 0) continue

    const digest = publishedDigestKey(group[0]) !== null && group.length > 1
    const messages = digest
      ? splitPublishedDigest(recipients)
      : [{ title: group[0].notification.title, body: group[0].notification.body, recipients }]
    for (const messageContent of messages) {
      const userIds = [...new Set(messageContent.recipients.map((recipient) => recipient.userId))]
      try {
        const result = await sendDingTalkOtoMarkdown(userIds, messageContent.title, messageContent.body, organizationId)
        const invalidStaffIds = new Set(result.invalidStaffIds)
        const flowControlledStaffIds = new Set(result.flowControlledStaffIds)
        for (const recipient of messageContent.recipients) {
          const message = invalidStaffIds.has(recipient.userId)
            ? 'dingtalk_recipient_invalid'
            : flowControlledStaffIds.has(recipient.userId)
              ? 'dingtalk_recipient_rate_limited'
              : null
          if (message) {
            const retryable = message === 'dingtalk_recipient_rate_limited'
            await prisma.notificationDelivery.update({ where: { id: recipient.delivery.id }, data: { status: 'FAILED', attemptCount: recipient.attempt, nextAttemptAt: retryable && recipient.attempt < config.notifications.maxAttempts ? retryAt(recipient.attempt) : null, lastError: message } })
            log.warn(`[Notifications] delivery ${recipient.delivery.id} failed: ${message}`)
          } else {
            await prisma.notificationDelivery.update({ where: { id: recipient.delivery.id }, data: { status: 'SENT', attemptCount: recipient.attempt, sentAt: new Date(), providerMessageId: result.processQueryKey, nextAttemptAt: null, lastError: null } })
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'dingtalk_notification_failed'
        const retryable = isRetryableDingTalkError(error)
        for (const recipient of messageContent.recipients) {
          await prisma.notificationDelivery.update({ where: { id: recipient.delivery.id }, data: { status: 'FAILED', attemptCount: recipient.attempt, nextAttemptAt: retryable && recipient.attempt < config.notifications.maxAttempts ? retryAt(recipient.attempt) : null, lastError: message.slice(0, 500) } })
          log.warn(`[Notifications] delivery ${recipient.delivery.id} failed: ${message}`)
        }
      }
    }
  }
}

export async function processNotificationQueue(log: WorkerLog = console) { await processOutboxBatch(log); await materializeScheduledNotifications(); await processDeliveryBatch(log); await pollPendingApprovals(log).catch((error) => log.warn(`[Approvals] poll failed: ${error instanceof Error ? error.message : error}`)) }

export function startNotificationWorker(log: WorkerLog = console) {
  if (!config.notifications.enabled) return { stop: () => undefined }
  let running = false
  const run = async () => { if (running) return; running = true; try { await processNotificationQueue(log) } catch (error) { log.error(`[Notifications] worker failed: ${error instanceof Error ? error.message : error}`) } finally { running = false } }
  void run(); const timer = setInterval(() => { void run() }, Math.max(1000, config.notifications.pollIntervalMs)); timer.unref(); return { stop: () => clearInterval(timer) }
}
