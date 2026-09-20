import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, envApiKeyAuth, Type } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { randomUUID } from 'node:crypto'
import type { AuthContext } from '../auth.js'
import { hasAgentPermission, isGlobalL2, isL1, projectAccess, visibleProjectIds } from '../auth.js'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { projectSummary, projectSummarySelect, serializeVersion, versionSelect } from '../routes/projects.js'
import { requestsTaskCompletion, resolveAttachmentAwareIntent } from '../dingtalkBotCommands.js'
import { prepareAgentMemory, promptWithMemory, recordAgentTurn, type AgentMemoryContext } from './agentMemory.js'
import { resolveDeliverableTarget } from './deliverableCommand.js'
import type { AgentAction, AgentAttachment, AgentEvidence, AgentProjectDraft, AgentProjectSnapshot, AgentRequest, AgentRun, AgentSnapshot, AgentTaskPatch, AgentTaskSnapshot, AgentTaskSpec, AgentWorkflowPreview } from './types.js'

const completedStatuses = new Set(['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'])
const intentLabels: Record<string, string> = {
  'project-create': '项目创建执行',
  'task-query': '任务查询',
  'predecessor-deliverable': '前置交付物获取',
  'deliverable-submit': '交付物提交',
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
  report: '管理简报',
  unknown: '通用问答',
}

export class AgentBlockedError extends Error {
  constructor(message = '当前账号没有可使用 Project Agent 的项目权限') {
    super(message)
    this.name = 'AgentBlockedError'
  }
}

export async function runProjectAgent(actor: AuthContext, request: AgentRequest): Promise<AgentRun> {
  const runId = randomUUID()
  if (!(await hasAgentPermission(actor))) return blockedRun(runId, actor, 'L3 不能使用 Project Agent。请通过钉钉任务通知、固定进度指令或发送任务编号和交付物完成操作。')
  const message = request.message.trim() || (request.attachment ? '提交交付物' : '')
  let memory: AgentMemoryContext | null = null
  try {
    memory = await prepareAgentMemory(actor, { ...request, message })
  } catch (error) {
    console.warn('[Agent] memory prepare failed', error instanceof Error ? error.message : error)
  }
  const finish = async (result: AgentRun) => {
    if (memory) {
      try { await recordAgentTurn(actor, { ...request, message }, result, memory) } catch (error) { console.warn('[Agent] memory record failed', error instanceof Error ? error.message : error) }
    }
    return result
  }
  if (!message) return finish(blockedRun(runId, actor, '请输入要分析的问题。'))

  const intent = resolveAttachmentAwareIntent(message, request.attachment, recognizeIntent(message))
  const snapshot = await loadSnapshot(actor, request.projectId, intent === 'project-create')
  if (!snapshot) return finish(blockedRun(runId, actor, '当前账号没有可使用 Project Agent 的项目权限。请联系 L1 或项目级 L2 管理员授权。'))

  // Workflow generation returns a validated, structured draft from the local
  // parser so the UI can render and confirm it. The model remains available
  // for narrative analysis, but it must not be responsible for JSON shape or
  // write operations.
  if (snapshot.scope.level !== 'L3' && !['workflow-generate', 'project-create', 'task-query', 'predecessor-deliverable', 'deliverable-submit', 'task-create', 'task-update', 'task-delete', 'task-assign', 'workflow-publish'].includes(intent) && config.pi.available) {
    try {
      return finish(await runWithPi(runId, promptWithMemory(message, memory), message, snapshot, memory?.conversationId ?? request.conversationId))
    } catch {
      // Model providers are external dependencies. Keep the project usable when
      // the provider is unavailable, misconfigured, or times out.
    }
  }
  return finish(runDeterministic(runId, message, snapshot, request.attachment))
}

