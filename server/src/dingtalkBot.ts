import path from 'node:path'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import type { DWClientDownStream } from 'dingtalk-stream'
import type { FastifyInstance } from 'fastify'
import { checkTaskPermission, createServiceSession, hasAgentPermission, resolveDingTalkActor, revokeSession, type AuthContext } from './auth.js'
import { runProjectAgent } from './agent/projectAgent.js'
import type { AgentAction, AgentRun } from './agent/types.js'
import { config } from './config.js'
import { prisma } from './db.js'
import { fetchDingTalkIdentityByUserId } from './dingtalk.js'
import { fetchDingTalkApi } from './dingtalkUsage.js'
import { submitTaskApproval } from './approvals.js'
import { executeDingTalkTaskDelivery, readStoredDeliverable } from './deliverables/dingtalkDelivery.js'
import { resolvePredecessorDeliverable, type PredecessorDeliverableResult } from './deliverables/predecessorDelivery.js'
import { createPendingAttachmentStore, extractTaskWbs, hasTaskReference, isBotCancellationCommand, isBotConfirmationCommand, isDingTalkSendResponseSuccessful, isNotificationAcknowledgementCommand, normalizeBotCommand, parseL3TaskQuery, parseProgressCommand, parseRobotMessage, requestsTaskCompletion, type RobotMessagePayload } from './dingtalkBotCommands.js'
import { createDeliverableViewLink } from './deliverables/viewLink.js'
import { isDingTalkIntegrationEnabled } from './dingtalkPolicy.js'

type PendingAction = {
  actor: AuthContext
  action: AgentAction
  expiresAt: number
}

type InjectRequest = {
  method: 'POST' | 'PATCH' | 'DELETE'
  url: string
  body?: Record<string, unknown>
}

const pendingActions = new Map<string, PendingAction>()
const pendingAttachments = createPendingAttachmentStore(10 * 60 * 1000)
const seenMessageIds = new Map<string, number>()
const pendingActionTtlMs = 10 * 60 * 1000
const seenMessageTtlMs = 5 * 60 * 1000

function pruneState(now = Date.now()) {
  for (const [key, pending] of pendingActions) {
    if (pending.expiresAt <= now) pendingActions.delete(key)
  }
  for (const [key, seenAt] of seenMessageIds) {
    if (seenAt + seenMessageTtlMs <= now) seenMessageIds.delete(key)
  }
  pendingAttachments.prune(now)
}

function senderUserId(message: RobotMessagePayload) {
  return message.senderStaffId?.trim() || message.senderId?.trim() || ''
}

function senderCorpId(message: RobotMessagePayload) {
  return message.senderCorpId?.trim() || message.chatbotCorpId?.trim() || config.dingtalk.corpId
}

function conversationKey(message: RobotMessagePayload, userId: string) {
  return `${message.conversationId?.trim() || 'direct'}:${userId}`
}

function isGroupMessage(message: RobotMessagePayload) {
  return message.conversationType === '2' || message.conversationType?.toLowerCase() === 'group'
}

function wasMentioned(message: RobotMessagePayload) {
  const mentionIds = message.at?.atUserIds
  if (message.isAtAll || message.at?.isAtAll) return true
  if (Array.isArray(mentionIds)) return mentionIds.length > 0
  // Stream robot callbacks are normally delivered only after the robot is
  // mentioned. If DingTalk omits mention metadata, keep the event instead of
  // silently dropping every group message.
  return true
}

function shouldProcess(message: RobotMessagePayload) {
  return !config.dingtalk.bot.requireMention || !isGroupMessage(message) || wasMentioned(message)
}

function executableAction(run: AgentRun) {
  return run.actions.find((action) => ['create-project', 'create-task', 'update-task', 'delete-task', 'assign-task', 'publish-workflow', 'submit-deliverable', 'get-predecessor-deliverable'].includes(action.kind))
}

