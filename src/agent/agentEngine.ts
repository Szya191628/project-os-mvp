import type { Project, Workflow, WorkflowNode } from '../types'
import { getTaskSummaries, isCompletionStatus } from '../workflow/taskQueries.ts'
import { diffSchedules, scheduleWorkflow } from '../workflow/schedule.ts'

export type AgentIntent =
  | 'project-create'
  | 'task-query'
  | 'predecessor-deliverable'
  | 'task-create'
  | 'task-update'
  | 'task-delete'
  | 'task-assign'
  | 'workflow-publish'
  | 'portfolio-analysis'
  | 'schedule-analysis'
  | 'resource-analysis'
  | 'deliverable-analysis'
  | 'workflow-generate'
  | 'workflow-edit'
  | 'navigation'
  | 'report'
  | 'unknown'

export type AgentActorRole = 'viewer' | 'editor' | 'publisher' | 'executor'
export type AgentFindingTone = 'danger' | 'warning' | 'success' | 'neutral'

export interface AgentEvidence {
  id: string
  title: string
  detail: string
  tone: AgentFindingTone
  projectId?: string
  taskId?: string
}

export interface AgentAction {
  id: string
  label: string
  kind: 'open-project' | 'preview-workflow' | 'create-project' | 'create-task' | 'update-task' | 'delete-task' | 'assign-task' | 'publish-workflow' | 'submit-deliverable' | 'get-predecessor-deliverable'
  projectId?: string
  taskId?: string
  workflow?: Workflow
  projectDraft?: AgentProjectDraft
  taskDraft?: AgentTaskDraft
  taskPatch?: AgentTaskPatch
  memberId?: string
  memberName?: string
  assignmentMode?: 'add' | 'remove' | 'replace'
  existingMemberIds?: string[]
  deliverable?: { name: string; kind?: string; versionLabel?: string; url?: string; mimeType?: string; sizeBytes?: number; externalProvider?: string; externalId?: string }
  predecessorTaskId?: string
  deliverableId?: string
}

export interface AgentProjectDraft {
  name: string
  code?: string
  owner?: string
  department?: string
  start: string
  end: string
  taskSpecs: Array<{ name: string; duration: number }>
}

export interface AgentTaskDraft {
  projectId: string
  name: string
  duration: number
  effort: number
  ownerMemberId?: string
  ownerName?: string
  description?: string
  closureCriteria?: string
}

export interface AgentTaskPatch {
  name?: string
  duration?: number
  effort?: number
  description?: string | null
  closureCriteria?: string | null
  status?: string
  progress?: number
  actualStart?: string | null
  actualEnd?: string | null
  completionNote?: string | null
  overdueReason?: string | null
}

export interface AgentResult {
  intent: AgentIntent
  intentLabel: string
  modeLabel: string
  confidence: number
  answer: string
  evidence: AgentEvidence[]
  actions: AgentAction[]
  suggestions: string[]
  missingFields: string[]
  scopeLabel: string
  sourceLabel: string
  previewWorkflow?: Workflow
}

export interface AgentContext {
  projects: Project[]
  workflows: Record<string, Workflow>
  currentProjectId?: string
  today?: string
  actorRole?: AgentActorRole
  members?: Array<{ id: string; name: string }>
}

type AgentHandlerResult = Pick<AgentResult, 'answer' | 'evidence' | 'actions' | 'suggestions' | 'scopeLabel'> & Partial<Pick<AgentResult, 'missingFields' | 'previewWorkflow'>>

const intentLabels: Record<AgentIntent, string> = {
  'project-create': '项目创建执行',
  'task-query': '任务查询',
  'predecessor-deliverable': '前置交付物获取',
  'task-create': '任务新增执行',
  'task-update': '任务修改执行',
  'task-delete': '任务删除执行',
  'task-assign': '负责人分配执行',
  'workflow-publish': '流程发布执行',
  'portfolio-analysis': '项目组合分析',
  'schedule-analysis': '排期影响分析',
  'resource-analysis': '资源负载分析',
  'deliverable-analysis': '交付物闭环检查',
  'workflow-generate': '流程草稿生成',
  'workflow-edit': '流程调整建议',
  navigation: '项目导航',
  report: '管理简报',
  unknown: '通用问答',
}

const modeLabels: Record<AgentIntent, string> = {
  'project-create': '执行确认',
  'task-query': '只读查询',
  'predecessor-deliverable': '执行确认',
  'task-create': '执行确认',
  'task-update': '执行确认',
  'task-delete': '执行确认',
  'task-assign': '执行确认',
  'workflow-publish': '执行确认',
  'workflow-generate': '草稿预览',
  'workflow-edit': '变更模拟',
  navigation: '导航',
  unknown: '只读分析',
  'portfolio-analysis': '只读分析',
  'schedule-analysis': '只读分析',
  'resource-analysis': '只读分析',
  'deliverable-analysis': '只读分析',
  report: '只读分析',
}