async function loadSnapshot(actor: AuthContext, requestedProjectId: string | undefined, allowEmpty = false): Promise<AgentSnapshot | null> {
  const visibleIds = await visibleProjectIds(actor)
  const candidateIds = visibleIds ? [...visibleIds] : undefined
  if (requestedProjectId && candidateIds && !candidateIds.includes(requestedProjectId)) return null

  const projects = await prisma.project.findMany({
    where: {
      organizationId: actor.organizationId,
      archivedAt: null,
      ...(candidateIds ? { id: { in: candidateIds } } : {}),
      ...(requestedProjectId ? { id: requestedProjectId } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { code: 'asc' }],
    select: projectSummarySelect,
  })

  const accessEntries = isL1(actor)
    ? projects.map((project) => [project, { level: 'L1' as const }] as const)
    : await Promise.all(projects.map(async (project) => [project, await projectAccess(actor, project.id)] as const))
  const allowedEntries = accessEntries.filter(([, access]) => access !== null)
  const allowedProjects = allowedEntries.map(([project]) => project)
  const accessByProject = new Map(allowedEntries.map(([project, access]) => [project.id, access!]))
  if (requestedProjectId && !allowedProjects.some((project) => project.id === requestedProjectId)) return null
  if (!isL1(actor) && allowedProjects.length === 0 && !(allowEmpty && isGlobalL2(actor))) return null

  const managerScope = isL1(actor) || isGlobalL2(actor) || allowedEntries.some(([, access]) => access?.level === 'L2')
  const members = managerScope
    ? await prisma.member.findMany({ where: { organizationId: actor.organizationId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : []

  const projectSnapshots = await Promise.all(allowedProjects.map(async (project) => {
    const summary = projectSummary(project)
    const workflow = await prisma.workflow.findUnique({
      where: { projectId: project.id },
      select: { draftVersionId: true, publishedVersionId: true },
    })
    const versionId = workflow?.draftVersionId ?? workflow?.publishedVersionId
    const version = versionId ? await prisma.workflowVersion.findUnique({ where: { id: versionId }, select: versionSelect }) : null
    const serialized = serializeVersion(version)
    const taskNodes = serialized?.nodes.filter((node) => node.nodeType === 'TASK' || node.nodeType === 'MILESTONE') ?? []
    const access = accessByProject.get(project.id)
    const isScopedL3 = access?.level === 'L3'
    const ownTaskIds = new Set(taskNodes.filter((node) => node.taskId && (node.task?.assignees.some((assignee) => assignee.memberId === actor.memberId) || node.ownerMember?.id === actor.memberId)).map((node) => node.taskId!))
    const ownNodeIds = new Set(taskNodes.filter((node) => node.taskId && ownTaskIds.has(node.taskId)).map((node) => node.id))
    const exposedNodeIds = new Set(ownNodeIds)
    if (isScopedL3 && serialized) {
      // L3 may inspect the direct predecessor(s) of their own task, but no
      // unrelated task, owner, schedule, budget, or member data.
      for (const edge of serialized.edges) {
        if (ownNodeIds.has(edge.targetNodeId)) exposedNodeIds.add(edge.sourceNodeId)
      }
    }
    const visibleTaskNodes = isScopedL3 ? taskNodes.filter((node) => exposedNodeIds.has(node.id)) : taskNodes
    const snapshotByNodeId = new Map<string, AgentTaskSnapshot>()
    for (const node of visibleTaskNodes) {
      const deliverables = node.task?.deliverables.map((deliverable) => ({
        id: deliverable.id,
        name: deliverable.name,
        kind: deliverable.kind,
        versionLabel: deliverable.versionLabel,
        url: deliverable.url,
        objectKey: deliverable.objectKey,
        mimeType: deliverable.mimeType,
        sizeBytes: deliverable.sizeBytes,
        externalProvider: deliverable.externalProvider,
        externalId: deliverable.externalId,
        approvalProcessInstanceId: deliverable.approvalProcessInstanceId,
        approvalProcessCode: deliverable.approvalProcessCode,
        approvalFileId: deliverable.approvalFileId,
        approvalSpaceId: deliverable.approvalSpaceId,
        createdAt: deliverable.createdAt.toISOString(),
        uploader: deliverable.uploader?.name ?? null,
      })) ?? []
      snapshotByNodeId.set(node.id, {
        id: node.taskId ?? node.id,
        wbs: node.wbs,
        name: node.name,
        projectId: project.id,
        owner: node.ownerMember?.name ?? '待分配',
        effortHours: node.effortHours,
        durationDays: node.durationDays,
        progress: node.task?.execution?.progress ?? 0,
        status: node.task?.execution?.status ?? 'NOT_STARTED',
        plannedStart: node.schedules[0]?.plannedStart ?? null,
        plannedEnd: node.schedules[0]?.plannedEnd ?? null,
        description: node.description,
        closureCriteria: node.closureCriteria,
        assignees: node.task?.assignees.map((assignee) => assignee.member.name) ?? [],
        assigneeIds: node.task?.assignees.map((assignee) => assignee.memberId) ?? [],
        ownerMemberId: node.ownerMember?.id,
        deliverableCount: deliverables.length,
        incompleteClosureCheckCount: node.task?.closureChecks.filter((check) => !check.completed).length ?? 0,
        isMine: ownNodeIds.has(node.id),
        deliverables,
        closureChecks: node.task?.closureChecks.map((check) => ({ id: check.id, label: check.label, completed: check.completed })) ?? [],
      })
    }
    if (serialized) {
      for (const node of visibleTaskNodes) {
        const snapshot = snapshotByNodeId.get(node.id)
        if (!snapshot || !snapshot.isMine) continue
        snapshot.predecessors = serialized.edges
          .filter((edge) => edge.targetNodeId === node.id)
          .map((edge) => snapshotByNodeId.get(edge.sourceNodeId))
          .filter((candidate): candidate is AgentTaskSnapshot => Boolean(candidate))
          .map((candidate) => ({ id: candidate.id, wbs: candidate.wbs, name: candidate.name, status: candidate.status, progress: candidate.progress, deliverables: candidate.deliverables ?? [] }))
      }
    }
    const tasks = [...snapshotByNodeId.values()]
    return {
      id: summary.id,
      code: summary.code,
      name: summary.name,
      status: summary.status,
      health: summary.health,
      plannedStart: summary.plannedStart,
      plannedEnd: summary.plannedEnd,
      progress: summary.progress,
      owner: summary.owner?.name ?? '待分配',
      budgetAmount: isScopedL3 ? null : summary.budgetAmount,
      actualCostAmount: isScopedL3 ? null : summary.actualCostAmount,
      tasks,
    } satisfies AgentProjectSnapshot
  }))

  return {
    projects: projectSnapshots,
    scope: { level: isL1(actor) ? 'L1' : isGlobalL2(actor) ? 'L2' : 'L3', projectIds: isL1(actor) ? 'all' : projectSnapshots.map((project) => project.id) },
    actor: { memberId: actor.memberId, organizationId: actor.organizationId },
    capabilities: { canCreateProject: isL1(actor) || isGlobalL2(actor) },
    members,
    today: new Date().toISOString().slice(0, 10),
  }
}

function runDeterministic(runId: string, message: string, snapshot: AgentSnapshot, attachment?: AgentAttachment): AgentRun {
  const intent = resolveAttachmentAwareIntent(message, attachment, recognizeIntent(message))
  const selected = resolveProject(message, snapshot.projects)
  const projects = selected ? [selected] : snapshot.projects
  const tasks = projects.flatMap((project) => project.tasks)
  const scopeLabel = selected ? `项目 · ${selected.name}` : '全部授权项目'
  const base = {
    runId,
    status: 'completed' as const,
    intent,
    intentLabel: intentLabels[intent] ?? intentLabels.unknown,
     modeLabel: ['workflow-generate', 'project-create', 'task-create', 'task-update', 'task-delete', 'task-assign', 'workflow-publish', 'deliverable-submit', 'predecessor-deliverable'].includes(intent) ? '执行确认' : '只读分析',
    confidence: intent === 'unknown' ? 0.42 : 0.86,
    evidence: [] as AgentEvidence[],
    actions: [] as AgentAction[],
    suggestions: ['查看项目排期', '分析未来四周的资源冲突'],
    missingFields: [] as string[],
    scopeLabel,
    sourceLabel: `Project OS 后端实时数据 · ${projects.length} 个项目 · 本地确定性兜底`,
    scope: snapshot.scope,
  }

  if (snapshot.scope.level === 'L3' && !['task-query', 'predecessor-deliverable', 'task-update', 'deliverable-submit', 'unknown'].includes(intent)) {
    return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: 'L3 Agent 当前支持查询自己的任务、查看直接前置节点及其交付物、同步自己的进度和提交交付物；项目结构、负责人分配、删除和发布需由 L1/L2 管理员处理。', suggestions: ['查看我的任务', '获取我上一个节点的交付物', '把我的任务进度改为 80%', '给我的任务提交交付物'] }
  }

  if (intent === 'project-create') {
    if (!snapshot.capabilities.canCreateProject) return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: '当前登录用户没有新建项目权限，Agent 不会越权执行。请使用 L1 或全局 L2 账号，或联系管理员授权。', suggestions: ['查看当前授权项目', '联系 L1 管理员开通项目创建权限'] }
    const projectDraft = parseProjectDraft(message, snapshot.today)
    if (!projectDraft) return { ...base, modeLabel: '需要补充信息', answer: '请提供要创建的项目名称，例如“创建一个项目，名字叫光铸制作”。', missingFields: ['项目名称'], suggestions: ['创建一个项目，名字叫光铸制作'] }
    const taskSummary = projectDraft.taskSpecs.length > 0 ? `，并包含 ${projectDraft.taskSpecs.length} 个流程任务` : ''
    return { ...base, answer: `已准备创建项目“${projectDraft.name}”${taskSummary}。点击确认后，Agent 将以当前登录用户身份调用项目创建权限。`, evidence: [{ id: 'project-create-preview', title: `新项目 · ${projectDraft.name}`, detail: `${projectDraft.start} → ${projectDraft.end}${taskSummary}`, tone: 'success' }], actions: [{ id: 'create-project', label: '确认创建项目', kind: 'create-project', projectDraft }], suggestions: projectDraft.taskSpecs.length > 0 ? ['确认创建后继续载入流程草稿', '先创建项目，再补充负责人和交付物'] : ['确认创建后在流程图中添加任务'], missingFields: projectDraft.taskSpecs.length > 0 ? ['负责人', '闭环交付物', '具体工作内容'] : [] }
  }

  if (intent === 'task-query') {
    const ownTasks = tasks.filter((candidate) => candidate.isMine)
    const implicitTaskQuery = isImplicitTaskDetailsQuery(message)
    const task = resolveTask(message, projects) ?? ((/(?:上一个|前置|前一个)/.test(message) || implicitTaskQuery) && ownTasks.length === 1 ? ownTasks[0] : undefined)
    if (!task && /(?:我的|自己|我负责|本人|待我)/.test(message)) {
      const ownTasks = tasks.filter((candidate) => candidate.isMine)
      if (ownTasks.length === 0) return { ...base, answer: '当前授权范围内没有分配给你的任务。', suggestions: ['联系项目 L2 管理员分配任务'] }
      return { ...base, answer: `你当前有 ${ownTasks.length} 个任务：${ownTasks.map((candidate) => `${candidate.wbs} ${candidate.name}（${candidate.progress}%）`).join('、')}。`, evidence: ownTasks.slice(0, 8).map((candidate) => ({ id: `task-${candidate.id}`, title: `${candidate.wbs} · ${candidate.name}`, detail: `状态：${candidate.status} · 进度：${candidate.progress}% · ${candidate.description?.trim() ? `工作内容：${candidate.description.trim()} · ` : ''}交付物 ${candidate.deliverableCount} 个`, tone: 'neutral' as const, projectId: candidate.projectId, taskId: candidate.id })), suggestions: ['查看任务具体工作内容', '查看某个任务的上一个节点', '更新我的任务进度'] }
    }
    if (!task) return { ...base, modeLabel: '需要补充信息', answer: '请提供任务编号（如 1.1）或任务名称，我会在当前登录用户的授权范围内查询。', missingFields: ['任务编号或名称'], suggestions: ['查询 1.1 任务详情', '查看当前项目任务'] }
    if (snapshot.scope.level === 'L3' && !task.isMine) return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: 'L3 只能查询自己负责的任务；直接前置节点只能在查询自己的任务时随附查看。', suggestions: ['查看我的任务', '查看自己的任务上一个节点'] }
    const detailText = (implicitTaskQuery || Boolean(resolveTask(message, projects)))
      ? ` 工作内容：${task.description?.trim() || '尚未填写'}；闭环标准：${task.closureCriteria?.trim() || '尚未设置'}；检查项：${task.closureChecks?.length ? task.closureChecks.map((check) => `${check.completed ? '已完成' : '待完成'}${check.label}`).join('、') : '无'}。`
      : ''
    const predecessorText = /(?:上一个|前置|前一个)/.test(message)
      ? (task.predecessors?.length ? ` 上一个任务节点：${task.predecessors.map((predecessor) => `${predecessor.wbs} ${predecessor.name}（${predecessor.status}，${predecessor.progress}%${predecessor.deliverables.length > 0 ? `，交付物：${predecessor.deliverables.map((item) => item.name).join('、')}` : '，暂无交付物'}）`).join('；')}` : ' 该任务没有已配置的直接前置任务。')
      : ''
    const deliverableText = task.deliverables?.length ? `，交付物：${task.deliverables.map((item) => item.name).join('、')}` : '，暂无交付物'
    return { ...base, answer: `已找到任务“${task.wbs} ${task.name}”：${task.status}，进度 ${task.progress}%，工期 ${task.durationDays} 天，负责人 ${task.assignees.join('、') || task.owner}${deliverableText}。${detailText}${predecessorText}`, evidence: [{ id: `task-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `状态：${task.status} · 进度：${task.progress}% · 计划：${task.plannedStart ?? '待排期'} → ${task.plannedEnd ?? '待排期'} · ${task.description?.trim() ? `工作内容：${task.description.trim()} · ` : ''}交付物 ${task.deliverableCount} 个`, tone: 'neutral', projectId: task.projectId, taskId: task.id }], actions: [openProjectAction(projects.find((project) => project.id === task.projectId), '打开任务详情')], suggestions: ['修改该任务进度', '查看该任务交付物'] }
  }

  if (intent === 'predecessor-deliverable') {
    const ownTasks = tasks.filter((candidate) => candidate.isMine)
    const task = resolveTask(message, projects) ?? (ownTasks.length === 1 ? ownTasks[0] : undefined)
    if (!task) return { ...base, modeLabel: '需要补充信息', answer: ownTasks.length > 1 ? `你当前有 ${ownTasks.length} 个任务，请提供任务编号（如 1.2），我才能定位它的前置交付物。` : '请提供任务编号（如 1.2），我会定位该任务的直接前置交付物。', missingFields: ['任务编号或名称'], suggestions: ownTasks.slice(0, 5).map((candidate) => `获取 ${candidate.wbs} 的上一个节点交付物`) }
    if (snapshot.scope.level === 'L3' && !task.isMine) return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: 'L3 只能获取自己负责任务的直接前置交付物。', suggestions: ['获取自己任务的上一个节点交付物'] }
    const predecessors = task.predecessors ?? []
    const candidates = predecessors.flatMap((predecessor) => predecessor.deliverables.map((deliverable) => ({ predecessor, deliverable })))
    if (candidates.length === 0) return { ...base, answer: `任务“${task.wbs} ${task.name}”没有已关联的直接前置交付物。请先由前置任务负责人提交文件，或补充审批附件关联。`, evidence: [{ id: `predecessor-empty-${task.id}`, title: `${task.wbs} · 前置交付物`, detail: predecessors.length ? `已找到 ${predecessors.length} 个直接前置节点，但均未关联交付物。` : '该任务没有配置直接前置节点。', tone: 'warning', projectId: task.projectId, taskId: task.id }], suggestions: ['查看我的任务', '联系前置任务负责人补交交付物'] }
    const normalized = message.toLowerCase()
    const requested = candidates.find(({ deliverable }) => normalized.includes(deliverable.name.toLowerCase())) ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!requested) return { ...base, modeLabel: '需要选择交付物', answer: `找到 ${candidates.length} 个前置交付物，请在消息中指定文件名：${candidates.map(({ predecessor, deliverable }) => `${predecessor.wbs} ${deliverable.name}`).join('、')}。`, missingFields: ['交付物名称'], suggestions: candidates.slice(0, 4).map(({ deliverable }) => `获取 ${deliverable.name}`) }
    const { predecessor, deliverable } = requested
    return { ...base, answer: `已找到前置节点“${predecessor.wbs} ${predecessor.name}”的交付物“${deliverable.name}”。回复确认后，Agent 会校验权限并从审批附件/项目存储取回文件，通过钉钉回传。`, evidence: [{ id: `predecessor-deliverable-${deliverable.id}`, title: `${predecessor.wbs} · ${deliverable.name}`, detail: `前置节点：${predecessor.name} · ${deliverable.approvalProcessInstanceId ? '已关联钉钉审批附件' : deliverable.url ? '已有文件引用' : '等待文件存储'}`, tone: 'success', projectId: task.projectId, taskId: task.id }], actions: [{ id: `get-predecessor-deliverable-${deliverable.id}`, label: '确认获取前置交付物', kind: 'get-predecessor-deliverable', projectId: task.projectId, taskId: task.id, predecessorTaskId: predecessor.id, deliverableId: deliverable.id, deliverable: { name: deliverable.name, kind: deliverable.kind === 'LINK' ? 'link' : 'file', url: deliverable.url ?? undefined, mimeType: deliverable.mimeType ?? undefined, sizeBytes: deliverable.sizeBytes ?? undefined, externalProvider: deliverable.externalProvider ?? undefined, externalId: deliverable.externalId ?? undefined } }], suggestions: ['确认获取并回传文件', '查看我的任务'] }
  }

  if (intent === 'deliverable-submit') {
    const task = resolveDeliverableTarget(message, projects, snapshot.scope.level)
    if (!task) return { ...base, modeLabel: '需要补充信息', answer: attachment ? `已收到“${attachment.name}”，请回复任务编号（如 1.1）。任务完成仍需主管或管理员通过钉钉审批。` : '请在消息中提供任务编号（如 1.1），并附上要提交的钉钉文件。', missingFields: ['任务编号', ...(attachment ? [] : ['钉钉附件'])], suggestions: ['1.1，并提交完成'] }
    if (snapshot.scope.level === 'L3' && !task.isMine) return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: 'L3 只能为自己负责的任务提交交付物。', suggestions: ['提交自己负责任务的交付物'] }
    if (!attachment) return { ...base, modeLabel: '需要补充附件', answer: '已定位任务，但没有收到钉钉附件。请重新发送任务编号并附上文件。', missingFields: ['钉钉附件'], suggestions: [`给 ${task.wbs} 提交交付物（附文件）`] }
    const completeTask = requestsTaskCompletion(message)
    const deliverable = { ...attachment, kind: 'dingtalk' as const, versionLabel: `v${task.deliverableCount + 1}` }
    return { ...base, answer: `已准备把“${attachment.name}”提交到任务“${task.wbs} ${task.name}”${completeTask ? '，任务不会直接完成，保存交付物后仍需主管或管理员通过钉钉审批' : ''}。回复确认后执行。`, evidence: [{ id: `deliverable-submit-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `附件：${attachment.name}${attachment.sizeBytes === undefined ? '' : ` · ${attachment.sizeBytes} bytes`}${completeTask ? ' · 待钉钉审批通过后完成' : ''}`, tone: 'warning', projectId: task.projectId, taskId: task.id }], actions: [{ id: `submit-deliverable-${task.id}`, label: completeTask ? '确认提交并等待审批' : '确认提交交付物', kind: 'submit-deliverable', projectId: task.projectId, taskId: task.id, deliverable, completeTask }], suggestions: [completeTask ? '确认提交并等待审批' : '确认提交交付物', '取消'] }
  }

  if (intent === 'task-create') {
    const project = selected ?? (projects.length === 1 ? projects[0] : undefined)
    const taskDraft = project ? parseTaskDraft(message, project, snapshot) : null
    if (!project) return { ...base, modeLabel: '需要选择项目', answer: '请先指定一个授权项目，例如“在 PRJ-001 新增任务：接口开发 3 天”。', missingFields: ['项目'], suggestions: ['在 PRJ-001 新增任务：接口开发 3 天'] }
    if (!taskDraft) return { ...base, modeLabel: '需要补充信息', answer: '请提供任务名称，例如“在当前项目新增任务：接口开发 3 天”。', missingFields: ['任务名称'], suggestions: ['新增任务：接口开发 3 天'] }
    return { ...base, answer: `已准备在“${project.name}”中新增任务“${taskDraft.name}”。点击确认后将使用当前登录用户的任务配置权限写入草稿。`, evidence: [{ id: 'task-create-preview', title: `新增任务 · ${taskDraft.name}`, detail: `${taskDraft.duration} 天 · ${taskDraft.effort} h${taskDraft.ownerName ? ` · 负责人 ${taskDraft.ownerName}` : ''}`, tone: 'success', projectId: project.id }], actions: [{ id: `create-task-${project.id}`, label: '确认新增任务', kind: 'create-task', projectId: project.id, taskDraft }], suggestions: ['确认后继续调整任务描述和闭环条件', '新增下一项任务'] }
  }

  if (intent === 'task-update') {
    const task = resolveTask(message, projects)
    const taskPatch = task ? parseTaskPatch(message, task) : null
    if (!task) return { ...base, modeLabel: '需要补充信息', answer: '请提供要修改的任务编号（如 1.1）或名称。', missingFields: ['任务编号或名称'], suggestions: ['修改 1.1 工期为 5 天', '把 1.1 进度改为 80%'] }
    if (snapshot.scope.level === 'L3' && !task.isMine) return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: 'L3 只能更新自己负责的任务，不能修改前置任务或其他成员的任务。', suggestions: ['更新自己的任务进度'] }
    if (!taskPatch || Object.keys(taskPatch).length === 0) return { ...base, modeLabel: '需要补充信息', answer: `已找到任务“${task.wbs} ${task.name}”，但没有识别到要修改的字段。可修改名称、工期、工时、描述、闭环条件、状态或进度。`, missingFields: ['修改字段'], suggestions: [`把 ${task.wbs} 工期改为 ${task.durationDays + 1} 天`, `把 ${task.wbs} 进度改为 80%`] }
    if (snapshot.scope.level === 'L3' && Object.keys(taskPatch).some((field) => !['status', 'progress', 'actualStart', 'actualEnd', 'completionNote', 'overdueReason'].includes(field))) return { ...base, status: 'blocked', modeLabel: '权限拦截', answer: 'L3 Agent 只允许同步自己任务的进度、状态、实际起止日期和执行备注；任务名称、工期、工时及流程结构需由 L1/L2 管理员修改。', suggestions: [`把 ${task.wbs} 进度改为 80%`, `把 ${task.wbs} 状态改为进行中`] }
    return { ...base, answer: `已准备修改任务“${task.wbs} ${task.name}”。点击确认后将按当前登录用户权限保存修改。`, evidence: [{ id: `task-update-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: describeTaskPatch(taskPatch), tone: 'warning', projectId: task.projectId, taskId: task.id }], actions: [{ id: `update-task-${task.id}`, label: '确认修改任务', kind: 'update-task', projectId: task.projectId, taskId: task.id, taskPatch }], suggestions: ['确认修改', '继续调整该任务负责人'] }
  }

  if (intent === 'task-delete') {
    const task = resolveTask(message, projects)
    if (!task) return { ...base, modeLabel: '需要补充信息', answer: '请提供要删除的任务编号（如 1.1）或名称。', missingFields: ['任务编号或名称'], suggestions: ['删除 1.1 任务'] }
    return { ...base, answer: `已准备删除任务“${task.wbs} ${task.name}”及其关联连线。点击确认后执行软删除，之后可通过任务恢复入口恢复。`, evidence: [{ id: `task-delete-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `所属项目：${projectName(projects, task.projectId)} · 关联交付物 ${task.deliverableCount} 个`, tone: 'warning', projectId: task.projectId, taskId: task.id }], actions: [{ id: `delete-task-${task.id}`, label: '确认删除任务', kind: 'delete-task', projectId: task.projectId, taskId: task.id }], suggestions: ['确认删除', '先打开任务查看详情'] }
  }

  if (intent === 'task-assign') {
    const task = resolveTask(message, projects)
    const member = findMember(message, snapshot.members)
    if (!task || !member) return { ...base, modeLabel: '需要补充信息', answer: !task ? '请提供任务编号或名称。' : '请提供公司在职成员姓名，例如“把 1.1 负责人改为周野”。', missingFields: [!task ? '任务编号或名称' : '成员姓名'], suggestions: ['把 1.1 负责人改为周野', '给 1.1 添加负责人 林珊'] }
    const assignmentMode = /移除|取消|删除.*负责人/.test(message) ? 'remove' as const : /改为|改成|设置为|替换/.test(message) ? 'replace' as const : 'add' as const
    return { ...base, answer: `已准备${assignmentMode === 'remove' ? '移除' : assignmentMode === 'replace' ? '替换' : '添加'}任务“${task.wbs} ${task.name}”的负责人${assignmentMode === 'remove' ? '' : `为 ${member.name}`}。点击确认后按当前用户的任务分配权限执行。`, evidence: [{ id: `task-assign-${task.id}`, title: `${task.wbs} · ${task.name}`, detail: `当前负责人：${task.assignees.join('、') || task.owner} · 目标成员：${member.name}`, tone: 'warning', projectId: task.projectId, taskId: task.id }], actions: [{ id: `assign-task-${task.id}-${member.id}`, label: '确认调整负责人', kind: 'assign-task', projectId: task.projectId, taskId: task.id, memberId: member.id, memberName: member.name, assignmentMode, existingMemberIds: task.assigneeIds }], suggestions: ['确认调整负责人', '查询该任务详情'] }
  }

  if (intent === 'workflow-publish') {
    const project = selected ?? (projects.length === 1 ? projects[0] : undefined)
    if (!project) return { ...base, modeLabel: '需要选择项目', answer: '请指定要发布的授权项目，例如“发布 PRJ-001 的流程草稿”。', missingFields: ['项目'], suggestions: ['发布当前项目流程草稿'] }
    return { ...base, answer: `已准备发布“${project.name}”的流程草稿。点击确认后将调用当前登录用户的流程发布权限。`, evidence: [{ id: `workflow-publish-${project.id}`, title: `${project.code} · ${project.name}`, detail: '发布后任务流程将对执行成员生效。', tone: 'warning', projectId: project.id }], actions: [{ id: `publish-workflow-${project.id}`, label: '确认发布流程', kind: 'publish-workflow', projectId: project.id }], suggestions: ['确认发布流程', '先检查任务连线和负责人'] }
  }

  if (intent === 'portfolio-analysis' || intent === 'report') {
    const risks = projects.filter((project) => project.health !== 'HEALTHY' || project.status === 'AT_RISK' || project.status === 'PAUSED')
    const overdue = tasks.filter((task) => isOverdue(task, snapshot.today)).length
    const evidence = risks.slice(0, 5).map<AgentEvidence>((project) => ({ id: `project-${project.id}`, title: `${project.code} · ${project.name}`, detail: `${project.health} · ${project.status} · 完成度 ${project.progress}% · 计划至 ${project.plannedEnd ?? '待排期'}`, tone: project.health === 'WARNING' || project.status === 'AT_RISK' ? 'danger' : 'warning', projectId: project.id }))
    return { ...base, answer: `当前范围内有 ${projects.length} 个项目、${tasks.length} 个流程任务，其中 ${risks.length} 个项目需要关注${overdue > 0 ? `，另有 ${overdue} 个任务已超期` : ''}。`, evidence, actions: risks.slice(0, 3).map((project) => openProjectAction(project, '查看项目流程')), suggestions: risks.length > 0 ? ['打开高风险项目查看受影响任务', '模拟延长关键任务后的顺延范围'] : base.suggestions }
  }

  if (intent === 'resource-analysis') {
    const byOwner = new Map<string, AgentTaskSnapshot[]>()
    for (const task of tasks) {
      const owner = task.assignees[0] ?? task.owner
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), task])
    }
    const ranked = [...byOwner.entries()].sort((left, right) => sumEffort(right[1]) - sumEffort(left[1]))
    return { ...base, answer: ranked.length === 0 ? '当前范围没有可汇总的任务负载。' : `当前范围有 ${ranked.length} 位任务负责人，计划工时最高的是 ${ranked[0][0]}（${sumEffort(ranked[0][1])} h，${new Set(ranked[0][1].map((task) => task.projectId)).size} 个项目）。`, evidence: ranked.slice(0, 6).map(([owner, ownerTasks], index) => ({ id: `resource-${owner}`, title: `${index + 1}. ${owner}`, detail: `${ownerTasks.length} 个任务 · ${sumEffort(ownerTasks)} h`, tone: index === 0 ? 'warning' : 'neutral' })), suggestions: ['按项目查看资源明细', '检查未来四周的关键人员冲突'] }
  }

  if (intent === 'deliverable-analysis') {
    const missing = tasks.filter((task) => completedStatuses.has(task.status) && task.deliverableCount === 0)
    return { ...base, answer: missing.length === 0 ? '没有发现已完成但缺少交付物的任务。' : `发现 ${missing.length} 个已完成任务没有关联交付物，建议在关闭任务前补齐文件或链接。`, evidence: missing.slice(0, 8).map((task) => ({ id: `deliverable-${task.id}`, title: `${projectName(projects, task.projectId)} · ${task.wbs} ${task.name}`, detail: `负责人：${task.assignees.join('、') || task.owner} · 已完成 ${task.progress}% · 尚未关联文档/链接`, tone: 'warning' as const, projectId: task.projectId, taskId: task.id })), suggestions: ['打开任务详情上传交付物', '检查未完成任务的闭环检查项'] }
  }

  if (intent === 'schedule-analysis') {
    const overdue = tasks.filter((task) => isOverdue(task, snapshot.today))
    return { ...base, answer: `排期检查完成：当前范围有 ${overdue.length} 个未完成任务超过计划结束日。后置任务会在全部前置任务提交完成后开始计时。`, evidence: overdue.slice(0, 8).map((task) => ({ id: `overdue-${task.id}`, title: `${projectName(projects, task.projectId)} · ${task.wbs} ${task.name}`, detail: `计划结束 ${task.plannedEnd ?? '待排期'}，当前 ${task.progress}%。`, tone: 'danger' as const, projectId: task.projectId, taskId: task.id })), actions: overdue.slice(0, 3).map((task) => openProjectAction(projects.find((project) => project.id === task.projectId), '查看超期任务')) }
  }

  if (intent === 'workflow-generate') {
    const project = selected ?? projects[0]
    const taskSpecs = parseWorkflowTaskSpecs(message)
    if (!project) return { ...base, modeLabel: '需要选择项目', answer: '请先选择一个目标项目，再生成任务流程图。', missingFields: ['项目'], suggestions: ['打开一个项目后再生成流程', '例如：为 PRJ-001 创建需求、设计、开发、验收流程'] }
    if (taskSpecs.length < 2) return { ...base, modeLabel: '需要补充任务', answer: '我可以根据自然语言生成流程图，但至少需要两个任务。请提供任务名称，可选填工期，例如“需求澄清 3 天、方案设计 5 天、开发 7 天、验收 2 天”。', missingFields: ['至少两个任务'], suggestions: ['创建一个流程：需求澄清 3 天、方案设计 5 天、开发 7 天、验收 2 天', '创建并行流程：接口开发 5 天、页面开发 5 天、联调 2 天'] }
    const parallel = /并行|同时|并发|同步/.test(message)
    const previewWorkflow = createWorkflowPreview(project.id, snapshot.today, taskSpecs, parallel)
    return {
      ...base,
      modeLabel: '草稿预览',
      answer: `已生成${parallel ? '并行汇聚' : '串行'}任务流程图，共 ${taskSpecs.length} 个任务。流程目前只是预览，不会直接写入数据库。`,
      evidence: [{ id: 'generated-flow', title: `${parallel ? '并行汇聚' : '串行'} · ${taskSpecs.length} 个任务`, detail: `${taskSpecs.map((task) => `${task.name}（${task.duration} 天）`).join(' → ')} · 前置关系已生成`, tone: 'success', projectId: project.id }],
      actions: [{ id: 'preview-generated-flow', label: '载入流程图确认', kind: 'preview-workflow', projectId: project.id, workflow: previewWorkflow }],
      missingFields: ['负责人', '闭环交付物', '具体工作内容'],
      suggestions: ['载入流程图后补充负责人和交付物', '确认后点击“保存草稿”，再由管理员发布'],
      previewWorkflow,
    }
  }

  if (intent === 'unknown') return { ...base, answer: '我可以帮你分析项目进度、风险、排期、资源负载和交付物，也可以生成流程草稿。请告诉我项目、任务或你想要的动作。', suggestions: ['哪些项目可能延期？', '分析未来四周的资源冲突', '检查缺少交付物的任务'] }
  return { ...base, answer: selected ? `已定位到项目“${selected.name}”，你可以继续询问它的排期、任务或交付物。` : '请提供项目编号或名称，我会在当前授权范围内定位。', actions: selected ? [openProjectAction(selected, '打开项目')] : [] }
}

