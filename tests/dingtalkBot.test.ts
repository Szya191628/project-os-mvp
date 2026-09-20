import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDeliverableTarget } from '../server/src/agent/deliverableCommand.ts'
import type { AgentProjectSnapshot } from '../server/src/agent/types.ts'
import { completesTaskAfterApproval, parseDeliveryProgress, parseTaskDeliveryType } from '../server/src/approvalDelivery.ts'
import { createPendingAttachmentStore, extractTaskWbs, isBotCancellationCommand, isBotConfirmationCommand, isDingTalkSendResponseSuccessful, isNotificationAcknowledgementCommand, normalizeBotCommand, parseL3TaskQuery, parseProgressCommand, parseRobotMessage, requestsTaskCompletion, resolveAttachmentAwareIntent } from '../server/src/dingtalkBotCommands.ts'

test('钉钉机器人命令会压缩空白并识别确认/取消', () => {
  assert.equal(normalizeBotCommand('  查询   项目进度\n'), '查询 项目进度')
  assert.equal(isBotConfirmationCommand('确认删除。'), true)
  assert.equal(isBotConfirmationCommand('确认执行'), true)
  assert.equal(isBotConfirmationCommand('确认有哪些项目'), false)
  assert.equal(isBotCancellationCommand('取消！'), true)
})

test('钉钉机器人识别确认收到和进度更新指令', () => {
  assert.equal(isNotificationAcknowledgementCommand('确认收到。'), true)
  assert.equal(isNotificationAcknowledgementCommand('确认执行'), false)
  assert.equal(parseProgressCommand('进度 80%'), 80)
  assert.equal(parseProgressCommand('完成度：100'), 100)
  assert.equal(parseProgressCommand('进度 120%'), undefined)
})

test('钉钉文件发送会识别 HTTP 200 下的业务错误', () => {
  assert.equal(isDingTalkSendResponseSuccessful(true, { errcode: 0, errmsg: 'ok' }), true)
  assert.equal(isDingTalkSendResponseSuccessful(true, { errcode: 40035, errmsg: 'invalid media' }), false)
  assert.equal(isDingTalkSendResponseSuccessful(false, { errcode: 0 }), false)
})

test('L3 固定查询指令不会进入 Agent', () => {
  assert.deepEqual(parseL3TaskQuery('我的任务'), { kind: 'my-tasks' })
  assert.deepEqual(parseL3TaskQuery('查看 1.1'), { kind: 'task', wbs: '1.1' })
  assert.deepEqual(parseL3TaskQuery('1.1 交付物'), { kind: 'deliverables', wbs: '1.1' })
  assert.equal(parseL3TaskQuery('查询项目风险'), undefined)
})

test('L3 固定交付物指令可提取任务 WBS', () => {
  assert.equal(extractTaskWbs('1.1，并完成任务'), '1.1')
  assert.equal(extractTaskWbs('给任务 2.3 提交验收报告'), '2.3')
  assert.equal(extractTaskWbs('查看项目进度'), undefined)
})

test('只接受文本类型的钉钉机器人消息', () => {
  const message = parseRobotMessage(JSON.stringify({ msgtype: 'text', text: { content: '查询项目' }, senderStaffId: 'user-1' }))
  assert.equal(message?.text.content, '查询项目')
  assert.equal(parseRobotMessage(JSON.stringify({ msgtype: 'image', image: { mediaId: 'x' } })), null)
  assert.equal(parseRobotMessage('not-json'), null)
})

test('钉钉文件消息会保留附件引用供 Agent 提交交付物', () => {
  const message = parseRobotMessage(JSON.stringify({
    msgtype: 'file',
    robotCode: 'bot-1',
    file: { fileName: '验收报告.pdf', downloadCode: 'download-1', fileSize: 2048, mimeType: 'application/pdf' },
    senderStaffId: 'user-1',
  }))
  assert.equal(message?.attachment?.name, '验收报告.pdf')
  assert.equal(message?.attachment?.externalProvider, 'DINGTALK')
  assert.equal(message?.attachment?.externalId, 'download-1')
  assert.equal(message?.attachment?.robotCode, 'bot-1')
  assert.equal(message?.attachment?.url, 'dingtalk://download/bot-1:download-1')
  assert.equal(message?.attachment?.sizeBytes, 2048)
})