export function recognizeAgentIntent(question: string): AgentIntent {
  const value = question.trim()
  if (!value) return 'unknown'
  if (/(发布|上线|生效)/.test(value) && /(流程|任务|草稿|项目)/.test(value)) return 'workflow-publish'
  if (/(创建|新建|建立|立项).*(?:一个)?\s*项目|项目.*(创建|新建|建立|立项)/.test(value)) return 'project-create'
  if (/(生成|创建|新建|搭建|设计|制作|绘制).*(流程|流程图)|(?:流程|流程图).*(生成|创建|新建|搭建|设计|制作|绘制)/.test(value)) return 'workflow-generate'
  if (/(删除|移除|作废).*(?:任务|工作项|节点)|(?:任务|工作项|节点).*(删除|移除|作废)/.test(value)) return 'task-delete'
  if (/(添加|新增|新建|创建).*(?:任务|工作项|节点)|(?:任务|工作项|节点).*(添加|新增|新建|创建)/.test(value)) return 'task-create'
  if (/(负责人|指派|分配给|添加负责人|移除负责人)/.test(value) && /(任务|工作项|节点|1\.\d)/.test(value)) return 'task-assign'
  if (/(修改|更新|调整|把|将|改成|改为|设为|设置).*(?:任务|工作项|节点|工期|时长|进度|状态|名称|工作内容|描述|闭环条件|交付标准)|(?:任务|工作项|节点|工期|时长|进度|状态|名称|工作内容|描述|闭环条件|交付标准).*(修改|更新|调整|把|将|改成|改为|设为|设置)/.test(value)) return 'task-update'
  if (/(获取|下载|拿到|发给我|回传|取回|查看).*(上一个|前置|前一个).*(交付物|文件|文档|附件)|(上一个|前置|前一个).*(交付物|文件|文档|附件).*(获取|下载|拿到|发给我|回传|取回|查看)/.test(value)) return 'predecessor-deliverable'
  if (isImplicitTaskDetailsQuery(value)) return 'task-query'
  if (/(添加|插入|删除|连线|依赖|前置|后置|改.*工期|调整.*工期)/.test(value)) return 'workflow-edit'
  if (/(哪些项目|项目组合|项目健康|风险清单|项目可能延期)/.test(value)) return 'portfolio-analysis'
  if (/(工期|排期|顺延|延期|延误|提前|截止|日历|工作日|(?:增加|延长|减少|缩短)\s*\d+\s*(?:天|日))/.test(value)) return 'schedule-analysis'
  if (/(资源|负载|冲突|人员|谁.*任务|工时)/.test(value)) return 'resource-analysis'
  if (/(交付物|文档|闭环|检查项|缺少.*交付)/.test(value)) return 'deliverable-analysis'
  if (/(打开|查看|进入|定位).*(项目|任务|流程)|PRJ[-_]?\d+/i.test(value)) return 'navigation'
  if (/(查询|查找|查看|任务详情|任务进度|任务负责人)/.test(value) && /(任务|工作项|节点|1\.\d)/.test(value)) return 'task-query'
  if (/(简报|周报|汇报|报告)/.test(value)) return 'report'
  if (/(项目|风险|进度|延期|健康|组合|状态)/.test(value)) return 'portfolio-analysis'
  return 'unknown'
}

export function runAgentQuery(question: string, context: AgentContext): AgentResult {
  const intent = recognizeAgentIntent(question)
  const base = {
    intent,
    intentLabel: intentLabels[intent],
    modeLabel: modeLabels[intent],
    confidence: intent === 'unknown' ? 0.42 : 0.86,
    evidence: [] as AgentEvidence[],
    actions: [] as AgentAction[],
    suggestions: [] as string[],
    missingFields: [] as string[],
    scopeLabel: '全部项目',
    sourceLabel: `实时数据库 · ${context.projects.length} 个项目`,
  }

  switch (intent) {
    case 'project-create': return { ...base, ...generateProjectDraft(question, context) }
    case 'task-query': return { ...base, ...queryTask(question, context) }
    case 'task-create': return { ...base, ...generateTaskDraft(question, context) }
    case 'task-update': return { ...base, ...generateTaskPatch(question, context) }
    case 'task-delete': return { ...base, ...generateTaskDelete(question, context) }
    case 'task-assign': return { ...base, ...generateTaskAssignment(question, context) }
    case 'workflow-publish': return { ...base, ...generatePublishAction(question, context) }
    case 'portfolio-analysis': return { ...base, ...analyzePortfolio(question, context) }
    case 'schedule-analysis': return { ...base, ...analyzeSchedule(question, context) }
    case 'resource-analysis': return { ...base, ...analyzeResources(question, context) }
    case 'deliverable-analysis': return { ...base, ...analyzeDeliverables(question, context) }
    case 'workflow-generate': return { ...base, ...generateWorkflowDraft(question, context) }
    case 'workflow-edit': return { ...base, ...analyzeWorkflowEdit(question, context) }
    case 'navigation': return { ...base, ...navigateToEntity(question, context) }
    case 'report': return { ...base, ...buildReport(context) }
    default: return {
      ...base,
      answer: '我可以帮你分析项目组合、排期顺延、资源负载和交付物，也可以生成流程草稿并带你进入发布确认。请告诉我项目、任务或你想要的动作。',
      suggestions: ['哪些项目可能延期？', '分析未来四周的资源冲突', '检查缺少交付物的任务', '创建一个流程：需求澄清、方案设计、开发、验收'],
    }
  }
}

function analyzePortfolio(question: string, context: AgentContext): AgentHandlerResult {
  const scope = getScope(question, context)
  const projects = scope.projects
  const riskProjects = projects.filter((project) => project.health === '预警' || project.status === '有风险' || project.status === '已暂停')
  const taskCount = scope.tasks.length
  const overdueCount = scope.tasks.filter((task) => task.overdue).length
  const evidence: AgentEvidence[] = riskProjects.slice(0, 5).map((project) => ({
    id: `project-${project.id}`,
    title: `${project.code} · ${project.name}`,
    detail: `${project.health} · ${project.status} · 完成度 ${project.progress}% · 计划至 ${project.end}`,
    tone: project.health === '预警' || project.status === '有风险' ? 'danger' : 'warning',
    projectId: project.id,
  }))
  if (overdueCount > 0) evidence.push({ id: 'overdue-tasks', title: '排期检查', detail: `${overdueCount} 个未完成任务已超过计划结束日。`, tone: 'danger' })
  return {
    answer: projects.length === 0
      ? '当前没有可分析的项目数据。'
      : `当前范围内有 ${projects.length} 个项目、${taskCount} 个流程任务，其中 ${riskProjects.length} 个项目需要关注${overdueCount > 0 ? `，另有 ${overdueCount} 个任务已超期` : ''}。`,
    evidence,
    actions: riskProjects.slice(0, 3).map((project) => openProjectAction(project, '查看项目流程')),
    suggestions: riskProjects.length > 0 ? ['打开高风险项目查看受影响任务', '模拟延长关键任务后的顺延范围'] : ['查看资源负载', '生成本周项目组合简报'],
    scopeLabel: scope.label,
  }
}