async function runWithPi(runId: string, message: string, originalMessage: string, snapshot: AgentSnapshot, conversationId?: string): Promise<AgentRun> {
  const models = createModels()
  const model = {
    id: config.pi.modelId,
    name: config.pi.modelName,
    api: 'openai-completions' as const,
    provider: config.pi.provider,
    baseUrl: config.pi.baseUrl,
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: config.pi.maxTokens,
  }
  const provider = createProvider({
    id: config.pi.provider,
    name: config.pi.modelName,
    baseUrl: config.pi.baseUrl,
    auth: { apiKey: envApiKeyAuth('Project OS Agent API key', ['PI_AGENT_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  })
  models.setProvider(provider)
  const tools = createPiTools(snapshot)
  const agent = new Agent({
    initialState: {
      systemPrompt: '你是 Project OS 的项目管理智能体。只能依据工具返回的当前授权数据回答，不要猜测或补全数据库没有的内容。回答使用简洁中文；可以提出当前登录用户有权限执行的动作，但所有写入、发布、删除或权限变更都必须交回宿主页面确认，不能自行越权执行。',
      model,
      tools,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: conversationId,
    toolExecution: 'sequential',
    maxRetryDelayMs: config.pi.timeoutMs,
    beforeToolCall: async ({ toolCall, args }) => {
      const projectId = (args as { projectId?: string }).projectId
      if (toolCall.name === 'get_project_summary' && !isAllowedProject(snapshot, projectId)) return { block: true, terminate: true, reason: '该项目不在当前账号的授权范围内。' }
      if (toolCall.name === 'find_missing_deliverables' && projectId && !isAllowedProject(snapshot, projectId)) return { block: true, terminate: true, reason: '该项目不在当前账号的授权范围内。' }
      return undefined
    },
  })
  let answer = ''
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') answer += event.assistantMessageEvent.delta
  })
  await agent.prompt(message)
  if (!answer) {
    const last = [...agent.state.messages].reverse().find((item) => item.role === 'assistant')
    if (last && 'content' in last && Array.isArray(last.content)) answer = last.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
  }
  if (!answer.trim()) throw new Error('pi_empty_response')
  const selected = resolveProject(originalMessage, snapshot.projects)
  const intent = recognizeIntent(originalMessage)
  return {
    runId,
    status: 'completed',
    answer: answer.trim(),
    evidence: [],
    actions: selected ? [openProjectAction(selected, '打开项目')] : [],
    suggestions: ['查看项目排期', '检查缺少交付物的任务'],
    missingFields: [],
    scopeLabel: selected ? `项目 · ${selected.name}` : '全部授权项目',
    sourceLabel: `Pi Runtime · Project OS 实时数据 · ${snapshot.projects.length} 个项目`,
    intent,
    intentLabel: intentLabels[intent] ?? intentLabels.unknown,
    modeLabel: 'Pi 智能分析',
    confidence: 0.9,
    scope: snapshot.scope,
  }
}

function createPiTools(snapshot: AgentSnapshot): AgentTool[] {
  return [
    {
      name: 'search_projects',
      label: '搜索项目',
      description: '在当前授权范围内按项目编号或名称搜索项目。',
      parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 80 })) }),
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as { query?: string }
        return toolResult(snapshot.projects.filter((project) => !params.query || `${project.code} ${project.name}`.toLowerCase().includes(params.query.toLowerCase())).map(projectSummaryForTool))
      },
    },
    {
      name: 'get_project_summary',
      label: '读取项目摘要',
      description: '读取一个授权项目的进度、状态、健康度和任务概况。',
      parameters: Type.Object({ projectId: Type.String({ minLength: 1 }) }),
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as { projectId: string }
        const project = snapshot.projects.find((candidate) => candidate.id === params.projectId)
        if (!project) throw new Error('project_not_in_scope')
        return toolResult(projectSummaryForTool(project))
      },
    },
    {
      name: 'find_missing_deliverables',
      label: '检查交付物',
      description: '查找当前授权项目中已完成但没有交付物的任务。',
      parameters: Type.Object({ projectId: Type.Optional(Type.String()) }),
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as { projectId?: string }
        return toolResult(snapshot.projects.filter((project) => !params.projectId || project.id === params.projectId).flatMap((project) => project.tasks.filter((task) => completedStatuses.has(task.status) && task.deliverableCount === 0).map((task) => ({ projectId: project.id, projectCode: project.code, taskId: task.id, wbs: task.wbs, name: task.name, owner: task.owner }))))
      },
    },
  ]
}

