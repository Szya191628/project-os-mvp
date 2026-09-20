import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, Workflow, WorkflowNode } from '../src/types.ts'
import { buildDueNotifications, createWorkflowNotifications, mergeNotifications } from '../src/notifications.ts'
import { scheduleWorkflow } from '../src/workflow/schedule.ts'
import { dedupeTaskSummaries, groupTaskSummariesByProject, type TaskSummary } from '../src/workflow/taskQueries.ts'
import { hasExceededDragThreshold } from '../src/workflow/drag.ts'
import { alignSerialNodes, alignSerialWorkflowNodes, arrangeWorkflowNodes, buildOrthogonalPath } from '../src/workflow/layout.ts'
import { getFlowCanvasMetrics } from '../src/workflow/canvas.ts'
import { buildPublishedTaskNotices, findMiddleInsertedTaskIds, type PublishedTaskNode } from '../server/src/notifications/taskPublished.ts'
import { DEFAULT_NOTIFICATION_TEMPLATES, renderNotificationTemplate } from '../server/src/notifications/taskEvents.ts'
import { hasWorkflowAuditChanges, summarizeWorkflowAudit } from '../server/src/workflowAudit.ts'
import { normalizePortfolioWorkflow } from '../server/src/portfolioWorkflow.ts'
import { getProjectCapabilities } from '../src/projectAccess.ts'
import { LatestSaveQueue, persistWorkflowSnapshot } from '../src/workflow/persistence.ts'
import { loadPortfolioSelection, savePortfolioSelection } from '../src/portfolioSelection.ts'

const project: Project = {
  id: 'p-test',
  code: 'PRJ-TEST',
  name: '测试项目',
  owner: '陈默',
  ownerInitials: 'CM',
  department: '研发中心',
  status: '规划中',
  progress: 0,
  start: '2026-08-31',
  end: '2026-09-30',
  budget: 0,
  actualCost: 0,
  health: '健康',
  memberIds: [],
  nextMilestone: '待规划',
}

test('点击流程节点时的轻微位移不会被判定为拖动', () => {
  assert.equal(hasExceededDragThreshold({ x: 100, y: 100 }, { x: 102, y: 101 }), false)
  assert.equal(hasExceededDragThreshold({ x: 100, y: 100 }, { x: 106, y: 100 }), true)
})

test('项目级能力会隐藏 L3 的管理操作并保留自身任务交付权限', () => {
  const l3 = getProjectCapabilities('L3')
  assert.equal(l3.canEditWorkflow, false)
  assert.equal(l3.canPublishWorkflow, false)
  assert.equal(l3.canManageProjectMembers, false)
  assert.equal(l3.canManageOwnDeliverables, true)
  assert.equal(l3.canSubmitApproval, true)

  const supervisor = getProjectCapabilities('SUPERVISOR')
  assert.equal(supervisor.canViewWorkflow, true)
  assert.equal(supervisor.canViewProjectMembers, true)
  assert.equal(supervisor.canEditTaskStructure, false)
  assert.equal(supervisor.canSubmitApproval, false)
})

test('组合画布可以向四个方向继续扩展并保持节点坐标', () => {
  const nodes = [{ position: { x: -80, y: -40 } }, { position: { x: 900, y: 700 } }]
  const base = getFlowCanvasMetrics(nodes, 184, 112, { width: 0, height: 0, left: 0, top: 0 })
  const expanded = getFlowCanvasMetrics(nodes, 184, 112, { width: 1200, height: 1200, left: 1200, top: 1200 })

  assert.equal(expanded.origin.x, base.origin.x + 1200)
  assert.equal(expanded.origin.y, base.origin.y + 1200)
  assert.equal(expanded.width > base.width, true)
  assert.equal(expanded.height > base.height, true)
})

test('自动排版按依赖关系从左到右', () => {
  const workflow = makeWorkflow('2026-08-31')
  workflow.nodes.find((node) => node.id === 'a')!.position = { x: 900, y: 320 }
  workflow.nodes.find((node) => node.id === 'b')!.position = { x: 120, y: 40 }
  const positions = arrangeWorkflowNodes(workflow)

  assert.equal(positions.start.x < positions.a.x, true)
  assert.equal(positions.start.x < positions.b.x, true)
  assert.equal(positions.c.x > positions.a.x, true)
  assert.equal(positions.c.x > positions.b.x, true)
  assert.equal(positions.end.x > positions.c.x, true)
})

