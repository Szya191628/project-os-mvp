import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const projects = await prisma.project.findMany({
    where: { OR: [{ code: 'PRJ-001' }, { name: { contains: '研发流程平台' } }] },
    select: { id: true, code: true, name: true },
  })
  console.log('projects:', JSON.stringify(projects))

  for (const project of projects) {
    const wf = await prisma.workflow.findUnique({
      where: { projectId: project.id },
      include: {
        draftVersion: { select: { id: true, versionNo: true, status: true } },
        publishedVersion: { select: { id: true, versionNo: true, status: true } },
      },
    })
    if (!wf) { console.log(`[${project.code}] no workflow`); continue }
    console.log(`\n[${project.code}] workflow=${wf.id} draft=${JSON.stringify(wf.draftVersion)} published=${JSON.stringify(wf.publishedVersion)}`)

    for (const label of ['draftVersion', 'publishedVersion']) {
      const version = (wf as Record<string, { id: string } | null>)[label]
      if (!version) continue
      const nodes = await prisma.workflowNode.findMany({ where: { workflowVersionId: version.id }, orderBy: { createdAt: 'asc' } })
      const edges = await prisma.workflowEdge.findMany({ where: { workflowVersionId: version.id } })
      const se = nodes.filter((n) => String(n.nodeType) === 'START' || String(n.nodeType) === 'END')
      console.log(`\n--- ${label} ${version.id}: ${nodes.length} nodes, ${edges.length} edges; start/end nodes: ${se.length} ---`)
      for (const n of se) {
        const out = edges.filter((e) => e.sourceNodeId === n.id).map((e) => e.targetId)
        const inn = edges.filter((e) => e.targetNodeId === n.id).map((e) => e.sourceId)
        console.log(`  ${String(n.nodeType)} id=${n.id} name="${n.name}" pos=(${n.positionX},${n.positionY}) out=${out.length} in=${inn.length}`)
      }
      console.log('  all nodes:', nodes.map((n) => `${n.wbs || String(n.nodeType)}:${n.name}(x=${Math.round(n.positionX)})`).join(' | '))
    }
  }
}

main().finally(() => prisma.$disconnect())