function projectSummaryForTool(project: AgentProjectSnapshot) {
  return { id: project.id, code: project.code, name: project.name, status: project.status, health: project.health, progress: project.progress, plannedStart: project.plannedStart, plannedEnd: project.plannedEnd, owner: project.owner, taskCount: project.tasks.length, overdueTaskCount: project.tasks.filter((task) => isOverdue(task, new Date().toISOString().slice(0, 10))).length }
}

function toolResult(details: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
}

function isAllowedProject(snapshot: AgentSnapshot, projectId: string | undefined) {
  return Boolean(projectId && (snapshot.scope.projectIds === 'all' || snapshot.scope.projectIds.includes(projectId)))
}

function blockedRun(runId: string, actor: AuthContext, answer: string): AgentRun {
  return { runId, status: 'blocked', answer, evidence: [], actions: [], suggestions: [], missingFields: [], scopeLabel: '无可用授权范围', sourceLabel: 'Project OS 权限策略', intent: 'unknown', intentLabel: intentLabels.unknown, modeLabel: '权限拦截', confidence: 1, scope: { level: isL1(actor) ? 'L1' : isGlobalL2(actor) ? 'L2' : 'L3', projectIds: [] } }
}

function recognizeIntent(message: string) {
  if (/(发布|上线|生效).*(流程|任务|草稿|项目)/.test(message)) return 'workflow-publish'
  if (/(创建|新建|建立|立项).*(?:一个)?\s*项目|项目.*(创建|新建|建立|立项)/.test(message)) return 'project-create'
  if (/(生成|创建|新建|搭建|设计|制作|绘制).*(流程|流程图)|(?:流程|流程图).*(生成|创建|新建|搭建|设计|制作|绘制)/.test(message)) return 'workflow-generate'
  if (/(删除|移除|作废).*(?:任务|工作项|节点)|(?:任务|工作项|节点).*(删除|移除|作废)/.test(message)) return 'task-delete'
  if (/(添加|新增|新建|创建).*(?:任务|工作项|节点)|(?:任务|工作项|节点).*(添加|新增|新建|创建)/.test(message)) return 'task-create'
  if (/(负责人|指派|分配给|添加负责人|移除负责人)/.test(message) && /(任务|工作项|节点|1\.\d)/.test(message)) return 'task-assign'
  if (/(修改|更新|调整|同步|上报|把|将|改成|改为|设为|设置).*(?:任务|工作项|节点|工期|时长|进度|状态|名称|工作内容|描述|闭环条件|交付标准)|(?:任务|工作项|节点|工期|时长|进度|状态|名称|工作内容|描述|闭环条件|交付标准).*(修改|更新|调整|同步|上报|把|将|改成|改为|设为|设置)/.test(message)) return 'task-update'
  if (/(获取|下载|拿到|发给我|回传|取回|查看).*(上一个|前置|前一个).*(交付物|文件|文档|附件)|(上一个|前置|前一个).*(交付物|文件|文档|附件).*(获取|下载|拿到|发给我|回传|取回|查看)/.test(message)) return 'predecessor-deliverable'
  if (/(提交|上传|附上|关联).*(交付物|文件|文档)|(?:交付物|文件|文档).*(提交|上传|附上|关联)/.test(message)) return 'deliverable-submit'
  if (/(上一个|前置|前一个).*(进度|交付物)|(?:进度|交付物).*(上一个|前置|前一个)/.test(message)) return 'task-query'
  if (isImplicitTaskDetailsQuery(message)) return 'task-query'
  if (/(我的任务|自己的任务|自己负责|我负责|待我|本人)/.test(message) || (/(查询|查找|查看|任务详情|任务进度|任务负责人)/.test(message) && /(任务|工作项|节点|1\.\d)/.test(message))) return 'task-query'
  if (/(交付物|文档|闭环|检查项|缺少.*交付)/.test(message)) return 'deliverable-analysis'
  if (/(资源|负载|冲突|人员|谁.*任务|工时)/.test(message)) return 'resource-analysis'
  if (/(哪些项目|项目组合|项目健康|风险清单|项目可能延期)/.test(message)) return 'portfolio-analysis'
  if (/(工期|排期|顺延|延期|延误|提前|截止|日历|工作日|增加|延长|减少|缩短)/.test(message)) return 'schedule-analysis'
  if (/(简报|周报|汇报|报告)/.test(message)) return 'report'
  if (/(哪些项目|项目组合|项目健康|风险清单|项目可能延期|风险|进度|状态|项目)/.test(message)) return 'portfolio-analysis'
  return 'unknown'
}

