/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Prisma doubles exercise the real HTTP routes. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { prisma } from '../server/src/db.ts'
import { registerProjectRoutes } from '../server/src/routes/projects.ts'
import { registerWriteRoutes } from '../server/src/routes/writes.ts'

test('independent tasks: multiple departments, roles, organization isolation and exclusive claim', async () => {
  const a = '00000000-0000-4000-8000-000000000001'
  const b = '00000000-0000-4000-8000-000000000002'
  const restorers: (() => void)[] = []
  const stub = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key)
    Reflect.set(target, key, replacement)
    restorers.push(() => { Reflect.set(target, key, original) })
  }
  let actor = { memberId: 'publisher', organizationId: 'org', roleCodes: ['L1'] }
  const rows: any[] = []
  const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((condition: any) => matches(row, condition))
    if (key === 'departmentIds') return value.isEmpty ? row.departmentIds.length === 0 : row.departmentIds.some((id: string) => value.hasSome.includes(id))
    return row[key] === value
  })
  const app = Fastify()
  stub(prisma.department, 'count', async ({ where }: any) => where.id.in.filter((id: string) => [a, b].includes(id)).length)
  stub(prisma.department, 'findMany', async () => [{ id: a, name: '研发' }, { id: b, name: '运营' }])
  stub(prisma.member, 'findFirst', async () => ({ departmentId: actor.memberId === 'primary' ? a : null, memberDepartments: actor.memberId === 'secondary' ? [{ departmentId: b }] : [] }))
  stub(prisma.projectRoleGrant, 'findFirst', async () => null)
  stub(prisma.claimTask, 'create', async ({ data }: any) => {
    const row = { ...data, id: `task-${rows.length}`, archivedAt: null, claimedByMemberId: null, status: 'NOT_STARTED', progress: 0, publisher: { name: '发布人' } }
    rows.push(row)
    return row
  })
  stub(prisma.claimTask, 'findMany', async ({ where }: any) => rows.filter((row) => matches(row, where)))
  stub(prisma.claimTask, 'findFirst', async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null)
  stub(prisma.claimTask, 'updateMany', async ({ where, data }: any) => {
    const row = rows.find((item) => matches(item, where))
    if (!row) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  })
  stub(prisma, '$transaction', async (callback: any) => callback(prisma))
  stub(prisma.auditLog, 'create', async () => ({}))
  app.decorateRequest('actor', null)
  app.addHook('preHandler', async (request) => { request.actor = actor })
  await registerProjectRoutes(app)
  await registerWriteRoutes(app)
  const publish = (departmentIds: unknown) => app.inject({ method: 'POST', url: '/api/v1/claim-tasks', payload: { name: '部门任务', departmentIds } })
  const list = () => app.inject('/api/v1/claim-tasks')
  const edit = (payload: object) => app.inject({ method: 'PUT', url: '/api/v1/claim-tasks/task-0', payload })
  const claim = () => app.inject({ method: 'POST', url: '/api/v1/claim-tasks/task-0/claim', payload: {} })
  try {
    assert.equal((await publish([a, b, a])).statusCode, 201)
    assert.deepEqual(rows[0].departmentIds, [a, b])
    const publisherTasks = (await list()).json().data
    assert.equal(publisherTasks.length, 1, 'publisher can inspect own task')
    assert.deepEqual(publisherTasks[0].claimDepartmentNames, ['研发', '运营'])
    assert.equal((await claim()).statusCode, 409, 'L1 outside allowed departments cannot claim')
    actor.roleCodes = ['L2']
    assert.equal((await publish([])).statusCode, 201, 'L2 can publish to all departments')
    assert.equal((await claim()).statusCode, 409, 'L2 outside allowed departments cannot claim')
    assert.equal((await publish('invalid')).statusCode, 400)
    assert.equal((await publish(['invalid'])).statusCode, 400)
    assert.equal((await publish(['00000000-0000-4000-8000-000000000099'])).statusCode, 400)
    actor = { memberId: 'outsider', organizationId: 'org', roleCodes: ['L3'] }
    assert.equal((await publish([a])).statusCode, 403, 'L3 cannot publish')
    assert.equal((await edit({ name: '越权修改' })).statusCode, 403, 'L3 cannot edit a published task')
    const outsiderTasks = (await list()).json().data
    assert.equal(outsiderTasks.length, 1, 'outside departments only sees unrestricted task')
    assert.deepEqual(outsiderTasks[0].claimDepartmentNames, ['全部部门'])
    assert.equal((await claim()).statusCode, 409, 'direct claim cannot bypass departments')
    actor.memberId = 'primary'
    assert.equal((await list()).json().data.length, 2, 'primary department matches')
    actor.memberId = 'secondary'
    assert.equal((await list()).json().data.length, 2, 'additional department matches')
    actor.organizationId = 'other-org'
    assert.equal((await list()).json().data.length, 0)
    assert.equal((await claim()).statusCode, 409)
    actor.organizationId = 'org'
    const attempts = await Promise.all([claim(), claim()])
    assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [201, 409])
    assert.equal(rows[0].claimedByMemberId, 'secondary')
    assert.equal((await list()).json().data.length, 1, 'claimed task leaves pool')
  } finally {
    await app.close()
    restorers.reverse().forEach((restore) => restore())
    await prisma.$disconnect()
  }
})
