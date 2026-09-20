// Run with tsx; default is read-only verification. --apply repairs this incident only.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { loadPublishedWorkflowTasks } from '../src/publishedTasks.js'

const db = new PrismaClient()
const projectId = '89ef4ba1-247d-4eb5-9372-4dec8ca6e36f'
const publishedVersionId = 'a70a99ea-18ed-473a-9fca-655256caca3c'
const draftVersionId = 'ee3e052d-d417-4297-be07-002ff79e96fc'
const memberId = 'e8a1a1b8-fd79-4c1d-b262-e2f6164fe596'

try {
  await db.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workflow: true } })
    assert.equal(project.archivedAt, null)
    assert.equal(project.workflow?.publishedVersionId, publishedVersionId, 'Published version changed; re-inspect before repair')
    assert.equal(project.workflow?.draftVersionId, draftVersionId, 'Draft changed; re-inspect before repair')
    const nodes = await tx.workflowNode.findMany({
      where: { workflowVersionId: publishedVersionId, nodeType: { in: ['TASK', 'MILESTONE'] } },
      include: { task: { include: { execution: true } } },
      orderBy: { wbs: 'asc' },
    })
    assert.deepEqual(nodes.map((node) => node.wbs), ['1.1', '1.2', '1.3', '1.4', '1.5'])
    const archived = nodes.flatMap((node) => node.task?.archivedAt ? [node.task] : [])
    if (process.argv.includes('--apply') && archived.length) {
      // These rows were archived together by the v6 draft save, not by task deletion.
      for (const task of archived) {
        assert.equal(task.archivedAt!.toISOString().slice(0, 19), '2026-09-16T02:58:37')
      }
      const deletions = await tx.auditLog.count({ where: { projectId, action: 'TASK_DELETED', resourceId: { in: archived.map((task) => task.id) } } })
      assert.equal(deletions, 0, 'Explicit task deletion found; refuse restoration')
      for (const task of archived) {
        const updated = await tx.task.updateMany({ where: { id: task.id, projectId, archivedAt: task.archivedAt }, data: { archivedAt: null } })
        assert.equal(updated.count, 1)
      }
      await tx.auditLog.create({ data: {
        organizationId: project.organizationId,
        projectId,
        resourceType: 'WORKFLOW_VERSION',
        resourceId: publishedVersionId,
        action: 'PUBLISHED_TASK_ARCHIVE_REPAIRED',
        beforeJson: archived.map((task) => ({ taskId: task.id, archivedAt: task.archivedAt!.toISOString() })),
        afterJson: { reason: 'Restore published v5 tasks incorrectly archived while saving draft v6', tasks: archived.map((task) => ({ taskId: task.id, archivedAt: null })) },
      } })
      console.log(`Restored ${archived.length} tasks; original archive timestamps saved in audit log.`)
    }
    const tasks = await loadPublishedWorkflowTasks(tx, { organizationId: project.organizationId, projectIds: [projectId], memberId })
    assert.deepEqual(tasks.map((task) => task.wbs), ['1.4', '1.5'], '史泽宇的已发布任务必须包含 1.4 和 1.5')
    for (const node of nodes) {
      const task = await tx.task.findUniqueOrThrow({ where: { id: node.taskId! }, include: { execution: true } })
      assert.equal(task.archivedAt, null)
      assert.deepEqual(task.execution, node.task!.execution, 'Execution and approval history must not change')
    }
    console.log(JSON.stringify(tasks.map(({ wbs, name, status, versionNo }) => ({ wbs, name, status, versionNo })), null, 2))
  }, { isolationLevel: 'Serializable', timeout: 15000 })
} finally {
  await db.$disconnect()
}
