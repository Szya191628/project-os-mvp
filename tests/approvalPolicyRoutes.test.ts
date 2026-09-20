/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma test doubles implement only the selected fields; no database is connected. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { prisma } from '../server/src/db.ts'
import { registerApprovalRoutes } from '../server/src/routes/approvals.ts'
import { expandSequentialApprovers } from '../server/src/approvalRecipientAccess.ts'

test('project OA configuration round trip and designated inbox permissions without external calls', async () => {
  const restorers: (() => void)[] = []
  const stub = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key)
    Reflect.set(target, key, replacement)
    restorers.push(() => { Reflect.set(target, key, original) })
  }
  const app = Fastify()
  let actorId = 'reviewer'
  let policy: any = null
  const members = ['reviewer', 'cc', 'other'].map((id) => ({ id, name: id, memberRoles: [{ role: { code: 'L1' } }], projectRoleGrants: [], projectMemberships: [] }))
  stub(prisma.project, 'findFirst', async ({ where }: any) => where.id === 'project' ? { id: 'project' } : null)
  stub(prisma.member, 'findMany', async () => members)
  stub(prisma.member, 'findFirst', async () => members.find((member) => member.id === actorId))
  stub(prisma.approvalPolicy, 'findUnique', async () => policy)
  stub(prisma.approvalPolicy, 'upsert', async ({ create }: any) => {
    policy = { id: 'policy', projectId: 'project', version: 1, enabled: create.enabled, steps: create.steps.create }
    return policy
  })
  stub(prisma, '$transaction', async (callback: any) => callback(prisma))
  stub(prisma.auditLog, 'create', async () => ({}))
  const approval = () => ({ id: 'approval', taskId: 'task', source: 'PROJECT_OS', status: 'PENDING', currentStepNo: 1, policySnapshot: policy.steps, createdAt: new Date(), completedAt: null, _count: { packageLinks: 1 }, steps: [{ ...policy.steps[0], status: 'PENDING', decidedAt: null }], task: { project: { id: 'project', code: 'P', name: 'Project', organization: { name: 'Org' } }, execution: { progress: 0 }, assignees: [], nodes: [] } })
  stub(prisma.taskApproval, 'findMany', async () => [approval()])
  stub(prisma.taskApproval, 'findFirst', async () => approval())
  app.decorateRequest('actor', null)
  app.addHook('preHandler', async (request) => { request.actor = { memberId: actorId, organizationId: 'org', roleCodes: ['L1'] } })
  await registerApprovalRoutes(app)
  try {
    const payload = { enabled: true, steps: [{ stage: 'L2', mode: 'ANY', minApprovals: 1, approverMemberIds: ['reviewer'], ccMemberIds: ['cc'] }] }
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/projects/project/approval-policy', payload })
    assert.equal(saved.statusCode, 200, saved.body)
    const read = await app.inject('/api/v1/projects/project/approval-policy')
    assert.deepEqual(read.json().data.steps[0].approverMemberIds, ['reviewer'])
    assert.deepEqual(read.json().data.steps[0].ccMemberIds, ['cc'])
    for (const [id, canDecide, recipientType] of [['reviewer', true, 'APPROVER'], ['cc', false, 'CC'], ['other', false, 'MANAGER']]) {
      actorId = id as string
      const inbox = await app.inject('/api/v1/approvals')
      assert.equal(inbox.statusCode, 200, inbox.body)
      assert.equal(inbox.json().data[0].canDecide, canDecide)
      assert.equal(inbox.json().data[0].recipientType, recipientType)
      if (!canDecide) {
        const decision = await app.inject({ method: 'POST', url: '/api/v1/approvals/approval/decision', payload: { outcome: 'APPROVED' } })
        assert.equal(decision.statusCode, 403, decision.body)
      }
    }
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/projects/project/approval-policy', payload: { ...payload, steps: [{ ...payload.steps[0], approverMemberIds: 'reviewer' }] } })
    assert.equal(bad.statusCode, 400)
    assert.equal((await app.inject('/api/v1/projects/another-org-project/approval-policy')).statusCode, 404)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/projects/another-org-project/approval-policy', payload })).statusCode, 404)
    const multi = await app.inject({ method: 'PUT', url: '/api/v1/projects/project/approval-policy', payload: { ...payload, steps: [{ ...payload.steps[0], approverMemberIds: ['reviewer', 'other'] }] } })
    assert.equal(multi.statusCode, 200)
    assert.deepEqual(multi.json().data.steps[0].approverMemberIds, ['reviewer', 'other'])
    const snapshot = expandSequentialApprovers(policy.steps)
    const live: any = { ...approval(), processInstanceId: 'project-os:first', policySnapshot: snapshot, steps: [{ ...snapshot[0], processInstanceId: 'project-os:first', status: 'PENDING' }], formValues: {}, submitterDingUserId: null }
    stub(prisma.taskApproval, 'findFirst', async () => ({ ...live, steps: live.steps.filter((step: any) => step.status === 'PENDING') }))
    stub(prisma.taskApproval, 'findUnique', async () => live)
    stub(prisma.taskApproval, 'findMany', async () => [live])
    stub(prisma.taskApproval, 'update', async ({ data }: any) => Object.assign(live, data))
    stub(prisma.taskApprovalStep, 'updateMany', async ({ where, data }: any) => {
      const matches = live.steps.filter((step: any) => step.processInstanceId === where.processInstanceId && step.status === where.status)
      matches.forEach((step: any) => Object.assign(step, data))
      return { count: matches.length }
    })
    stub(prisma.taskApprovalStep, 'create', async ({ data }: any) => { live.steps.push({ ...data, status: 'PENDING' }); return data })
    const task = { projectId: 'project', project: { organizationId: 'org' } }
    stub(prisma.task, 'findUnique', async () => task)
    stub(prisma.task, 'findFirst', async () => task)
    stub(prisma.outboxEvent, 'create', async () => ({}))
    const decide = () => app.inject({ method: 'POST', url: '/api/v1/approvals/approval/decision', payload: { outcome: 'APPROVED' } })
    actorId = 'other'
    assert.equal((await decide()).statusCode, 403, 'second reviewer cannot approve first level')
    actorId = 'reviewer'
    const first = await decide()
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(live.currentStepNo, 2)
    assert.equal(live.status, 'PENDING', 'first approval does not finish the process')
    assert.equal(live.steps[0].status, 'APPROVED')
    assert.equal((await decide()).statusCode, 403, 'previous reviewer cannot approve second level')
    actorId = 'other'
    assert.equal((await app.inject('/api/v1/approvals')).json().data[0].canDecide, true)
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/approvals/approval/decision', payload: { outcome: 'REJECTED' } })
    assert.equal(rejected.statusCode, 200, rejected.body)
    assert.equal(live.status, 'REJECTED')
  } finally {
    await app.close()
    restorers.reverse().forEach((restore) => restore())
    await prisma.$disconnect()
  }
})