function isImplicitTaskDetailsQuery(message: string) {
  return /(?:这个|该|当前|此).*(?:任务|工作项|节点).*(?:具体|详细|工作内容|工作说明|任务内容|描述|交付标准|闭环)|(?:具体|详细).*(?:内容|工作内容|任务内容|工作说明|任务描述)/.test(message)
}

type WorkflowTaskSpec = AgentTaskSpec

function parseProjectDraft(message: string, today: string): AgentProjectDraft | null {
  const name = extractProjectName(message)
  if (!name) return null
  const taskSpecs = parseWorkflowTaskSpecs(message)
  const totalDuration = taskSpecs.reduce((sum, task) => sum + task.duration, 0)
  const end = addNaturalDays(today, Math.max(totalDuration, 1))
  return { name, owner: '', department: '研发中心', start: today, end, taskSpecs }
}

function extractProjectName(message: string) {
  const named = message.match(/名字\s*(?:叫|为|是)\s*[:：]?\s*([^，,：:；;\n]+?)(?=\s*[:：，,；;\n]|$)/)
  if (named?.[1]) return named[1].trim()
  const projectNamed = message.match(/项目(?:名称|名)?\s*(?:叫|为|是)\s*[:：]?\s*([^，,：:；;\n]+?)(?=\s*[:：，,；;\n]|$)/)
  if (projectNamed?.[1]) return projectNamed[1].trim()
  const prefix = message.match(/(?:创建|新建|建立|立项)\s*(?:一个)?\s*项目\s*(?:叫|为|是)?\s*[:：]?\s*([^，,：:；;\n]+?)(?=\s*[:：，,；;\n]|$)/)
  return prefix?.[1]?.trim() || ''
}

