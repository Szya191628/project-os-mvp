/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Prisma doubles exercise the real HTTP route. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { prisma } from '../server/src/db.ts'
import { registerWriteRoutes } from '../server/src/routes/writes.ts'

test('L1/L2 can edit a published independent task while L3 is rejected', async () => {
  const restorers: (() => void)[] = []
  const stub = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key)
    Reflect.set(target, key, replacement)
    restorers.push(() => Reflect.set(target, key, original))
  }
  let actor = { memberId: 'l2', organizationId: 'org', roleCodes: ['L2'] }
  const row: any = { id: 'task-1', organizationId: 'org', publisherMemberId: 'publisher', name: '旧任务', departmentIds: [], description: '旧说明', closureCriteria: '旧标准', durationDays: 1, effortHours: 8, archivedAt: null }
  const app = Fastify()
  stub(prisma.claimTask, 'findFirst', async () => row)
  stub(prisma.claimTask, 'update', async ({ data }: any) => { Object.assign(row, data); return row })
  stub(prisma.department, 'count', async () => 1)
  stub(prisma.projectRoleGrant, 'findFirst', async () => null)
  stub(prisma.auditLog, 'create', async () => ({}))
  app.decorateRequest('actor', null)
  app.addHook('preHandler', async (request) => { request.actor = actor })
  await registerWriteRoutes(app)
  try {
    const edited = await app.inject({ method: 'PUT', url: '/api/v1/claim-tasks/task-1', payload: { name: '新任务', duration: 3, effort: 24, description: '', closureCriteria: '新标准', departmentIds: [] } })
    assert.equal(edited.statusCode, 200)
    assert.equal(row.name, '新任务')
    assert.equal(row.description, null)
    assert.equal(row.durationDays, 3)
    actor = { memberId: 'l3', organizationId: 'org', roleCodes: ['L3'] }
    const forbidden = await app.inject({ method: 'PUT', url: '/api/v1/claim-tasks/task-1', payload: { name: '越权修改' } })
    assert.equal(forbidden.statusCode, 403)
  } finally {
    await app.close()
    restorers.reverse().forEach((restore) => restore())
    await prisma.$disconnect()
  }
})