function analyzeSchedule(question: string, context: AgentContext): AgentHandlerResult {
  const scope = getScope(question, context)
  const target = findTask(question, scope)
  const delta = parseDurationDelta(question)
  if (target && delta !== null) {
    const workflow = scope.workflows[target.projectId]
    if (!workflow) return { answer: '找到任务，但该项目还没有可用的流程版本。', evidence: [], actions: [], suggestions: ['打开项目后先保存流程草稿'], scopeLabel: scope.label }
    const before = scheduleWorkflow(workflow)
    const simulated: Workflow = { ...workflow, nodes: workflow.nodes.map((node) => node.id === target.id ? { ...node, duration: Math.max(0, node.duration + delta) } : node) }
    const after = scheduleWorkflow(simulated)
    const changes = diffSchedules(before, after).filter((change) => change.nodeId !== target.id && workflow.nodes.find((node) => node.id === change.nodeId)?.type !== 'end')
    const changedNames = changes.map((change) => workflow.nodes.find((node) => node.id === change.nodeId)?.name).filter(Boolean).slice(0, 5)
    return {
      answer: `已模拟“${target.name}”${delta >= 0 ? `增加 ${delta} 个自然日` : `减少 ${Math.abs(delta)} 个自然日`}：${changes.length > 0 ? `会影响 ${changes.length} 个下游节点` : '未发现下游节点排期变化'}。`,
      evidence: [
        { id: `schedule-${target.id}`, title: `${target.wbs} · ${target.name}`, detail: `原工期 ${target.duration} 天，模拟后 ${Math.max(0, target.duration + delta)} 天。`, tone: delta > 0 ? 'warning' : 'success', projectId: target.projectId, taskId: target.id },
        ...(changes.length > 0 ? [{ id: `schedule-impact-${target.id}`, title: '顺延范围', detail: changedNames.join('、') + (changes.length > changedNames.length ? ` 等 ${changes.length} 个节点` : ''), tone: 'warning' as const, projectId: target.projectId }] : []),
      ],
      actions: [openProjectAction(scope.projects.find((project) => project.id === target.projectId), '打开流程确认')],
      suggestions: ['在流程图中确认变更，再保存草稿', '查看该任务的前置和后置关系'],
      scopeLabel: scope.label,
      previewWorkflow: simulated,
    }
  }

  const issues = scope.workflowsList.flatMap((workflow) => scheduleWorkflow(workflow).issues.map((issue) => ({ workflow, issue })))
  const overdue = scope.tasks.filter((task) => task.overdue)
  return {
    answer: `排期检查完成：${issues.length} 个流程结构问题，${overdue.length} 个任务已超过计划结束日。后置任务会在全部前置任务提交完成后开始计时。`,
    evidence: [
      ...issues.slice(0, 4).map(({ workflow, issue }) => ({ id: `issue-${workflow.projectId}-${issue.code}`, title: `${getProjectName(context.projects, workflow.projectId)} · ${issue.code}`, detail: issue.message, tone: 'danger' as const, projectId: workflow.projectId })),
      ...overdue.slice(0, 4).map((task) => ({ id: `overdue-${task.id}`, title: `${task.projectCode} · ${task.wbs} ${task.name}`, detail: `计划结束 ${task.plannedEnd ?? '待排期'}，当前 ${task.progress}%。`, tone: 'warning' as const, projectId: task.projectId, taskId: task.id })),
    ],
    actions: overdue.slice(0, 3).map((task) => openProjectAction(scope.projects.find((project) => project.id === task.projectId), '查看超期任务')),
    suggestions: ['告诉我“1.1 增加 2 天”模拟顺延', '查看工作日历配置'],
    scopeLabel: scope.label,
  }
}

function analyzeResources(question: string, context: AgentContext): AgentHandlerResult {
  const scope = getScope(question, context)
  const rows = new Map<string, { effort: number; tasks: number; pending: number; projects: Set<string> }>()
  for (const task of scope.tasks) {
    const row = rows.get(task.owner) ?? { effort: 0, tasks: 0, pending: 0, projects: new Set<string>() }
    row.effort += task.effort
    row.tasks += 1
    row.pending += isCompletionStatus(task.status) ? 0 : 1
    row.projects.add(task.projectId)
    rows.set(task.owner, row)
  }
  const ranked = [...rows.entries()].sort((a, b) => b[1].effort - a[1].effort)
  const unassigned = ranked.find(([owner]) => owner === '待分配')
  return {
    answer: ranked.length === 0 ? '当前没有可汇总的任务负载。' : `当前范围有 ${ranked.length} 位任务负责人，计划工时最高的是 ${ranked[0][0]}（${ranked[0][1].effort} h，${ranked[0][1].projects.size} 个项目）。${unassigned ? `另有 ${unassigned[1].tasks} 个任务尚未分配负责人。` : ''}`,
    evidence: ranked.slice(0, 6).map(([owner, row], index) => ({ id: `resource-${owner}`, title: `${index + 1}. ${owner}`, detail: `${row.tasks} 个任务 · ${row.pending} 个待完成 · ${row.effort} h · ${row.projects.size} 个项目`, tone: index === 0 ? 'warning' : 'neutral' })),
    actions: [],
    suggestions: ['打开资源负载页查看跨项目明细', '按项目分析关键人员冲突'],
    scopeLabel: scope.label,
  }
}