function addNaturalDays(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function resolveTask(message: string, projects: AgentProjectSnapshot[]) {
  const wbs = message.match(/\b\d+(?:\.\d+)+\b/)?.[0]
  const normalized = message.toLowerCase()
  return projects.flatMap((project) => project.tasks).find((task) => (wbs && task.wbs === wbs) || normalized.includes(task.name.toLowerCase()))
}

function findMember(message: string, members: Array<{ id: string; name: string }>) {
  const normalized = message.toLowerCase()
  return [...members].sort((left, right) => right.name.length - left.name.length).find((member) => normalized.includes(member.name.toLowerCase()))
}

function parseTaskDraft(message: string, project: AgentProjectSnapshot, snapshot: AgentSnapshot) {
  const durationMatch = message.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)/)
  const effortMatch = message.match(/(?:工时|小时)\s*(?:为|改为|设置为|：|:)?\s*(\d+(?:\.\d+)?)/)
  const duration = Math.max(0, Number(durationMatch?.[1] ?? 1))
  const effort = Math.max(0, Number(effortMatch?.[1] ?? duration * 8))
  const nameMatch = message.match(/(?:任务|工作项|节点)(?:名称|名)?\s*(?:叫|为|是|：|:)\s*([^，,：:；;\n]+?)(?=\s*(?:\d+(?:\.\d+)?\s*(?:个)?\s*(?:自然日|工作日|天|日)|负责人|工时|小时|描述|说明|闭环|$))/)
  const fallback = message.match(/(?:添加|新增|新建|创建)\s*(?:一个)?\s*(?:任务|工作项|节点)\s*(?:：|:)\s*([^，,：:；;\n]+)/)
  const rawName = nameMatch?.[1] ?? fallback?.[1]
  const name = rawName?.replace(/\d+(?:\.\d+)?\s*(?:个)?\s*(?:自然日|工作日|天|日)/, '').trim()
  if (!name || name.length < 2) return null
  const owner = findMember(message, snapshot.members)
  return { projectId: project.id, name, duration, effort, ownerMemberId: owner?.id, ownerName: owner?.name, description: undefined, closureCriteria: undefined }
}