function actionSummary(action: AgentAction) {
  if (action.kind === 'create-project') return `创建项目“${action.projectDraft?.name ?? '未命名'}”`
  if (action.kind === 'create-task') return `新增任务“${action.taskDraft?.name ?? '未命名'}”`
  if (action.kind === 'update-task') return '修改任务信息'
  if (action.kind === 'delete-task') return '删除任务（可恢复）'
  if (action.kind === 'assign-task') return `调整负责人为 ${action.memberName ?? '指定成员'}`
  if (action.kind === 'publish-workflow') return '发布流程草稿'
  if (action.kind === 'submit-deliverable') return `提交交付物“${action.deliverable?.name ?? '未命名附件'}”${action.completeTask ? '并等待钉钉审批完成任务' : ''}`
  if (action.kind === 'get-predecessor-deliverable') return `获取前置节点交付物“${action.deliverable?.name ?? '指定文件'}”`
  return action.label
}

async function sendTextReply(client: DWClient, message: RobotMessagePayload, content: string) {
  const webhook = message.sessionWebhook?.trim()
  if (!webhook) return
  const accessToken = await client.getAccessToken()
  const response = await fetchDingTalkApi({ operation: 'robot/sessionWebhook/message', url: webhook, init: {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: content.slice(0, 4000) },
      at: { atUserIds: senderUserId(message) ? [senderUserId(message)] : [], isAtAll: false },
    }),
    signal: AbortSignal.timeout(10000),
  } })
  await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`dingtalk_reply_failed_${response.status}`)
}

function fileType(name: string) {
  return path.extname(name).replace(/^\./u, '').toLowerCase() || 'file'
}

async function uploadDingTalkFile(accessToken: string, name: string, mimeType: string | null | undefined, bytes: Uint8Array) {
  const form = new FormData()
  const blobBytes = bytes.slice().buffer as ArrayBuffer
  form.append('media', new Blob([blobBytes], { type: mimeType || 'application/octet-stream' }), name)
  const response = await fetchDingTalkApi({ operation: 'media/upload', url: `https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(accessToken)}&type=file`, init: { method: 'POST', body: form, signal: AbortSignal.timeout(15000) } })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new Error(`dingtalk_media_upload_failed_${response.status}`)
  const mediaId = typeof payload?.media_id === 'string' ? payload.media_id : typeof payload?.mediaId === 'string' ? payload.mediaId : undefined
  if (!mediaId) throw new Error('dingtalk_media_id_missing')
  return mediaId
}

async function postDingTalkFileMessage(client: DWClient, message: RobotMessagePayload, file: { name: string; mimeType: string | null; bytes: Uint8Array }) {
  const accessToken = await client.getAccessToken()
  if (file.bytes.byteLength > 20 * 1024 * 1024) throw new Error('dingtalk_file_message_too_large')
  const mediaId = await uploadDingTalkFile(accessToken, file.name, file.mimeType, file.bytes)
  const msgParam = { file: { media_id: mediaId, file_name: file.name, file_type: fileType(file.name) } }
  const webhook = message.sessionWebhook?.trim()
  if (webhook) {
    try {
      const response = await fetchDingTalkApi({ operation: 'robot/sessionWebhook/file', url: webhook, init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken }, body: JSON.stringify({ msgtype: 'file', ...msgParam }), signal: AbortSignal.timeout(10000) } })
      const payload = await response.json().catch(() => null)
      if (isDingTalkSendResponseSuccessful(response.ok, payload)) return
    } catch {
      // Fall through to the official robot send API when the session webhook
      // rejects the file message or returns a business-level error.
    }
  }
  const robotCode = (message as { robotCode?: string }).robotCode?.trim() || config.dingtalk.bot.clientId
  const endpoint = isGroupMessage(message) ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send' : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
  const body = isGroupMessage(message)
    ? { robotCode, openConversationId: message.conversationId, msgKey: 'sampleFile', msgParam: JSON.stringify(msgParam) }
    : { robotCode, userIds: [senderUserId(message)], msgKey: 'sampleFile', msgParam: JSON.stringify(msgParam) }
  const response = await fetchDingTalkApi({ operation: new URL(endpoint).pathname, url: endpoint, init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) } })
  const payload = await response.json().catch(() => null)
  if (!isDingTalkSendResponseSuccessful(response.ok, payload)) throw new Error(`dingtalk_file_reply_failed_${response.status}`)
}

