import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

function st(x: string | undefined | null) { return x ?? 'NONE' }

async function main() {
  const project = await prisma.project.findFirst({ where: { code: 'API-TEST-001' }, select: { id: true, code: true } })
  if (!project) { console.log('not found'); return }
  const wf = await prisma.workflow.findUnique({ where: { projectId: project.id }, include: { draftVersion: { select: { id: true, versionNo: true } }, publishedVersion: { select: { id: true, versionNo: true } } } })
  console.log('draft v' + (wf?.draftVersion?.versionNo ?? '-'), '| published v' + (wf?.publishedVersion?.versionNo ?? '-'))
  const version = (wf?.draftVersion ?? wf?.publishedVersion)!
  const nodes = await prisma.workflowNode.findMany({ where: { workflowVersionId: version.id, nodeType: { in: ['TASK', 'MILESTONE'] } }, include: { task: { include: { execution: true } } }, orderBy: { wbs: 'asc' } })
  const edges = await prisma.workflowEdge.findMany({ where: { workflowVersionId: version.id }, include: { sourceNode: { select: { wbs: true, nodeType: true } }, targetNode: { select: { wbs: true } } } })
  console.log('--- nodes (' + version.versionNo + ') ---')
  for (const n of nodes) {
    const e = n.task?.execution
    console.log(n.wbs, '"' + n.name + '"', 'exec=' + st(e?.status), 'progress=' + (e?.progress ?? '-'), 'readyAt=' + (e?.readyAt?.toISOString().slice(0, 10) ?? '-'), 'task=' + (n.taskId ?? '-').slice(0, 8))
  }
  console.log('--- edges ---')
  for (const e of edges) console.log((e.sourceNode.nodeType === 'START' ? 'START' : e.sourceNode.wbs) + ' -> ' + e.targetNode.wbs)
  const notifs = await prisma.notification.findMany({ where: { project: { code: 'API-TEST-001' } }, orderBy: { createdAt: 'desc' }, take: 5, select: { eventType: true, title: true, createdAt: true } })
  console.log('--- recent notifications ---')
  for (const n of notifs) console.log(n.createdAt.toISOString(), n.eventType, n.title)
}
main().finally(() => prisma.$disconnect())
