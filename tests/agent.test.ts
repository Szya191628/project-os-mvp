import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, Workflow, WorkflowNode } from '../src/types.ts'
import { recognizeAgentIntent, runAgentQuery } from '../src/agent/agentEngine.ts'
import { embedText, isEphemeralChitchat } from '../server/src/agent/agentMemoryUtils.ts'

const project: Project = {
  id: 'agent-project',
  code: 'PRJ-AGENT',
  name: 'Agent 测试项目',
  owner: '陈默',
  ownerInitials: 'CM',
  department: '研发中心',
  status: '执行中',
  progress: 35,
  start: '2026-09-01',
  end: '2026-09-30',
  budget: 100000,
  actualCost: 20000,
  health: '健康',
  memberIds: [],
  nextMilestone: '方案评审',
}

test('Agent 按关键词识别分析、草稿和发布意图', () => {
  assert.equal(recognizeAgentIntent('分析未来四周的资源冲突'), 'resource-analysis')
  assert.equal(recognizeAgentIntent('创建一个流程：需求澄清 3 天、方案设计 5 天'), 'workflow-generate')
  assert.equal(recognizeAgentIntent('发布 PRJ-AGENT 的流程草稿'), 'workflow-publish')
  assert.equal(recognizeAgentIntent('创建一个项目 名字叫光铸制作：需求澄清 3 天'), 'project-create')
  assert.equal(recognizeAgentIntent('获取我上一个节点的交付物'), 'predecessor-deliverable')
})

test('Agent 创建项目时先返回带流程清单的确认动作', () => {
  const result = runAgentQuery('创建一个项目 名字叫光铸制作：需求澄清 3 天、方案设计 5 天', { projects: [], workflows: {}, today: '2026-09-01', actorRole: 'publisher' })

  assert.equal(result.intent, 'project-create')
  assert.equal(result.actions[0]?.kind, 'create-project')
  assert.equal(result.actions[0]?.projectDraft?.name, '光铸制作')
  assert.deepEqual(result.actions[0]?.projectDraft?.taskSpecs.map((task) => task.name), ['需求澄清', '方案设计'])
})

test('Agent 可以模拟任务工期变化并返回下游影响', () => {
  const workflow = makeWorkflow()
  const result = runAgentQuery('PRJ-AGENT 的 1.1 增加 2 天', { projects: [project], workflows: { [project.id]: workflow }, today: '2026-09-01', actorRole: 'publisher' })

  assert.equal(result.intent, 'schedule-analysis')
  assert.match(result.answer, /影响 1 个下游节点/)
  assert.equal(result.previewWorkflow?.nodes.find((node) => node.wbs === '1.1')?.duration, 5)
})

test('Agent 生成流程草稿时创建任务和汇聚关系', () => {
  const result = runAgentQuery('为 PRJ-AGENT 创建并行流程：接口开发 5 天、页面开发 5 天、联调 2 天', { projects: [project], workflows: {}, currentProjectId: project.id, today: '2026-09-01' })

  assert.equal(result.intent, 'workflow-generate')
  assert.equal(result.previewWorkflow?.nodes.filter((node) => node.type === 'task').length, 3)
  assert.equal(result.previewWorkflow?.edges.length, 5)
  assert.equal(result.previewWorkflow?.edges.filter((edge) => edge.target === 'agent-task-3').length, 2)
})

test('Agent 能找出已完成但缺少交付物的任务', () => {
  const workflow = makeWorkflow()
  workflow.nodes.find((node) => node.wbs === '1.1')!.status = '已完成'
  workflow.nodes.find((node) => node.wbs === '1.1')!.progress = 100
  const result = runAgentQuery('检查缺少交付物的任务', { projects: [project], workflows: { [project.id]: workflow }, today: '2026-09-01' })

  assert.equal(result.intent, 'deliverable-analysis')
  assert.equal(result.evidence.length, 1)
  assert.match(result.evidence[0].detail, /尚未关联文档/)
})

