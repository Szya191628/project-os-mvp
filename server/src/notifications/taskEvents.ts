export type NotificationEvent =
  | 'TASK_PUBLISHED'
  | 'TASK_DUE_SOON'
  | 'TASK_READY'
  | 'TASK_OVERDUE'
  | 'TASK_ASSIGNEE_CHANGED'
  | 'TASK_SCHEDULE_CHANGED'
  | 'TASK_APPROVAL_SUBMITTED'
  | 'TASK_APPROVAL_VIEWED'
  | 'TASK_DELIVERABLE_SUBMITTED'

export type TaskNotificationContext = {
  projectCode: string
  projectName: string
  taskWbs: string
  taskName: string
  description?: string | null
  closureCriteria?: string | null
  plannedStart?: string | null
  plannedEnd?: string | null
  previousPlannedStart?: string | null
  previousPlannedEnd?: string | null
  assigneeName?: string | null
  actorName?: string | null
  previousTaskName?: string | null
  previousTaskOwner?: string | null
  previousTaskEnd?: string | null
  submitterName?: string | null
  deliveryType?: string | null
  /** 提交交付物时的附件名与安全查看链接（按收件人签名） */
  deliverableName?: string | null
  deliverableLink?: string | null
  progress?: string | null
  /** 下游任务节点摘要（已拼好的人类可读多行文本） */
  nextTasks?: string | null
}

export const DEFAULT_NOTIFICATION_TEMPLATES: Record<NotificationEvent, { titleTemplate: string; bodyTemplate: string }> = {
  TASK_PUBLISHED: {
    titleTemplate: '{{actorName}} 发布了新任务：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n你的任务：{{taskWbs}} {{taskName}}\n请回复“确认收到”确认，或回复“进度 80%”同步进度。',
  },
  TASK_DUE_SOON: {
    titleTemplate: '任务即将开始提醒：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n你的任务：{{taskWbs}} {{taskName}}\n计划开始：{{plannedStart}}\n计划完成：{{plannedEnd}}\n任务将在开始前 3 天提醒；若不足 3 天，将在系统启动时立即提醒。请提前准备，回复“确认收到”确认。',
  },
  TASK_READY: {
    titleTemplate: '前置任务已完成：{{taskWbs}} {{taskName}} 可以开始',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n你的任务：{{taskWbs}} {{taskName}}\n上一个任务节点：{{previousTaskName}}（负责人：{{previousTaskOwner}}）已于 {{previousTaskEnd}} 完成\n交付标准：{{closureCriteria}}\n下一个任务节点：{{nextTasks}}\n计划开始：{{plannedStart}}\n计划完成：{{plannedEnd}}\n请回复“确认收到”或“进度 80%”同步状态。',
  },
  TASK_OVERDUE: {
    titleTemplate: '任务已延期：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n你的任务：{{taskWbs}} {{taskName}}\n计划完成：{{plannedEnd}}\n当前任务尚未完成，请回复“进度 80%”或说明延期原因。',
  },
  TASK_ASSIGNEE_CHANGED: {
    titleTemplate: '任务负责人已变更：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n你的任务：{{taskWbs}} {{taskName}}\n负责人已调整为你。\n计划完成：{{plannedEnd}}\n请回复“确认收到”确认。',
  },
  TASK_SCHEDULE_CHANGED: {
    titleTemplate: '任务排期已变更：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n你的任务：{{taskWbs}} {{taskName}}\n计划开始：{{previousPlannedStart}} → {{plannedStart}}\n计划完成：{{previousPlannedEnd}} → {{plannedEnd}}\n请按新排期执行。',
  },
  TASK_APPROVAL_SUBMITTED: {
    titleTemplate: '待审批交付物：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n任务：{{taskWbs}} {{taskName}}\n提交人：{{submitterName}}\n交付类型：{{deliveryType}}\n负责人已在钉钉 OA 提交交付物，请按项目审批策略处理。阶段交付审批通过后任务仍在进行中；最终交付审批通过后系统才会完成任务并启动下一个任务。',
  },
  TASK_APPROVAL_VIEWED: {
    titleTemplate: '交付物已同步：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n任务：{{taskWbs}} {{taskName}}\n提交人：{{submitterName}}\n负责人已提交交付物，内容已同步到系统。\n本通知仅供查看，审批由 L2/管理员处理；你没有审批权限。',
  },
  TASK_DELIVERABLE_SUBMITTED: {
    titleTemplate: '交付物已提交：{{taskWbs}} {{taskName}}',
    bodyTemplate: '项目：{{projectCode}} · {{projectName}}\n提交人：{{submitterName}}\n当前进度：{{progress}}\n文件：{{deliverableName}}\n{{deliverableLink}}\n任务当前仍在进行中，完成审批将在负责人申请完成后发起。',
  },
}

export function renderNotificationTemplate(template: string, context: TaskNotificationContext) {
  const values: Record<string, string> = {
    projectCode: context.projectCode,
    projectName: context.projectName,
    taskWbs: context.taskWbs,
    taskName: context.taskName,
    description: context.description?.trim() || '尚未填写',
    closureCriteria: context.closureCriteria?.trim() || '尚未设置',
    plannedStart: context.plannedStart || '待排期',
    plannedEnd: context.plannedEnd || '待排期',
    previousPlannedStart: context.previousPlannedStart || '未设置',
    previousPlannedEnd: context.previousPlannedEnd || '未设置',
    assigneeName: context.assigneeName || '待分配',
    actorName: context.actorName || '项目管理员',
    previousTaskName: context.previousTaskName || '无（项目开始）',
    previousTaskOwner: context.previousTaskOwner || '待分配',
    previousTaskEnd: context.previousTaskEnd || '待排期',
    submitterName: context.submitterName || '任务负责人',
    deliveryType: context.deliveryType || '最终交付',
    deliverableName: context.deliverableName || '未命名交付物',
    deliverableLink: context.deliverableLink || '（文件暂无在线预览，请在 Project OS 任务详情查看）',
    progress: context.progress || '—',
    nextTasks: context.nextTasks?.trim() || '无（项目结束）',
  }
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '')
}

export function dateOnly(value: Date | null | undefined) {
  return value?.toISOString().slice(0, 10) ?? null
}
