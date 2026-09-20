import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const project = await prisma.project.findFirst({ where: { code: 'PRJ-001' }, select: { id: true, code: true, name: true } })
  if (!project) { console.log('project not found'); return }

  const wf = await prisma.workflow.findUnique({
    where: { projectId: project.id },
    include: {
      draftVersion: true,
      publishedVersion: true,
    },
  })
  if (!wf) { console.log('no workflow'); return }
  console.log(`draft v${wf.draftVersion?.versionNo} (${wf.draftVersion?.id}) | published v${wf.publishedVersion?.versionNo} (${wf.publishedVersion?.id})`)

  // Tasks with execution state
  const tasks = await prisma.task.findMany({
    where: { projectId: project.id, archivedAt: null },
    include: {
      execution: true,
      nodes: { select: { id: true, wbs: true, name: true, nodeType: true, workflowVersionId: true } },
      assignees: { include: { member: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`\n=== tasks (${tasks.length}) ===`)
  for (const t of tasks) {
    const e = t.execution
    console.log(`task=${t.id} type=${t.taskType}`)
    console.log(`  nodes: ${t.nodes.map((n) => `${n.wbs}/${n.nodeType}@v${n.workflowVersionId.slice(0, 8)}`).join(', ')}`)
    if (e) {
      console.log(`  execution: status=${e.status} progress=${e.progress} actualStart=${e.actualStart?.toISOString()?.slice(0, 10)} actualEnd=${e.actualEnd?.toISOString()?.slice(0, 10)} completionApproval=${e.completionApprovalStatus} confirmedAt=${e.completionConfirmedAt?.toISOString()?.slice(0, 10) ?? '-'}`)
    } else {
      console.log('  execution: NONE')
    }
    console.log(`  assignees: ${t.assignees.map((a) => a.member.name).join(',') || '-'}`)
  }

  // Workflow nodes for both versions with their denormalized status
  for (const [label, version] of [['draft', wf.draftVersion], ['published', wf.publishedVersion]] as const) {
    if (!version) continue
    const nodes = await prisma.workflowNode.findMany({
      where: { workflowVersionId: version.id, taskType: undefined, OR: [{ nodeType: 'TASK' }, { nodeType: 'MILESTONE' }] },
      include: { task: { include: { execution: true } } },
      orderBy: { wbs: 'asc' },
    })
    console.log(`\n=== ${label} v${version.versionNo} task nodes (${nodes.length}) ===`)
    for (const n of nodes) {
      const e = n.task?.execution
      console.log(`${n.wbs} node=${n.id.slice(0, 8)} name="${n.name}" nodeStatus? taskExec=${e ? `${e.status}/approval=${e.completionApprovalStatus}` : 'NONE'} taskId=${n.taskId?.slice(0, 8)}`)
    }
  }

  // edges for draft: who blocks whom
  const draftVersion = wf.draftVersion
  if (draftVersion) {
    const edges = await prisma.workflowEdge.findMany({
      where: { workflowVersionId: draftVersion.id },
      include: { sourceNode: { select: { wbs: true, name: true } }, targetNode: { select: { wbs: true, name: true } } },
    })
    console.log(`\n=== draft edges (${edges.length}) ===`)
    for (const e of edges) console.log(`${e.sourceNode.wbs}(${e.sourceNode.name}) -> ${e.targetNode.wbs}(${e.targetNode.name})`)

    const histories = await prisma.taskStatusHistory.findMany({
      where: { task: { projectId: project.id } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      include: { task: { select: { nodes: { select: { wbs: true } } } } },
    })
    console.log(`\n=== recent status history (${histories.length}) ===`)
    for (const h of histories) {
      console.log(`${h.createdAt.toISOString()} task=${h.task.nodes.map((n) => n.wbs).join('/') || h.taskId.slice(0, 8)} ${h.fromStatus ?? '∅'} -> ${h.toStatus} reason=${h.reason ?? '-'}`)
    }
  }
}

main().finally(() => prisma.$disconnect())