test('正交连线只使用水平和垂直线段', () => {
  assert.equal(buildOrthogonalPath({ x: 10, y: 20 }, { x: 100, y: 80 }), 'M 10 20 H 55 V 80 H 100')
  assert.equal(buildOrthogonalPath({ x: 10, y: 20 }, { x: 100, y: 20 }), 'M 10 20 H 100')
  assert.equal(buildOrthogonalPath({ x: 10, y: 20 }, { x: 100, y: 80 }, 34), 'M 10 20 H 34 V 80 H 100')
})

test('串联任务对齐到同一水平线并保留分支节点位置', () => {
  const workflow = makeWorkflow('2026-08-31')
  const d = makeNode('d', 'task', '串联任务 D', 2)
  d.position = { x: 420, y: 320 }
  const e = makeNode('e', 'task', '串联任务 E', 2)
  e.position = { x: 680, y: 120 }
  workflow.nodes.push(d, e)
  workflow.edges = [
    { id: 'start-a', source: 'start', target: 'a', type: 'FS', lagDays: 0 },
    { id: 'start-b', source: 'start', target: 'b', type: 'FS', lagDays: 0 },
    { id: 'a-c', source: 'a', target: 'c', type: 'FS', lagDays: 0 },
    { id: 'b-c', source: 'b', target: 'c', type: 'FS', lagDays: 0 },
    { id: 'c-d', source: 'c', target: 'd', type: 'FS', lagDays: 0 },
    { id: 'd-e', source: 'd', target: 'e', type: 'FS', lagDays: 0 },
    { id: 'e-end', source: 'e', target: 'end', type: 'FS', lagDays: 0 },
  ]

  const result = alignSerialWorkflowNodes(workflow)

  assert.deepEqual(result.alignedNodeIds, ['d', 'e'])
  assert.equal(result.positions.d.y, result.positions.e.y)
  assert.equal(result.positions.d.y, 220)
  assert.equal(result.positions.d.x, d.position.x)
  assert.equal(result.positions.e.x, e.position.x)
  assert.equal(result.positions.a.y, workflow.nodes.find((node) => node.id === 'a')!.position.y)
  assert.deepEqual(result.movedNodeIds, ['d', 'e'])
})

test('项目组合中的串联项目和组合任务可以复用对齐规则', () => {
  const nodes = [
    { id: 'project:a', type: 'project', position: { x: 80, y: 160 } },
    { id: 'task:1', type: 'task', position: { x: 340, y: 320 } },
    { id: 'task:2', type: 'task', position: { x: 600, y: 80 } },
    { id: 'project:b', type: 'project', position: { x: 860, y: 240 } },
  ]
  const edges = [
    { source: 'project:a', target: 'task:1' },
    { source: 'task:1', target: 'task:2' },
    { source: 'task:2', target: 'project:b' },
  ]

  const result = alignSerialNodes(nodes, edges)

  assert.deepEqual(result.alignedNodeIds, ['task:1', 'task:2'])
  assert.equal(result.positions['task:1'].y, result.positions['task:2'].y)
  assert.equal(result.positions['task:1'].y, 200)
  assert.equal(result.positions['project:a'].y, 160)
  assert.equal(result.positions['project:b'].y, 240)
  assert.deepEqual(result.movedNodeIds, ['task:1', 'task:2'])
})

test('项目组合任务保留项目任务编辑字段', () => {
  const result = normalizePortfolioWorkflow('portfolio-1', [], {
    version: 3,
    nodes: [{
      id: 'task:1',
      type: 'task',
      projectId: 'project-1',
      taskId: 'task-1',
      wbs: 'T1',
      name: '接口联调',
      owner: '史泽宇',
      assigneeIds: ['member-1'],
      assigneeNames: ['史泽宇'],
      status: '未开始',
      progress: 0,
      duration: 5,
      effort: 40,
      plannedStart: '2026-09-10',
      plannedEnd: '2026-09-14',
      description: '完成接口联调和记录',
      closureCriteria: '提交联调报告',
      positionX: 80,
      positionY: 80,
    }],
    edges: [],
  })

  assert.deepEqual(result.nodes[0], {
    id: 'task:1',
    type: 'task',
    projectId: 'project-1',
    taskId: 'task-1',
    wbs: 'T1',
    name: '接口联调',
    owner: '史泽宇',
    assigneeIds: ['member-1'],
    assigneeNames: ['史泽宇'],
    status: '未开始',
    progress: 0,
    plannedStart: '2026-09-10',
    plannedEnd: '2026-09-14',
    duration: 5,
    effort: 40,
    description: '完成接口联调和记录',
    closureCriteria: '提交联调报告',
    positionX: 80,
    positionY: 80,
  })
})

