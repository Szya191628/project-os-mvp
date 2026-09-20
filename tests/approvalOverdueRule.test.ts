import assert from 'node:assert/strict'
import test from 'node:test'
import { prisma } from '../server/src/db.ts'
import { submitTaskApproval } from '../server/src/approvals.ts'

function stub(target: object, key: string, implementation: (...args: never[]) => unknown) {
  const original = Reflect.get(target, key)
  Reflect.set(target, key, implementation)
  return () => Reflect.set(target, key, original)
}

test('an in-progress task can submit Project OS approval without an overdue reason', async () => {
  const executionUpdates: { overdueReason?: string }[] = []
  const task = {
    id: 'task-1', projectId: 'project-1',
    execution: { status: 'IN_PROGRESS', overdueReason: null },
    project: { code: 'PRJ-001', name: '测试项目', workflow: { publishedVersionId: 'version-1' } },
    nodes: [{ id: 'node-1', wbs: '1.1', name: '测试任务', description: null, closureCriteria: null, schedules: [{ plannedEnd: new Date('2026-09-13T00:00:00.000Z') }] }],
    assignees: [{ memberId: 'executor' }], deliverables: [],
  }
  const approval = { id: 'approval-1', taskId: 'task-1', processInstanceId: 'project-os:1', processCode: 'PROJECT_OS_TASK_DELIVERY', source: 'PROJECT_OS', deliveryType: 'FINAL', status: 'PENDING', createdAt: new Date() }
  const restores = [
    stub(prisma.task, 'findFirst', async () => task),
    stub(prisma.taskApproval, 'findFirst', async () => null),
    stub(prisma.approvalPolicy, 'findUnique', async () => null),
    stub(prisma, '$transaction', async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    stub(prisma.taskExecution, 'updateMany', async ({ data }: { data: { overdueReason?: string } }) => { executionUpdates.push(data); return { count: 1 } }),
    stub(prisma.taskApproval, 'create', async () => approval),
    stub(prisma.taskApprovalStep, 'create', async () => ({})),
    stub(prisma.taskApprovalDeliverable, 'createMany', async () => ({ count: 0 })),
    stub(prisma.outboxEvent, 'create', async () => ({})),
    stub(prisma.auditLog, 'create', async () => ({})),
  ]
  try {
    const result = await submitTaskApproval({ organizationId: 'org-1', actorMemberId: 'executor', actorName: '执行者', taskId: 'task-1', progress: 100, deliveryType: 'FINAL', source: 'PROJECT_OS' })
    assert.equal(result.id, 'approval-1')
    assert.equal(executionUpdates[0]?.overdueReason, undefined)
  } finally {
    restores.reverse().forEach((restore) => restore())
  }
})