function storedDeliverableLink(result: PredecessorDeliverableResult) {
  const value = result.deliverable.url
  if (!value) return ''
  if (/^https?:\/\//iu.test(value)) return value
  return `${config.apiOrigin}${value.startsWith('/') ? value : `/${value}`}`
}

async function invokeAuthorizedRoute(app: FastifyInstance, actor: AuthContext, input: InjectRequest) {
  const session = await createServiceSession(actor.memberId, 'project-os-dingtalk-bot')
  try {
    const response = await app.inject({
      method: input.method,
      url: input.url,
      headers: {
        cookie: `${config.sessionCookieName}=${session.token}`,
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { payload: input.body } : {}),
    })
    const body = response.json<{ data?: unknown; error?: string }>()
    if (response.statusCode >= 400) throw new Error(body.error ?? `project_os_action_failed_${response.statusCode}`)
    return body.data
  } finally {
    await revokeSession(session.token)
  }
}

async function latestNotificationTask(actor: AuthContext) {
  return prisma.notificationRecipient.findFirst({
    where: { memberId: actor.memberId, notification: { organizationId: actor.organizationId, taskId: { not: null } } },
    orderBy: { notification: { createdAt: 'desc' } },
    select: { id: true, notification: { select: { id: true, taskId: true, title: true } } },
  })
}

async function acknowledgeLatestNotification(actor: AuthContext) {
  const item = await latestNotificationTask(actor)
  if (!item) return null
  await prisma.notificationRecipient.update({ where: { id: item.id }, data: { acknowledgedAt: new Date(), readAt: new Date() } })
  return item.notification
}

async function findL3TasksByWbs(actor: AuthContext, wbs: string) {
  const rows = await prisma.workflowNode.findMany({
    where: { wbs, taskId: { not: null }, task: { archivedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } } },
    select: { task: { select: { id: true, projectId: true, project: { select: { code: true, name: true } }, execution: { select: { status: true, progress: true, actualStart: true, actualEnd: true, completionApprovalStatus: true, overdueReason: true } }, nodes: { where: { wbs }, take: 1, select: { wbs: true, name: true, schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 } } } } } },
  })
  const candidates = new Map<string, { id: string; projectId: string; projectCode: string; projectName: string; wbs: string; name: string; execution: { status: string; progress: number; actualStart: Date | null; actualEnd: Date | null; completionApprovalStatus: string; overdueReason: string | null } | null; plannedStart: Date | null; plannedEnd: Date | null }>()
  for (const row of rows) {
    if (row.task?.nodes[0]) candidates.set(row.task.id, { id: row.task.id, projectId: row.task.projectId, projectCode: row.task.project.code, projectName: row.task.project.name, wbs: row.task.nodes[0].wbs, name: row.task.nodes[0].name, execution: row.task.execution, plannedStart: row.task.nodes[0].schedules[0]?.plannedStart ?? null, plannedEnd: row.task.nodes[0].schedules[0]?.plannedEnd ?? null })
  }
  const authorized: typeof candidates extends Map<string, infer Candidate> ? Candidate[] : never[] = []
  for (const candidate of candidates.values()) {
    const permission = await checkTaskPermission(actor, candidate.id, 'deliverable.manage.own')
    if ('task' in permission) authorized.push(candidate)
  }
  return authorized
}

function taskStatusLabel(status: string | undefined) {
  return ({ NOT_STARTED: '未开始', IN_PROGRESS: '进行中', BLOCKED: '受阻', DUE_UNFINISHED: '到期未完成', COMPLETED: '已完成', EARLY_FINISHED: '提前结束', ON_TIME_FINISHED: '如期结束', OVERDUE_FINISHED: '超期结束' } as Record<string, string>)[status ?? ''] ?? '未知'
}

function dateLabel(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : '待排期'
}

async function listL3Tasks(actor: AuthContext) {
  const rows = await prisma.task.findMany({
    where: { archivedAt: null, project: { organizationId: actor.organizationId, archivedAt: null }, assignees: { some: { memberId: actor.memberId, removedAt: null } } },
    select: { id: true, project: { select: { code: true, name: true } }, execution: { select: { status: true, progress: true, completionApprovalStatus: true } }, nodes: { where: { workflowVersion: { status: 'PUBLISHED' } }, orderBy: { wbs: 'asc' }, take: 1, select: { wbs: true, name: true, schedules: { select: { plannedStart: true, plannedEnd: true }, take: 1 } } } },
    take: 100,
  })
  return rows.filter((row) => row.nodes[0]).sort((a, b) => (a.nodes[0]?.schedules[0]?.plannedStart?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.nodes[0]?.schedules[0]?.plannedStart?.getTime() ?? Number.MAX_SAFE_INTEGER))
}