test('多前置汇聚使用最晚前置完成日', () => {
  const result = scheduleWorkflow(makeWorkflow('2026-08-31'))

  assert.equal(result.issues.length, 0)
  assert.equal(result.schedules.a.plannedEnd, '2026-09-03')
  assert.equal(result.schedules.b.plannedEnd, '2026-09-02')
  assert.equal(result.schedules.c.plannedStart, '2026-09-03')
  assert.equal(result.schedules.c.plannedEnd, '2026-09-07')
  assert.equal(result.schedules.end.plannedEnd, '2026-09-07')
})

test('我的任务全部版本按项目和 WBS 去重并优先已发布版本', () => {
  const makeSummary = (overrides: Partial<TaskSummary>): TaskSummary => ({
    id: 'draft-task',
    projectId: 'project-1',
    projectCode: 'PRJ-001',
    projectName: '示例项目',
    projectStatus: '规划中',
    workflowStatus: 'draft',
    wbs: '1.4',
    name: '1.4',
    owner: '陈默',
    assigneeIds: [],
    status: '未开始',
    progress: 0,
    effort: 24,
    blockedBy: [],
    overdue: false,
    milestone: false,
    ...overrides,
  })
  const result = dedupeTaskSummaries([
    makeSummary({ id: 'draft-task' }),
    makeSummary({ id: 'published-task', workflowStatus: 'published' }),
    makeSummary({ id: 'other-task', wbs: '1.5' }),
  ])

  assert.deepEqual(result.map(({ id, workflowStatus }) => ({ id, workflowStatus })), [
    { id: 'published-task', workflowStatus: 'published' },
    { id: 'other-task', workflowStatus: 'draft' },
  ])
})

test('我的任务按项目分组并保留组内排序', () => {
  const makeSummary = (projectId: string, projectCode: string, projectName: string, wbs: string): TaskSummary => ({
    id: `${projectId}-${wbs}`,
    projectId,
    projectCode,
    projectName,
    projectStatus: '规划中',
    workflowStatus: 'published',
    wbs,
    name: wbs,
    owner: '陈默',
    assigneeIds: [],
    status: '未开始',
    progress: 0,
    effort: 24,
    blockedBy: [],
    overdue: false,
    milestone: false,
  })
  const groups = groupTaskSummariesByProject([
    makeSummary('project-a', 'PRJ-A', '天线开发', '1.2'),
    makeSummary('project-b', 'PRJ-B', '智能工厂一期', '1.1'),
    makeSummary('project-a', 'PRJ-A', '天线开发', '1.4'),
  ])

  assert.deepEqual(groups.map((group) => ({ id: group.projectId, count: group.tasks.length, wbs: group.tasks.map((task) => task.wbs) })), [
    { id: 'project-a', count: 2, wbs: ['1.2', '1.4'] },
    { id: 'project-b', count: 1, wbs: ['1.1'] },
  ])
})

test('没有前置关系的普通任务从项目基准日独立排期', () => {
  const workflow = makeWorkflow('2026-08-31')
  const standalone = makeNode('standalone', 'task', '独立任务', 2)
  workflow.nodes.push(standalone)

  const result = scheduleWorkflow(workflow)

  assert.equal(result.issues.length, 0)
  assert.equal(result.schedules.standalone.plannedStart, '2026-08-31')
  assert.equal(result.schedules.standalone.plannedEnd, '2026-09-02')
})

test('指定任务具体计划时间后保留日期，并按指定结束日顺延下游', () => {
  const workflow = makeWorkflow('2026-08-31')
  const task = workflow.nodes.find((node) => node.id === 'a')!
  task.plannedStartOverride = '2026-09-05'
  task.plannedEndOverride = '2026-09-08'

  const result = scheduleWorkflow(workflow)

  assert.equal(result.issues.length, 0)
  assert.equal(result.schedules.a.plannedStart, '2026-09-05')
  assert.equal(result.schedules.a.plannedEnd, '2026-09-08')
  assert.equal(result.schedules.c.plannedStart, '2026-09-08')
})

test('任务实际启动后以实际开始日重排当前节点并顺延后续节点', () => {
  const workflow = makeWorkflow('2026-09-10')
  const task = workflow.nodes.find((node) => node.id === 'a')!
  task.status = '进行中'
  task.actualStart = '2026-09-16'
  task.specialRelease = {
    workflowVersionId: 'version-1',
    targetNodeId: task.id,
    predecessorTaskIds: ['predecessor-1'],
    predecessors: [{ taskId: 'predecessor-1', nodeId: 'predecessor-node', wbs: '1.1', name: '前置任务', status: '进行中' }],
    reason: '前置任务延期，先行处理',
    approvedAt: '2026-09-16T02:00:00.000Z',
  }

  const result = scheduleWorkflow(workflow)

  assert.equal(result.schedules.a.plannedStart, '2026-09-16')
  assert.equal(result.schedules.a.plannedEnd, '2026-09-19')
  assert.equal(result.schedules.c.plannedStart, '2026-09-19')
})

