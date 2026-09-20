/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma test doubles inspect only selected query fields. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { prisma } from '../server/src/db.ts'
import { processNotificationQueue } from '../server/src/notifications/notificationWorker.ts'

function stub(target: object, key: string, implementation: (...args: never[]) => unknown) {
  const original = (target as Record<string, unknown>)[key]
  Object.defineProperty(target, key, { configurable: true, writable: true, value: implementation })
  return () => Object.defineProperty(target, key, { configurable: true, writable: true, value: original })
}

test('approval notifications use configured approvers and CC recipients', async () => {
  const recipientRows: { memberId: string }[] = []
  const event = {
    id: 'event-1', organizationId: 'org-1', eventType: 'TASK_APPROVAL_SUBMITTED', status: 'PENDING', attemptCount: 0,
    payload: { taskId: 'task-1', approvalId: 'approval-1', source: 'PROJECT_OS', stage: 'L2', submitterMemberId: 'executor', submitterName: '执行者', deliveryType: 'FINAL', progress: 100 },
  }
  const restores = [
    stub(prisma.outboxEvent, 'findMany', async () => [event]),
    stub(prisma.outboxEvent, 'findUnique', async () => event),
    stub(prisma.outboxEvent, 'updateMany', async () => ({ count: 1 })),
    stub(prisma.outboxEvent, 'update', async () => event),
    stub(prisma.taskApproval, 'findUnique', async () => ({
      currentStepNo: 1,
      policySnapshot: [{ stepNo: 1, stage: 'L2', mode: 'ANY', minApprovals: 1, approverMemberIds: ['l1-approver'], ccMemberIds: ['cc-viewer'] }],
    })),
    stub(prisma.task, 'findFirst', async () => ({
      id: 'task-1', projectId: 'project-1', project: { code: 'PRJ-001', name: '测试项目' },
      nodes: [{ wbs: '1.1', name: '测试任务', ownerMember: null }], assignees: [{ member: { id: 'executor', manager: null } }],
    })),
    stub(prisma.projectRoleGrant, 'findMany', async () => [{ memberId: 'other-l2' }]),
    stub(prisma.projectMember, 'findMany', async () => []),
    stub(prisma.member, 'findMany', async () => [{ id: 'l1-approver' }]),
    stub(prisma.notificationTemplate, 'findFirst', async () => null),
    stub(prisma.notification, 'upsert', async () => ({ id: 'notification-1' })),
    stub(prisma.notificationRecipient, 'createMany', async ({ data }: { data: { memberId: string }[] }) => { recipientRows.push(...data); return { count: data.length } }),
    stub(prisma.notificationDelivery, 'createMany', async () => ({ count: 0 })),
    stub(prisma.notificationDelivery, 'findMany', async () => []),
    stub(prisma.workflow, 'findMany', async () => []),
  ]
  try {
    await processNotificationQueue({ info: () => undefined, warn: () => undefined, error: () => undefined })
  } finally {
    for (const restore of restores.reverse()) restore()
  }
  assert.deepEqual(recipientRows.map((row) => row.memberId), ['l1-approver', 'cc-viewer'])
})

test('notification delivery skips stale workflow reminders', async () => {
  const queries: any[] = []
  const restores = [
    stub(prisma.outboxEvent, 'findMany', async () => []),
    stub(prisma.workflow, 'findMany', async () => []),
    stub(prisma.notificationDelivery, 'findMany', async (input: any) => { queries.push(input); return [] }),
  ]
  try {
    await processNotificationQueue({ info: () => undefined, warn: () => undefined, error: () => undefined })
  } finally {
    for (const restore of restores.reverse()) restore()
  }
  assert.equal(queries.length, 1)
  assert.match(JSON.stringify(queries[0].where), /archivedAt/)
  assert.match(JSON.stringify(queries[0].where), /OVERDUE_FINISHED/)
})