test('钉钉富媒体消息会提取任务说明作为 Agent 文本', () => {
  const message = parseRobotMessage(JSON.stringify({
    msgtype: 'richText',
    robotCode: 'bot-1',
    content: { richText: [{ text: '给 1.7 提交验收报告' }, { fileName: '验收报告.pdf', downloadCode: 'download-1' }] },
  }))
  assert.equal(message?.text?.content, '给 1.7 提交验收报告')
  assert.equal(message?.attachment?.name, '验收报告.pdf')
})

test('钉钉分开发送文件和任务说明时会在同一会话恢复附件', () => {
  const store = createPendingAttachmentStore(10 * 60 * 1000)
  const fileMessage = parseRobotMessage(JSON.stringify({
    msgtype: 'file',
    robotCode: 'bot-1',
    file: { fileName: '验收报告.pdf', downloadCode: 'download-1' },
  }))
  assert.ok(fileMessage?.attachment)

  store.remember('direct:user-1', fileMessage.attachment, 1_000)
  const textMessage = parseRobotMessage(JSON.stringify({ msgtype: 'text', text: { content: '1.1，并完成任务' } }))
  assert.ok(textMessage)
  const restored = store.peek('direct:user-1', 2_000)

  assert.equal(restored?.name, '验收报告.pdf')
  assert.equal(requestsTaskCompletion(textMessage.text?.content ?? ''), true)
  assert.equal(store.take('direct:user-1', 2_000)?.externalId, 'download-1')
  assert.equal(store.peek('direct:user-1', 2_000), undefined)
})

test('钉钉待提交附件过期后不会误关联到新消息', () => {
  const store = createPendingAttachmentStore(1_000)
  store.remember('direct:user-1', { name: '旧文件.pdf', externalId: 'old' }, 1_000)
  assert.equal(store.peek('direct:user-1', 2_001), undefined)
})

test('L3 只有一个待办任务时可用上一条附件定位任务并请求完成', () => {
  const projects: AgentProjectSnapshot[] = [{
      id: 'project-1', code: 'PRJ-001', name: '测试项目', status: 'ACTIVE', health: 'HEALTHY', plannedStart: '2026-09-01', plannedEnd: '2026-09-30', progress: 30, owner: '项目经理', budgetAmount: null, actualCostAmount: null,
      tasks: [{ id: 'task-1', wbs: '1.1', name: '接口开发', projectId: 'project-1', owner: '史泽宇', effortHours: 8, durationDays: 1, progress: 80, status: 'IN_PROGRESS', plannedStart: '2026-09-03', plannedEnd: '2026-09-04', description: '完成接口', closureCriteria: '提交验收报告', assignees: ['史泽宇'], assigneeIds: ['member-1'], deliverableCount: 0, incompleteClosureCheckCount: 0, isMine: true }],
    }]

  const task = resolveDeliverableTarget('我已经完成任务，这是交付物', projects, 'L3')

  assert.equal(task?.id, 'task-1')
  assert.equal(requestsTaskCompletion('我已经完成任务，这是交付物'), true)
})

test('恢复暂存附件后任务编号消息不会降级成普通问答', () => {
  assert.equal(resolveAttachmentAwareIntent('1.1，并完成任务', { name: '验收报告.pdf', externalId: 'download-1' }, 'unknown'), 'deliverable-submit')
  assert.equal(resolveAttachmentAwareIntent('查看项目进度', undefined, 'portfolio-analysis'), 'portfolio-analysis')
})

test('OA 交付类型缺省兼容最终交付，阶段交付不直接完成任务', () => {
  assert.equal(parseTaskDeliveryType('阶段交付'), 'STAGE')
  assert.equal(parseTaskDeliveryType('中间成果'), 'STAGE')
  assert.equal(parseTaskDeliveryType('STAGE'), 'STAGE')
  assert.equal(parseTaskDeliveryType('最终交付'), 'FINAL')
  assert.equal(parseTaskDeliveryType(undefined), 'FINAL')
  assert.equal(completesTaskAfterApproval('STAGE'), false)
  assert.equal(completesTaskAfterApproval('FINAL'), true)
})

test('OA 进度字段支持百分号并拒绝越界值', () => {
  assert.equal(parseDeliveryProgress('80%'), 80)
  assert.equal(parseDeliveryProgress('80.4'), 80)
  assert.equal(parseDeliveryProgress(''), undefined)
  assert.equal(parseDeliveryProgress('101'), undefined)
})
