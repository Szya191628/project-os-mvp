/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma route test double only inspects the notification filter. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { prisma } from '../server/src/db.ts'
import { registerNotificationRoutes } from '../server/src/routes/notifications.ts'

test('通知中心隐藏已完成任务的临期和超期提醒', async () => {
  const app = Fastify()
  const restores: (() => void)[] = []
  const stub = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key)
    Reflect.set(target, key, replacement)
    restores.push(() => Reflect.set(target, key, original))
  }
  let query: any
  const completedReminder = {
    notificationId: 'notification-1', readAt: null, acknowledgedAt: null,
    notification: {
      id: 'notification-1', projectId: 'project-1', taskId: 'task-1', eventType: 'TASK_OVERDUE',
      title: '任务已延期：1.4 低洼地王', body: '当前任务尚未完成', dueDate: new Date('2026-09-13'), createdAt: new Date('2026-09-16'),
      project: { id: 'project-1', code: 'PRJ-005', name: '天线开发' }, task: { nodes: [{ name: '1.4 低洼地王' }] },
    },
  }
  stub(prisma.notificationRecipient, 'findMany', async (input: any) => {
    query = input
    return JSON.stringify(input.where).includes('OVERDUE_FINISHED') ? [] : [completedReminder]
  })
  stub(prisma.notificationDelivery, 'findMany', async () => [])
  app.decorateRequest('actor', null)
  app.addHook('preHandler', async (request) => { request.actor = { memberId: 'member-1', organizationId: 'org-1', roleCodes: ['L3'] } })
  await registerNotificationRoutes(app)
  try {
    const response = await app.inject('/api/v1/notifications')
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().data, [])
    assert.match(JSON.stringify(query.where), /OVERDUE_FINISHED/)
    assert.match(JSON.stringify(query.where), /archivedAt/)
    assert.match(JSON.stringify(query.include), /versionNo/)
  } finally {
    await app.close()
    restores.reverse().forEach((restore) => restore())
  }
})

test('通知确认、批量删除和模板管理保持权限与租户边界', async () => {
  const app = Fastify()
  const restores: (() => void)[] = []
  const calls: { acknowledge?: any; delete?: any; upsert?: any } = {}
  const stub = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key)
    Reflect.set(target, key, replacement)
    restores.push(() => Reflect.set(target, key, original))
  }
  stub(prisma.notificationRecipient, 'updateMany', async (input: any) => { calls.acknowledge = input; return { count: 1 } })
  stub(prisma.notificationRecipient, 'deleteMany', async (input: any) => { calls.delete = input; return { count: 2 } })
  stub(prisma.notificationTemplate, 'findMany', async () => [])
  stub(prisma.notificationTemplate, 'upsert', async (input: any) => {
    calls.upsert = input
    return { eventType: 'TASK_OVERDUE', channel: 'DINGTALK', titleTemplate: input.create.titleTemplate, bodyTemplate: input.create.bodyTemplate, enabled: true, updatedAt: new Date() }
  })
  app.decorateRequest('actor', null)
  app.addHook('preHandler', async (request) => { request.actor = { memberId: 'member-1', organizationId: 'org-1', roleCodes: ['L1'] } })
  await registerNotificationRoutes(app)
  try {
    const templates = await app.inject('/api/v1/notification-templates')
    assert.equal(templates.statusCode, 200, templates.body)
    assert.ok(templates.json().data.length > 0)

    const saved = await app.inject({ method: 'PUT', url: '/api/v1/notification-templates/TASK_OVERDUE', payload: { titleTemplate: '标题', bodyTemplate: '正文', enabled: true } })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(calls.upsert.create.titleTemplate, '标题')

    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/notification-templates/INVALID', payload: {} })
    assert.equal(invalid.statusCode, 400)

    const acknowledged = await app.inject({ method: 'POST', url: '/api/v1/notifications/notification-1/acknowledge', payload: {} })
    assert.equal(acknowledged.statusCode, 200, acknowledged.body)
    assert.equal(calls.acknowledge.where.memberId, 'member-1')
    assert.equal(calls.acknowledge.where.notification.organizationId, 'org-1')

    const emptyDelete = await app.inject({ method: 'POST', url: '/api/v1/notifications/batch-delete', payload: {} })
    assert.equal(emptyDelete.statusCode, 400)
    const deleted = await app.inject({ method: 'POST', url: '/api/v1/notifications/batch-delete', payload: { ids: ['notification-1', 'notification-2'] } })
    assert.equal(deleted.statusCode, 200, deleted.body)
    assert.equal(deleted.json().data.deleted, 2)
    assert.equal(calls.delete.where.memberId, 'member-1')
    assert.equal(calls.delete.where.notification.organizationId, 'org-1')
  } finally {
    await app.close()
    restores.reverse().forEach((restore) => restore())
  }
})