test('中途插入任务只顺延相关下游分支', () => {
  const workflow = makeWorkflow('2026-08-31')
  const inserted = makeNode('inserted', 'task', '插入任务', 2)
  inserted.position = { x: 400, y: 260 }
  workflow.nodes.push(inserted)
  workflow.edges = workflow.edges.flatMap((edge) => edge.id === 'a-c'
    ? [{ id: 'a-inserted', source: 'a', target: 'inserted', type: 'FS' as const, lagDays: 0 }, { id: 'inserted-c', source: 'inserted', target: 'c', type: 'FS' as const, lagDays: 0 }]
    : [edge])

  const result = scheduleWorkflow(workflow)

  assert.equal(result.issues.length, 0)
  assert.equal(result.schedules.b.plannedStart, '2026-08-31')
  assert.equal(result.schedules.b.plannedEnd, '2026-09-02')
  assert.equal(result.schedules.inserted.plannedStart, '2026-09-03')
  assert.equal(result.schedules.inserted.plannedEnd, '2026-09-05')
  assert.equal(result.schedules.c.plannedStart, '2026-09-05')
  assert.equal(result.schedules.c.plannedEnd, '2026-09-09')
})

test('工作日历跳过周末并保留自然日项目兼容性', () => {
  const workflow = makeWorkflow('2026-09-04')
  workflow.calendar = { mode: 'working', name: '标准工作日历', weeklyWorkdays: [1, 2, 3, 4, 5], holidays: [], customRestDays: [], makeupWorkdays: [] }
  const result = scheduleWorkflow(workflow)

  assert.equal(result.issues.length, 0)
  assert.equal(result.schedules.a.plannedStart, '2026-09-04')
  assert.equal(result.schedules.a.plannedEnd, '2026-09-09')
  assert.equal(result.schedules.c.plannedStart, '2026-09-09')
})

test('前置任务提前完成后，并行分支和汇聚下游按实际完成日顺延计算', () => {
  const workflow = makeWorkflow('2026-09-01')
  workflow.calendar = { mode: 'working', name: '标准工作日历', weeklyWorkdays: [1, 2, 3, 4, 5], holidays: [], customRestDays: [], makeupWorkdays: [] }
  const merge = makeNode('merge', 'task', '汇聚任务', 1)
  workflow.nodes.push(merge)
  workflow.edges = [
    { id: 'start-a', source: 'start', target: 'a', type: 'FS', lagDays: 0 },
    { id: 'a-b', source: 'a', target: 'b', type: 'FS', lagDays: 0 },
    { id: 'a-c', source: 'a', target: 'c', type: 'FS', lagDays: 0 },
    { id: 'b-merge', source: 'b', target: 'merge', type: 'FS', lagDays: 0 },
    { id: 'c-merge', source: 'c', target: 'merge', type: 'FS', lagDays: 0 },
    { id: 'merge-end', source: 'merge', target: 'end', type: 'FS', lagDays: 0 },
  ]
  const early = workflow.nodes.find((node) => node.id === 'a')!
  early.status = '提前结束'
  early.actualEnd = '2026-09-01'
  early.completionConfirmedAt = '2026-09-01'
  early.completionApprovalStatus = 'approved'

  const result = scheduleWorkflow(workflow)

  assert.equal(result.issues.length, 0)
  assert.equal(result.schedules.a.plannedEnd, '2026-09-04')
  assert.equal(result.schedules.b.plannedStart, '2026-09-01')
  assert.equal(result.schedules.c.plannedStart, '2026-09-01')
  assert.equal(result.schedules.merge.plannedStart, '2026-09-07')
  assert.equal(result.schedules.end.plannedStart, '2026-09-08')
})

test('钉钉审批未通过时完成状态不推动下游排期', () => {
  const workflow = makeWorkflow('2026-09-01')
  workflow.calendar = { mode: 'working', name: '标准工作日历', weeklyWorkdays: [1, 2, 3, 4, 5], holidays: [], customRestDays: [], makeupWorkdays: [] }
  const early = workflow.nodes.find((node) => node.id === 'a')!
  early.status = '提前结束'
  early.actualEnd = '2026-09-01'
  early.completionConfirmedAt = '2026-09-01'
  early.completionApprovalStatus = 'pending'

  const result = scheduleWorkflow(workflow)

  assert.equal(result.schedules.a.plannedEnd, '2026-09-04')
  assert.equal(result.schedules.c.plannedStart, '2026-09-04')
})

