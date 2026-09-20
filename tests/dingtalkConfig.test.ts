import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isApprovalPollDue } from '../server/src/approvalPolling.ts'
import { config } from '../server/src/config.ts'
import { isRetryableDingTalkError } from '../server/src/notifications/dingtalkRetry.ts'

test('钉钉审批轮询和外部发现默认关闭，避免后台持续调用审批接口', () => {
  assert.equal(config.approval.pollEnabled, false)
  assert.equal(config.approval.discoveryEnabled, false)
})

test('审批轮询不能复用通知 worker 的高频间隔', () => {
  const intervalMs = 15 * 60 * 1000
  assert.ok(config.approval.pollIntervalMs >= intervalMs)
  assert.equal(isApprovalPollDue(1_000, null, intervalMs), true)
  assert.equal(isApprovalPollDue(1_000 + intervalMs - 1, 1_000, intervalMs), false)
  assert.equal(isApprovalPollDue(1_000 + intervalMs, 1_000, intervalMs), true)
})

test('钉钉通知只对临时错误重试', () => {
  assert.equal(isRetryableDingTalkError(new Error('dingtalk_request_failed_429')), true)
  assert.equal(isRetryableDingTalkError(new Error('dingtalk_request_failed_503')), true)
  assert.equal(isRetryableDingTalkError(new Error('dingtalk_recipient_invalid')), false)
  assert.equal(isRetryableDingTalkError(new Error('dingtalk_proactive_notifications_disabled')), false)
})
