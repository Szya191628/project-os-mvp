import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'node:fs'

const prisma = new PrismaClient()

const TODAY = '2026-09-07'

async function main() {
  const ids = ['a2b47665-68c2-4c2a-add0-1f71816d84a3', 'c66d1c43-f20b-4eb0-ba41-4e754b4397a3', 'f96d297c-0099-49a0-afe3-f5a59fea0692']
  const before = await prisma.taskExecution.findMany({ where: { taskId: { in: ids } } })
  writeFileSync('scripts/.prj001-exec-backup.json', JSON.stringify(before, null, 2), 'utf-8')
  console.log('backed up', before.length, 'execution rows')

  // 1.1 → 如期结束（今天完成）
  const r1 = await prisma.taskExecution.update({ where: { taskId: 'a2b47665-68c2-4c2a-add0-1f71816d84a3' }, data: { status: 'ON_TIME_FINISHED', progress: 100, actualStart: new Date('2026-09-07'), actualEnd: new Date(TODAY), completionConfirmedAt: new Date(TODAY) } })
  console.log('1.1 ->', r1.status, r1.actualStart?.toISOString().slice(0, 10), '→', r1.actualEnd?.toISOString().slice(0, 10))

  // 1.2 → 修正矛盾日期（end ≥ start）
  const r2 = await prisma.taskExecution.update({ where: { taskId: 'c66d1c43-f20b-4eb0-ba41-4e754b4397a3' }, data: { actualEnd: new Date('2026-09-02') } })
  console.log('1.2 -> actualEnd =', r2.actualEnd?.toISOString().slice(0, 10), '(start 2026-09-02)')

  // 1.3 → 重置为未开始（此前在前置未完成时就开始了），1.1 已完成所以标记已解锁
  const r3 = await prisma.taskExecution.update({ where: { taskId: 'f96d297c-0099-49a0-afe3-f5a59fea0692' }, data: { status: 'NOT_STARTED', progress: 0, actualStart: null, readyAt: new Date(TODAY) } })
  console.log('1.3 ->', r3.status, 'readyAt =', r3.readyAt?.toISOString().slice(0, 10))
}

main().finally(() => prisma.$disconnect())
