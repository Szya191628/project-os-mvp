import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NotificationEventType as PrismaNotificationEventType, TaskExecutionStatus as PrismaTaskExecutionStatus } from '@prisma/client'
import { isGlobalL2, isL1 } from '../auth.js'
import { prisma } from '../db.js'
import { DEFAULT_NOTIFICATION_TEMPLATES, type NotificationEvent } from '../notifications/taskEvents.js'

const eventTypes = Object.keys(DEFAULT_NOTIFICATION_TEMPLATES) as NotificationEvent[]
const workflowNoticeEvents: PrismaNotificationEventType[] = ['TASK_PUBLISHED', 'TASK_READY', 'TASK_DUE_SOON', 'TASK_OVERDUE', 'TASK_ASSIGNEE_CHANGED', 'TASK_SCHEDULE_CHANGED']
const taskReminderEvents: PrismaNotificationEventType[] = ['TASK_DUE_SOON', 'TASK_OVERDUE']
const completedTaskStatuses: PrismaTaskExecutionStatus[] = ['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED']

async function requireNotificationManager(request: FastifyRequest, reply: FastifyReply) {
  const actor = request.actor
  if (!actor) { await reply.code(401).send({ error: 'authentication_required' }); return null }
  const projectL2 = !isL1(actor) && !isGlobalL2(actor) && await prisma.projectRoleGrant.count({ where: { memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } } }) > 0
  if (!isL1(actor) && !isGlobalL2(actor) && !projectL2) { await reply.code(403).send({ error: 'forbidden', permission: 'notification.manage' }); return null }
  return actor
}

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get('/api/v1/notifications', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    try {
      const rows = await prisma.notificationRecipient.findMany({
        where: {
          memberId: actor.memberId,
          notification: {
            organizationId: actor.organizationId,
            AND: [
              {
                OR: [
                  { eventType: { notIn: workflowNoticeEvents } },
                  { eventType: { in: workflowNoticeEvents }, task: { archivedAt: null } },
                ],
              },
              {
                OR: [
                  { eventType: { notIn: taskReminderEvents } },
                  { eventType: { in: taskReminderEvents }, task: { execution: { status: { notIn: completedTaskStatuses } } } },
                ],
              },
            ],
          },
        },
        orderBy: { createdAt: 'desc' }, take: 100,
        include: { notification: { include: { project: { select: { id: true, code: true, name: true } }, task: { select: { nodes: { where: { workflowVersion: { status: 'PUBLISHED' } }, orderBy: { workflowVersion: { versionNo: 'desc' } }, take: 1, select: { name: true } } } } }, }, },
      })
      const deliveries = await prisma.notificationDelivery.findMany({ where: { memberId: actor.memberId, notificationId: { in: rows.map((row) => row.notificationId) }, channel: 'DINGTALK' }, select: { notificationId: true, status: true, sentAt: true } })
      const deliveryByNotification = new Map(deliveries.map((delivery) => [delivery.notificationId, delivery]))
      return { data: rows.map((row) => ({ id: row.notification.id, projectId: row.notification.projectId, taskId: row.notification.taskId, projectCode: row.notification.project?.code ?? '', projectName: row.notification.project?.name ?? '', taskName: row.notification.task?.nodes[0]?.name ?? '', eventType: row.notification.eventType, title: row.notification.title, body: row.notification.body, dueDate: row.notification.dueDate?.toISOString() ?? null, createdAt: row.notification.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null, acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, delivery: deliveryByNotification.get(row.notificationId) ?? null })) }
    } catch (error) {
      app.log.error(error, 'notifications fetch failed')
      return reply.code(500).send({ error: 'notifications_fetch_failed' })
    }
  })

  app.post<{ Params: { notificationId: string } }>('/api/v1/notifications/:notificationId/acknowledge', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const updated = await prisma.notificationRecipient.updateMany({ where: { notificationId: request.params.notificationId, memberId: actor.memberId, notification: { organizationId: actor.organizationId } }, data: { acknowledgedAt: new Date(), readAt: new Date() } })
    if (updated.count === 0) return reply.code(404).send({ error: 'notification_not_found' })
    return { data: { notificationId: request.params.notificationId, acknowledged: true } }
  })

  // 批量删除：只删除当前登录人的收件记录（NotificationRecipient），其他接收人不受影响
  app.post('/api/v1/notifications/batch-delete', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const body = (request.body ?? {}) as { ids?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    if (ids.length === 0) return reply.code(400).send({ error: 'no_notifications_selected' })
    const removed = await prisma.notificationRecipient.deleteMany({ where: { memberId: actor.memberId, notificationId: { in: ids }, notification: { organizationId: actor.organizationId } } })
    return { data: { deleted: removed.count } }
  })

  app.get('/api/v1/notification-templates', async (request, reply) => {
    const actor = await requireNotificationManager(request, reply)
    if (!actor) return
    const custom = await prisma.notificationTemplate.findMany({ where: { organizationId: actor.organizationId, channel: 'DINGTALK' } })
    const byType = new Map(custom.map((item) => [item.eventType as NotificationEvent, item]))
    return { data: eventTypes.map((eventType) => { const item = byType.get(eventType); const fallback = DEFAULT_NOTIFICATION_TEMPLATES[eventType]; return { eventType, channel: 'DINGTALK', titleTemplate: item?.titleTemplate ?? fallback.titleTemplate, bodyTemplate: item?.bodyTemplate ?? fallback.bodyTemplate, enabled: item?.enabled ?? true, customized: Boolean(item), updatedAt: item?.updatedAt?.toISOString() ?? null } }) }
  })

  app.put<{ Params: { eventType: string }; Body: { titleTemplate?: string; bodyTemplate?: string; enabled?: boolean } }>('/api/v1/notification-templates/:eventType', async (request, reply) => {
    const actor = await requireNotificationManager(request, reply)
    if (!actor) return
    const eventType = request.params.eventType as NotificationEvent
    if (!eventTypes.includes(eventType)) return reply.code(400).send({ error: 'invalid_notification_event_type' })
    const fallback = DEFAULT_NOTIFICATION_TEMPLATES[eventType]
    const titleTemplate = request.body?.titleTemplate?.trim() || fallback.titleTemplate
    const bodyTemplate = request.body?.bodyTemplate?.trim() || fallback.bodyTemplate
    if (titleTemplate.length > 200 || bodyTemplate.length > 4000) return reply.code(413).send({ error: 'notification_template_too_long' })
    const item = await prisma.notificationTemplate.upsert({ where: { organizationId_eventType_channel: { organizationId: actor.organizationId, eventType: eventType as PrismaNotificationEventType, channel: 'DINGTALK' } }, update: { titleTemplate, bodyTemplate, enabled: request.body?.enabled ?? true, updatedById: actor.memberId }, create: { organizationId: actor.organizationId, eventType: eventType as PrismaNotificationEventType, channel: 'DINGTALK', titleTemplate, bodyTemplate, enabled: request.body?.enabled ?? true, updatedById: actor.memberId } })
    return { data: { eventType: item.eventType, channel: item.channel, titleTemplate: item.titleTemplate, bodyTemplate: item.bodyTemplate, enabled: item.enabled, customized: true, updatedAt: item.updatedAt.toISOString() } }
  })
}