test('循环依赖阻止形成可用排期', () => {
  const workflow = makeWorkflow('2026-08-31')
  workflow.edges.push({ id: 'c-a-cycle', source: 'c', target: 'a', type: 'FS', lagDays: 0 })
  const result = scheduleWorkflow(workflow)

  assert.equal(result.issues.some((issue) => issue.code === 'cycle'), true)
})

test('发布生成任务消息，前置全部完成后生成解锁消息', () => {
  const draft = makeWorkflow('2026-08-31')
  draft.status = 'draft'
  draft.version = 0
  const published: Workflow = { ...draft, status: 'published', version: 1, publishedAt: '2026-08-31T09:00:00.000Z' }
  const publishNotices = createWorkflowNotifications(project, draft, published, new Date('2026-08-31T09:00:00.000Z'))

  assert.equal(publishNotices.filter((notice) => notice.type === 'task-published').length, 3)

  const before: Workflow = { ...published, nodes: published.nodes.map((node) => node.id === 'a' || node.id === 'b' ? { ...node, status: '未开始' as const } : node) }
  const beforeWithChain: Workflow = { ...before, edges: [...before.edges, { id: 'a-b', source: 'a', target: 'b', type: 'FS' as const, lagDays: 0 }] }
  const submitted: Workflow = { ...beforeWithChain, nodes: beforeWithChain.nodes.map((node) => node.id === 'a' ? { ...node, status: '提前结束' as const, actualEnd: '2026-09-01', completionApprovalStatus: 'approved' as const, completionConfirmedAt: '2026-09-01' } : node) }
  const completionNotices = createWorkflowNotifications(project, beforeWithChain, submitted, new Date('2026-09-01T09:00:00.000Z'))

  assert.equal(completionNotices.filter((notice) => notice.type === 'task-completion-review').length, 0)
  assert.deepEqual(completionNotices.filter((notice) => notice.type === 'task-ready').map((notice) => notice.taskId), ['b'])

  const after: Workflow = { ...published, nodes: published.nodes.map((node) => node.id === 'a' ? { ...node, status: '如期结束' as const, actualEnd: '2026-09-03' } : node.id === 'b' ? { ...node, status: '如期结束' as const, actualEnd: '2026-09-02' } : node) }
  const readyNotices = createWorkflowNotifications(project, before, after, new Date('2026-09-03T09:00:00.000Z'))

  assert.deepEqual(readyNotices.filter((notice) => notice.type === 'task-ready').map((notice) => notice.taskId), ['c'])

})

test('流程发布后采用服务器返回的真实版本和任务 ID', async () => {
  const draft = makeWorkflow('2026-08-31')
  draft.status = 'draft'
  draft.version = 4
  draft.nodes[1].taskId = 'old-task-id'
  const localPublished = { ...draft, status: 'published' as const, version: 5 }
  const serverPublished = { ...localPublished, version: 4, nodes: localPublished.nodes.map((node) => node.id === 'a' ? { ...node, taskId: 'new-task-id' } : node) }
  const calls: string[] = []

  const result = await persistWorkflowSnapshot(localPublished, draft, {
    saveDraft: async () => { calls.push('save-draft') },
    savePublished: async () => { calls.push('save-published') },
    publish: async () => { calls.push('publish') },
    reload: async () => { calls.push('reload'); return serverPublished },
  })

  assert.deepEqual(calls, ['save-draft', 'publish', 'reload'])
  assert.equal(result.version, 4)
  assert.equal(result.nodes[1].taskId, 'new-task-id')
})

test('自动保存队列同一资源只保留一个进行中的请求并落地最新版本', async () => {
  const calls: number[] = []
  let resolveStarted: () => void = () => undefined
  let releaseFirst: () => void = () => undefined
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = new LatestSaveQueue<number>(async (value) => {
    calls.push(value)
    if (value === 2) {
      resolveStarted()
      await firstRequest
    }
  }, 0)

  queue.enqueue(1)
  queue.enqueue(2)
  await started
  queue.enqueue(3)
  queue.enqueue(4)
  releaseFirst()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.deepEqual(calls, [2, 4])
  queue.cancel()
})

test('组合选择在页面重建后沿用上次选择', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }

  savePortfolioSelection('portfolio-2', storage)

  assert.equal(loadPortfolioSelection(storage), 'portfolio-2')
})

