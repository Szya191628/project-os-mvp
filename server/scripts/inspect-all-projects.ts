import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const projects = await prisma.project.findMany({ where: { archivedAt: null }, select: { id: true, code: true, name: true, workflow: { select: { draftVersion: { select: { id: true, versionNo: true } }, publishedVersion: { select: { id: true, versionNo: true } } } } } })
  for (const p of projects) {
    const draft = p.workflow?.draftVersion
    const published = p.workflow?.publishedVersion
    const version = draft ?? published
    const label = draft ? 'draft v' + draft.versionNo : 'published v' + (published ? published.versionNo : '-')
    if (!version) { console.log(p.code, p.name, ': no version'); continue }
    const nodes = await prisma.workflowNode.findMany({ where: { workflowVersionId: version.id, nodeType: { in: ['TASK', 'MILESTONE'] } }, include: { task: { include: { execution: { select: { status: true } } } } }, orderBy: { wbs: 'asc' } })
    console.log(p.code, p.name, '[' + label + ']')
    for (const n of nodes) {
      const exec = n.task?.execution
      console.log('   ' + n.wbs + ' "' + n.name + '" exec=' + (exec ? exec.status : 'NONE'))
    }
  }
}
main().finally(() => prisma.$disconnect())