async function replyToL3Query(actor: AuthContext, query: NonNullable<ReturnType<typeof parseL3TaskQuery>>) {
  if (query.kind === 'my-tasks') {
    const tasks = await listL3Tasks(actor)
    if (tasks.length === 0) return '当前没有分配给你的任务。'
    const lines = tasks.slice(0, 20).map((task) => {
      const node = task.nodes[0]!
      const execution = task.execution
      return `${task.project.code} · ${node.wbs} ${node.name}｜${taskStatusLabel(execution?.status)} ${execution?.progress ?? 0}%｜${dateLabel(node.schedules[0]?.plannedStart)} → ${dateLabel(node.schedules[0]?.plannedEnd)}`
    })
    return `你的任务（按计划开始时间）：\n${lines.join('\n')}${tasks.length > 20 ? `\n还有 ${tasks.length - 20} 个任务，请用“查看 1.1”查询详情。` : ''}`
  }
  const candidates = await findL3TasksByWbs(actor, query.wbs)
  if (candidates.length === 0) return `没有找到你负责的任务“${query.wbs}”。`
  if (candidates.length > 1) return `任务编号“${query.wbs}”在多个授权项目中重复，请补充项目编号后再查询。`
  const task = candidates[0]!
  if (query.kind === 'task') return `任务：${task.projectCode} · ${task.wbs} ${task.name}\n状态：${taskStatusLabel(task.execution?.status)}\n进度：${task.execution?.progress ?? 0}%\n计划：${dateLabel(task.plannedStart)} → ${dateLabel(task.plannedEnd)}\n完成审批：${task.execution?.completionApprovalStatus === 'APPROVED' ? '已通过' : '未通过/未完成'}${task.execution?.overdueReason ? `\n超期原因：${task.execution.overdueReason}` : ''}`
  const deliverables = await prisma.taskDeliverable.findMany({ where: { taskId: task.id, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, versionLabel: true, sizeBytes: true, objectKey: true, url: true, createdAt: true } })
  if (deliverables.length === 0) return `任务“${task.wbs} ${task.name}”目前还没有交付物。`
  const lines = deliverables.map((item, index) => `${index + 1}. ${item.name}（${item.versionLabel}，${dateLabel(item.createdAt)}）\n${item.objectKey || item.url ? createDeliverableViewLink(item.id, actor.memberId) : '仅有钉钉引用，文件尚未缓存'}`)
  return `任务“${task.wbs} ${task.name}”的交付物：\n${lines.join('\n')}`
}

