import type { FastifyInstance } from 'fastify'
import { appendAuditLog, hasAgentPermission } from '../auth.js'
import { runProjectAgent } from '../agent/projectAgent.js'
import type { AgentAttachment } from '../agent/types.js'

type AgentBody = {
  message?: string
  projectId?: string
  conversationId?: string
  attachment?: AgentAttachment
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.post<{ Body: AgentBody }>('/api/v1/agent/query', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    if (!(await hasAgentPermission(actor))) return reply.code(403).send({ error: 'forbidden', permission: 'agent.use' })
    const message = request.body?.message?.trim() ?? ''
    if (!message && !request.body?.attachment) return reply.code(400).send({ error: 'message_required' })
    if (message.length > 2000) return reply.code(413).send({ error: 'message_too_long' })

    const result = await runProjectAgent(actor, {
      message,
      projectId: request.body?.projectId,
      conversationId: request.body?.conversationId,
      channel: 'web',
      attachment: request.body?.attachment,
    })
    await appendAuditLog({
      request,
      action: 'AGENT_QUERY',
      resourceType: 'AGENT_RUN',
      resourceId: result.runId,
      projectId: request.body?.projectId,
      afterJson: { status: result.status, intent: result.intent, sourceLabel: result.sourceLabel },
    })
    return { data: result }
  })
}