test('开始前提醒、临期和超期提醒按计划日期生成，重复合并保持幂等', () => {
  const workflow = makeWorkflow('2026-08-28')
  workflow.status = 'published'
  workflow.version = 3
  workflow.publishedAt = '2026-08-28T09:00:00.000Z'
  const dueNotices = buildDueNotifications(project, workflow, { reminderDays: 3 }, new Date('2026-08-31T09:00:00.000Z'))

  assert.equal(dueNotices.some((notice) => notice.id.startsWith('start-soon:') && notice.taskId === 'c'), true)
  assert.equal(dueNotices.some((notice) => notice.type === 'task-due-soon' && notice.taskId === 'a'), true)
  assert.equal(dueNotices.some((notice) => notice.type === 'task-overdue' && notice.taskId === 'b'), true)

  const first = mergeNotifications([], [dueNotices[0]], { [workflow.projectId]: workflow })
  const second = mergeNotifications(first, [dueNotices[0]], { [workflow.projectId]: workflow })
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
})

test('发布流程后为任务负责人生成包含前后节点的钉钉提醒', () => {
  const member = { id: 'member-1', name: '林珊' }
  const nodes: PublishedTaskNode[] = [
    { id: 'start', taskId: null, nodeType: 'START', wbs: '0', name: '项目开始', description: null, closureCriteria: null, ownerMember: null, assignees: [], closureChecks: [], plannedStart: new Date('2026-09-01'), plannedEnd: new Date('2026-09-01') },
    { id: 'a', taskId: 'task-a', nodeType: 'TASK', wbs: '1.1', name: '需求确认', description: '确认需求范围', closureCriteria: '需求文档签字', ownerMember: { id: 'member-0', name: '陈默' }, assignees: [], closureChecks: [], plannedStart: new Date('2026-09-01'), plannedEnd: new Date('2026-09-02') },
    { id: 'b', taskId: 'task-b', nodeType: 'TASK', wbs: '1.2', name: '接口开发', description: '完成鉴权接口', closureCriteria: '接口测试通过', ownerMember: member, assignees: [member], closureChecks: [], plannedStart: new Date('2026-09-02'), plannedEnd: new Date('2026-09-05') },
    { id: 'c', taskId: 'task-c', nodeType: 'TASK', wbs: '1.3', name: '联调', description: null, closureCriteria: null, ownerMember: { id: 'member-2', name: '周野' }, assignees: [], closureChecks: [], plannedStart: new Date('2026-09-05'), plannedEnd: new Date('2026-09-06') },
  ]
  const notices = buildPublishedTaskNotices({ organizationId: 'org-1', projectId: 'project-1', projectCode: 'PRJ-001', projectName: '研发项目', versionId: 'version-1', publisherName: '史泽宇', publisherLevel: 'L1', nodes, edges: [{ sourceNodeId: 'start', targetNodeId: 'a' }, { sourceNodeId: 'a', targetNodeId: 'b' }, { sourceNodeId: 'b', targetNodeId: 'c' }] })
  const notice = notices.find((item) => item.taskId === 'task-b')

  assert.deepEqual(notice?.recipientMemberIds, ['member-1'])
  assert.match(notice?.body ?? '', /完成鉴权接口/)
  assert.match(notice?.body ?? '', /接口测试通过/)
  assert.match(notice?.body ?? '', /陈默.*2026-09-02/)
  assert.match(notice?.body ?? '', /周野/)
})

test('重新发布流程时跳过已完成任务的钉钉提醒', () => {
  const owner = { id: 'member-owner', name: '史泽宇' }
  const nodes: PublishedTaskNode[] = [
    { id: 'completed', taskId: 'task-completed', nodeType: 'TASK', wbs: '1.1', name: '接口开发', description: null, closureCriteria: null, ownerMember: owner, assignees: [owner], closureChecks: [], plannedStart: new Date('2026-09-01'), plannedEnd: new Date('2026-09-02'), executionStatus: 'COMPLETED' } as PublishedTaskNode,
    { id: 'open', taskId: 'task-open', nodeType: 'TASK', wbs: '1.2', name: '页面开发', description: null, closureCriteria: null, ownerMember: owner, assignees: [owner], closureChecks: [], plannedStart: new Date('2026-09-01'), plannedEnd: new Date('2026-09-02'), executionStatus: 'IN_PROGRESS' } as PublishedTaskNode,
  ]
  const notices = buildPublishedTaskNotices({ organizationId: 'org-1', projectId: 'project-1', projectCode: 'PRJ-001', projectName: '研发项目', versionId: 'version-2', publisherName: '史泽宇', publisherLevel: 'L1', nodes, edges: [] })

  assert.deepEqual(notices.map((notice) => notice.taskId), ['task-open'])
})