test('Agent 支持任务查询、新增、修改、删除和负责人调整确认动作', () => {
  const workflow = makeWorkflow()
  workflow.nodes[1].taskId = 'db-task-1'
  workflow.nodes[1].assigneeIds = ['member-lin']
  workflow.nodes[1].assigneeNames = ['林珊']
  const context = { projects: [project], workflows: { [project.id]: workflow }, currentProjectId: project.id, today: '2026-09-01', actorRole: 'publisher' as const, members: [{ id: 'member-lin', name: '林珊' }, { id: 'member-zhou', name: '周野' }] }

  const query = runAgentQuery('查询 1.1 任务详情', context)
  assert.equal(query.intent, 'task-query')
  assert.equal(query.actions[0]?.kind, 'open-project')

  const create = runAgentQuery('在 PRJ-AGENT 新增任务：接口开发 3 天，负责人周野', context)
  assert.equal(create.intent, 'task-create')
  assert.equal(create.actions[0]?.kind, 'create-task')
  assert.equal(create.actions[0]?.taskDraft?.ownerMemberId, 'member-zhou')

  const update = runAgentQuery('把 PRJ-AGENT 的 1.1 工期改为 5 天、进度改为 80%', context)
  assert.equal(update.intent, 'task-update')
  assert.equal(update.actions[0]?.kind, 'update-task')
  assert.deepEqual(update.actions[0]?.taskPatch, { duration: 5, progress: 80 })

  const remove = runAgentQuery('删除 PRJ-AGENT 的 1.1 任务', context)
  assert.equal(remove.intent, 'task-delete')
  assert.equal(remove.actions[0]?.kind, 'delete-task')

  const assign = runAgentQuery('把 PRJ-AGENT 的 1.1 负责人改为周野', context)
  assert.equal(assign.intent, 'task-assign')
  assert.equal(assign.actions[0]?.kind, 'assign-task')
  assert.equal(assign.actions[0]?.assignmentMode, 'replace')
  assert.deepEqual(assign.actions[0]?.existingMemberIds, ['member-lin'])
})

test('Agent 能从“我的任务”上下文回答当前任务的具体工作内容', () => {
  const workflow = makeWorkflow()
  workflow.nodes.splice(2, 1)
  workflow.edges = [
    { id: 'start-first', source: 'start', target: 'task-1', type: 'FS', lagDays: 0 },
    { id: 'first-end', source: 'task-1', target: 'end', type: 'FS', lagDays: 0 },
  ]
  workflow.nodes[1].description = '实现接口鉴权和参数校验'
  workflow.nodes[1].closureCriteria = '接口测试全部通过'

  const result = runAgentQuery('这个任务的具体工作内容是什么？', {
    projects: [project],
    workflows: { [project.id]: workflow },
    currentProjectId: project.id,
    today: '2026-09-01',
    actorRole: 'member',
  })

  assert.equal(result.intent, 'task-query')
  assert.match(result.answer, /实现接口鉴权和参数校验/)
  assert.match(result.answer, /接口测试全部通过/)

  const shorthand = runAgentQuery('具体内容呢？', {
    projects: [project],
    workflows: { [project.id]: workflow },
    currentProjectId: project.id,
    today: '2026-09-01',
    actorRole: 'member',
  })
  assert.equal(shorthand.intent, 'task-query')
  assert.match(shorthand.answer, /实现接口鉴权和参数校验/)
})

test('Agent 为流程发布返回需要确认的动作', () => {
  const result = runAgentQuery('发布 PRJ-AGENT 的流程草稿', { projects: [project], workflows: {}, currentProjectId: project.id, actorRole: 'publisher' })

  assert.equal(result.intent, 'workflow-publish')
  assert.equal(result.actions[0]?.kind, 'publish-workflow')
})

test('Agent 记忆会识别短暂闲聊并生成可比较的向量', () => {
  assert.equal(isEphemeralChitchat('你好'), true)
  assert.equal(isEphemeralChitchat('查询我的任务'), false)
  const left = embedText('以后默认用简洁表格回答')
  const right = embedText('请保持简洁格式回答')
  assert.equal(left.length, right.length)
  assert.ok(left.some((value) => value !== 0))
})

function makeWorkflow(): Workflow {
  const first = makeNode('task-1', '1.1', '前置任务', 3)
  const second = makeNode('task-2', '1.2', '后置任务', 2)
  return {
    projectId: project.id,
    baselineStart: '2026-09-01',
    status: 'draft',
    version: 0,
    nodes: [
      makeNode('start', '0', '项目开始', 0, 'start'),
      first,
      second,
      makeNode('end', '2', '项目结束', 0, 'end'),
    ],
    edges: [
      { id: 'start-first', source: 'start', target: first.id, type: 'FS', lagDays: 0 },
      { id: 'first-second', source: first.id, target: second.id, type: 'FS', lagDays: 0 },
      { id: 'second-end', source: second.id, target: 'end', type: 'FS', lagDays: 0 },
    ],
  }
}

function makeNode(id: string, wbs: string, name: string, duration: number, type: WorkflowNode['type'] = 'task'): WorkflowNode {
  return { id, projectId: project.id, type, wbs, name, owner: type === 'task' ? '陈默' : '项目组', duration, effort: duration * 8, progress: type === 'start' ? 100 : 0, status: type === 'start' ? '已完成' : '未开始', position: { x: 0, y: 0 } }
}
