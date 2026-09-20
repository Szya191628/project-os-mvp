import type { FastifyInstance } from 'fastify'
import { prisma } from '../db.js'

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'project-os-api',
  }))

  app.get('/readyz', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return { status: 'ready', database: 'ok' }
    } catch {
      return reply.code(503).send({ status: 'not_ready', database: 'unavailable' })
    }
  })
}