function analyzeDeliverables(question: string, context: AgentContext): AgentHandlerResult {
  const scope = getScope(question, context)
  const missing = scope.nodes.filter((node) => node.type === 'task' || node.type === 'milestone').filter((node) => {
    const complete = isCompletionStatus(node.status) || node.progress >= 100
    return complete && (node.deliverables?.length ?? 0) === 0
  })
  return {
    answer: missing.length === 0 ? '没有发现已完成但缺少交付物的任务。' : `发现 ${missing.length} 个已完成任务没有关联交付物，建议在关闭任务前补齐文件或链接。`,
    evidence: missing.slice(0, 8).map((node) => ({ id: `deliverable-${node.id}`, title: `${getProjectName(context.projects, node.projectId)} · ${node.wbs} ${node.name}`, detail: `负责人：${node.owner} · 已完成 ${node.progress}% · 尚未关联文档/链接`, tone: 'warning' as const, projectId: node.projectId, taskId: node.id })),
    actions: missing.slice(0, 3).map((node) => openProjectAction(context.projects.find((project) => project.id === node.projectId), '补充交付物')),
    suggestions: ['打开任务详情上传交付物', '检查未完成任务的闭环检查项'],
    scopeLabel: scope.label,
  }
}

function queryTask(question: string, context: AgentContext): AgentHandlerResult {
  const scope = getScope(question, context)
  const implicitTaskQuery = isImplicitTaskDetailsQuery(question)
  const task = resolveTaskNode(question, context) ?? (implicitTaskQuery && scope.nodes.length === 1 ? scope.nodes[0] : undefined)
  if (!task) return { answer: '请提供任务编号（如 1.1）或任务名称，我会在当前登录用户的授权范围内查询。', evidence: [], actions: [], suggestions: ['查询 1.1 任务详情', '查看当前项目任务'], missingFields: ['任务编号或名称'], scopeLabel: '待补充' }
  const detailText = implicitTaskQuery ? ` 工作内容：${task.description?.trim() || '尚未填写'}；闭环标准：${task.closureCriteria?.trim() || '尚未设置'}。` : ''
  return { answer: `已找到任务“${task.wbs} ${task.name}”：${task.status}，进度 ${task.progress}%，工期 ${task.duration} 天，负责人 ${assigneeSummary(task)}。${detailText}`, evidence: [{ id: `task-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `状态：${task.status} · 进度：${task.progress}% · 计划：${task.plannedStart ?? '待排期'} → ${task.plannedEnd ?? '待排期'} · ${task.description?.trim() ? `工作内容：${task.description.trim()} · ` : ''}交付物 ${task.deliverables?.length ?? 0} 个`, tone: 'neutral', projectId: task.projectId, taskId: task.taskId ?? task.id }], actions: [openProjectAction(context.projects.find((project) => project.id === task.projectId), '打开任务详情')], suggestions: ['修改该任务工期或进度', '查看该任务交付物'], scopeLabel: `任务 · ${task.name}` }
}

function assigneeSummary(task: WorkflowNode) {
  return task.assigneeNames?.length ? task.assigneeNames.join('、') : task.owner || '待分配'
}

function generateTaskDraft(question: string, context: AgentContext): AgentHandlerResult {
  const project = resolveProject(question, context) ?? (context.currentProjectId ? context.projects.find((candidate) => candidate.id === context.currentProjectId) : context.projects.length === 1 ? context.projects[0] : undefined)
  if (!project) return { answer: '请先指定一个授权项目，例如“在 PRJ-001 新增任务：接口开发 3 天”。', evidence: [], actions: [], suggestions: ['在 PRJ-001 新增任务：接口开发 3 天'], missingFields: ['项目'], scopeLabel: '待选择项目' }
  const name = extractTaskName(question)
  if (!name) return { answer: '请提供任务名称，例如“在当前项目新增任务：接口开发 3 天”。', evidence: [], actions: [], suggestions: ['新增任务：接口开发 3 天'], missingFields: ['任务名称'], scopeLabel: `项目 · ${project.name}` }
  const duration = Math.max(0, Number(question.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)/)?.[1] ?? 1))
  const effort = Math.max(0, Number(question.match(/(?:工时|小时)\s*(?:为|改为|设置为|：|:)?\s*(\d+(?:\.\d+)?)/)?.[1] ?? duration * 8))
  const owner = findContextMember(question, context)
  const taskDraft = { projectId: project.id, name, duration, effort, ownerMemberId: owner?.id, ownerName: owner?.name }
  return { answer: `已准备在“${project.name}”中新增任务“${name}”。点击确认后将保存到流程草稿。`, evidence: [{ id: 'task-create-preview', title: `新增任务 · ${name}`, detail: `${duration} 天 · ${effort} h${owner ? ` · 负责人 ${owner.name}` : ''}`, tone: 'success', projectId: project.id }], actions: [{ id: `create-task-${project.id}`, label: '确认新增任务', kind: 'create-task', projectId: project.id, taskDraft }], suggestions: ['确认后继续调整任务描述和闭环条件', '新增下一项任务'], scopeLabel: `项目 · ${project.name}` }
}

function generateTaskPatch(question: string, context: AgentContext): AgentHandlerResult {
  const task = resolveTaskNode(question, context)
  if (!task) return { answer: '请提供要修改的任务编号（如 1.1）或名称。', evidence: [], actions: [], suggestions: ['修改 1.1 工期为 5 天', '把 1.1 进度改为 80%'], missingFields: ['任务编号或名称'], scopeLabel: '待补充' }
  const patch = parseContextTaskPatch(question, task)
  if (Object.keys(patch).length === 0) return { answer: `已找到任务“${task.wbs} ${task.name}”，但没有识别到要修改的字段。可修改名称、工期、工时、描述、闭环条件、状态或进度。`, evidence: [], actions: [], suggestions: [`把 ${task.wbs} 工期改为 ${task.duration + 1} 天`, `把 ${task.wbs} 进度改为 80%`], missingFields: ['修改字段'], scopeLabel: `任务 · ${task.name}` }
  return { answer: `已准备修改任务“${task.wbs} ${task.name}”。点击确认后将按当前登录用户权限保存修改。`, evidence: [{ id: `task-update-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: describeContextTaskPatch(patch), tone: 'warning', projectId: task.projectId, taskId: task.taskId ?? task.id }], actions: [{ id: `update-task-${task.id}`, label: '确认修改任务', kind: 'update-task', projectId: task.projectId, taskId: task.taskId ?? task.id, taskPatch: patch }], suggestions: ['确认修改', '继续调整该任务负责人'], scopeLabel: `任务 · ${task.name}` }
}

