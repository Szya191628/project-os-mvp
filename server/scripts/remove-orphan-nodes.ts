import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'node:fs'

const prisma = new PrismaClient()

const ORPHAN_IDS = [
  'f1bf9f6d-02b8-47ad-888a-14337e03f232', // 多余 START (129,16)
  'e0cb9c0b-97ea-4170-9904-2d4099e208ee', // 多余 END (155,39)
]

async function main() {
  const nodes = await prisma.workflowNode.findMany({
    where: { id: { in: ORPHAN_IDS } },
    include: { sourceEdges: true, targetEdges: true, schedules: true },
  })
  console.log('found:', nodes.map((n) => `${String(n.nodeType)} ${n.id} edges=${n.sourceEdges.length + n.targetEdges.length} schedules=${n.schedules.length}`))

  if (nodes.length !== ORPHAN_IDS.length) {
    console.log('ABORT: expected 2 nodes, found', nodes.length)
    return
  }
  if (nodes.some((n) => n.sourceEdges.length + n.targetEdges.length > 0)) {  // schedules are handled below (backed up + deleted)
    console.log('ABORT: orphan node has edges/schedules, manual review needed')
    return
  }

  // backup before delete (nodes + their schedule rows)
  const scheduleRows = await prisma.workflowNodeSchedule.findMany({ where: { nodeId: { in: ORPHAN_IDS } } })
  writeFileSync(
    'scripts/.orphan-nodes-backup.json',
    JSON.stringify({ nodes: nodes.map((n) => ({ ...n, sourceEdges: undefined, targetEdges: undefined, schedules: undefined })), schedules: scheduleRows }, null, 2),
    'utf-8',
  )

  const delSched = await prisma.workflowNodeSchedule.deleteMany({ where: { nodeId: { in: ORPHAN_IDS } } })
  console.log('deleted schedules:', delSched.count)
  const res = await prisma.workflowNode.deleteMany({ where: { id: { in: ORPHAN_IDS } } })
  console.log('deleted nodes:', res.count)

  // verify draft is now clean
  const draftVersionId = '0df35daa-1a8c-4cdd-a52e-2081bd351688'
  const se = await prisma.workflowNode.findMany({
    where: { workflowVersionId: draftVersionId, nodeType: { in: ['START', 'END'] } },
    select: { id: true, nodeType: true, positionX: true, positionY: true },
  })
  console.log('remaining START/END in draft v7:', JSON.stringify(se))
}

main().finally(() => prisma.$disconnect())