async function submitL3DingTalkDelivery(actor: AuthContext, command: string, attachment: NonNullable<RobotMessagePayload['attachment']>, accessToken: string) {
  const wbs = extractTaskWbs(command)
  if (!wbs) return { stored: false, message: `已收到文件“${attachment.name}”。请回复任务编号（如 1.1）；L3 只能提交自己负责的任务交付物。` }
  const candidates = await findL3TasksByWbs(actor, wbs)
  if (candidates.length === 0) return { stored: false, message: `没有找到你负责的任务“${wbs}”，交付物未保存。请确认任务编号，或联系 L2/管理员分配任务。` }
  if (candidates.length > 1) return { stored: false, message: `任务编号“${wbs}”在多个授权项目中重复，请补充项目编号后再提交，交付物未保存。` }
  const target = candidates[0]
  const wantsCompletion = requestsTaskCompletion(command)
  try {
    // 文档 §4：普通交付物提交不等于任务完成；“并提交完成”在保存交付物后
    // 自动发起钉钉 OA 完成审批，由 L2/管理员审批，任务不能被直接置为完成。
    const result = await executeDingTalkTaskDelivery({ actor, taskId: target.id, attachment, accessToken, completeTask: false })
    const duplicate = result.alreadyStored ? '（该文件已同步，无需重复保存）' : ''
    let completion: string
    if (wantsCompletion) {
      const submitter = await prisma.member.findUnique({ where: { id: actor.memberId }, select: { name: true } })
      try {
        const approval = await submitTaskApproval({
          organizationId: actor.organizationId,
          actorMemberId: actor.memberId,
          actorName: submitter?.name ?? '任务负责人',
          taskId: target.id,
          note: `钉钉机器人提交交付物：${attachment.name}`,
        })
        completion = `已自动发起完成审批（实例 ${approval.processInstanceId.slice(0, 12)}…），等待 L2/管理员在钉钉中审批；审批通过后任务自动完成并解锁下游。`
      } catch (approvalError) {
        const detail = approvalError instanceof Error ? approvalError.message : 'approval_failed'
        completion = detail === 'approval_pending_exists' ? '该任务已有完成审批进行中，请等待审批结果后再补交材料。'
          : detail === 'dingtalk_approval_not_configured' ? '完成审批未自动发起：系统尚未配置钉钉 OA 审批模板，请联系管理员。'
          : detail === 'overdue_reason_required' ? '任务已超期，无法发起完成审批：请先联系 L2 说明超期原因。'
          : detail === 'dingtalk_approver_missing' ? '完成审批未自动发起：项目缺少可用的 L2/管理员审批人，请联系管理员。'
          : `完成审批发起失败：${detail}。交付物已保存，可稍后在 Project OS 中重新发起。`
      }
    } else {
      completion = '任务状态未被修改；需要申请完成时，请回复“1.1，并提交完成”。'
    }
    return { stored: true, message: `已将“${attachment.name}”同步到任务“${wbs}”（${target.projectCode}）${duplicate}。${completion}` }
  } catch (error) {
    return { stored: false, message: `交付物同步失败：${error instanceof Error ? error.message : '权限或文件状态不允许'}。` }
  }
}

async function executeAgentAction(app: FastifyInstance, actor: AuthContext, action: AgentAction, dingtalkAccessToken?: string) {
  if (action.kind === 'create-project' && action.projectDraft) {
    return invokeAuthorizedRoute(app, actor, {
      method: 'POST',
      url: '/api/v1/projects',
      body: {
        name: action.projectDraft.name,
        code: action.projectDraft.code,
        ownerName: action.projectDraft.owner,
        departmentName: action.projectDraft.department,
        plannedStart: action.projectDraft.start,
        plannedEnd: action.projectDraft.end,
      },
    })
  }
  if (action.kind === 'create-task' && action.taskDraft) {
    return invokeAuthorizedRoute(app, actor, {
      method: 'POST',
      url: `/api/v1/projects/${action.taskDraft.projectId}/tasks`,
      body: {
        name: action.taskDraft.name,
        duration: action.taskDraft.duration,
        effort: action.taskDraft.effort,
        ownerMemberId: action.taskDraft.ownerMemberId,
        description: action.taskDraft.description,
        closureCriteria: action.taskDraft.closureCriteria,
      },
    })
  }
  if (action.kind === 'update-task' && action.taskId && action.taskPatch) {
    return invokeAuthorizedRoute(app, actor, { method: 'PATCH', url: `/api/v1/tasks/${action.taskId}`, body: action.taskPatch as Record<string, unknown> })
  }
  if (action.kind === 'delete-task' && action.taskId) {
    return invokeAuthorizedRoute(app, actor, { method: 'DELETE', url: `/api/v1/tasks/${action.taskId}` })
  }
  if (action.kind === 'assign-task' && action.taskId && action.memberId) {
    if (action.assignmentMode === 'remove') {
      return invokeAuthorizedRoute(app, actor, { method: 'DELETE', url: `/api/v1/tasks/${action.taskId}/assignees/${action.memberId}` })
    }
    const result = await invokeAuthorizedRoute(app, actor, { method: 'POST', url: `/api/v1/tasks/${action.taskId}/assignees`, body: { memberId: action.memberId } })
    if (action.assignmentMode === 'replace') {
      for (const existingMemberId of action.existingMemberIds ?? []) {
        if (existingMemberId !== action.memberId) await invokeAuthorizedRoute(app, actor, { method: 'DELETE', url: `/api/v1/tasks/${action.taskId}/assignees/${existingMemberId}` })
      }
    }
    return result
  }
  if (action.kind === 'publish-workflow' && action.projectId) {
    return invokeAuthorizedRoute(app, actor, { method: 'POST', url: `/api/v1/projects/${action.projectId}/workflow/publish` })
  }
  if (action.kind === 'submit-deliverable' && action.taskId && action.deliverable) {
    if ((action.deliverable.externalProvider ?? 'DINGTALK').toUpperCase() === 'DINGTALK' && (action.deliverable.externalId || action.deliverable.url?.startsWith('dingtalk://'))) {
      if (!dingtalkAccessToken) throw new Error('dingtalk_access_token_missing')
      return executeDingTalkTaskDelivery({ actor, taskId: action.taskId, attachment: action.deliverable, accessToken: dingtalkAccessToken, completeTask: action.completeTask })
    }
    const deliverable = await invokeAuthorizedRoute(app, actor, {
      method: 'POST',
      url: `/api/v1/tasks/${action.taskId}/deliverables`,
      body: {
        name: action.deliverable.name,
        kind: action.deliverable.kind ?? 'dingtalk',
        versionLabel: action.deliverable.versionLabel ?? 'v1',
        url: action.deliverable.url,
        mimeType: action.deliverable.mimeType,
        sizeBytes: action.deliverable.sizeBytes,
        externalProvider: action.deliverable.externalProvider ?? 'DINGTALK',
        externalId: action.deliverable.externalId,
      },
    })
    return { deliverable, taskCompleted: false, approvalRequired: Boolean(action.completeTask) }
  }
  if (action.kind === 'get-predecessor-deliverable' && action.taskId) {
    return resolvePredecessorDeliverable({ actor, taskId: action.taskId, predecessorTaskId: action.predecessorTaskId, deliverableId: action.deliverableId, accessToken: dingtalkAccessToken })
  }
  throw new Error('agent_action_missing_parameters')
}