function generateTaskDelete(question: string, context: AgentContext): AgentHandlerResult {
  const task = resolveTaskNode(question, context)
  if (!task) return { answer: '请提供要删除的任务编号（如 1.1）或名称。', evidence: [], actions: [], suggestions: ['删除 1.1 任务'], missingFields: ['任务编号或名称'], scopeLabel: '待补充' }
  return { answer: `已准备删除任务“${task.wbs} ${task.name}”及其关联连线。点击确认后执行软删除。`, evidence: [{ id: `task-delete-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `所属项目：${getProjectName(context.projects, task.projectId)} · 关联交付物 ${task.deliverables?.length ?? 0} 个`, tone: 'warning', projectId: task.projectId, taskId: task.taskId ?? task.id }], actions: [{ id: `delete-task-${task.id}`, label: '确认删除任务', kind: 'delete-task', projectId: task.projectId, taskId: task.taskId ?? task.id }], suggestions: ['确认删除', '先打开任务查看详情'], scopeLabel: `任务 · ${task.name}` }
}

function generateTaskAssignment(question: string, context: AgentContext): AgentHandlerResult {
  const task = resolveTaskNode(question, context)
  const member = findContextMember(question, context)
  if (!task || !member) return { answer: !task ? '请提供任务编号或名称。' : '请提供公司在职成员姓名，例如“把 1.1 负责人改为周野”。', evidence: [], actions: [], suggestions: ['把 1.1 负责人改为周野', '给 1.1 添加负责人 林珊'], missingFields: [!task ? '任务编号或名称' : '成员姓名'], scopeLabel: '待补充' }
  const assignmentMode = /移除|取消|删除.*负责人/.test(question) ? 'remove' as const : /改为|改成|设置为|替换/.test(question) ? 'replace' as const : 'add' as const
  return { answer: `已准备${assignmentMode === 'remove' ? '移除' : assignmentMode === 'replace' ? '替换' : '添加'}任务“${task.wbs} ${task.name}”的负责人${assignmentMode === 'remove' ? '' : `为 ${member.name}`}。点击确认后按当前用户权限执行。`, evidence: [{ id: `task-assign-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `当前负责人：${assigneeSummary(task)} · 目标成员：${member.name}`, tone: 'warning', projectId: task.projectId, taskId: task.taskId ?? task.id }], actions: [{ id: `assign-task-${task.id}-${member.id}`, label: '确认调整负责人', kind: 'assign-task', projectId: task.projectId, taskId: task.taskId ?? task.id, memberId: member.id, memberName: member.name, assignmentMode, existingMemberIds: task.assigneeIds ?? [] }], suggestions: ['确认调整负责人', '查询该任务详情'], scopeLabel: `任务 · ${task.name}` }
}

function generatePublishAction(question: string, context: AgentContext): AgentHandlerResult {
  const project = resolveProject(question, context) ?? (context.currentProjectId ? context.projects.find((candidate) => candidate.id === context.currentProjectId) : context.projects.length === 1 ? context.projects[0] : undefined)
  if (!project) return { answer: '请指定要发布的授权项目，例如“发布 PRJ-001 的流程草稿”。', evidence: [], actions: [], suggestions: ['发布当前项目流程草稿'], missingFields: ['项目'], scopeLabel: '待选择项目' }
  return { answer: `已准备发布“${project.name}”的流程草稿。点击确认后将调用当前登录用户的流程发布权限。`, evidence: [{ id: `workflow-publish-${project.id}`, title: `${project.code} · ${project.name}`, detail: '发布后任务流程将对执行成员生效。', tone: 'warning', projectId: project.id }], actions: [{ id: `publish-workflow-${project.id}`, label: '确认发布流程', kind: 'publish-workflow', projectId: project.id }], suggestions: ['确认发布流程', '先检查任务连线和负责人'], scopeLabel: `项目 · ${project.name}` }
}

function generateProjectDraft(question: string, context: AgentContext): AgentHandlerResult {
  const name = extractProjectName(question)
  if (!name) return { answer: '请提供要创建的项目名称，例如“创建一个项目，名字叫光铸制作”。', evidence: [], actions: [], suggestions: ['创建一个项目，名字叫光铸制作'], missingFields: ['项目名称'], scopeLabel: '待补充' }
  const start = context.today ?? new Date().toISOString().slice(0, 10)
  const taskSpecs = parseTaskNames(question)
  const totalDuration = taskSpecs.reduce((sum, task) => sum + task.duration, 0)
  const end = addNaturalDays(start, Math.max(totalDuration, 1))
  const projectDraft: AgentProjectDraft = { name, owner: '', department: '研发中心', start, end, taskSpecs }
  return {
    answer: `已准备创建项目“${name}”${taskSpecs.length > 0 ? `，并包含 ${taskSpecs.length} 个流程任务` : ''}。点击确认后，Agent 将以当前登录用户身份调用项目创建权限。`,
    evidence: [{ id: 'project-create-preview', title: `新项目 · ${name}`, detail: `${start} → ${end}${taskSpecs.length > 0 ? ` · ${taskSpecs.map((task) => `${task.name}（${task.duration} 天）`).join('、')}` : ''}`, tone: 'success' }],
    actions: [{ id: 'create-project', label: '确认创建项目', kind: 'create-project', projectDraft }],
    suggestions: taskSpecs.length > 0 ? ['确认创建后继续载入流程草稿', '先创建项目，再补充负责人和交付物'] : ['确认创建后在流程图中添加任务'],
    missingFields: taskSpecs.length > 0 ? ['负责人', '闭环交付物', '具体工作内容'] : [],
    scopeLabel: '新项目草稿',
  }
}

