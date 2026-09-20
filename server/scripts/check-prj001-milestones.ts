import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const project = await prisma.project.findFirst({ where: { code: 'PRJ-001' }, select: { id: true, code: true, workflow: { select: { draftVersion: { select: { id: true, versionNo: true } }, publishedVersion: { select: { id: true, versionNo: true } } } } } })
  const wf = project!.workflow!
  const version = wf.publishedVersion ?? wf.draftVersion
  console.log('using:', wf.publishedVersion ? 'published v' + wf.publishedVersion.versionNo : 'draft v' + (wf.draftVersion?.versionNo ?? '-'))
  const nodes = await prisma.workflowNode.findMany({
    where: { workflowVersionId: version!.id, nodeType: { in: ['TASK', 'MILESTONE'] } },
    select: { id: true, name: true, taskId: true, schedules: { orderBy: { computedAt: 'desc' }, take: 1, select: { plannedStart: true, plannedEnd: true } }, task: { select: { execution: { select: { status: true } } } } },
  })
  const now = Date.now()
  const horizon = new Date(now + 30 * 864e5).toISOString().slice(0, 10)
  const recent = new Date(now - 30 * 864e5).toISOString().slice(0, 10)
  console.log('window:', recent, '→', horizon)
  for (const n of nodes) {
    const s = n.schedules[0]
    const ps = s ? s.plannedStart.toISOString().slice(0, 10) : null
    const pe = s ? s.plannedEnd.toISOString().slice(0, 10) : null
    const status = n.task?.execution?.status ?? 'NOT_STARTED'
    const included = Boolean(s && ps && pe && !(ps > horizon || pe < recent))
    console.log(n.name + ' | plan ' + ps + ' → ' + pe + ' | ' + status + ' | panel: ' + (included ? 'INCLUDE' : 'EXCLUDED'))
  }
}
main().finally(() => prisma.$disconnect())