function parseTaskPatch(message: string, task: AgentTaskSnapshot): AgentTaskPatch | null {
  const patch: AgentTaskPatch = {}
  const duration = message.match(/(?:工期|时长|持续时间)\s*(?:(?:改为|改成|调整为|设置为|为|：|:)\s*)?(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)?/)
  const delta = message.match(/(?:工期|时长|持续时间)?\s*(增加|延长|减少|缩短)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)/)
  if (duration) patch.duration = Math.max(0, Number(duration[1]))
  if (delta) patch.duration = Math.max(0, task.durationDays + (['减少', '缩短'].includes(delta[1]) ? -1 : 1) * Number(delta[2]))
  const effort = message.match(/(?:工时|小时)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*(\d+(?:\.\d+)?)/)
  if (effort) patch.effort = Math.max(0, Number(effort[1]))
  const progress = message.match(/进度\s*(?:(?:改为|改成|调整为|设置为|到|为|：|:)\s*)?(\d+(?:\.\d+)?)\s*%?/) 
  if (progress) patch.progress = Math.max(0, Math.min(100, Number(progress[1])))
  const status = ['未开始', '进行中', '受阻', '已完成', '提前结束', '如期结束', '超期结束'].find((label) => new RegExp(`状态\\s*(?:改为|改成|调整为|设置为|为|：|:)\\s*${label}`).test(message))
  if (status) patch.status = status
  const name = message.match(/(?:名称|名字|标题)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*([^，,；;。\n]+)/)
  if (name?.[1]) patch.name = name[1].trim()
  const description = message.match(/(?:工作内容|描述|说明)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*([^。\n]+)/)
  if (description?.[1]) patch.description = description[1].trim()
  const closure = message.match(/(?:闭环条件|交付标准)\s*(?:改为|改成|调整为|设置为|为|：|:)\s*([^。\n]+)/)
  if (closure?.[1]) patch.closureCriteria = closure[1].trim()
  return patch
}