function generateWorkflowDraft(question: string, context: AgentContext): AgentHandlerResult {
  const names = parseTaskNames(question)
  if (names.length < 2) {
    return {
      answer: '我可以先生成流程草稿，但还缺少至少两个任务。请按“任务名称 + 工期”提供清单，例如：需求澄清 3 天、方案设计 5 天、开发 7 天、验收 2 天。',
      evidence: [],
      actions: [],
      suggestions: ['创建一个流程：需求澄清 3 天、方案设计 5 天、开发 7 天、验收 2 天', '创建并行流程：接口开发 5 天、页面开发 5 天、联调 2 天'],
      missingFields: ['任务清单（至少 2 项）'],
      scopeLabel: context.currentProjectId ? `当前项目 · ${getProjectName(context.projects, context.currentProjectId)}` : '待选择项目',
    }
  }
  const projectId = context.currentProjectId ?? context.projects[0]?.id ?? 'agent-draft-project'
  const project = context.projects.find((candidate) => candidate.id === projectId)
  const baselineStart = context.today ?? new Date().toISOString().slice(0, 10)
  const parallel = /并行|同时/.test(question)
  const nodes: WorkflowNode[] = [
    { id: 'agent-start', projectId, type: 'start', wbs: '0', name: '项目开始', owner: '项目组', duration: 0, effort: 0, progress: 100, status: '已完成', position: { x: 40, y: 220 } },
    ...names.map((item, index) => ({
      id: `agent-task-${index + 1}`,
      projectId,
      type: 'task' as const,
      wbs: `1.${index + 1}`,
      name: item.name,
      owner: '待分配',
      duration: item.duration,
      effort: item.duration * 8,
      progress: 0,
      status: '未开始' as const,
      description: '由 Agent 根据自然语言生成的流程草稿，待管理员补充具体工作内容。',
      closureCriteria: '提交交付物并完成检查项',
      position: { x: 250 + (index % 3) * 270, y: 100 + Math.floor(index / 3) * 170 },
    })),
    { id: 'agent-end', projectId, type: 'end', wbs: '2', name: '项目结束', owner: '项目组', duration: 0, effort: 0, progress: 0, status: '未开始', position: { x: 1080, y: 220 } },
  ]
  const taskNodes = nodes.filter((node) => node.type === 'task')
  const edges: Workflow['edges'] = []
  if (parallel && taskNodes.length >= 3) {
    for (const node of taskNodes.slice(0, -1)) edges.push({ id: `agent-start-${node.id}`, source: 'agent-start', target: node.id, type: 'FS' as const, lagDays: 0 })
    const merge = taskNodes.at(-1)!
    for (const node of taskNodes.slice(0, -1)) edges.push({ id: `${node.id}-${merge.id}`, source: node.id, target: merge.id, type: 'FS' as const, lagDays: 0 })
    edges.push({ id: `${merge.id}-end`, source: merge.id, target: 'agent-end', type: 'FS' as const, lagDays: 0 })
  } else {
    edges.push({ id: 'agent-start-first', source: 'agent-start', target: taskNodes[0].id, type: 'FS' as const, lagDays: 0 })
    for (let index = 0; index < taskNodes.length - 1; index += 1) edges.push({ id: `${taskNodes[index].id}-${taskNodes[index + 1].id}`, source: taskNodes[index].id, target: taskNodes[index + 1].id, type: 'FS' as const, lagDays: 0 })
    edges.push({ id: `${taskNodes.at(-1)!.id}-end`, source: taskNodes.at(-1)!.id, target: 'agent-end', type: 'FS' as const, lagDays: 0 })
  }
  const previewWorkflow: Workflow = { projectId, baselineStart, status: 'draft', version: 0, nodes, edges, calendar: project ? context.workflows[project.id]?.calendar : undefined }
  const schedule = scheduleWorkflow(previewWorkflow)
  return {
    answer: `已生成 ${parallel ? '并行汇聚' : '串行'}流程草稿：${names.map((item) => `${item.name}（${item.duration} 天）`).join(' → ')}。这是预览版本，尚未写入数据库。`,
    evidence: [{ id: 'generated-flow', title: `${parallel ? '并行汇聚' : '串行'} · ${names.length} 个任务`, detail: `预计项目周期 ${schedule.schedules['agent-end']?.plannedEnd ?? '待计算'} · 前置关系已生成 · 负责人待分配`, tone: 'success', projectId }],
    actions: [{ id: 'preview-generated-flow', label: project ? '打开项目确认并录入' : '先选择项目', kind: 'preview-workflow', projectId, workflow: previewWorkflow }],
    suggestions: ['补充每个任务的负责人、交付物和具体工作内容', '确认后在项目流程图中保存草稿，再由管理员发布'],
    missingFields: ['负责人', '闭环交付物', '具体工作内容'],
    scopeLabel: project ? `项目 · ${project.name}` : 'Agent 临时草稿',
    previewWorkflow,
  }
}

function analyzeWorkflowEdit(question: string, context: AgentContext): AgentHandlerResult {
  const target = findTask(question, getScope(question, context))
  if (!target) {
    return { answer: '可以模拟添加任务、修改工期或调整前后置关系。请指定任务编号或名称，例如“1.1 增加 2 天”。', evidence: [], actions: [], suggestions: ['模拟 1.1 增加 2 天', '在两个任务之间插入一个任务'], scopeLabel: '待指定任务' }
  }
  return { answer: `已定位任务“${target.wbs} ${target.name}”。你可以继续告诉我需要增加几天、插入什么任务，Agent会先给出顺延预览。`, evidence: [{ id: `edit-target-${target.id}`, title: `${target.wbs} · ${target.name}`, detail: `当前工期 ${target.duration} 天 · ${target.owner} · ${target.status}`, tone: 'neutral', projectId: target.projectId, taskId: target.id }], actions: [openProjectAction(context.projects.find((project) => project.id === target.projectId), '打开流程编辑')], suggestions: ['增加 2 天并模拟下游顺延', '打开流程图调整连线'], scopeLabel: `${target.wbs} ${target.name}` }
}

