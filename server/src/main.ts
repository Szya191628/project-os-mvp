import { buildApp } from './app.js'
import { closeDatabase } from './db.js'
import { config } from './config.js'
import { startDingTalkBot } from './dingtalkBot.js'
import { startNotificationWorker } from './notifications/notificationWorker.js'

const app = await buildApp()
const dingtalkBot = await startDingTalkBot(app)
const notificationWorker = startNotificationWorker(app.log)

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  await closeDatabase()
  process.exit(1)
}

const shutdown = async () => {
  notificationWorker.stop()
  dingtalkBot.stop()
  await app.close()
  await closeDatabase()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
