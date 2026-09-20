import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectPublishedTasks } from '../server/src/publishedTasks.ts'

function candidate(overrides: Partial<Parameters<typeof projectPublishedTasks>[0][number]> = {}) {
  return {
    nodeId: 'node-1',
    versionId: 'version-1',
    versionNo: 2,
    versionStatus: 'PUBLISHED' as const,
    taskId: 'task-1',
    taskArchivedAt: null,
    nodeType: 'TASK',
    projectId: 'project-1',
    projectCode: 'PRJ-001',
    projectName: '示例项目',
    projectStatus: 'IN_PROGRESS',
    wbs: '1.4',
    name: '低洼地王',
    ownerMemberId: 'owner-1',
    ownerName: '负责人',
    ownerActive: true,
    activeAssigneeIds: [],
    status: 'NOT_STARTED',
    progress: 0,
    effortHours: 24,
    plannedStart: new Date('2026-09-10T00:00:00.000Z'),
    plannedEnd: new Date('2026-09-13T00:00:00.000Z'),
    actualStart: null,
    actualEnd: null,
    description: null,
    closureCriteria: null,
    specialRelease: false,
    blockedBy: [],
    deliverableCount: 0,
    closureCheckCount: 0,
    completedClosureCheckCount: 0,
    ...overrides,
  }
}

test('已发布任务投影排除草稿和归档任务，并统一使用数据库任务 ID', () => {
  const result = projectPublishedTasks([
    candidate({ taskId: 'archived-task', taskArchivedAt: new Date('2026-09-01T00:00:00.000Z') }),
    candidate({ taskId: 'draft-task', versionStatus: 'DRAFT' }),
    candidate({ taskId: 'live-task', activeAssigneeIds: ['assignee-1', 'assignee-1'] }),
  ])

  assert.deepEqual(result.map((task) => task.id), ['live-task'])
  assert.equal(result[0]?.nodeId, 'node-1')
  assert.deepEqual(result[0]?.assigneeIds, ['assignee-1'])
})

test('已发布任务投影在没有有效执行人时回退到负责人', () => {
  const result = projectPublishedTasks([candidate({ ownerMemberId: 'owner-2', activeAssigneeIds: [] })])

  assert.deepEqual(result[0]?.assigneeIds, ['owner-2'])
})

test('已发布任务投影统一前置未完成时的受阻状态', () => {
  const result = projectPublishedTasks([candidate({ status: 'NOT_STARTED', blockedBy: ['前置任务'] })])

  assert.equal(result[0]?.status, 'BLOCKED')
  assert.deepEqual(result[0]?.blockedBy, ['前置任务'])
})