function navigateToEntity(question: string, context: AgentContext): AgentHandlerResult {
  const scope = getScope(question, context)
  const task = findTask(question, scope)
  const project = resolveProject(question, context) ?? (task ? context.projects.find((candidate) => candidate.id === task.projectId) : undefined)
  if (!project) return { answer: '没有定位到对应项目。请提供项目编号（如 PRJ-001）或项目名称。', evidence: [], actions: [], suggestions: ['打开 PRJ-001', '查看当前项目流程'], scopeLabel: '未定位' }
  return {
    answer: task ? `已定位到“${project.name}”中的任务 ${task.wbs} ${task.name}。` : `已定位到项目“${project.name}”。`,
    evidence: [{ id: `navigation-${project.id}`, title: `${project.code} · ${project.name}`, detail: `负责人：${project.owner} · 进度 ${project.progress}% · ${project.status}`, tone: 'neutral', projectId: project.id, taskId: task?.id }],
    actions: [openProjectAction(project, task ? '打开任务详情' : '打开项目')],
    suggestions: task ? ['查看前置和后置任务', '检查该任务交付物'] : ['分析项目排期', '查看项目流程草稿'],
    scopeLabel: `项目 · ${project.name}`,
  }
}

function buildReport(context: AgentContext): AgentHandlerResult {
  const scope = getScope('', context)
  const risk = scope.projects.filter((project) => project.health === '预警' || project.status === '有风险').length
  const overdue = scope.tasks.filter((task) => task.overdue).length
  const owners = new Set(scope.tasks.map((task) => task.owner).filter((owner) => owner !== '待分配')).size
  return {
    answer: `项目组合简报：${scope.projects.length} 个项目，整体平均完成度 ${average(scope.projects.map((project) => project.progress))}%；${risk} 个项目需要关注，${overdue} 个任务超期，当前有 ${owners} 位负责人参与流程执行。`,
    evidence: scope.projects.slice(0, 5).map((project) => ({ id: `report-${project.id}`, title: `${project.code} · ${project.name}`, detail: `${project.status} · ${project.health} · 完成度 ${project.progress}% · 下一里程碑 ${project.nextMilestone}`, tone: project.health === '预警' ? 'danger' as const : project.health === '关注' ? 'warning' as const : 'success' as const, projectId: project.id })),
    actions: risk > 0 ? scope.projects.filter((project) => project.health === '预警' || project.status === '有风险').slice(0, 3).map((project) => openProjectAction(project, '查看风险项目')) : [],
    suggestions: ['导出本周项目组合简报（下一阶段）', '分析未来四周资源冲突'],
    scopeLabel: scope.label,
  }
}

function getScope(question: string, context: AgentContext) {
  const resolvedProject = resolveProject(question, context) ?? (/(当前项目|这个项目|本项目)/.test(question) ? context.projects.find((project) => project.id === context.currentProjectId) : undefined)
  const projects = resolvedProject ? [resolvedProject] : context.projects
  const workflowsList = projects.map((project) => context.workflows[project.id]).filter((workflow): workflow is Workflow => Boolean(workflow))
  const tasks = projects.flatMap((project) => getTaskSummaries(project, context.workflows[project.id], context.today ?? new Date().toISOString().slice(0, 10)))
  const nodes = workflowsList.flatMap((workflow) => workflow.nodes.filter((node) => node.type === 'task' || node.type === 'milestone'))
  return { projects, workflowsList, workflows: Object.fromEntries(workflowsList.map((workflow) => [workflow.projectId, workflow])), tasks, nodes, label: resolvedProject ? `项目 · ${resolvedProject.name}` : '全部项目' }
}

function resolveProject(question: string, context: AgentContext) {
  const normalized = question.toLowerCase()
  return context.projects.find((project) => normalized.includes(project.code.toLowerCase()) || normalized.includes(project.name.toLowerCase()))
}

function findTask(question: string, scope: ReturnType<typeof getScope>) {
  const wbs = question.match(/\b\d+(?:\.\d+)+\b/)?.[0]
  return scope.nodes.find((node) => (wbs && node.wbs === wbs) || question.includes(node.name))
}

function parseDurationDelta(question: string) {
  const match = question.match(/(?:增加|延长|顺延|减少|缩短|提前)\s*(\d+)\s*(?:天|日)?/)
  if (!match) return null
  const value = Number(match[1])
  return /减少|缩短|提前/.test(question) ? -value : value
}

function parseTaskNames(question: string) {
  if (!/\d+(?:\.\d+)?\s*(?:天|日)/.test(question)) return []
  const projectTaskSource = question.match(/(?:项目(?:名称|名)?|名字)\s*(?:叫|为|是)?\s*[^，,：:；;\n]+\s*[:：]\s*(.+)$/)?.[1]
  const source = projectTaskSource ?? question.match(/(?:包括|如下|任务有|任务是|流程[：:]|任务[：:])[\s：:]*(.+)$/)?.[1] ?? question
  const parts = source.split(/[，,、；;。]/).map((part) => part.trim()).filter(Boolean)
  return parts.map((part) => {
    const duration = Number(part.match(/(\d+(?:\.\d+)?)\s*(?:天|日)/)?.[1] ?? 3)
    const name = part.replace(/\d+(?:\.\d+)?\s*(?:天|日)/, '').replace(/^(?:请|帮我|生成|创建|新建|一个|流程|并行|串行|同时|然后|任务)\s*/, '').trim()
    return { name, duration: Math.max(0, duration) }
  }).filter((item) => item.name.length >= 2 && !/^(并行|串行|同时|后置|前置)$/.test(item.name))
}

