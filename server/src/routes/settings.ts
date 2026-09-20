import type { FastifyInstance } from 'fastify'
import { appendAuditLog, isL1 } from '../auth.js'
import { prisma } from '../db.js'
import { DINGTALK_INTEGRATION_DISABLED } from '../dingtalkPolicy.js'
import { setDingTalkIntegrationState } from '../dingtalkBot.js'

type DingTalkSettingsBody = { enabled?: boolean }

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/api/v1/settings/dingtalk', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const organization = await prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { dingtalkIntegrationEnabled: true } })
    if (!organization) return reply.code(404).send({ error: 'organization_not_found' })
    return { data: { enabled: organization.dingtalkIntegrationEnabled, loginOnlyWhenDisabled: true, canManage: isL1(actor) } }
  })

  app.patch<{ Body: DingTalkSettingsBody }>('/api/v1/settings/dingtalk', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    if (!isL1(actor)) return reply.code(403).send({ error: 'forbidden', permission: 'dingtalk.integration.manage' })
    if (typeof request.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'dingtalk_integration_enabled_required' })

    const enabled = request.body.enabled
    const settings = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.update({ where: { id: actor.organizationId }, data: { dingtalkIntegrationEnabled: enabled }, select: { dingtalkIntegrationEnabled: true } })
      let stoppedDeliveries = 0
      if (!enabled) {
        const result = await tx.notificationDelivery.updateMany({
          where: { channel: 'DINGTALK', status: { in: ['PENDING', 'FAILED'] }, notification: { organizationId: actor.organizationId } },
          data: { status: 'FAILED', nextAttemptAt: null, lastError: DINGTALK_INTEGRATION_DISABLED },
        })
        stoppedDeliveries = result.count
      }
      return { enabled: organization.dingtalkIntegrationEnabled, stoppedDeliveries }
    })

    await appendAuditLog({ request, action: 'DINGTALK_INTEGRATION_TOGGLED', resourceType: 'ORGANIZATION', resourceId: actor.organizationId, afterJson: { enabled: settings.enabled, stoppedDeliveries: settings.stoppedDeliveries } })
    try {
      await setDingTalkIntegrationState(actor.organizationId, settings.enabled)
    } catch (error) {
      request.log.error({ err: error }, 'DingTalk integration runtime state update failed')
      return reply.code(503).send({ error: 'dingtalk_integration_runtime_update_failed', enabled: settings.enabled })
    }
    return { data: { enabled: settings.enabled, loginOnlyWhenDisabled: true, canManage: true, stoppedDeliveries: settings.stoppedDeliveries } }
  })
}