test('中途插入任务时同时通知负责人和其直属主管', () => {
  const owner = { id: 'member-owner', name: '林珊' }
  const manager = { id: 'member-manager', name: '研发主管' }
  const nodes: PublishedTaskNode[] = [
    { id: 'start', taskId: null, nodeType: 'START', wbs: '0', name: '项目开始', description: null, closureCriteria: null, ownerMember: null, assignees: [], closureChecks: [], plannedStart: new Date('2026-09-01'), plannedEnd: new Date('2026-09-01') },
    { id: 'before', taskId: 'task-before', nodeType: 'TASK', wbs: '1.1', name: '需求确认', description: null, closureCriteria: null, ownerMember: owner, assignees: [owner], closureChecks: [], plannedStart: new Date('2026-09-01'), plannedEnd: new Date('2026-09-02') },
    { id: 'inserted', taskId: 'task-inserted', nodeType: 'TASK', wbs: '1.2', name: '接口开发', description: null, closureCriteria: null, ownerMember: owner, assignees: [owner], managerMembers: [manager], closureChecks: [], plannedStart: new Date('2026-09-03'), plannedEnd: new Date('2026-09-05') },
    { id: 'after', taskId: 'task-after', nodeType: 'TASK', wbs: '1.3', name: '联调', description: null, closureCriteria: null, ownerMember: { id: 'member-after', name: '周野' }, assignees: [], closureChecks: [], plannedStart: new Date('2026-09-06'), plannedEnd: new Date('2026-09-07') },
    { id: 'end', taskId: null, nodeType: 'END', wbs: '2', name: '项目结束', description: null, closureCriteria: null, ownerMember: null, assignees: [], closureChecks: [], plannedStart: new Date('2026-09-07'), plannedEnd: new Date('2026-09-07') },
  ]
  const edges = [
    { sourceNodeId: 'start', targetNodeId: 'before' },
    { sourceNodeId: 'before', targetNodeId: 'inserted' },
    { sourceNodeId: 'inserted', targetNodeId: 'after' },
    { sourceNodeId: 'after', targetNodeId: 'end' },
  ]

  assert.deepEqual(findMiddleInsertedTaskIds(nodes, edges, new Set(['task-before', 'task-after'])), new Set(['task-inserted']))
  const notices = buildPublishedTaskNotices({ organizationId: 'org-1', projectId: 'project-1', projectCode: 'PRJ-001', projectName: '研发项目', versionId: 'version-2', publisherName: '史泽宇', publisherLevel: 'L1', nodes, edges, managerTaskIds: new Set(['task-inserted']) })

  assert.deepEqual(notices.find((notice) => notice.taskId === 'task-inserted')?.recipientMemberIds, ['member-owner', 'member-manager'])
  assert.deepEqual(notices.find((notice) => notice.taskId === 'task-before')?.recipientMemberIds, ['member-owner'])
})

test('第二期通知模板可以渲染任务排期与变量', () => {
  const rendered = renderNotificationTemplate(DEFAULT_NOTIFICATION_TEMPLATES.TASK_SCHEDULE_CHANGED.bodyTemplate, {
    projectCode: 'PRJ-001', projectName: '研发项目', taskWbs: '1.2', taskName: '接口开发',
    previousPlannedStart: '2026-09-04', previousPlannedEnd: '2026-09-06', plannedStart: '2026-09-05', plannedEnd: '2026-09-08',
  })
  assert.match(rendered, /2026-09-04 → 2026-09-05/)
  assert.match(rendered, /2026-09-06 → 2026-09-08/)
})

test('主管交付物通知明确仅供查看且不要求审批', () => {
  const template = DEFAULT_NOTIFICATION_TEMPLATES.TASK_APPROVAL_VIEWED
  assert.match(template.bodyTemplate, /仅供查看/)
  assert.match(template.bodyTemplate, /审批由 L2\/管理员处理/)
  assert.doesNotMatch(template.bodyTemplate, /请及时审批/)
})

test('OA 审批通知明确区分阶段交付和最终交付', () => {
  const rendered = renderNotificationTemplate(DEFAULT_NOTIFICATION_TEMPLATES.TASK_APPROVAL_SUBMITTED.bodyTemplate, {
    projectCode: 'PRJ-001', projectName: '研发项目', taskWbs: '1.2', taskName: '接口开发',
    submitterName: '张三', deliveryType: '阶段交付', progress: '60%',
  })
  assert.match(rendered, /交付类型：阶段交付/)
  assert.match(rendered, /阶段交付审批通过后任务仍在进行中/)
  assert.match(rendered, /最终交付审批通过后系统才会完成任务/)
})