function describeTaskPatch(patch: AgentTaskPatch) {
  const entries = [
    patch.name ? `名称：${patch.name}` : '',
    patch.duration === undefined ? '' : `工期：${patch.duration} 天`,
    patch.effort === undefined ? '' : `工时：${patch.effort} h`,
    patch.progress === undefined ? '' : `进度：${patch.progress}%`,
    patch.status ? `状态：${patch.status}` : '',
    patch.description ? '更新工作内容' : '',
    patch.closureCriteria ? '更新闭环条件' : '',
  ].filter(Boolean)
  return entries.join(' · ')
}

function parseWorkflowTaskSpecs(message: string): WorkflowTaskSpec[] {
  if (!/\d+(?:\.\d+)?\s*(?:个)?\s*(?:自然日|工作日|天|日)/.test(message)) return []
  const projectTaskSource = message.match(/(?:项目(?:名称|名)?|名字)\s*(?:叫|为|是)?\s*[^，,：:；;\n]+\s*[:：]\s*(.+)$/)?.[1]
  const source = projectTaskSource ?? message.match(/(?:包括|包含|如下|任务有|任务是|流程图?|任务)\s*[：:]\s*(.+)$/)?.[1] ?? message
  return source
    .split(/[，,、；;\n]+|→|->|=>|\s+(?:然后|接着|之后|再|并且)\s+/)
    .map((part) => {
      const durationMatch = part.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:自然日|工作日|天|日)/)
      const duration = Math.max(0, Number(durationMatch?.[1] ?? 3))
      const name = part
        .replace(/\d+(?:\.\d+)?\s*(?:个)?\s*(?:自然日|工作日|天|日)/, '')
        .replace(/^(?:请|帮我|给我|生成|创建|新建|制作|绘制|设计|一个|流程图?|流程|任务|并行|串行|同时|并发|同步|然后|接着|再|包含|包括)\s*/g, '')
        .trim()
      return { name, duration }
    })
    .filter((task) => task.name.length >= 2 && !/^(?:并行|串行|同时|并发|同步|前置|后置)$/.test(task.name))
}

function createWorkflowPreview(projectId: string, baselineStart: string, taskSpecs: WorkflowTaskSpec[], parallel: boolean): AgentWorkflowPreview {
  const nodes: AgentWorkflowPreview['nodes'] = [
    { id: 'agent-start', projectId, type: 'start', wbs: '0', name: '项目开始', owner: '项目组', duration: 0, effort: 0, progress: 100, status: '已完成', position: { x: 40, y: 220 } },
    ...taskSpecs.map((task, index) => ({
      id: `agent-task-${index + 1}`,
      projectId,
      type: 'task' as const,
      wbs: `1.${index + 1}`,
      name: task.name,
      owner: '待分配',
      duration: task.duration,
      effort: task.duration * 8,
      progress: 0,
      status: '未开始',
      description: '由 Agent 根据自然语言生成的流程草稿，待管理员补充具体工作内容。',
      closureCriteria: '提交交付物并完成检查项',
      position: { x: 250 + (index % 3) * 270, y: 100 + Math.floor(index / 3) * 170 },
    })),
    { id: 'agent-end', projectId, type: 'end', wbs: '2', name: '项目结束', owner: '项目组', duration: 0, effort: 0, progress: 0, status: '未开始', position: { x: 1080, y: 220 } },
  ]
  const taskNodes = nodes.filter((node) => node.type === 'task')
  const edges: AgentWorkflowPreview['edges'] = []
  if (parallel && taskNodes.length >= 3) {
    for (const node of taskNodes.slice(0, -1)) edges.push({ id: `agent-start-${node.id}`, source: 'agent-start', target: node.id, type: 'FS', lagDays: 0 })
    const merge = taskNodes.at(-1)!
    for (const node of taskNodes.slice(0, -1)) edges.push({ id: `${node.id}-${merge.id}`, source: node.id, target: merge.id, type: 'FS', lagDays: 0 })
    edges.push({ id: `${merge.id}-end`, source: merge.id, target: 'agent-end', type: 'FS', lagDays: 0 })
  } else {
    edges.push({ id: 'agent-start-first', source: 'agent-start', target: taskNodes[0].id, type: 'FS', lagDays: 0 })
    for (let index = 0; index < taskNodes.length - 1; index += 1) edges.push({ id: `${taskNodes[index].id}-${taskNodes[index + 1].id}`, source: taskNodes[index].id, target: taskNodes[index + 1].id, type: 'FS', lagDays: 0 })
    edges.push({ id: `${taskNodes.at(-1)!.id}-end`, source: taskNodes.at(-1)!.id, target: 'agent-end', type: 'FS', lagDays: 0 })
  }
  return { projectId, baselineStart, status: 'draft', version: 0, nodes, edges }
}

function resolveProject(message: string, projects: AgentProjectSnapshot[]) {
  const normalized = message.toLowerCase()
  return projects.find((project) => normalized.includes(project.code.toLowerCase()) || normalized.includes(project.name.toLowerCase()))
}

function isOverdue(task: AgentTaskSnapshot, today: string) {
  return Boolean(task.plannedEnd && task.plannedEnd < today && !completedStatuses.has(task.status))
}

function sumEffort(tasks: AgentTaskSnapshot[]) {
  return tasks.reduce((sum, task) => sum + task.effortHours, 0)
}

function projectName(projects: AgentProjectSnapshot[], projectId: string) {
  return projects.find((project) => project.id === projectId)?.name ?? '未知项目'
}

function openProjectAction(project: AgentProjectSnapshot | undefined, label: string): AgentAction {
  return { id: `open-${project?.id ?? 'project'}`, label, kind: 'open-project', projectId: project?.id }
}
