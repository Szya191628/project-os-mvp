import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { config } from './config.js'
import { registerAuthHooks } from './auth.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerWriteRoutes } from './routes/writes.js'
import { registerAccessRoutes } from './routes/access.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerAgentRoutes } from './routes/agent.js'
import { registerTemplateRoutes } from './routes/templates.js'
import { registerNotificationRoutes } from './routes/notifications.js'
import { registerDeliverableRoutes } from './routes/deliverables.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerResourceRoutes } from './routes/resources.js'

export async function buildApp() {
  const app = Fastify({ logger: true })

  await app.register(cors, {
    origin: config.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: config.deliverables.maxSizeBytes, files: 1, fields: 12 } })
  await registerAuthHooks(app)
  await registerHealthRoutes(app)
  await registerAuthRoutes(app)
  await registerAgentRoutes(app)
  await registerTemplateRoutes(app)
  await registerNotificationRoutes(app)
  await registerDeliverableRoutes(app)
  await registerApprovalRoutes(app)
  await registerSettingsRoutes(app)
  await registerResourceRoutes(app)
  await registerProjectRoutes(app)
  await registerAccessRoutes(app)
  await registerWriteRoutes(app)

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error)
    return reply.code(500).send({ error: 'internal_server_error' })
  })

  return app
}