test('流程改动日志摘要识别节点、依赖和排期变化', () => {
  const before = {
    versionId: 'v1', versionNo: 1, status: 'DRAFT', baselineStart: '2026-09-01',
    nodes: [
      { id: 'a-1', wbs: '1.1', nodeType: 'TASK', name: '需求确认', ownerMemberId: 'm1', durationDays: 2, effortHours: 16, description: null, closureCriteria: null, positionX: 0, positionY: 0, plannedStart: '2026-09-01', plannedEnd: '2026-09-02' },
      { id: 'b-1', wbs: '1.2', nodeType: 'TASK', name: '接口开发', ownerMemberId: 'm2', durationDays: 3, effortHours: 24, description: null, closureCriteria: null, positionX: 200, positionY: 0, plannedStart: '2026-09-03', plannedEnd: '2026-09-05' },
    ],
    edges: [{ source: '1.1', target: '1.2', dependencyType: 'FS', lagDays: 0 }],
  }
  const after = {
    ...before,
    versionId: 'v2',
    versionNo: 2,
    nodes: [
      { ...before.nodes[0], durationDays: 3, plannedEnd: '2026-09-03' },
      { ...before.nodes[1], plannedStart: '2026-09-04', plannedEnd: '2026-09-06' },
      { id: 'c-1', wbs: '1.3', nodeType: 'TASK', name: '联调', ownerMemberId: 'm3', durationDays: 2, effortHours: 16, description: null, closureCriteria: null, positionX: 400, positionY: 0, plannedStart: '2026-09-07', plannedEnd: '2026-09-08' },
    ],
    edges: [{ source: '1.1', target: '1.2', dependencyType: 'FS', lagDays: 0 }, { source: '1.2', target: '1.3', dependencyType: 'FS', lagDays: 0 }],
  }
  const summary = summarizeWorkflowAudit('WORKFLOW_DRAFT_SAVED', before, after)

  assert.equal(summary.nodeAddedCount, 1)
  assert.equal(summary.nodeUpdatedCount, 1)
  assert.equal(summary.dependencyAddedCount, 1)
  assert.equal(summary.scheduleChangedCount, 2)
  assert.ok(summary.details.some((detail) => detail.includes('新增节点')))
  assert.ok(summary.details.some((detail) => detail.includes('新增依赖')))
  const layoutOnly = { ...before, nodes: before.nodes.map((node, index) => index === 0 ? { ...node, positionX: node.positionX + 80 } : node) }
  assert.equal(hasWorkflowAuditChanges(before, layoutOnly), false)
  assert.equal(hasWorkflowAuditChanges(before, before), false)
  assert.equal(hasWorkflowAuditChanges(before, after), true)
})

function makeWorkflow(baselineStart: string): Workflow {
  return {
    projectId: project.id,
    baselineStart,
    status: 'published',
    version: 1,
    publishedAt: '2026-08-31T09:00:00.000Z',
    calendar: { mode: 'natural', name: '项目自然日', weeklyWorkdays: [1, 2, 3, 4, 5], holidays: [], customRestDays: [], makeupWorkdays: [] },
    nodes: [
      makeNode('start', 'start', '项目开始', 0),
      makeNode('a', 'task', '前置任务 A', 3),
      makeNode('b', 'task', '前置任务 B', 2),
      makeNode('c', 'task', '汇聚任务 C', 4),
      makeNode('end', 'end', '项目结束', 0),
    ],
    edges: [
      { id: 'start-a', source: 'start', target: 'a', type: 'FS', lagDays: 0 },
      { id: 'start-b', source: 'start', target: 'b', type: 'FS', lagDays: 0 },
      { id: 'a-c', source: 'a', target: 'c', type: 'FS', lagDays: 0 },
      { id: 'b-c', source: 'b', target: 'c', type: 'FS', lagDays: 0 },
      { id: 'c-end', source: 'c', target: 'end', type: 'FS', lagDays: 0 },
    ],
  }
}

function makeNode(id: string, type: WorkflowNode['type'], name: string, duration: number): WorkflowNode {
  return { id, projectId: project.id, type, wbs: id, name, owner: '待分配', duration, effort: duration * 8, progress: 0, status: type === 'start' ? '已完成' : '未开始', position: { x: 0, y: 0 } }
}
