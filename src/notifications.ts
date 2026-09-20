import type { NotificationSettings, Project, ProjectNotification, ProjectNotificationType, Workflow, WorkflowNode } from './types'
import { isCompletionApproved, scheduleWorkflow } from './workflow/schedule.ts'

export const defaultNotificationSettings: NotificationSettings = { reminderDays: 3 }

const completionStatuses = new Set<WorkflowNode['status']>(['已完成', '提前结束', '如期结束', '超期结束'])

export function createWorkflowNotifications(project: Project, before: Workflow | undefined, after: Workflow, now = new Date()): ProjectNotification[] {
  const notifications: ProjectNotification[] = []
  const createdAt = after.publishedAt ?? now.toISOString()
  const wasPublished = before?.status === 'published'
  const isPublished = after.status === 'published'

  if (!wasPublished && isPublished) {
    const previouslyPublishedIds = new Set(before?.baseline?.nodes.map((node) => node.id) ?? [])
    const publishableNodes = after.nodes.filter((node) => (node.type === 'task' || node.type === 'milestone') && (!before?.baseline || !previouslyPublishedIds.has(node.id)))
    notifications.push(...publishableNodes.map((node) => notification({
      id: `published:${project.id}:${after.version ?? after.publishedAt ?? createdAt}:${node.id}`,
      project,
      task: node,
      type: 'task-published',
      title: '新任务已发布',
      body: `“${node.name}”已发布，负责人：${node.owner || '待分配'}。`,
      createdAt,
      dueDate: after.nodes.find((candidate) => candidate.id === node.id)?.plannedEnd,
    })))
  }

  if (wasPublished && isPublished) {
    for (const node of after.nodes.filter((candidate) => candidate.type === 'task' || candidate.type === 'milestone')) {
      const previousNode = before?.nodes.find((candidate) => candidate.id === node.id)
      if (!previousNode) continue
      if (isComplete(node) || isReady(before, node.id) || !isReady(after, node.id)) continue
      notifications.push(notification({
        id: `ready:${project.id}:${after.version ?? after.publishedAt ?? createdAt}:${node.id}:${node.actualStart ?? node.plannedStart ?? 'ready'}`,
        project,
        task: node,
        type: 'task-ready',
        title: '任务已解锁',
        body: `“${node.name}”的全部前置任务已完成，可以开始执行。`,
        createdAt: now.toISOString(),
        dueDate: node.plannedEnd,
      }))
    }
  }

  return notifications
}

export function buildDueNotifications(project: Project, workflow: Workflow | undefined, settings: NotificationSettings, now = new Date()): ProjectNotification[] {
  if (!workflow || workflow.status !== 'published') return []
  const schedule = scheduleWorkflow(workflow)
  const today = formatDate(now)
  const notifications: ProjectNotification[] = []
  const versionKey = workflow.version ?? workflow.publishedAt ?? 'published'

  for (const node of workflow.nodes.filter((candidate) => candidate.type === 'task' || candidate.type === 'milestone')) {
    if (isComplete(node)) continue
    const plannedStart = schedule.schedules[node.id]?.plannedStart ?? node.plannedStart
    if (plannedStart) {
      const daysUntilStart = dateDistance(today, plannedStart)
      if (daysUntilStart >= 0 && daysUntilStart <= settings.reminderDays) {
        const startText = daysUntilStart === 0 ? '今天开始' : `还有 ${daysUntilStart} 天开始`
        notifications.push(notification({
          id: `start-soon:${project.id}:${versionKey}:${node.id}:${plannedStart}`,
          project,
          task: node,
          type: 'task-due-soon',
          title: '任务即将开始',
          body: `“${node.name}”计划于 ${plannedStart} 开始，${startText}。`,
          createdAt: now.toISOString(),
          dueDate: plannedStart,
        }))
      }
    }
    const plannedEnd = schedule.schedules[node.id]?.plannedEnd ?? node.plannedEnd
    if (!plannedEnd) continue
    const daysUntilDue = dateDistance(today, plannedEnd)
    if (daysUntilDue < 0) {
      notifications.push(notification({
        id: `overdue:${project.id}:${versionKey}:${node.id}:${plannedEnd}`,
        project,
        task: node,
        type: 'task-overdue',
        title: '任务已超期',
        body: `“${node.name}”已超过计划完成日 ${plannedEnd}，请尽快提交钉钉审批或补充超期原因。`,
        createdAt: now.toISOString(),
        dueDate: plannedEnd,
      }))
    } else if (daysUntilDue <= settings.reminderDays) {
      const dueText = daysUntilDue === 0 ? '今天' : `还有 ${daysUntilDue} 天`
      notifications.push(notification({
        id: `due-soon:${project.id}:${versionKey}:${node.id}:${plannedEnd}`,
        project,
        task: node,
        type: 'task-due-soon',
        title: '任务即将到期',
        body: `“${node.name}”计划于 ${plannedEnd} 完成，${dueText}。`,
        createdAt: now.toISOString(),
        dueDate: plannedEnd,
      }))
    }
  }

  return notifications
}

export function mergeNotifications(existing: ProjectNotification[], incoming: ProjectNotification[], workflows: Record<string, Workflow>): ProjectNotification[] {
  let changed = false
  const withoutLegacyReviews = existing.filter((item) => item.type !== 'task-completion-review')
  if (withoutLegacyReviews.length !== existing.length) changed = true
  const completed = new Set<string>()
  for (const workflow of Object.values(workflows)) {
    for (const node of workflow.nodes) {
      if (isComplete(node)) completed.add(`${workflow.projectId}:${node.id}`)
    }
  }

  const updated = withoutLegacyReviews.map((item) => {
    if ((item.type === 'task-due-soon' || item.type === 'task-overdue') && item.taskId && completed.has(`${item.projectId}:${item.taskId}`) && !item.read) {
      changed = true
      return { ...item, read: true }
    }
    return item
  })
  const known = new Set(updated.map((item) => item.id))
  const additions = incoming.filter((item) => {
    if (known.has(item.id)) return false
    known.add(item.id)
    return true
  })
  if (additions.length > 0) changed = true
  return changed ? [...additions, ...updated].slice(0, 120) : existing
}

function notification(input: {
  id: string
  project: Project
  task?: WorkflowNode
  type: ProjectNotificationType
  title: string
  body: string
  createdAt: string
  dueDate?: string
}): ProjectNotification {
  return {
    id: input.id,
    projectId: input.project.id,
    projectCode: input.project.code,
    projectName: input.project.name,
    taskId: input.task?.id,
    taskName: input.task?.name,
    type: input.type,
    title: input.title,
    body: input.body,
    createdAt: input.createdAt,
    read: false,
    dueDate: input.dueDate,
  }
}

function isComplete(node: WorkflowNode) {
  return completionStatuses.has(node.status)
}

function isReady(workflow: Workflow | undefined, nodeId: string) {
  if (!workflow) return false
  const predecessors = workflow.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => workflow.nodes.find((node) => node.id === edge.source))
    .filter((node): node is WorkflowNode => Boolean(node && node.type !== 'start' && node.type !== 'end'))
  return predecessors.length === 0 || predecessors.every(isCompletionApproved)
}

function toUtcDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function dateDistance(from: string, to: string) {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / (24 * 60 * 60 * 1000))
}