async function recordBotAudit(actor: AuthContext, run: AgentRun, message: RobotMessagePayload) {
  await prisma.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorMemberId: actor.memberId,
      action: 'DINGTALK_BOT_AGENT_QUERY',
      resourceType: 'AGENT_RUN',
      resourceId: run.runId,
      projectId: run.actions.find((action) => action.projectId)?.projectId,
      afterJson: {
        status: run.status,
        intent: run.intent,
        source: 'dingtalk-bot',
        messageId: message.msgId ?? null,
        conversationId: message.conversationId ?? null,
      },
    },
  })
}

async function processRobotMessage(app: FastifyInstance, client: DWClient, downstream: DWClientDownStream) {
  const message = parseRobotMessage(downstream.data)
  if (!message || !shouldProcess(message)) return
  if (!(await isDingTalkIntegrationEnabled(config.dingtalk.organizationId))) return
  const userId = senderUserId(message)
  const corpId = senderCorpId(message)
  if (!userId || corpId !== config.dingtalk.corpId) {
    await sendTextReply(client, message, '无法识别当前钉钉成员，请确认机器人属于已配置的企业。')
    return
  }
  // A Stream callback carries senderStaffId, while OAuth may only have
  // unionId/openId. First use the already-linked staff ID; if it is not
  // linked, enrich it through DingTalk's contact API before resolving the
  // member. The bot never provisions a new member from an unverified ID.
  let actor = await resolveDingTalkActor({ corpId, userId, name: message.senderNick?.trim() || undefined }, { provision: false })
  if (!actor) {
    try {
      const accessToken = await client.getAccessToken()
      const details = await fetchDingTalkIdentityByUserId(accessToken, userId)
      actor = await resolveDingTalkActor({ corpId, userId, unionId: details.unionId, openId: details.openId, name: details.name ?? (message.senderNick?.trim() || undefined) }, { provision: false })
    } catch {
      // Keep the normal “not joined” response below. A failed enrichment must
      // not create a second member with only a staff ID.
    }
  }
  if (!actor) {
    await sendTextReply(client, message, '当前钉钉成员还没有加入 Project OS，请联系管理员完成成员授权。')
    return
  }

  const key = conversationKey(message, userId)
  const command = normalizeBotCommand(message.text?.content ?? '')
  const pending = pendingActions.get(key)
  if (pending && isBotCancellationCommand(command)) {
    pendingActions.delete(key)
    pendingAttachments.forget(key)
    await sendTextReply(client, message, '已取消待执行操作。')
    return
  }

  if (!pending && isBotCancellationCommand(command) && pendingAttachments.peek(key)) {
    pendingAttachments.forget(key)
    await sendTextReply(client, message, '已取消待提交的交付物。')
    return
  }
  if (pending && isBotConfirmationCommand(command)) {
    if (!(await hasAgentPermission(actor))) {
      pendingActions.delete(key)
      await sendTextReply(client, message, '当前账号没有 Agent 执行权限；L3 请使用钉钉固定指令或发送任务编号和交付物。')
      return
    }
    pendingActions.delete(key)
    try {
      const dingtalkAccessToken = pending.action.kind === 'submit-deliverable' || pending.action.kind === 'get-predecessor-deliverable' ? await client.getAccessToken() : undefined
      const actionResult = await executeAgentAction(app, pending.actor, pending.action, dingtalkAccessToken)
      if (pending.action.kind === 'submit-deliverable') pendingAttachments.take(key)
      if (pending.action.kind === 'get-predecessor-deliverable') {
        const result = actionResult as PredecessorDeliverableResult
        if (result.deliverable.objectKey) {
          try {
            const bytes = await readStoredDeliverable(result.deliverable.objectKey)
            await postDingTalkFileMessage(client, message, { name: result.deliverable.name, mimeType: result.deliverable.mimeType, bytes: new Uint8Array(bytes) })
            await sendTextReply(client, message, `已回传前置节点“${result.sourceTask.wbs} ${result.sourceTask.name}”的文件“${result.deliverable.name}”。`)
          } catch {
            const link = storedDeliverableLink(result)
            await sendTextReply(client, message, `文件已取回，但钉钉暂时无法直接发送文件。请打开下载链接：${link || '请在 Project OS 交付物列表下载'}。`)
          }
        } else {
          await sendTextReply(client, message, `已找到文件“${result.deliverable.name}”，但当前审批附件尚未缓存为 Project OS 文件。${storedDeliverableLink(result) ? `下载：${storedDeliverableLink(result)}` : '请联系管理员补充审批附件关联。'}`)
        }
      } else if (pending.action.kind === 'submit-deliverable' && pending.action.completeTask && (actionResult as { approvalRequired?: boolean })?.approvalRequired) {
        await sendTextReply(client, message, `交付物已保存，但任务不能直接完成。请在 Project OS 任务详情中提交钉钉 OA 审批，主管或管理员审批通过后系统会自动完成任务并启动下一个任务。`)
      } else {
        await sendTextReply(client, message, `已完成：${actionSummary(pending.action)}。`)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '操作失败'
      await sendTextReply(client, message, `操作未完成：${detail}`)
    }
    return
  }

  const taskQuery = parseL3TaskQuery(command)
  if (taskQuery) {
    await sendTextReply(client, message, await replyToL3Query(actor, taskQuery))
    return
  }

  if (isNotificationAcknowledgementCommand(command)) {
    const notification = await acknowledgeLatestNotification(actor)
    await sendTextReply(client, message, notification ? `已确认收到：${notification.title}` : '暂时没有待确认的任务提醒。')
    return
  }

  const progress = parseProgressCommand(command)
  if (progress !== undefined) {
    const notification = await latestNotificationTask(actor)
    if (!notification?.notification.taskId) {
      await sendTextReply(client, message, '暂时没有可更新的任务，请先让机器人发送任务提醒。')
      return
    }
    try {
      await invokeAuthorizedRoute(app, actor, { method: 'PATCH', url: `/api/v1/tasks/${notification.notification.taskId}`, body: { progress } })
      await prisma.notificationRecipient.update({ where: { id: notification.id }, data: { acknowledgedAt: new Date(), readAt: new Date() } })
      await sendTextReply(client, message, `已将“${notification.notification.title}”进度更新为 ${progress}%。${progress === 100 ? '任务完成仍需 L2/管理员通过钉钉 OA 审批。' : ''}`)
    } catch (error) {
      await sendTextReply(client, message, `进度更新失败：${error instanceof Error ? error.message : '权限或任务状态不允许'}`)
    }
    return
  }

  if (message.attachment && !hasTaskReference(command)) {
    pendingAttachments.remember(key, message.attachment)
    await sendTextReply(client, message, `已收到文件“${message.attachment.name}”。请回复任务编号（如 1.1）保存交付物；需要申请完成任务时回复“1.1，并提交完成”，系统会保存交付物并自动发起钉钉 OA 完成审批，由 L2/管理员审批。`)
    return
  }
  const attachment = message.attachment ?? pendingAttachments.peek(key)
  if (!(await hasAgentPermission(actor))) {
    if (!attachment) {
      await sendTextReply(client, message, 'L3 不使用自然语言 Agent。你可以回复“确认收到”、发送“进度 80%”，或发送文件并在消息中写任务编号（如“1.1，并提交完成”）。')
      return
    }
    const result = await submitL3DingTalkDelivery(actor, command, attachment, await client.getAccessToken())
    if (result.stored) pendingAttachments.take(key)
    await sendTextReply(client, message, result.message)
    return
  }
  const run = await runProjectAgent(actor, { message: command, conversationId: message.conversationId, channel: 'dingtalk', attachment })
  await recordBotAudit(actor, run, message)
  const action = executableAction(run)
  if (action && run.status === 'completed') {
    pendingActions.set(key, { actor, action, expiresAt: Date.now() + pendingActionTtlMs })
    await sendTextReply(client, message, `${run.answer}\n\n回复“确认”执行：${actionSummary(action)}；回复“取消”放弃。`)
  } else {
    await sendTextReply(client, message, run.answer)
  }
}

export type DingTalkBotRuntime = { stop: () => void }

let botApp: FastifyInstance | null = null
let activeBotClient: DWClient | null = null
let activeBotStop: (() => void) | null = null
let botStarting = false

function stopActiveDingTalkBot() {
  const stop = activeBotStop
  activeBotStop = null
  activeBotClient = null
  if (stop) stop()
}

export async function setDingTalkIntegrationState(organizationId: string, enabled: boolean) {
  if (organizationId !== config.dingtalk.organizationId || !botApp) return
  if (!enabled) {
    stopActiveDingTalkBot()
    return
  }
  if (!activeBotClient && !botStarting) await startDingTalkBot(botApp)
}

export async function startDingTalkBot(app: FastifyInstance): Promise<DingTalkBotRuntime> {
  botApp = app
  const runtime = { stop: () => stopActiveDingTalkBot() }
  if (!config.dingtalk.bot.enabled) return runtime
  if (!config.dingtalk.bot.available) {
    console.warn('[DingTalk] bot is enabled but Stream credentials or organization configuration is incomplete')
    return runtime
  }
  if (!(await isDingTalkIntegrationEnabled(config.dingtalk.organizationId))) return runtime
  if (activeBotClient || botStarting) return runtime

  botStarting = true
  const client = new DWClient({
    clientId: config.dingtalk.bot.clientId,
    clientSecret: config.dingtalk.bot.clientSecret,
    debug: config.dingtalk.bot.debug,
  })
  client.registerCallbackListener(TOPIC_ROBOT, async (downstream) => {
    pruneState()
    const message = parseRobotMessage(downstream.data)
    const messageId = message?.msgId?.trim() || downstream.headers.messageId
    if (messageId && seenMessageIds.has(messageId)) {
      client.socketCallBackResponse(downstream.headers.messageId, { code: 200, message: 'duplicate_ignored' })
      return
    }
    if (messageId) seenMessageIds.set(messageId, Date.now())
    try {
      await processRobotMessage(app, client, downstream)
    } catch (error) {
      console.error('[DingTalk] bot message handling failed', error)
      if (message) {
        try { await sendTextReply(client, message, 'Agent 暂时无法处理这条消息，请稍后重试。') } catch { /* keep stream callback isolated */ }
      }
    } finally {
      try { client.socketCallBackResponse(downstream.headers.messageId, { code: 200, message: 'processed' }) } catch { /* connection may have closed */ }
    }
  })
  try {
    await client.connect()
    const stop = () => {
      try { client.disconnect() } finally {
        if (activeBotClient === client) activeBotClient = null
        if (activeBotStop === stop) activeBotStop = null
      }
    }
    activeBotClient = client
    activeBotStop = stop
    console.info('[DingTalk] Stream bot started')
    return runtime
  } catch (error) {
    try { client.disconnect() } catch { /* connection may not have opened */ }
    throw error
  } finally {
    botStarting = false
  }
}