function resolveTaskNode(question: string, context: AgentContext) {
  const scope = getScope(question, context)
  const wbs = question.match(/\b\d+(?:\.\d+)+\b/)?.[0]
  const normalized = question.toLowerCase()
  return scope.nodes.find((node) => (wbs && node.wbs === wbs) || normalized.includes(node.name.toLowerCase()))
}

function isImplicitTaskDetailsQuery(question: string) {
  return /(?:这个|该|当前|此).*(?:任务|工作项|节点).*(?:具体|详细|工作内容|工作说明|任务内容|描述|交付标准|闭环)|(?:具体|详细).*(?:内容|工作内容|任务内容|工作说明|任务描述)/.test(question)
}

function extractTaskName(question: string) {
  const named = question.match(/(?:任务|工作项|节点)(?:名称|名)?\s*(?:叫|为|是|：|:)\s*([^，,：:；;\n]+?)(?=\s*(?:\d+(?:\.\d+)?\s*(?:个)?\s*(?:自然日|工作日|天|日)|负责人|工时|小时|描述|说明|闭环|$))/)
  const fallback = question.match(/(?:添加|新增|新建|创建)\s*(?:一个)?\s*(?:任务|工作项|节点)\s*(?:：|:)\s*([^，,：:；;\n]+)/)
  return (named?.[1] ?? fallback?.[1])?.replace(/\d+(?:\.\d+)?\s*(?:个)?\s*(?:自然日|工作日|天|日)/, '').trim() || ''
}

function findContextMember(question: string, context: AgentContext) {
  const fallbackNames = context.projects.flatMap((project) => [project.owner]).concat(Object.values(context.workflows).flatMap((workflow) => workflow.nodes.flatMap((node) => [node.owner, ...(node.assigneeNames ?? [])])))
  const names = [...new Set((context.members?.map((member) => member.name) ?? fallbackNames).filter((name) => name && !['待分配', '项目组'].includes(name)))]
  const normalized = question.toLowerCase()
  const name = names.sort((left, right) => right.length - left.length).find((candidate) => normalized.includes(candidate.toLowerCase()))
  const member = context.members?.find((candidate) => candidate.name === name)
  return member ? { id: member.id, name: member.name } : undefined
}

function parseContextTaskPatch(question: string, task: WorkflowNode) {
  const patch: AgentTaskPatch = {}
  const duration = question.match(/(?:工期|时长|持续时间)\s*(?:(?:改为|改成|调整为|设置为|为|：|:)\s*)?(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)?/)
  const delta = question.match(/(?:工期|时长|持续时间)?\s*(增加|延长|减少|缩短)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)/)
  if (duration) patch.duration = Math.max(0, Number(duration[1]))
  if (delta) patch.duration = Math.max(0, task.duration + (['减少', '缩短'].includes(delta[1]) ? -1 : 1) * Number(delta[2]))
  const effort = question.match(/(?:工时|小时)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*(\d+(?:\.\d+)?)/)
  if (effort) patch.effort = Math.max(0, Number(effort[1]))
  const progress = question.match(/进度\s*(?:改为|改成|调整为|设置为|到|为|：|:)\s*(\d+(?:\.\d+)?)\s*%?/)
  if (progress) patch.progress = Math.max(0, Math.min(100, Number(progress[1])))
  const status = ['未开始', '进行中', '受阻', '已完成', '提前结束', '如期结束', '超期结束'].find((label) => new RegExp(`状态\\s*(?:改为|改成|调整为|设置为|为|：|:)\\s*${label}`).test(question))
  if (status) patch.status = status
  const name = question.match(/(?:名称|名字|标题)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*([^，,；;。\n]+)/)
  if (name?.[1]) patch.name = name[1].trim()
  const description = question.match(/(?:工作内容|描述|说明)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*([^。\n]+)/)
  if (description?.[1]) patch.description = description[1].trim()
  const closure = question.match(/(?:闭环条件|交付标准)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*([^。\n]+)/)
  if (closure?.[1]) patch.closureCriteria = closure[1].trim()
  return patch
}

function describeContextTaskPatch(patch: AgentTaskPatch) {
  return [patch.name ? `名称：${patch.name}` : '', patch.duration === undefined ? '' : `工期：${patch.duration} 天`, patch.effort === undefined ? '' : `工时：${patch.effort} h`, patch.progress === undefined ? '' : `进度：${patch.progress}%`, patch.status ? `状态：${patch.status}` : '', patch.description ? '更新工作内容' : '', patch.closureCriteria ? '更新闭环条件' : ''].filter(Boolean).join(' · ')
}

function extractProjectName(question: string) {
  const named = question.match(/名字\s*(?:叫|为|是)\s*[:：]?\s*([^，,：:；;\n]+?)(?=\s*[:：，,；;\n]|$)/)
  if (named?.[1]) return named[1].trim()
  const projectNamed = question.match(/项目(?:名称|名)?\s*(?:叫|为|是)\s*[:：]?\s*([^，,：:；;\n]+?)(?=\s*[:：，,；;\n]|$)/)
  if (projectNamed?.[1]) return projectNamed[1].trim()
  const prefix = question.match(/(?:创建|新建|建立|立项)\s*(?:一个)?\s*项目\s*(?:叫|为|是)?\s*[:：]?\s*([^，,：:；;\n]+?)(?=\s*[:：，,；;\n]|$)/)
  return prefix?.[1]?.trim() || ''
}

function addNaturalDays(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function openProjectAction(project: Project | undefined, label: string): AgentAction {
  return { id: `open-${project?.id ?? 'project'}`, label, kind: 'open-project', projectId: project?.id }
}

function getProjectName(projects: Project[], projectId: string) {
  return projects.find((project) => project.id === projectId)?.name ?? '未知项目'
}

function average(values: number[]) {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}
