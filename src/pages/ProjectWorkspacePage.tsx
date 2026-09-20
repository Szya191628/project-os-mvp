import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleCheck, Diamond, FileText, GitBranch, History, Link2, ListTree, Maximize2, Minimize2, MoreHorizontal, Plus, Rows3, Search, Sparkles, Trash2, Upload, UsersRound, X } from 'lucide-react'
import { pinyin } from 'pinyin-pro'
import { createWorkflowTemplate, deleteTask as deleteTaskApi, directStartTask as directStartTaskApi, fetchPredecessorDeliverables, fetchProjectAssigneeOptions, fetchWorkflow, fetchWorkflowAuditLogs, fetchWorkflowTemplates, loadWorkflowTemplate, refreshTaskApproval, resolveApiUrl, submitSpecialReleaseApproval, submitTaskApproval, updateProjectApprovalSettings, uploadTaskDeliverable, type PredecessorDeliverableItem } from '../api'
import { initialTasks } from '../data'
import { getProjectCapabilities, type ProjectCapabilities } from '../projectAccess'
import type { Project, ProjectMemberOption, Task, TaskApprovalView, WorkCalendarConfig, Workflow, WorkflowAuditLog, WorkflowBaseline, WorkflowDeliverable, WorkflowEdge, WorkflowNode, WorkflowPosition, WorkflowTemplateSummary } from '../types'
import { ProgressBar, StatusBadge } from '../components/UI'
import { ProjectMembersDrawer } from '../components/ProjectMembersDrawer'
import { ApprovalManagementDialog } from '../components/ApprovalManagementDialog'
import { TaskApprovalPage } from '../components/TaskApprovalPage'
import { calendarDateOffset, diffSchedules, isCompletionApproved, isWorkingDate, normalizeWorkCalendar, scheduleWorkflow, type ScheduleChange, type ScheduledNode } from '../workflow/schedule'
import { hasExceededDragThreshold } from '../workflow/drag'
import { getFlowCanvasMetrics, getFlowCanvasPanScroll, getFlowNodePositionFromDrag } from '../workflow/canvas'
import { alignSerialWorkflowNodes, buildOrthogonalPath, FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH } from '../workflow/layout'
import { getTaskMenuActions, type TaskMenuAction } from '../workflow/taskMenu'

type WorkspaceView = 'flow' | 'gantt' | 'list' | 'milestones'

type ScheduleImpact = ScheduleChange & { name: string }
type ChangeNotice = { reason: string; changes: ScheduleImpact[] }
type BaselineChange = { nodeId: string; name: string; kind: '新增节点' | '移除节点' | '计划调整' | '工期调整' | '依赖调整'; before?: { plannedStart: string; plannedEnd: string; duration: number }; after?: { plannedStart: string; plannedEnd: string; duration: number } }
type TaskEditPatch = Pick<WorkflowNode, 'name' | 'owner' | 'duration' | 'description' | 'closureCriteria' | 'assigneeIds' | 'assigneeNames' | 'plannedStartOverride' | 'plannedEndOverride'>
type TaskDrawerFocus = 'overview' | 'deliverables' | 'predecessors' | 'approval' | 'special-release' | 'edit'
type TaskPageAction = Exclude<TaskMenuAction, 'edit'>

function workflowNodeIdForTask(workflow: Workflow, taskIdentifier: string | null | undefined) {
  return taskIdentifier ? workflow.nodes.find((node) => node.id === taskIdentifier || node.taskId === taskIdentifier)?.id ?? null : null
}

const taskMenuCopy: Record<TaskMenuAction, { label: string; hint: string }> = {
  view: { label: '查看任务', hint: '任务时间、任务详情、需要交付的内容' },
  'view-progress': { label: '查看进度', hint: '进度状态和已提交交付物（仅查看）' },
  'direct-start': { label: '直接开启任务', hint: '管理员跳过前置检查，确认后进入进行中' },
  'submit-approval': { label: '提交 OA 审批', hint: '选择阶段交付或最终交付' },
  'special-release': { label: '发起特殊放行审批', hint: '前置任务未完成时申请启动当前任务' },
  edit: { label: '编辑任务', hint: '仅 L1/L2 可用' },
  'approval-history': { label: '查看审批记录', hint: '阶段交付、最终交付和特殊放行' },
}

export function ProjectWorkspacePage({ project, workflow: workflowProp, lastSavedWorkflow, initialTaskId, onWorkflowChange, onWorkflowReload, currentMemberId, capabilities = getProjectCapabilities(project.accessLevel), readOnly = false }: { project: Project; workflow: Workflow; lastSavedWorkflow?: Workflow; initialTaskId?: string | null; onWorkflowChange: (workflow: Workflow) => void; onWorkflowReload?: (workflow: Workflow) => void; currentMemberId?: string; capabilities?: ProjectCapabilities; readOnly?: boolean }) {
  const [workflow, setWorkflow] = useState<Workflow>(() => ({ ...workflowProp, status: workflowProp.status ?? 'draft' }))
  const [view, setView] = useState<WorkspaceView>('flow')
  const initialNodeId = workflowNodeIdForTask(workflowProp, initialTaskId)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => initialNodeId)
  const [taskActionPage, setTaskActionPage] = useState<TaskPageAction | null>(() => initialNodeId ? (capabilities.accessLevel === 'L3' ? 'view' : 'view-progress') : null)
  const [taskFocus, setTaskFocus] = useState<TaskDrawerFocus>('overview')
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [history, setHistory] = useState<Workflow[]>([])
  const [changeNotice, setChangeNotice] = useState<ChangeNotice | null>(null)
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null)
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false)
  const [resetLayoutDialogOpen, setResetLayoutDialogOpen] = useState(false)
  const [membersDrawerOpen, setMembersDrawerOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [approvalManagementOpen, setApprovalManagementOpen] = useState(false)
  const [projectMenuAutoStart, setProjectMenuAutoStart] = useState<boolean | null>(null)
  const [assigneeOptions, setAssigneeOptions] = useState<ProjectMemberOption[]>([])
  const [query, setQuery] = useState('')
  const [templateDialog, setTemplateDialog] = useState<'save' | 'use' | null>(null)
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([])
  const [templateLoading, setTemplateLoading] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [auditDialogOpen, setAuditDialogOpen] = useState(false)
  const [auditLogs, setAuditLogs] = useState<WorkflowAuditLog[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const savedDraftLayoutRef = useRef<Record<string, WorkflowPosition>>(getWorkflowLayout(lastSavedWorkflow ?? workflowProp))
  const publishedLayoutRef = useRef<Record<string, WorkflowPosition>>(workflowProp.publishedLayout ?? (workflowProp.status === 'published' ? getWorkflowLayout(workflowProp) : {}))
  const deletingTaskRef = useRef<string | null>(null)
  const [hasPublishedLayout, setHasPublishedLayout] = useState(() => Object.keys(workflowProp.publishedLayout ?? (workflowProp.status === 'published' ? getWorkflowLayout(workflowProp) : {})).length > 0)
  useEffect(() => {
    let mounted = true
    void fetchProjectAssigneeOptions(project.id).then((members) => {
      if (mounted) setAssigneeOptions(members)
    }).catch(() => {
      // L3 viewers cannot edit assignments and do not receive organization-wide options.
      if (mounted) setAssigneeOptions([])
    })
    return () => { mounted = false }
  }, [project.id])
  useEffect(() => {
    if (!capabilities.canUseWorkflowTemplates) return
    let mounted = true
    void fetchWorkflowTemplates().then((items) => {
      if (mounted) setTemplates(items)
    }).catch(() => {
      // A viewer may not have access to the template catalog; the editor remains usable.
    })
    return () => { mounted = false }
  }, [capabilities.canUseWorkflowTemplates])
  useEffect(() => {
    if (lastSavedWorkflow) savedDraftLayoutRef.current = getWorkflowLayout(lastSavedWorkflow)
  }, [lastSavedWorkflow])
  useEffect(() => {
    // The workflow is loaded asynchronously by the parent; mirror the latest server snapshot into the editor state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkflow({ ...workflowProp, status: workflowProp.status ?? 'draft' })
    if (workflowProp.status === 'published' || workflowProp.status === 'draft') {
      setLifecycleMessage((current) => current === '流程发布中…' ? null : current)
    }
    if (workflowProp.publishedLayout) {
      publishedLayoutRef.current = workflowProp.publishedLayout
      setHasPublishedLayout(Object.keys(workflowProp.publishedLayout).length > 0)
    } else if (workflowProp.status === 'published') {
      publishedLayoutRef.current = getWorkflowLayout(workflowProp)
      setHasPublishedLayout(true)
    }
    const nextInitialNodeId = workflowNodeIdForTask(workflowProp, initialTaskId)
    if (nextInitialNodeId) setSelectedTaskId(nextInitialNodeId)
  }, [initialTaskId, workflowProp])
  const schedule = useMemo(() => scheduleWorkflow(workflow), [workflow])
  const calendar = useMemo(() => normalizeWorkCalendar(workflow.calendar), [workflow.calendar])
  const tasks = useMemo(() => workflowToTasks(workflow, schedule.schedules), [schedule.schedules, workflow])
  const baselineChanges = useMemo(() => getBaselineChanges(workflow, schedule.schedules), [schedule.schedules, workflow])
  const scheduledProjectStart = schedule.schedules.start?.plannedStart ?? project.start
  const scheduledProjectEnd = schedule.schedules.end?.plannedEnd ?? project.end
  const selectedTask = tasks.find((task) => task.id === selectedTaskId)
  const selectedWorkflowNode = selectedTaskId ? workflow.nodes.find((node) => node.id === selectedTaskId) : undefined
  const visibleTasks = useMemo(() => tasks.filter((task) => task.name.toLowerCase().includes(query.toLowerCase())), [query, tasks])
  const canPublish = schedule.issues.length === 0 && workflow.nodes.some((node) => node.type === 'task' || node.type === 'milestone')
  const workspaceReadOnly = readOnly || capabilities.accessLevel === 'SUPERVISOR'
  const isTaskMine = (task: Pick<WorkflowNode, 'ownerMemberId' | 'assigneeIds'>) => Boolean(currentMemberId && (task.ownerMemberId === currentMemberId || task.assigneeIds?.includes(currentMemberId)))
  const selectedTaskIsMine = Boolean(selectedTask && isTaskMine(selectedTask))
  const canEditSelectedTask = capabilities.canEditTaskStructure && !workspaceReadOnly
  const canManageSelectedDeliverables = !workspaceReadOnly && (capabilities.canManageAllDeliverables || (capabilities.canManageOwnDeliverables && (capabilities.accessLevel !== 'L3' || selectedTaskIsMine)))
  const canSubmitSelectedApproval = !workspaceReadOnly && capabilities.canSubmitApproval && (capabilities.accessLevel !== 'L3' || selectedTaskIsMine)
  const selectedTaskReadOnly = workspaceReadOnly || !(canEditSelectedTask || canManageSelectedDeliverables || canSubmitSelectedApproval)
  const canSubmitTaskApproval = (node: WorkflowNode) => Boolean(!workspaceReadOnly && capabilities.canSubmitApproval && node.taskId && (capabilities.accessLevel !== 'L3' || isTaskMine(node)))
  const canEditTask = !workspaceReadOnly && capabilities.canEditTaskStructure
  const canDirectStartTask = !workspaceReadOnly && (capabilities.accessLevel === 'L1' || capabilities.accessLevel === 'L2')

  const openTaskView = (taskId: string) => {
    setSelectedTaskId(taskId)
    setSelectedEdgeId(null)
    setTaskActionPage(capabilities.accessLevel === 'L3' ? 'view' : 'view-progress')
    setTaskFocus('overview')
  }

  const openTemplatePicker = async () => {
    setTemplateDialog('use')
    setTemplateError(null)
    setTemplateLoading(true)
    try {
      setTemplates(await fetchWorkflowTemplates())
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : '模板读取失败')
    } finally {
      setTemplateLoading(false)
    }
  }

  const openAuditLog = async () => {
    setAuditDialogOpen(true)
    setAuditError(null)
    setAuditLoading(true)
    try {
      setAuditLogs(await fetchWorkflowAuditLogs(project.id))
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : '流程日志读取失败')
    } finally {
      setAuditLoading(false)
    }
  }

  const saveAsTemplate = async (input: { name: string; description: string }) => {
    setTemplateLoading(true)
    setTemplateError(null)
    try {
      const created = await createWorkflowTemplate({ ...input, workflow })
      setTemplates((current) => [created, ...current.filter((template) => template.id !== created.id)])
      setTemplateDialog(null)
      setLifecycleMessage(`模板“${created.name}”已加入模板库`)
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : '模板保存失败')
      throw error
    } finally {
      setTemplateLoading(false)
    }
  }

  const applyTemplate = async (template: WorkflowTemplateSummary) => {
    setTemplateLoading(true)
    setTemplateError(null)
    try {
      const nextWorkflow = await loadWorkflowTemplate(project.id, template.id)
      const nextDraft: Workflow = { ...nextWorkflow, status: 'draft', calendar: nextWorkflow.calendar ?? workflow.calendar }
      setHistory((current) => [...current.slice(-9), workflow])
      setWorkflow(nextDraft)
      onWorkflowChange(nextDraft)
      setSelectedTaskId(null)
      setSelectedEdgeId(null)
      setTemplateDialog(null)
      const changes = getScheduleImpacts(workflow, nextDraft)
      setChangeNotice(changes.length > 0 ? { reason: '载入流程模板', changes } : null)
      setLifecycleMessage(`已载入模板“${template.name}”，请检查任务负责人后保存草稿`)
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : '模板载入失败')
    } finally {
      setTemplateLoading(false)
    }
  }

  const commitWorkflow = (nextWorkflow: Workflow, reason: string, options: { trackHistory?: boolean; showImpact?: boolean } = {}) => {
    const nextDraft: Workflow = { ...nextWorkflow, status: 'draft', publishedAt: undefined }
    if (options.trackHistory !== false) setHistory((current) => [...current.slice(-9), workflow])
    setWorkflow(nextDraft)
    onWorkflowChange(nextDraft)
    setLifecycleMessage(null)
    setValidationMessage(null)
    if (options.showImpact !== false) {
      const changes = getScheduleImpacts(workflow, nextDraft)
      setChangeNotice(changes.length > 0 ? { reason, changes } : null)
    }
  }

  const insertTaskOnEdge = (edge: WorkflowEdge) => {
    const sourceNode = workflow.nodes.find((node) => node.id === edge.source)
    const targetNode = workflow.nodes.find((node) => node.id === edge.target)
    if (!sourceNode || !targetNode) {
      setValidationMessage('当前连线两端节点不存在，无法插入任务')
      return
    }
    let next = workflow.nodes.filter((node) => node.type === 'task').length + 1
    while (workflow.nodes.some((node) => node.id === `t${next}` || node.wbs === `1.${next}`)) next += 1
    const task: WorkflowNode = {
      id: `t${next}`,
      projectId: workflow.projectId,
      type: 'task',
      parentId: sourceNode.parentId,
      wbs: `1.${next}`,
      name: '待填写任务',
      owner: '待分配',
      duration: 3,
      effort: 24,
      progress: 0,
      status: '未开始',
      description: '',
      closureCriteria: '提交任务交付物并完成检查项',
      position: midpoint(sourceNode.position, targetNode.position),
    }
    const nextWorkflow: Workflow = {
      ...workflow,
      nodes: [...workflow.nodes, task],
      edges: [
        ...workflow.edges.filter((candidate) => candidate.id !== edge.id),
        { id: edge.id, source: edge.source, target: task.id, type: edge.type, lagDays: 0 },
        { id: `${task.id}-${targetNode.id}-inserted`, source: task.id, target: targetNode.id, type: edge.type, lagDays: edge.lagDays },
      ],
    }
    commitWorkflow(nextWorkflow, '在线段中插入任务')
    setSelectedTaskId(task.id)
    setSelectedEdgeId(null)
  }

  const addTask = () => {
    const selectedEdge = workflow.edges.find((edge) => edge.id === selectedEdgeId)
    if (selectedEdge) {
      insertTaskOnEdge(selectedEdge)
      return
    }
    let next = workflow.nodes.filter((node) => node.type === 'task').length + 1
    while (workflow.nodes.some((node) => node.id === `t${next}`)) next += 1
    const task: WorkflowNode = {
      id: `t${next}`,
      projectId: workflow.projectId,
      type: 'task',
      parentId: undefined,
      wbs: `1.${next}`,
      name: '待填写任务',
      owner: '待分配',
      duration: 3,
      effort: 24,
      progress: 0,
      status: '未开始',
      description: '',
      closureCriteria: '提交任务交付物并完成检查项',
      position: findEmptyNodePosition(workflow.nodes),
    }
    const nextWorkflow = { ...workflow, nodes: [...workflow.nodes, task] }
    commitWorkflow(nextWorkflow, '新增任务节点')
    setSelectedTaskId(task.id)
    setSelectedEdgeId(null)
  }

  const addParallelTask = () => {
    const selectedEdge = workflow.edges.find((edge) => edge.id === selectedEdgeId)
    const sourceNode = workflow.nodes.find((node) => node.id === selectedEdge?.source)
    const targetNode = workflow.nodes.find((node) => node.id === selectedEdge?.target)
    if (!selectedEdge || !sourceNode || !targetNode) {
      setValidationMessage('请先选择一条连线，再添加并行分支')
      return
    }
    let next = workflow.nodes.filter((node) => node.type === 'task').length + 1
    while (workflow.nodes.some((node) => node.id === `t${next}`)) next += 1
    const task: WorkflowNode = {
      id: `t${next}`,
      projectId: workflow.projectId,
      type: 'task',
      parentId: sourceNode.parentId,
      wbs: `1.${next}`,
      name: '并行任务',
      owner: '待分配',
      duration: 3,
      effort: 24,
      progress: 0,
      status: '未开始',
      description: '',
      closureCriteria: '提交任务交付物并完成检查项',
      position: parallelPosition(sourceNode.position, targetNode.position),
    }
    const nextWorkflow: Workflow = {
      ...workflow,
      nodes: [...workflow.nodes, task],
      edges: [
        ...workflow.edges,
        { id: `${sourceNode.id}-${task.id}-parallel`, source: sourceNode.id, target: task.id, type: 'FS', lagDays: 0 },
        { id: `${task.id}-${targetNode.id}-parallel`, source: task.id, target: targetNode.id, type: 'FS', lagDays: 0 },
      ],
    }
    commitWorkflow(nextWorkflow, '添加并行分支')
    setSelectedTaskId(task.id)
    setSelectedEdgeId(null)
  }

  const updateEdge = (edgeId: string, patch: Pick<WorkflowEdge, 'source' | 'target'>) => {
    const edge = workflow.edges.find((candidate) => candidate.id === edgeId)
    if (!edge) return
    const nextEndpoints = { source: patch.source || edge.source, target: patch.target || edge.target }
    const validation = validateEdgeEndpoints(workflow, nextEndpoints, edgeId)
    if (validation) {
      setValidationMessage(validation)
      return
    }
    const nextWorkflow = { ...workflow, edges: workflow.edges.map((candidate) => candidate.id === edgeId ? { ...candidate, ...nextEndpoints } : candidate) }
    commitWorkflow(nextWorkflow, '调整连线关系')
  }

  const addEdge = (source: string, target: string) => {
    const validation = validateEdgeEndpoints(workflow, { source, target })
    if (validation) {
      setValidationMessage(validation)
      return false
    }
    const nextWorkflow = { ...workflow, edges: [...workflow.edges, { id: `e-${source}-${target}-${Date.now()}`, source, target, type: 'FS' as const, lagDays: 0 }] }
    commitWorkflow(nextWorkflow, '新增连线')
    setSelectedEdgeId(nextWorkflow.edges.at(-1)?.id ?? null)
    return true
  }

  const deleteEdge = (edgeId: string) => {
    const edge = workflow.edges.find((candidate) => candidate.id === edgeId)
    if (!edge) return
    const nextWorkflow = { ...workflow, edges: workflow.edges.filter((candidate) => candidate.id !== edgeId) }
    commitWorkflow(nextWorkflow, '删除连线')
    setSelectedEdgeId(null)
  }

  const clearCanvas = () => {
    if (!window.confirm('清空画布将移除当前草稿中的全部任务和连线，仅保留项目开始与项目结束节点。是否继续？')) return
    const startNode = workflow.nodes.find((node) => node.type === 'start')
    const endNode = workflow.nodes.find((node) => node.type === 'end')
    if (!startNode || !endNode) {
      setValidationMessage('当前流程缺少项目开始或项目结束节点，无法清空画布')
      return
    }
    const nextWorkflow: Workflow = {
      ...workflow,
      nodes: [
        { ...startNode, position: { x: 80, y: 220 } },
        { ...endNode, position: { x: 820, y: 220 } },
      ],
      edges: [],
    }
    commitWorkflow(nextWorkflow, '清空画布')
    setSelectedTaskId(null)
    setSelectedEdgeId(null)
  }

  const moveNode = (nodeId: string, position: WorkflowPosition) => {
    const nextWorkflow = { ...workflow, nodes: workflow.nodes.map((node) => node.id === nodeId ? { ...node, position } : node) }
    commitWorkflow(nextWorkflow, '调整节点布局', { trackHistory: false, showImpact: false })
  }

  const alignSerialTasks = () => {
    if (!capabilities.canEditWorkflow || workflow.status !== 'draft') return
    const alignment = alignSerialWorkflowNodes(workflow)
    if (alignment.movedNodeIds.length === 0) {
      setLifecycleMessage(alignment.alignedNodeIds.length > 0 ? '串联任务已经在同一水平线上' : '当前没有可对齐的串联任务')
      setValidationMessage(null)
      return
    }
    const nextNodes = workflow.nodes.map((node) => ({ ...node, position: alignment.positions[node.id] }))
    commitWorkflow({ ...workflow, nodes: nextNodes }, '对齐串联任务', { showImpact: false })
    setLifecycleMessage(`已将 ${alignment.movedNodeIds.length} 个串联任务对齐到同一水平线，可点击“保存草稿”保留布局`)
  }

  const openResetLayout = () => {
    if (capabilities.canEditWorkflow) setResetLayoutDialogOpen(true)
  }

  const resetToSavedDraftLayout = () => {
    const savedLayout = savedDraftLayoutRef.current
    const nextNodes = workflow.nodes.map((node) => savedLayout[node.id] ? { ...node, position: savedLayout[node.id] } : node)
    const changed = workflow.nodes.some((node, index) => nextNodes[index].position.x !== node.position.x || nextNodes[index].position.y !== node.position.y)
    setResetLayoutDialogOpen(false)
    if (!changed) {
      setLifecycleMessage('当前布局已经是上次保存的草稿布局')
      setValidationMessage(null)
      return
    }
    commitWorkflow({ ...workflow, nodes: nextNodes }, '重置排版', { showImpact: false })
    setLifecycleMessage('已恢复上次保存的草稿布局，当前结果已保存为草稿')
  }

  const restorePublishedLayout = () => {
    const publishedLayout = publishedLayoutRef.current
    const nextNodes = workflow.nodes.map((node) => publishedLayout[node.id] ? { ...node, position: publishedLayout[node.id] } : node)
    const changed = workflow.nodes.some((node, index) => nextNodes[index].position.x !== node.position.x || nextNodes[index].position.y !== node.position.y)
    if (!changed) {
      setLifecycleMessage('当前布局已经是已发布布局')
      setValidationMessage(null)
      return
    }
    commitWorkflow({ ...workflow, nodes: nextNodes }, '恢复已发布布局', { showImpact: false })
    setLifecycleMessage('已恢复最近一次已发布布局，当前结果已保存为草稿')
  }

  const updateTask = (taskId: string, patch: TaskEditPatch) => {
    const nextWorkflow = { ...workflow, nodes: workflow.nodes.map((node) => node.id === taskId ? { ...node, ...patch } : node) }
    commitWorkflow(nextWorkflow, '修改任务与工期')
  }

  const updateTaskDeliverables = (taskId: string, deliverables: WorkflowDeliverable[]) => {
    const nextWorkflow = { ...workflow, nodes: workflow.nodes.map((node) => node.id === taskId ? { ...node, deliverables } : node) }
    commitExecution(nextWorkflow, deliverables.length > 0 ? `已关联 ${deliverables.length} 个交付物版本` : '已移除全部交付物')
  }

  const deleteTask = async (nodeId: string, taskId?: string) => {
    if (deletingTaskRef.current) return
    const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
    if (!node || (node.type !== 'task' && node.type !== 'milestone')) return
    deletingTaskRef.current = nodeId
    setDeletingTaskId(nodeId)
    const predecessors = workflow.edges.filter((edge) => edge.target === nodeId).map((edge) => workflow.nodes.find((candidate) => candidate.id === edge.source)?.name).filter((name): name is string => Boolean(name))
    const successors = workflow.edges.filter((edge) => edge.source === nodeId).map((edge) => workflow.nodes.find((candidate) => candidate.id === edge.target)?.name).filter((name): name is string => Boolean(name))
    const affected = [
      predecessors.length > 0 ? `前置任务：${predecessors.join('、')}` : '前置任务：无',
      successors.length > 0 ? `后置任务：${successors.join('、')}` : '后置任务：无',
    ].join('\n')
    if (!window.confirm(`确定删除任务“${node.name}”吗？\n\n删除后将移除相关连线，并重新计算下游排期。\n${affected}\n\n此操作可由 L1/L2 在任务恢复入口中恢复。`)) {
      deletingTaskRef.current = null
      setDeletingTaskId(null)
      return
    }

    // Newly added draft nodes do not have a database task yet; remove them locally.
    if (!taskId) {
      const nextWorkflow = { ...workflow, nodes: workflow.nodes.filter((candidate) => candidate.id !== nodeId), edges: workflow.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId) }
      commitWorkflow(nextWorkflow, '删除任务')
      setSelectedTaskId(null)
      setSelectedEdgeId(null)
      deletingTaskRef.current = null
      setDeletingTaskId(null)
      return
    }

    try {
      await deleteTaskApi(taskId)
      const refreshed = await fetchWorkflow(project.id)
      setWorkflow(refreshed)
      onWorkflowReload?.(refreshed)
      setSelectedTaskId(null)
      setSelectedEdgeId(null)
      setChangeNotice(null)
      setLifecycleMessage('任务已删除，相关连线已移除，下游排期已重算')
      setValidationMessage(null)
    } catch (error) {
      if (error instanceof Error && error.message === 'task_not_found') {
        try {
          const refreshed = await fetchWorkflow(project.id)
          setWorkflow(refreshed)
          onWorkflowReload?.(refreshed)
          setSelectedTaskId(null)
          setSelectedEdgeId(null)
          setLifecycleMessage('任务已被删除，流程已刷新')
          setValidationMessage(null)
        } catch {
          setValidationMessage('任务已不存在，但流程刷新失败，请手动刷新页面。')
        }
      } else {
        setValidationMessage(`删除任务失败：${error instanceof Error ? error.message : '请稍后重试'}`)
      }
    } finally {
      deletingTaskRef.current = null
      setDeletingTaskId(null)
    }
  }

  const updateCalendar = (nextCalendar: WorkCalendarConfig) => {
    commitWorkflow({ ...workflow, calendar: nextCalendar }, '调整工作日历')
    setCalendarDialogOpen(false)
  }

  // Project OS OA 审批：提交后刷新服务端工作流（审批中状态、审批记录随节点返回）。
  const reloadWorkflow = async () => {
    const refreshed = await fetchWorkflow(project.id)
    setWorkflow(refreshed)
    onWorkflowReload?.(refreshed)
    return refreshed
  }

  const submitDingTalkApproval = async (taskId: string, note: string, overdueReason: string, deliveryType: 'STAGE' | 'FINAL', progress: number): Promise<string | null> => {
    try {
      await submitTaskApproval(taskId, { note, overdueReason: overdueReason || undefined, deliveryType, progress, source: 'PROJECT_OS' })
      await reloadWorkflow()
      setLifecycleMessage(`已提交${deliveryType === 'STAGE' ? '阶段交付' : '最终交付'} OA 审批，任务进入审批中`)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : '提交 OA 审批失败'
      if (message === 'overdue_reason_required') return '任务已超期，请填写超期原因后再提交审批。'
      return message
    }
  }

  const submitSpecialRelease = async (taskId: string, reason: string): Promise<string | null> => {
    try {
      await submitSpecialReleaseApproval(taskId, reason, undefined, 'PROJECT_OS')
      await reloadWorkflow()
      setLifecycleMessage('已提交特殊放行审批，等待 L2/管理员处理')
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : '提交特殊放行审批失败'
      const labels: Record<string, string> = {
        special_release_reason_required: '请填写特殊放行原因。',
        special_release_not_needed: '当前任务不需要特殊放行。',
        special_release_already_approved: '当前任务已经特殊放行。',
        approval_pending_exists: '当前任务已有审批进行中，请先等待审批结果。',
      }
      return labels[message] ?? message
    }
  }

  const directStartTask = async (nodeId: string) => {
    const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
    if (!node?.taskId || node.status !== '未开始') return
    const predecessors = workflow.edges.filter((edge) => edge.target === nodeId).map((edge) => workflow.nodes.find((candidate) => candidate.id === edge.source)?.name).filter((name): name is string => Boolean(name))
    const predecessorSummary = predecessors.length > 0 ? `前置任务：${predecessors.join('、')}` : '前置任务：无'
    if (!window.confirm(`确认直接开启“${node.wbs} · ${node.name}”吗？\n\n${predecessorSummary}\n将跳过前置任务检查，任务立即进入“进行中”，并记录管理员操作。`)) return
    try {
      await directStartTaskApi(node.taskId)
      await reloadWorkflow()
      setLifecycleMessage(`任务“${node.wbs} · ${node.name}”已直接开启`)
      setValidationMessage(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '请稍后重试'
      const labels: Record<string, string> = {
        task_not_startable: '任务已经不是未开始状态，请刷新后重试。',
        task_not_published: '任务尚未发布到当前执行流程。',
        predecessors_not_completed: '前置任务尚未完成。',
      }
      setValidationMessage(`直接开启任务失败：${labels[message] ?? message}`)
    }
  }

  const handleTaskAction = (nodeId: string, action: TaskMenuAction) => {
    if (action === 'direct-start') {
      void directStartTask(nodeId)
      return
    }
    setSelectedTaskId(nodeId)
    setSelectedEdgeId(null)
    if (action === 'edit') {
      setTaskActionPage(null)
      setTaskFocus('edit')
    } else {
      setTaskActionPage(action)
      setTaskFocus('overview')
    }
  }

  const refreshDingTalkApproval = async (taskId: string, approvalId: string): Promise<string | null> => {
    try {
      const result = await refreshTaskApproval(taskId, approvalId)
      await reloadWorkflow()
      setLifecycleMessage(result.status === 'PENDING' ? '审批仍在进行中' : `审批状态已同步：${result.status === 'APPROVED' ? '已通过' : result.status === 'REJECTED' ? '已拒绝' : '已终止'}`)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : '同步审批状态失败'
    }
  }

  const toggleApprovalAutoStart = async () => {
    const next = !(projectMenuAutoStart ?? project.approvalAutoStart ?? false)
    setProjectMenuAutoStart(next)
    try {
      await updateProjectApprovalSettings(project.id, next)
      setLifecycleMessage(next ? '已开启：审批通过后自动开始后续任务' : '已关闭：审批通过后仅解锁并通知负责人')
    } catch (error) {
      setProjectMenuAutoStart(!next)
      setValidationMessage(`保存审批设置失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    }
  }

  const commitExecution = (nextWorkflow: Workflow, message: string) => {
    setHistory((current) => [...current.slice(-9), workflow])
    setWorkflow(nextWorkflow)
    onWorkflowChange(nextWorkflow)
    setChangeNotice(null)
    setLifecycleMessage(message)
    setValidationMessage(null)
  }

  const saveDraft = () => {
    const nextWorkflow = { ...workflow, status: 'draft' as const, publishedAt: undefined }
    setWorkflow(nextWorkflow)
    onWorkflowChange(nextWorkflow)
    setLifecycleMessage('草稿已保存')
    setValidationMessage(null)
  }

  const publishWorkflow = () => {
    if (!canPublish) {
      setValidationMessage(schedule.issues[0]?.message ?? '请至少添加一个任务后再发布流程')
      return
    }
    const publishedAt = new Date().toISOString()
    const version = workflow.version ?? 1
    publishedLayoutRef.current = getWorkflowLayout(workflow)
    setHasPublishedLayout(true)
    const nextWorkflow: Workflow = { ...workflow, status: 'published', version, publishedAt, baseline: createWorkflowBaseline(workflow, schedule.schedules, version, publishedAt) }
    setHistory((current) => [...current.slice(-9), workflow])
    setWorkflow(nextWorkflow)
    onWorkflowChange(nextWorkflow)
    setChangeNotice(null)
    setLifecycleMessage('流程发布中…')
    setValidationMessage(null)
  }

  const undoWorkflow = () => {
    const previousWorkflow = history.at(-1)
    if (!previousWorkflow) return
    const changes = getScheduleImpacts(workflow, previousWorkflow)
    setWorkflow(previousWorkflow)
    onWorkflowChange(previousWorkflow)
    setHistory((current) => current.slice(0, -1))
    setChangeNotice(changes.length > 0 ? { reason: '撤销最近一次变更', changes } : null)
    setLifecycleMessage('已撤销最近一次变更')
    setValidationMessage(null)
  }

  if (selectedTask && taskActionPage === 'submit-approval') {
    return <TaskApprovalPage project={project} task={selectedTask} onBack={() => { setSelectedTaskId(null); setTaskActionPage(null) }} onSaveDeliverables={(deliverables) => updateTaskDeliverables(selectedTask.id, deliverables)} onSubmit={(note, overdueReason, deliveryType, progress) => submitDingTalkApproval(selectedTask.taskId ?? '', note, overdueReason, deliveryType, progress)} />
  }

  return (
    <div className="workspace-page">
      <header className="project-header">
        <div className="breadcrumb"><button type="button">项目</button><ChevronRight size={14} /><span>{project.code}</span></div>
        <div className="project-title-line">
          <div><h1>{project.name}</h1><div className="project-meta-line"><StatusBadge tone={project.status === '有风险' ? 'danger' : project.status === '执行中' ? 'success' : project.status === '规划中' ? 'accent' : 'neutral'}>{project.status}</StatusBadge><span>{project.department}</span><span>{scheduledProjectStart}–{scheduledProjectEnd}</span><span>负责人：{project.owner}</span></div></div>
          <div className="page-actions"><button className="button button-secondary" type="button"><Bot size={17} />分析项目</button>{capabilities.canViewAudit && <button className="button button-secondary" type="button" onClick={() => void openAuditLog()}><History size={17} />流程改动日志</button>}{capabilities.canViewProjectMembers && <button className="button button-secondary" type="button" onClick={() => { setSelectedTaskId(null); setMembersDrawerOpen(true) }}><UsersRound size={17} />项目人员</button>}{capabilities.canManageProjectSettings && <div className="project-menu"><button className="icon-button button-border" type="button" aria-label="更多项目操作" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}><MoreHorizontal size={18} /></button>{projectMenuOpen && <div className="project-menu-panel" role="menu"><button className="project-menu-item" type="button" role="menuitemcheckbox" aria-checked={projectMenuAutoStart ?? project.approvalAutoStart ?? false} onClick={() => void toggleApprovalAutoStart()}><span className="project-menu-check">{(projectMenuAutoStart ?? project.approvalAutoStart ?? false) ? '✓' : ''}</span><span><strong>审批通过后自动开始后续任务</strong><small>关闭时，审批通过的任务完成后，下游任务仅解锁并通知负责人，由负责人自行开始。</small></span></button><button className="project-menu-item" type="button" onClick={() => { setProjectMenuOpen(false); setApprovalManagementOpen(true) }}><span className="project-menu-check">↗</span><span><strong>OA审批管理后台</strong><small>设置任务负责人提交审批时的审批人和抄送人。</small></span></button></div>}</div>}</div>
        </div>
        <div className="project-summary-strip">
          <div><span>总体进度</span><strong>{project.progress}%</strong><ProgressBar value={project.progress} /></div>
          <div><span>计划偏差</span><strong className={project.progress === 0 ? '' : 'text-warning'}>{project.progress === 0 ? '—' : '+4 天'}</strong><small>相对当前基线</small></div>
          <div><span>剩余工时</span><strong>{project.progress === 0 ? '待排期' : '584 h'}</strong><small>{project.progress === 0 ? '通过流程图添加任务' : '已完成 704 h'}</small></div>
          <div><span>成本使用</span><strong>{project.budget > 0 ? `${Math.round((project.actualCost / project.budget) * 100)}%` : '—'}</strong><small>{project.budget > 0 ? `¥${Math.round(project.actualCost / 10000)} 万 / ¥${Math.round(project.budget / 10000)} 万` : '尚未设置预算'}</small></div>
          <div><span>开放风险</span><strong>{project.progress === 0 ? '0' : '3'}</strong><small className={project.progress === 0 ? '' : 'text-danger'}>{project.progress === 0 ? '尚未登记风险' : '1 项需决策'}</small></div>
        </div>
      </header>

      {!taskActionPage && <>
      <div className="workspace-toolbar">
        <div className="tab-list" role="tablist" aria-label="项目视图">
          <button className={view === 'flow' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'flow'} onClick={() => setView('flow')}><GitBranch size={16} />流程图</button>
          <button className={view === 'gantt' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'gantt'} onClick={() => setView('gantt')}><CalendarDays size={16} />甘特图</button>
          <button className={view === 'list' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}><ListTree size={16} />任务列表</button>
          <button className={view === 'milestones' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'milestones'} onClick={() => setView('milestones')}><Diamond size={15} />里程碑</button>
        </div>
        <div className="workspace-tools">
          <label className="compact-search"><Search size={15} /><span className="sr-only">搜索任务</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" /></label>
          {capabilities.canUseWorkflowTemplates && <button className="button button-secondary button-compact" type="button" onClick={() => void openTemplatePicker()}><Rows3 size={16} />使用模板</button>}
          {capabilities.canManageWorkflowTemplates && <button className="button button-secondary button-compact" type="button" onClick={() => { setTemplateError(null); setTemplateDialog('save') }}><FileText size={16} />加入模板</button>}
          {capabilities.canManageProjectSettings && <button className="button button-secondary button-compact" type="button" onClick={() => setCalendarDialogOpen(true)}><CalendarDays size={16} />{calendar.mode === 'working' ? '工作日历' : '自然日'}</button>}
          <button className="button button-secondary button-compact" type="button"><Rows3 size={16} />字段</button>
          {capabilities.canEditWorkflow && <button className="button button-primary button-compact" type="button" onClick={addTask} title={selectedEdgeId ? '在选中的连线中插入任务，并顺延后置任务' : '在画布空白处添加任务'}><Plus size={16} />{selectedEdgeId ? '在线段插入任务' : '添加任务'}</button>}
        </div>
      </div>

      {view === 'flow' && <FlowView workflow={workflow} calendar={calendar} schedules={schedule.schedules} issues={schedule.issues} baselineChanges={baselineChanges} selectedTaskId={selectedTaskId} selectedEdgeId={selectedEdgeId} changeNotice={changeNotice} lifecycleMessage={lifecycleMessage} validationMessage={validationMessage} canPublish={canPublish} canUndo={history.length > 0 && capabilities.canEditWorkflow} canRestorePublishedLayout={hasPublishedLayout} canEditWorkflow={capabilities.canEditWorkflow} isL3={capabilities.accessLevel === 'L3'} isTaskMine={isTaskMine} canSubmitTaskApproval={canSubmitTaskApproval} canEditTask={canEditTask} canDirectStartTask={canDirectStartTask} supervisorView={workspaceReadOnly} onSaveDraft={saveDraft} onPublish={publishWorkflow} onUndo={undoWorkflow} onResetLayout={openResetLayout} onRestorePublishedLayout={restorePublishedLayout} onAlignSerialTasks={alignSerialTasks} onAddParallelTask={addParallelTask} onUpdateEdge={updateEdge} onAddEdge={addEdge} onDeleteEdge={deleteEdge} onClearCanvas={clearCanvas} onSelectTask={openTaskView} onTaskAction={handleTaskAction} onSelectEdge={(edgeId) => { setSelectedEdgeId(edgeId); setSelectedTaskId(null); setTaskActionPage(null) }} onClearEdge={() => setSelectedEdgeId(null)} onMoveNode={moveNode} />}
      {view === 'gantt' && <GanttView tasks={visibleTasks} baselineStart={workflow.baselineStart} calendar={calendar} selectedTaskId={selectedTaskId} onSelectTask={openTaskView} />}
      {view === 'list' && <TaskListView tasks={visibleTasks} selectedTaskId={selectedTaskId} onSelectTask={openTaskView} />}
      {view === 'milestones' && <MilestoneView tasks={tasks.filter((task) => task.level > 0)} onSelectTask={openTaskView} />}
      </>}

      {selectedTask && <TaskDrawer key={selectedTask.id} task={selectedTask} mode={taskActionPage ?? (taskFocus === 'edit' ? 'edit' : undefined)} focus={taskFocus} members={assigneeOptions} calendarMode={calendar.mode} workflowStatus={workflow.status ?? 'draft'} readOnly={selectedTaskReadOnly} readOnlyLabel={workspaceReadOnly ? '监督视图 · 只读' : '执行成员视图 · 仅可查看非本人任务'} canEditStructure={canEditSelectedTask} canManageDeliverables={canManageSelectedDeliverables} canSubmitApproval={canSubmitSelectedApproval} deleting={deletingTaskId === selectedTask.id} onClose={() => { setSelectedTaskId(null); setTaskActionPage(null) }} onSave={(patch) => updateTask(selectedTask.id, patch)} onSaveDeliverables={(deliverables) => updateTaskDeliverables(selectedTask.id, deliverables)} onSubmitDingTalkApproval={(note, overdueReason, deliveryType, progress) => submitDingTalkApproval(selectedTask.taskId ?? '', note, overdueReason, deliveryType, progress)} onSubmitSpecialRelease={(reason) => submitSpecialRelease(selectedTask.taskId ?? '', reason)} onRefreshDingTalkApproval={(approvalId) => refreshDingTalkApproval(selectedTask.taskId ?? '', approvalId)} onDelete={() => deleteTask(selectedTask.id, selectedTask.taskId ?? selectedWorkflowNode?.taskId)} />}
      {calendarDialogOpen && <WorkCalendarDialog calendar={calendar} onClose={() => setCalendarDialogOpen(false)} onSave={updateCalendar} />}
      {resetLayoutDialogOpen && <ResetLayoutDialog onClose={() => setResetLayoutDialogOpen(false)} onSaveDraft={() => { saveDraft(); setResetLayoutDialogOpen(false) }} onReset={resetToSavedDraftLayout} />}
      {templateDialog === 'save' && <WorkflowTemplateSaveDialog project={project} workflow={workflow} loading={templateLoading} error={templateError} onClose={() => setTemplateDialog(null)} onSave={saveAsTemplate} />}
      {templateDialog === 'use' && <WorkflowTemplatePicker templates={templates} loading={templateLoading} error={templateError} onClose={() => setTemplateDialog(null)} onUse={(template) => void applyTemplate(template)} />}
      {membersDrawerOpen && <ProjectMembersDrawer project={project} onClose={() => setMembersDrawerOpen(false)} />}
      {auditDialogOpen && <WorkflowAuditDialog project={project} logs={auditLogs} loading={auditLoading} error={auditError} onClose={() => setAuditDialogOpen(false)} onRefresh={() => void openAuditLog()} />}
      {approvalManagementOpen && <ApprovalManagementDialog projects={[project]} onClose={() => setApprovalManagementOpen(false)} />}
    </div>
  )
}

function workflowToTasks(workflow: Workflow, schedules: Record<string, ScheduledNode>): Task[] {
  const summary = workflow.projectId === 'p1' ? initialTasks.find((task) => task.level === 0) : undefined
  const nodes = workflow.nodes.filter((node) => node.type !== 'start' && node.type !== 'end')
  const mapped = nodes.map((node) => {
    const predecessors = getTaskPredecessors(workflow, node.id)
    const planned = schedules[node.id]
    const incoming = predecessors.map((predecessor) => predecessor.wbs)
    const specialRelease = node.specialRelease ?? null
    const blockedBy = specialRelease ? [] : predecessors.filter((predecessor) => !isCompletionApproved(predecessor)).map((predecessor) => predecessor.name)
    const readyAt = specialRelease?.approvedAt?.slice(0, 10) ?? (blockedBy.length === 0 && predecessors.length > 0 ? latestCompletionDate(predecessors, schedules) : undefined)
    return {
      id: node.id,
      taskId: node.taskId,
      projectId: node.projectId,
      parentId: node.parentId,
      ownerMemberId: node.ownerMemberId,
      assigneeIds: node.assigneeIds,
      assigneeNames: node.assigneeNames,
      wbs: node.wbs,
      name: node.name,
      owner: node.owner,
      startOffset: planned?.startOffset ?? 0,
      duration: node.duration,
      progress: node.progress,
      status: node.status,
      description: node.description,
      dependency: incoming.length > 0 ? `${incoming.join(', ')} FS` : undefined,
      milestone: node.type === 'milestone',
      level: node.parentId ? 1 : 0,
      effort: node.effort,
      plannedStart: planned?.plannedStart,
      plannedEnd: planned?.plannedEnd,
      plannedStartOverride: node.plannedStartOverride,
      plannedEndOverride: node.plannedEndOverride,
      actualStart: node.actualStart,
      actualEnd: node.actualEnd,
      completionApprovalStatus: node.completionApprovalStatus,
      completionConfirmedAt: node.completionConfirmedAt,
      closureCriteria: node.closureCriteria,
      closureChecks: node.closureChecks,
      completionNote: node.completionNote,
      overdueReason: node.overdueReason,
      specialRelease,
      deliverables: node.deliverables,
      approvals: node.approvals,
      blockedBy,
      readyAt,
      calendarStartOffset: planned?.calendarStartOffset,
      calendarSpan: planned?.calendarSpan,
    }
  })
  if (!summary) return mapped
  const childEnds = mapped.map((task) => task.plannedEnd).filter((date): date is string => Boolean(date)).sort()
  return [{ ...summary, plannedStart: workflow.baselineStart, plannedEnd: childEnds.at(-1) ?? workflow.baselineStart }, ...mapped]
}

function midpoint(first: WorkflowPosition, second: WorkflowPosition): WorkflowPosition {
  return { x: Math.round((first.x + second.x) / 2), y: Math.round((first.y + second.y) / 2) }
}

function findEmptyNodePosition(nodes: WorkflowNode[]) {
  const nodeWidth = 184
  const nodeHeight = 88
  const candidates: WorkflowPosition[] = []
  for (let row = 0; row < 20; row += 1) {
    for (let column = 0; column < 5; column += 1) candidates.push({ x: 220 + column * 240, y: 72 + row * 150 })
  }
  const overlaps = (position: WorkflowPosition) => nodes.some((node) => node.position.x < position.x + nodeWidth + 24 && node.position.x + nodeWidth + 24 > position.x && node.position.y < position.y + nodeHeight + 24 && node.position.y + nodeHeight + 24 > position.y)
  return candidates.find((position) => !overlaps(position)) ?? { x: 260, y: 72 }
}

const FLOW_CANVAS_GROWTH_STEP = 1200
const FLOW_CANVAS_AUTO_PAN_STEP = 24
const FLOW_CANVAS_AUTO_PAN_ZONE = 96

function findPendingEdgePosition(nodes: WorkflowNode[], nodeWidth: number, nodeHeight: number) {
  const candidates = [
    { start: { x: 220, y: 72 }, end: { x: 620, y: 72 } },
    { start: { x: 220, y: 500 }, end: { x: 620, y: 500 } },
    { start: { x: 420, y: 260 }, end: { x: 820, y: 260 } },
  ]
  const isOccupied = (position: { start: WorkflowPosition; end: WorkflowPosition }) => {
    const minX = Math.min(position.start.x, position.end.x) - 24
    const maxX = Math.max(position.start.x, position.end.x) + 24
    const minY = Math.min(position.start.y, position.end.y) - 24
    const maxY = Math.max(position.start.y, position.end.y) + 24
    return nodes.some((node) => node.position.x < maxX && node.position.x + nodeWidth > minX && node.position.y < maxY && node.position.y + nodeHeight > minY)
  }
  return candidates.find((candidate) => !isOccupied(candidate)) ?? candidates[0]
}

function parallelPosition(first: WorkflowPosition, second: WorkflowPosition): WorkflowPosition {
  const position = midpoint(first, second)
  return { x: position.x, y: Math.min(460, position.y + 120) }
}

function validateEdgeEndpoints(workflow: Workflow, endpoints: Pick<WorkflowEdge, 'source' | 'target'>, edgeId?: string) {
  const sourceNode = workflow.nodes.find((node) => node.id === endpoints.source)
  const targetNode = workflow.nodes.find((node) => node.id === endpoints.target)
  if (!sourceNode || !targetNode) return '连线两端必须选择已有节点'
  if (sourceNode.id === targetNode.id) return '连线的前置和后置不能是同一个节点'
  if (sourceNode.type === 'end') return '结束节点不能作为连线前置节点'
  if (targetNode.type === 'start') return '开始节点不能作为连线后置节点'
  if (workflow.edges.some((edge) => edge.id !== edgeId && edge.source === endpoints.source && edge.target === endpoints.target)) return '这两个节点之间已经存在连线'
  return null
}

function isCompletionStatus(status: WorkflowNode['status']) {
  return status === '已完成' || status === '提前结束' || status === '如期结束' || status === '超期结束'
}

// 完成态细分：按期完成 / 提前完成 / 超期完成（超期完成用警示色提示延期交付）
function completionStatusView(status: WorkflowNode['status']) {
  if (status === '提前结束') return { label: '提前完成', tone: 'success' as const }
  if (status === '超期结束') return { label: '超期完成', tone: 'warning' as const }
  if (status === '如期结束') return { label: '按期完成', tone: 'success' as const }
  return { label: '已完成', tone: 'success' as const }
}

function getTaskPredecessors(workflow: Workflow, nodeId: string) {
  return workflow.edges.filter((edge) => edge.target === nodeId).map((edge) => workflow.nodes.find((node) => node.id === edge.source)).filter((node): node is WorkflowNode => Boolean(node && node.type !== 'start' && node.type !== 'end'))
}

function latestCompletionDate(nodes: WorkflowNode[], schedules?: Record<string, ScheduledNode>) {
  return nodes.map((node) => isCompletionApproved(node) ? node.completionConfirmedAt ?? node.actualEnd ?? schedules?.[node.id]?.plannedEnd ?? node.plannedEnd : undefined).filter((date): date is string => Boolean(date)).sort().at(-1)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function getScheduleImpacts(beforeWorkflow: Workflow, afterWorkflow: Workflow): ScheduleImpact[] {
  const changes = diffSchedules(scheduleWorkflow(beforeWorkflow), scheduleWorkflow(afterWorkflow))
  return changes.map((change) => ({ ...change, name: afterWorkflow.nodes.find((node) => node.id === change.nodeId)?.name ?? beforeWorkflow.nodes.find((node) => node.id === change.nodeId)?.name ?? change.nodeId }))
}

function createWorkflowBaseline(workflow: Workflow, schedules: Record<string, ScheduledNode>, version: number, publishedAt: string): WorkflowBaseline {
  return {
    version,
    publishedAt,
    baselineStart: workflow.baselineStart,
    calendar: normalizeWorkCalendar(workflow.calendar),
    nodes: workflow.nodes.map((node) => {
      const planned = schedules[node.id]
      return { id: node.id, type: node.type, name: node.name, duration: node.duration, plannedStart: planned?.plannedStart ?? node.plannedStart ?? workflow.baselineStart, plannedEnd: planned?.plannedEnd ?? node.plannedEnd ?? workflow.baselineStart }
    }),
    edges: workflow.edges.map((edge) => ({ ...edge })),
  }
}

function getWorkflowLayout(workflow: Workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.id, { ...node.position }]))
}

function getBaselineChanges(workflow: Workflow, schedules: Record<string, ScheduledNode>): BaselineChange[] {
  const baseline = workflow.baseline
  if (!baseline) return []
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]))
  const currentNodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const changes: BaselineChange[] = []
  const nodeIds = new Set([...baselineNodes.keys(), ...currentNodes.keys()])

  for (const nodeId of nodeIds) {
    const beforeNode = baselineNodes.get(nodeId)
    const currentNode = currentNodes.get(nodeId)
    const currentSchedule = schedules[nodeId]
    const before = beforeNode ? { plannedStart: beforeNode.plannedStart, plannedEnd: beforeNode.plannedEnd, duration: beforeNode.duration } : undefined
    const after = currentNode && currentSchedule ? { plannedStart: currentSchedule.plannedStart, plannedEnd: currentSchedule.plannedEnd, duration: currentNode.duration } : undefined
    if (!beforeNode && currentNode && after) changes.push({ nodeId, name: currentNode.name, kind: '新增节点', after })
    else if (beforeNode && !currentNode) changes.push({ nodeId, name: beforeNode.name, kind: '移除节点', before })
    else if (before && after && before.duration !== after.duration) changes.push({ nodeId, name: currentNode?.name ?? beforeNode?.name ?? nodeId, kind: '工期调整', before, after })
    else if (before && after && (before.plannedStart !== after.plannedStart || before.plannedEnd !== after.plannedEnd)) changes.push({ nodeId, name: currentNode?.name ?? beforeNode?.name ?? nodeId, kind: '计划调整', before, after })
  }

  const baselineEdgeKeys = new Set(baseline.edges.map((edge) => `${edge.source}->${edge.target}:${edge.lagDays}`))
  const currentEdgeKeys = new Set(workflow.edges.map((edge) => `${edge.source}->${edge.target}:${edge.lagDays}`))
  if (baselineEdgeKeys.size !== currentEdgeKeys.size || [...baselineEdgeKeys].some((key) => !currentEdgeKeys.has(key))) {
    changes.push({ nodeId: 'workflow-edges', name: '流程依赖关系', kind: '依赖调整' })
  }
  return changes
}

function formatBaselineChange(change: BaselineChange) {
  if (change.kind === '新增节点') return `新增 · ${change.after?.plannedStart ?? '待排期'} → ${change.after?.plannedEnd ?? '待排期'}`
  if (change.kind === '移除节点') return `移除 · ${change.before?.plannedStart ?? '—'} → ${change.before?.plannedEnd ?? '—'}`
  if (change.kind === '依赖调整') return '前置依赖关系已调整'
  if (!change.before || !change.after) return change.kind
  if (change.kind === '工期调整') return `${change.before.duration} 天 → ${change.after.duration} 天 · ${change.before.plannedStart} → ${change.after.plannedStart}，结束 ${change.before.plannedEnd} → ${change.after.plannedEnd}`
  return `${change.before.plannedStart} → ${change.before.plannedEnd} · 调整为 ${change.after.plannedStart} → ${change.after.plannedEnd}`
}

type PendingEdge = { id: string; source: string; target: string; start: WorkflowPosition; end: WorkflowPosition }

function FlowView({ workflow, calendar, schedules, issues, baselineChanges, selectedTaskId, selectedEdgeId, changeNotice, lifecycleMessage, validationMessage, canPublish, canUndo, canRestorePublishedLayout, canEditWorkflow, isL3, isTaskMine, canSubmitTaskApproval, canEditTask, canDirectStartTask, supervisorView = false, onSaveDraft, onPublish, onUndo, onResetLayout, onRestorePublishedLayout, onAlignSerialTasks, onAddParallelTask, onUpdateEdge, onAddEdge, onDeleteEdge, onClearCanvas, onSelectTask, onTaskAction, onSelectEdge, onClearEdge, onMoveNode }: { workflow: Workflow; calendar: WorkCalendarConfig; schedules: Record<string, ScheduledNode>; issues: { message: string; nodeIds: string[] }[]; baselineChanges: BaselineChange[]; selectedTaskId: string | null; selectedEdgeId: string | null; changeNotice: ChangeNotice | null; lifecycleMessage: string | null; validationMessage: string | null; canPublish: boolean; canUndo: boolean; canRestorePublishedLayout: boolean; canEditWorkflow: boolean; isL3: boolean; isTaskMine: (node: Pick<WorkflowNode, 'ownerMemberId' | 'assigneeIds'>) => boolean; canSubmitTaskApproval: (node: WorkflowNode) => boolean; canEditTask: boolean; canDirectStartTask: boolean; supervisorView?: boolean; onSaveDraft: () => void; onPublish: () => void; onUndo: () => void; onResetLayout: () => void; onRestorePublishedLayout: () => void; onAlignSerialTasks: () => void; onAddParallelTask: () => void; onUpdateEdge: (edgeId: string, patch: Pick<WorkflowEdge, 'source' | 'target'>) => void; onAddEdge: (source: string, target: string) => boolean; onDeleteEdge: (edgeId: string) => void; onClearCanvas: () => void; onSelectTask: (id: string) => void; onTaskAction: (id: string, action: TaskMenuAction) => void; onSelectEdge: (id: string) => void; onClearEdge: () => void; onMoveNode: (id: string, position: WorkflowPosition) => void }) {
  const scrollCanvasRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; pointerStart: WorkflowPosition; startPosition: WorkflowPosition; startScroll: WorkflowPosition; startOrigin: WorkflowPosition; started: boolean } | null>(null)
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const canvasExpansionRef = useRef({ width: 0, height: 0, left: 0, top: 0 })
  const canvasOriginRef = useRef({ x: 0, y: 0 })
  const canvasGrowthPendingRef = useRef({ width: false, height: false, left: false, top: false })
  const [isDragging, setIsDragging] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [canvasExpansion, setCanvasExpansion] = useState({ width: 0, height: 0, left: 0, top: 0 })
  const [pendingEdge, setPendingEdge] = useState<PendingEdge | null>(null)
  const [pendingEdgeSelected, setPendingEdgeSelected] = useState(false)
  const [taskContextMenu, setTaskContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const taskContextMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!taskContextMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!taskContextMenuRef.current?.contains(event.target as Node)) setTaskContextMenu(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskContextMenu(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [taskContextMenu])
  useEffect(() => {
    if (!isFullscreen) return
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isFullscreen])
  const nodeWidth = FLOW_NODE_WIDTH
  const nodeHeight = FLOW_NODE_HEIGHT
  const canvasMetrics = getFlowCanvasMetrics(workflow.nodes, nodeWidth, nodeHeight, canvasExpansion)
  const canvasSize = { width: canvasMetrics.width, height: canvasMetrics.height }
  const canvasOrigin = canvasMetrics.origin
  const canvasOriginX = canvasOrigin.x
  const canvasOriginY = canvasOrigin.y
  useLayoutEffect(() => {
    const previousOrigin = canvasOriginRef.current
    const deltaX = canvasOriginX - previousOrigin.x
    const deltaY = canvasOriginY - previousOrigin.y
    const canvas = scrollCanvasRef.current
    if (canvas && (deltaX !== 0 || deltaY !== 0)) {
      canvas.scrollLeft = Math.max(0, canvas.scrollLeft + deltaX)
      canvas.scrollTop = Math.max(0, canvas.scrollTop + deltaY)
    }
    canvasOriginRef.current = { x: canvasOriginX, y: canvasOriginY }
  }, [canvasOriginX, canvasOriginY])
  const selectedEdge = workflow.edges.find((edge) => edge.id === selectedEdgeId)
  const selectedEdgeSource = selectedEdge ? workflow.nodes.find((node) => node.id === selectedEdge.source) : undefined
  const selectedEdgeTarget = selectedEdge ? workflow.nodes.find((node) => node.id === selectedEdge.target) : undefined
  const pendingEdgeSource = pendingEdge ? workflow.nodes.find((node) => node.id === pendingEdge.source) : undefined
  const selectableNodes = workflow.nodes.filter((node) => node.type !== 'end')
  const targetableNodes = workflow.nodes.filter((node) => node.type !== 'start')
  const contextMenuNode = taskContextMenu ? workflow.nodes.find((node) => node.id === taskContextMenu.nodeId) : undefined
  const contextMenuPredecessors = contextMenuNode && contextMenuNode.type !== 'start' && contextMenuNode.type !== 'end'
    ? workflow.edges.filter((edge) => edge.target === contextMenuNode.id).map((edge) => workflow.nodes.find((node) => node.id === edge.source)).filter((node): node is WorkflowNode => Boolean(node && node.type !== 'start' && node.type !== 'end'))
    : []
  const contextMenuBlocked = contextMenuPredecessors.some((node) => !isCompletionApproved(node)) && !contextMenuNode?.specialRelease
  const contextMenuActions = contextMenuNode ? getTaskMenuActions({ hasTaskId: Boolean(contextMenuNode.taskId), isCompleted: isCompletionStatus(contextMenuNode.status), isNotStarted: contextMenuNode.status === '未开始', hasBlockingPredecessors: contextMenuBlocked, hasPendingApproval: Boolean(contextMenuNode.approvals?.some((approval) => approval.status === 'PENDING')), hasSpecialRelease: Boolean(contextMenuNode.specialRelease), canDirectStart: canDirectStartTask, isL3, isOwnTask: isTaskMine(contextMenuNode), canViewProgress: true, canSubmitApproval: canSubmitTaskApproval(contextMenuNode), canEdit: canEditTask }) : []

  const openTaskContextMenu = (event: React.MouseEvent<HTMLButtonElement>, node: WorkflowNode) => {
    if (!node.taskId || (node.type !== 'task' && node.type !== 'milestone')) return
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 260
    const menuHeight = 390
    setTaskContextMenu({ nodeId: node.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)) })
  }

  const selectTaskAction = (action: TaskMenuAction) => {
    if (!taskContextMenu) return
    onTaskAction(taskContextMenu.nodeId, action)
    setTaskContextMenu(null)
  }

  const expandCanvas = (axis: 'width' | 'height' | 'left' | 'top', canvas: HTMLDivElement, targetScroll: number) => {
    if (canvasGrowthPendingRef.current[axis]) return
    canvasGrowthPendingRef.current[axis] = true
    const nextExpansion = { ...canvasExpansionRef.current, [axis]: canvasExpansionRef.current[axis] + FLOW_CANVAS_GROWTH_STEP }
    canvasExpansionRef.current = nextExpansion
    setCanvasExpansion(nextExpansion)
    window.requestAnimationFrame(() => {
      canvasGrowthPendingRef.current[axis] = false
      if (axis === 'width') canvas.scrollLeft = Math.max(0, Math.min(targetScroll, canvas.scrollWidth - canvas.clientWidth))
      if (axis === 'height') canvas.scrollTop = Math.max(0, Math.min(targetScroll, canvas.scrollHeight - canvas.clientHeight))
      if (axis === 'left') canvas.scrollLeft = Math.max(0, Math.min(targetScroll + FLOW_CANVAS_GROWTH_STEP, canvas.scrollWidth - canvas.clientWidth))
      if (axis === 'top') canvas.scrollTop = Math.max(0, Math.min(targetScroll + FLOW_CANVAS_GROWTH_STEP, canvas.scrollHeight - canvas.clientHeight))
    })
  }

  const autoPanCanvasAtEdge = (canvas: HTMLDivElement, pointer: WorkflowPosition) => {
    const rect = canvas.getBoundingClientRect()
    const moveHorizontal = (direction: -1 | 1) => {
      const currentScroll = canvas.scrollLeft
      const maxScroll = Math.max(0, canvas.scrollWidth - canvas.clientWidth)
      const nextScroll = Math.max(0, Math.min(maxScroll, currentScroll + direction * FLOW_CANVAS_AUTO_PAN_STEP))
      if (nextScroll !== currentScroll) canvas.scrollLeft = nextScroll
      else expandCanvas(direction < 0 ? 'left' : 'width', canvas, currentScroll)
    }
    const moveVertical = (direction: -1 | 1) => {
      const currentScroll = canvas.scrollTop
      const maxScroll = Math.max(0, canvas.scrollHeight - canvas.clientHeight)
      const nextScroll = Math.max(0, Math.min(maxScroll, currentScroll + direction * FLOW_CANVAS_AUTO_PAN_STEP))
      if (nextScroll !== currentScroll) canvas.scrollTop = nextScroll
      else expandCanvas(direction < 0 ? 'top' : 'height', canvas, currentScroll)
    }
    if (pointer.x <= rect.left + FLOW_CANVAS_AUTO_PAN_ZONE) moveHorizontal(-1)
    else if (pointer.x >= rect.right - FLOW_CANVAS_AUTO_PAN_ZONE) moveHorizontal(1)
    if (pointer.y <= rect.top + FLOW_CANVAS_AUTO_PAN_ZONE) moveVertical(-1)
    else if (pointer.y >= rect.bottom - FLOW_CANVAS_AUTO_PAN_ZONE) moveVertical(1)
  }

  const beginPendingEdge = () => {
    const position = findPendingEdgePosition(workflow.nodes, nodeWidth, nodeHeight)
    setPendingEdge({ id: `pending-edge-${Date.now()}`, source: '', target: '', ...position })
    setPendingEdgeSelected(false)
    onClearEdge()
  }

  const cancelPendingEdge = () => {
    setPendingEdge(null)
    setPendingEdgeSelected(false)
  }

  const handleClearCanvas = () => {
    setPendingEdge(null)
    setPendingEdgeSelected(false)
    onClearCanvas()
  }

  const configurePendingEdge = (field: 'source' | 'target', value: string) => {
    if (!pendingEdge) return
    const next = { ...pendingEdge, [field]: value }
    if (next.source && next.target) {
      if (onAddEdge(next.source, next.target)) {
        setPendingEdge(null)
        setPendingEdgeSelected(false)
      } else {
        setPendingEdge(field === 'target' ? { ...next, target: '' } : { ...next, source: '' })
      }
      return
    }
    setPendingEdge(next)
  }

  const handleDirectConnectionClick = (node: WorkflowNode) => {
    if (!pendingEdge || pendingEdgeSelected) return
    configurePendingEdge(pendingEdge.source ? 'target' : 'source', node.id)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>, node: WorkflowNode) => {
    if (!canEditWorkflow || (event.pointerType === 'mouse' && event.button !== 0)) return
    if (pendingEdge && !pendingEdgeSelected) {
      event.preventDefault()
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const scrollCanvas = scrollCanvasRef.current
    if (!scrollCanvas) return
    dragRef.current = { id: node.id, pointerStart: { x: event.clientX, y: event.clientY }, startPosition: { ...node.position }, startScroll: { x: scrollCanvas.scrollLeft, y: scrollCanvas.scrollTop }, startOrigin: { ...canvasOrigin }, started: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return
    const target = event.target
    if (target instanceof Element && (target.closest('button') || target.closest('g, path'))) return
    const canvas = event.currentTarget
    panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
    setIsPanning(true)
    canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan) {
      const canvas = event.currentTarget
      const nextScroll = getFlowCanvasPanScroll({ scroll: { x: canvas.scrollLeft, y: canvas.scrollTop }, previousPointer: { x: pan.lastX, y: pan.lastY }, pointer: { x: event.clientX, y: event.clientY } })
      pan.lastX = event.clientX
      pan.lastY = event.clientY
      const nextScrollLeft = nextScroll.x
      const nextScrollTop = nextScroll.y
      canvas.scrollLeft = Math.max(0, nextScrollLeft)
      canvas.scrollTop = Math.max(0, nextScrollTop)
      event.preventDefault()
      return
    }
    const drag = dragRef.current
    const scrollCanvas = scrollCanvasRef.current
    if (!drag || !scrollCanvas) return
    if (!drag.started && !hasExceededDragThreshold(drag.pointerStart, { x: event.clientX, y: event.clientY })) return
    if (!drag.started) {
      drag.started = true
      setIsDragging(true)
    }
    autoPanCanvasAtEdge(scrollCanvas, { x: event.clientX, y: event.clientY })
    const position = getFlowNodePositionFromDrag({ startPosition: drag.startPosition, pointerStart: drag.pointerStart, pointer: { x: event.clientX, y: event.clientY }, startScroll: drag.startScroll, scroll: { x: scrollCanvas.scrollLeft, y: scrollCanvas.scrollTop }, startOrigin: drag.startOrigin, origin: canvasOrigin })
    onMoveNode(drag.id, position)
  }

  const stopDragging = () => {
    dragRef.current = null
    panRef.current = null
    setIsDragging(false)
    setIsPanning(false)
  }

  return (
    <section className={`flow-workbench ${isFullscreen ? 'is-fullscreen' : ''}`} aria-label="项目流程图">
      <div className="flow-toolbar">
        <div><strong>{workflow.status === 'published' ? `流程版本 v${workflow.version ?? 1}` : workflow.baseline ? `流程草稿 · 基于 v${workflow.baseline.version}` : '流程草稿'}</strong><span>双击任务查看详情 · {calendar.mode === 'working' ? `${calendar.name} · 跳过休息日` : '自然日'} · 前置任务完成后自动开始计时</span></div>
        <div className="flow-edge-selection">
          {!canEditWorkflow ? <span>{supervisorView ? '监督视图 · 流程与连线仅可查看' : '执行成员视图 · 流程与连线仅可查看'}</span> : pendingEdge && !pendingEdgeSelected ? <>
            <span>直接连线</span>
            <span>{pendingEdgeSource ? `已选择前置：${pendingEdgeSource.wbs} · ${pendingEdgeSource.name}，请点击后置节点` : '请先点击前置节点，再点击后置节点'}</span>
            <button className="link-button" type="button" onClick={() => setPendingEdgeSelected(true)}>改用搜索选择</button>
            <button className="link-button flow-edge-delete" type="button" onClick={cancelPendingEdge}>取消连线</button>
          </> : pendingEdge && pendingEdgeSelected ? <>
            <span>配置新连线</span>
            <WorkflowNodeSearchPicker label="前置" ariaLabel="新连线前置节点" value={pendingEdge.source} nodes={selectableNodes} onChange={(value) => configurePendingEdge('source', value)} />
            <span>→</span>
            <WorkflowNodeSearchPicker label="后置" ariaLabel="新连线后置节点" value={pendingEdge.target} nodes={targetableNodes} onChange={(value) => configurePendingEdge('target', value)} />
            <button className="link-button flow-edge-delete" type="button" onClick={cancelPendingEdge}>删除连线</button>
            <button className="link-button" type="button" onClick={() => setPendingEdgeSelected(false)}>直接选择节点</button>
          </> : selectedEdge && selectedEdgeSource && selectedEdgeTarget ? <>
            <span>编辑连线</span>
            <WorkflowNodeSearchPicker label="前置" ariaLabel="已选连线前置节点" value={selectedEdge.source} nodes={selectableNodes} onChange={(value) => onUpdateEdge(selectedEdge.id, { source: value, target: selectedEdge.target })} />
            <span>→</span>
            <WorkflowNodeSearchPicker label="后置" ariaLabel="已选连线后置节点" value={selectedEdge.target} nodes={targetableNodes} onChange={(value) => onUpdateEdge(selectedEdge.id, { source: selectedEdge.source, target: value })} />
            <button className="link-button flow-edge-delete" type="button" onClick={() => onDeleteEdge(selectedEdge.id)}>删除连线</button>
            <button className="link-button" type="button" onClick={onClearEdge}>取消选择</button>
          </> : <span>点击虚线连线可编辑两端</span>}
          <label className="flow-edge-picker"><span>选择连线</span><select aria-label="选择已有连线" value={selectedEdgeId ?? ''} onChange={(event) => event.target.value ? onSelectEdge(event.target.value) : onClearEdge()}><option value="">选择连线</option>{workflow.edges.map((edge) => { const source = workflow.nodes.find((node) => node.id === edge.source); const target = workflow.nodes.find((node) => node.id === edge.target); return <option key={edge.id} value={edge.id}>{source?.name ?? edge.source} → {target?.name ?? edge.target}</option> })}</select></label>
          <button className="button button-secondary button-compact flow-fullscreen-button" type="button" onClick={() => setIsFullscreen((fullscreen) => !fullscreen)} aria-pressed={isFullscreen} title={isFullscreen ? '退出全屏画布（Esc）' : '全屏查看流程画布'}>{isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{isFullscreen ? '退出全屏' : '全屏画布'}</button>
          {canEditWorkflow && <>
          {workflow.status === 'draft' && <button className="button button-secondary button-compact" type="button" onClick={onAlignSerialTasks} title="将同一条串联链路中的任务移动到同一条水平线上，不改变依赖关系"><GitBranch size={15} />对齐串联任务</button>}
          <button className="button button-secondary button-compact" type="button" onClick={onResetLayout} title="恢复上次保存的草稿布局，不修改任务内容"><ChevronsUpDown size={15} />重置排版</button>
          <button className="button button-secondary button-compact" type="button" onClick={onRestorePublishedLayout} disabled={!canRestorePublishedLayout} title="恢复最近一次已发布的节点位置和连线布局"><History size={15} />恢复已发布布局</button>
           <button className="button button-secondary button-compact" type="button" onClick={pendingEdge ? cancelPendingEdge : beginPendingEdge}><Plus size={15} />{pendingEdge ? '取消连线' : '添加连线'}</button>
          <button className="button button-secondary button-compact" type="button" onClick={onAddParallelTask} disabled={!selectedEdgeId} title={selectedEdgeId ? '保留原连线，并新增一条并行分支汇聚到同一后置任务' : '请先选择一条连线'}>添加并行分支</button>
          <button className="button button-secondary button-compact flow-clear-button" type="button" onClick={handleClearCanvas} title="移除全部任务和连线，仅保留项目开始与项目结束"><Trash2 size={15} />清空画布</button>
          </>}
          <div className="flow-lifecycle-actions">{!canEditWorkflow ? (workflow.status === 'published' ? <StatusBadge tone="success">已发布</StatusBadge> : <StatusBadge tone="warning">草稿未生效</StatusBadge>) : <><button className="button button-secondary button-compact" type="button" onClick={onSaveDraft}>保存草稿</button>{workflow.status === 'published' ? <StatusBadge tone="success">已发布</StatusBadge> : <>{workflow.baseline && <StatusBadge tone="warning">草稿未生效</StatusBadge>}<button className="button button-primary button-compact" type="button" onClick={onPublish} disabled={!canPublish} title={canPublish ? '发布当前流程草稿' : '请先添加任务并修复流程问题'}>管理员发布</button></>}{canUndo && <button className="button button-secondary button-compact" type="button" onClick={onUndo}>撤销</button>}</>}</div>
        </div>
      </div>
      {(lifecycleMessage || validationMessage) && <div className={`flow-lifecycle-message ${validationMessage ? 'is-error' : ''}`} role={validationMessage ? 'alert' : 'status'}>{validationMessage ?? lifecycleMessage}</div>}
      {workflow.status === 'draft' && workflow.baseline && baselineChanges.length > 0 && <div className="flow-baseline-panel" role="status"><div className="flow-baseline-head"><div><strong>相对已发布基线 v{workflow.baseline.version} 的变更</strong><span>{baselineChanges.length} 项计划变化 · 当前仍是草稿，尚未对执行人员生效</span></div></div><ul>{baselineChanges.map((change) => <li key={change.nodeId}><span>{change.name}</span><span>{formatBaselineChange(change)}</span></li>)}</ul><small>任务的实际开始、实际完成和闭环记录会保留，不会被计划重算覆盖。</small></div>}
      <div ref={scrollCanvasRef} className={`flow-canvas ${isDragging ? 'is-dragging' : ''} ${isPanning ? 'is-panning' : ''}`} onPointerDown={handleCanvasPointerDown} onPointerMove={handlePointerMove} onPointerUp={stopDragging} onPointerCancel={stopDragging} onPointerLeave={() => { if (!dragRef.current && !panRef.current) stopDragging() }} onLostPointerCapture={stopDragging}>
        <div className="flow-canvas-stage" ref={canvasRef} style={{ width: canvasSize.width, height: canvasSize.height }}>
        <svg className="flow-edges" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} width={canvasSize.width} height={canvasSize.height} role="img" aria-label="流程依赖连线">
          <defs><marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
          {pendingEdge && pendingEdgeSelected && (() => {
            const startX = pendingEdge.start.x + canvasOrigin.x
            const startY = pendingEdge.start.y + canvasOrigin.y
            const endX = pendingEdge.end.x + canvasOrigin.x
            const endY = pendingEdge.end.y + canvasOrigin.y
            const path = buildOrthogonalPath({ x: startX, y: startY }, { x: endX, y: endY })
            const hitX = Math.min(startX, endX) - 18
            const hitY = Math.min(startY, endY) - 18
            return <g key={pendingEdge.id}><rect className="flow-edge-hit-box" x={hitX} y={hitY} width={Math.abs(endX - startX) + 36} height={Math.abs(endY - startY) + 36} role="button" tabIndex={0} aria-label="选择待配置连线" onClick={() => setPendingEdgeSelected(true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setPendingEdgeSelected(true) }} /><path className="flow-edge-hit" d={path} aria-hidden="true" onClick={() => setPendingEdgeSelected(true)} /><path className={`flow-edge-visual flow-edge-pending ${pendingEdgeSelected ? 'is-selected' : ''}`} d={path} markerEnd="url(#flow-arrow)" aria-hidden="true" onClick={() => setPendingEdgeSelected(true)} /></g>
          })()}
          {workflow.edges.map((edge) => {
            const source = workflow.nodes.find((node) => node.id === edge.source)
            const target = workflow.nodes.find((node) => node.id === edge.target)
            if (!source || !target) return null
            const startX = source.position.x + canvasOrigin.x + nodeWidth
            const startY = source.position.y + canvasOrigin.y + nodeHeight / 2
            const endX = target.position.x + canvasOrigin.x
            const endY = target.position.y + canvasOrigin.y + nodeHeight / 2
            const path = buildOrthogonalPath({ x: startX, y: startY }, { x: endX, y: endY })
            return <g key={edge.id}><path className="flow-edge-hit" d={path} role="button" tabIndex={0} aria-label={`选择连线 ${source.name} 到 ${target.name}`} onClick={() => onSelectEdge(edge.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelectEdge(edge.id) }} /><path className={`flow-edge-visual ${selectedEdgeId === edge.id ? 'is-selected' : ''}`} d={path} markerEnd="url(#flow-arrow)" aria-hidden="true" onClick={() => onSelectEdge(edge.id)} /></g>
          })}
        </svg>
          {workflow.nodes.map((node) => {
            const planned = schedules[node.id]
            const predecessors = node.type !== 'start' && node.type !== 'end' ? workflow.edges.filter((edge) => edge.target === node.id).map((edge) => workflow.nodes.find((candidate) => candidate.id === edge.source)).filter((predecessor): predecessor is WorkflowNode => Boolean(predecessor && predecessor.type !== 'start' && predecessor.type !== 'end')) : []
            const specialRelease = node.specialRelease ?? null
            const blockedBy = specialRelease ? [] : predecessors.filter((predecessor) => !isCompletionApproved(predecessor)).map((predecessor) => predecessor.name)
            const readyAt = specialRelease?.approvedAt?.slice(0, 10) ?? (blockedBy.length === 0 && predecessors.length > 0 ? latestCompletionDate(predecessors, schedules) : undefined)
            // 角标：进行中按计划完成日拆分为 按期进行 / 超期进行；审批中的任务单独标注
             const pendingApproval = node.approvals?.some((approval) => approval.status === 'PENDING')
             const statusChip = node.type !== 'task' ? null
              : isCompletionStatus(node.status) ? completionStatusView(node.status)
              : pendingApproval ? { label: '审批中', tone: 'info' }
              : node.status === '受阻' ? { label: '受阻', tone: 'warning' }
              : node.status === '进行中' || node.status === '到期未完成'
                ? (planned?.plannedEnd && planned.plannedEnd < todayIso() ? { label: '超期进行', tone: 'danger' } : { label: '按期进行', tone: 'accent' })
                : { label: node.status, tone: 'neutral' }
             const detailTitle = `${node.wbs} ${node.name} · ${assigneeSummary(node)} · ${planned ? `${planned.plannedStart} → ${planned.plannedEnd}` : '待排期'}`
             const connectionSource = pendingEdge && !pendingEdgeSelected && pendingEdge.source === node.id
             const hasTaskActions = Boolean(node.taskId && (node.type === 'task' || node.type === 'milestone'))
             return <div className="flow-node-shell" key={node.id} style={{ left: node.position.x + canvasOrigin.x, top: node.position.y + canvasOrigin.y }}>
               <button className={`flow-node flow-node-${node.type} ${hasTaskActions ? 'has-task-menu' : ''} ${selectedTaskId === node.id ? 'is-selected' : ''} ${connectionSource ? 'is-connection-source' : ''}`} type="button" title={`${detailTitle}，右键或点击更多操作`} aria-label={`${detailTitle}，双击查看详情，右键打开任务操作`} onPointerDown={(event) => handlePointerDown(event, node)} onLostPointerCapture={stopDragging} onContextMenu={(event) => openTaskContextMenu(event, node)} onClick={() => { if (pendingEdge && !pendingEdgeSelected) handleDirectConnectionClick(node) }} onDoubleClick={(event) => { if (pendingEdge && !pendingEdgeSelected) { event.preventDefault(); return } onSelectTask(node.id) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (pendingEdge && !pendingEdgeSelected) handleDirectConnectionClick(node); else onSelectTask(node.id) } }}>
             {statusChip && <span className={`flow-node-status flow-node-status-${statusChip.tone}`}>{statusChip.label}</span>}
            <span className="flow-node-kicker">{node.type === 'start' ? 'START' : node.type === 'end' ? 'END' : node.wbs}</span>
            <strong>{node.name}</strong>
            {node.type !== 'start' && node.type !== 'end' && <small className="flow-node-secondary">{assigneeSummary(node)} · {node.type === 'milestone' ? '里程碑' : `${node.duration} ${calendar.mode === 'working' ? '工作日' : '自然日'}`}</small>}
            {planned && <time>{planned.plannedStart} → {planned.plannedEnd}</time>}
            {predecessors.length > 1 && <small className="flow-node-secondary flow-node-merge">汇聚节点 · 需完成 {predecessors.length} 个前置</small>}
            {blockedBy.length === 0 && (node.status === '未开始' || node.status === '受阻') && predecessors.length > 0 && <small className="flow-node-secondary flow-node-ready">已解锁 · 计时自 {readyAt ?? '提交日'}</small>}
             {blockedBy.length > 0 && <small className="flow-node-secondary flow-node-blocked">待前置完成：{blockedBy.join('、')}</small>}
             {specialRelease && <small className="flow-node-secondary flow-node-ready">已特殊放行 · 前置任务待补做</small>}
               </button>
               {hasTaskActions && <button className="flow-node-more" type="button" aria-label={`打开 ${node.wbs} ${node.name} 的任务操作`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => openTaskContextMenu(event, node)}><MoreHorizontal size={15} /></button>}
             </div>
           })}
        </div>
       </div>
       {taskContextMenu && contextMenuNode && contextMenuActions.length > 0 && <div ref={taskContextMenuRef} className="task-context-menu" role="menu" aria-label={`${contextMenuNode.wbs} ${contextMenuNode.name} 任务操作`} style={{ left: taskContextMenu.x, top: taskContextMenu.y }} onContextMenu={(event) => event.preventDefault()}><div className="task-context-menu-title"><strong>{contextMenuNode.wbs} · {contextMenuNode.name}</strong><small>选择操作后打开对应任务功能</small></div>{contextMenuActions.map((action) => <button className={`task-context-menu-item ${action === 'special-release' ? 'is-warning' : ''}`} key={action} type="button" role="menuitem" onClick={() => selectTaskAction(action)}><strong>{taskMenuCopy[action].label}</strong><small>{taskMenuCopy[action].hint}</small></button>)}</div>}
       {issues.length > 0 && <div className="flow-issues" role="alert">{issues.map((issue, index) => <span key={`${issue.message}-${index}`}>{issue.message}</span>)}</div>}
      {changeNotice && changeNotice.changes.length > 0 && <div className="flow-change-panel" role="status"><div className="flow-change-head"><div><strong>排期已重算</strong><span>{changeNotice.reason} · {changeNotice.changes.length} 个节点受影响</span></div>{canUndo && <button className="link-button" type="button" onClick={onUndo}>撤销变更</button>}</div><ul>{changeNotice.changes.map((change) => <li key={change.nodeId}><span>{change.name}</span><span>{formatScheduleChange(change)}</span></li>)}</ul></div>}
      <div className="flow-legend"><span><i className="flow-dot flow-dot-active" />进行中</span><span><i className="flow-dot flow-dot-done" />已完成</span><span><i className="flow-dot flow-dot-pending" />未开始</span><span>未选连线时添加任务放到空白处 · 选中连线后添加任务会插入并顺延下游 · 画布会随节点移动和平移向四周自动扩展</span></div>
    </section>
  )
}

function WorkflowNodeSearchPicker({ label, ariaLabel, value, nodes, onChange }: { label: string; ariaLabel: string; value: string; nodes: WorkflowNode[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selectedNode = nodes.find((node) => node.id === value)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredNodes = nodes.filter((node) => {
    if (!normalizedQuery) return true
    return [node.wbs, node.name, node.owner].some((field) => field.toLowerCase().includes(normalizedQuery))
  }).slice(0, 20)

  const chooseNode = (node: WorkflowNode) => {
    onChange(node.id)
    setOpen(false)
    setQuery('')
  }

  return <div className="flow-edge-search-picker">
    <span>{label}</span>
    <div className="flow-edge-search-control">
      <Search size={14} aria-hidden="true" />
      <input aria-label={ariaLabel} role="combobox" aria-expanded={open} aria-autocomplete="list" placeholder="搜索节点" value={open ? query : selectedNode ? `${selectedNode.wbs} · ${selectedNode.name}` : ''} onFocus={() => { setQuery(''); setOpen(true) }} onChange={(event) => { setQuery(event.target.value); setOpen(true) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (filteredNodes[0]) chooseNode(filteredNodes[0]) } if (event.key === 'Escape') { setOpen(false); setQuery('') } }} onBlur={() => { window.setTimeout(() => setOpen(false), 120) }} />
      {open && <div className="flow-edge-search-menu" role="listbox" aria-label={`${label}节点搜索结果`}>
        {filteredNodes.length > 0 ? filteredNodes.map((node) => <button className="flow-edge-search-option" type="button" role="option" aria-selected={node.id === value} key={node.id} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseNode(node)}><strong>{node.wbs} · {node.name}</strong><small>{node.type === 'start' ? '开始节点' : node.type === 'end' ? '结束节点' : `${node.owner} · ${node.type === 'milestone' ? '里程碑' : '任务'}`}</small></button>) : <span className="flow-edge-search-empty">没有匹配的节点</span>}
      </div>}
    </div>
  </div>
}

function formatScheduleChange(change: ScheduleImpact) {
  const before = change.before ? `${change.before.plannedStart} → ${change.before.plannedEnd}` : '—'
  const after = change.after ? `${change.after.plannedStart} → ${change.after.plannedEnd}` : '—'
  if (!change.before) return `新增 · ${after}`
  if (!change.after) return `移除 · ${before}`
  return `${before} → ${after}`
}

function GanttView({ tasks, baselineStart, calendar, selectedTaskId, onSelectTask }: { tasks: Task[]; baselineStart: string; calendar: WorkCalendarConfig; selectedTaskId: string | null; onSelectTask: (id: string) => void }) {
  const timeline = useMemo(() => buildTimeline(tasks, baselineStart, calendar), [baselineStart, calendar, tasks])
  const gridStyle = { '--timeline-columns': timeline.days.length } as React.CSSProperties
  const todayPosition = Math.min(100, Math.max(0, (calendarDateOffset(timeline.start, todayIso()) / timeline.days.length) * 100))
  return (
    <section className="gantt-workbench" aria-label="项目 WBS 与甘特图">
      <div className="wbs-pane">
        <div className="gantt-pane-head">
          <span className="wbs-name-head">任务名称</span><span>负责人</span><span>工期</span><span>完成</span>
        </div>
        <div className="wbs-rows">
          {tasks.map((task) => (
            <button className={`wbs-row ${selectedTaskId === task.id ? 'is-selected' : ''} ${task.level === 0 ? 'is-summary' : ''}`} type="button" key={task.id} onClick={() => onSelectTask(task.id)}>
              <span className="wbs-task" style={{ '--level': task.level } as React.CSSProperties}>{task.level === 0 ? <ChevronDown size={15} /> : task.milestone ? <Diamond size={13} /> : <span className="row-grip"><ChevronsUpDown size={13} /></span>}<span><strong>{task.wbs} {task.name}</strong>{task.dependency && <small>依赖：{task.dependency}</small>}</span></span>
              <span>{assigneeSummary(task)}</span><span>{task.milestone ? '里程碑' : `${task.duration} ${calendar.mode === 'working' ? '工作日' : '自然日'}`}</span><span>{task.progress}%</span>
            </button>
          ))}
        </div>
      </div>

      <div className="timeline-pane">
        <div className="timeline-head">
          <div className="timeline-months" style={gridStyle}>{timeline.months.map((month) => <span key={month.key} style={{ gridColumn: `span ${month.span}` }}>{month.label}</span>)}</div>
          <div className="timeline-days" style={gridStyle}>{timeline.days.map((day) => <span className={day.isNonWorking ? 'is-weekend' : ''} key={day.iso}>{day.label}</span>)}</div>
        </div>
        <div className="timeline-body" style={gridStyle}>
          <div className="today-line" style={{ insetInlineStart: `${todayPosition}%` }}><span>今天</span></div>
          {tasks.map((task) => (
            <button className={`timeline-row ${selectedTaskId === task.id ? 'is-selected' : ''}`} style={gridStyle} type="button" key={task.id} onClick={() => onSelectTask(task.id)} aria-label={`${task.name}，完成 ${task.progress}%`}>
              <span className="day-grid" style={gridStyle}>{timeline.days.map((day) => <i className={day.isNonWorking ? 'is-weekend' : ''} key={day.iso} />)}</span>
              {task.milestone ? (
                <span className="milestone-diamond" style={{ '--start': timelineStartColumn(timeline.start, task.plannedStart, task.calendarStartOffset ?? task.startOffset) } as React.CSSProperties}><Diamond size={14} fill="currentColor" /></span>
              ) : (
                  <span className={`gantt-bar ${task.level === 0 ? 'is-summary' : ''} ${task.status === '受阻' || (task.blockedBy?.length ?? 0) > 0 ? 'is-blocked' : ''}`} style={{ '--start': timelineStartColumn(timeline.start, task.plannedStart, task.calendarStartOffset ?? task.startOffset), '--span': timelineSpan(task), '--done': `${task.progress}%` } as React.CSSProperties}>
                  <i /><em>{task.name}</em>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function buildTimeline(tasks: Task[], baselineStart: string, calendar: WorkCalendarConfig) {
  const start = [baselineStart, ...tasks.map((task) => task.plannedStart).filter((date): date is string => Boolean(date))].sort()[0] ?? baselineStart
  const latestEnd = tasks.map((task) => task.plannedEnd).filter((date): date is string => Boolean(date)).sort().at(-1) ?? start
  const totalDays = Math.max(24, calendarDateOffset(start, latestEnd) + 1)
  const days = Array.from({ length: totalDays }, (_, index) => {
    const iso = addTimelineDays(start, index)
    const dayOfWeek = new Date(`${iso}T00:00:00Z`).getUTCDay()
    return { iso, label: iso.slice(8, 10), isNonWorking: calendar.mode === 'working' ? !isWorkingDate(iso, calendar) : dayOfWeek === 0 || dayOfWeek === 6 }
  })
  const months: { key: string; label: string; span: number }[] = []
  for (const day of days) {
    const key = day.iso.slice(0, 7)
    const current = months.at(-1)
    if (current?.key === key) current.span += 1
    else months.push({ key, label: `${day.iso.slice(0, 4)}年${Number(day.iso.slice(5, 7))}月`, span: 1 })
  }
  return { start, days, months }
}

function addTimelineDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function timelineStartColumn(timelineStart: string, plannedStart: string | undefined, fallbackOffset: number) {
  return plannedStart ? calendarDateOffset(timelineStart, plannedStart) + 1 : fallbackOffset + 1
}

function timelineSpan(task: Task) {
  if (task.plannedStart && task.plannedEnd) return Math.max(1, calendarDateOffset(task.plannedStart, task.plannedEnd))
  return Math.max(1, task.calendarSpan ?? task.duration)
}

function TaskListView({ tasks, selectedTaskId, onSelectTask }: { tasks: Task[]; selectedTaskId: string | null; onSelectTask: (id: string) => void }) {
  return (
    <section className="panel task-list-panel">
      <div className="data-table task-list-table" role="table">
        <div className="table-row table-head"><span>WBS</span><span>任务</span><span>状态</span><span>负责人</span><span>依赖</span><span>工时</span><span>完成</span></div>
        {tasks.map((task) => {
          const status = taskStatusView(task)
          return <button className={`table-row ${selectedTaskId === task.id ? 'is-selected' : ''}`} type="button" key={task.id} onClick={() => onSelectTask(task.id)}>
            <span className="mono-cell">{task.wbs}</span><span className={task.level === 0 ? 'text-strong' : ''}>{task.name}</span><span><StatusBadge tone={status.tone}>{status.label}</StatusBadge></span><span>{assigneeSummary(task)}</span><span>{task.dependency ?? '—'}</span><span>{task.effort} h</span><span className="table-progress"><ProgressBar value={task.progress} /><small>{task.progress}%</small></span>
          </button>
        })}
      </div>
    </section>
  )
}

function MilestoneView({ tasks, onSelectTask }: { tasks: Task[]; onSelectTask: (id: string) => void }) {
  return (
    <section className="milestone-board">
      <article className="milestone-track">
        <div className="milestone-rail" />
        {tasks.map((task) => {
          const status = taskStatusView(task)
          return <button className="milestone-card" type="button" key={task.id} onClick={() => onSelectTask(task.id)}>
            <span className="milestone-marker"><Diamond size={15} fill="currentColor" /></span><time>{formatMilestoneDate(task.plannedStart ?? task.plannedEnd)}</time><h3>{task.name}</h3><p>{task.dependency ? `依赖 ${task.dependency}` : '暂无前置依赖'}</p><StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </button>
        })}
      </article>
      <aside className="panel baseline-note"><Sparkles size={19} /><h3>Agent 检查</h3><p>“现场联调”前置任务的剩余缓冲为 2 天。如果设备数据接入本周未达到 70%，建议提前安排周末联调窗口。</p><button className="link-button" type="button">生成缓冲方案</button></aside>
    </section>
  )
}

function formatMilestoneDate(date: string | undefined) {
  if (!date) return '待排期'
  return `${date.slice(5, 7)} 月 ${date.slice(8, 10)} 日`
}

function assigneeNames(value: Pick<WorkflowNode, 'owner' | 'assigneeNames'>) {
  const names = (value.assigneeNames ?? []).map((name) => name.trim()).filter(Boolean)
  return names.length > 0 ? names : value.owner && value.owner !== '待分配' ? [value.owner] : []
}

function assigneeSummary(value: Pick<WorkflowNode, 'owner' | 'assigneeNames'>) {
  const names = assigneeNames(value)
  if (names.length === 0) return '待分配'
  return names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 人` : names.join('、')
}

function TaskDrawer({ task, mode, focus = 'overview', members, calendarMode, workflowStatus, readOnly = false, readOnlyLabel = '监督视图 · 只读', canEditStructure = false, canManageDeliverables = false, canSubmitApproval = false, deleting = false, onClose, onSave, onSaveDeliverables, onSubmitDingTalkApproval, onSubmitSpecialRelease, onRefreshDingTalkApproval, onDelete }: { task: Task; mode?: TaskMenuAction; focus?: TaskDrawerFocus; members: ProjectMemberOption[]; calendarMode: WorkCalendarConfig['mode']; workflowStatus: 'draft' | 'published'; readOnly?: boolean; readOnlyLabel?: string; canEditStructure?: boolean; canManageDeliverables?: boolean; canSubmitApproval?: boolean; deleting?: boolean; onClose: () => void; onSave: (patch: TaskEditPatch) => void; onSaveDeliverables: (deliverables: WorkflowDeliverable[]) => void; onSubmitDingTalkApproval: (note: string, overdueReason: string, deliveryType: 'STAGE' | 'FINAL', progress: number) => Promise<string | null>; onSubmitSpecialRelease: (reason: string) => Promise<string | null>; onRefreshDingTalkApproval: (approvalId: string) => Promise<string | null>; onDelete?: () => void }) {
  const initialNames = assigneeNames(task)
  const initialIds = task.assigneeIds?.length ? task.assigneeIds : task.ownerMemberId ? [task.ownerMemberId] : []
  const [draft, setDraft] = useState({ name: task.name, owner: task.owner, duration: task.duration, plannedStartOverride: task.plannedStartOverride ?? '', plannedEndOverride: task.plannedEndOverride ?? '', description: task.description ?? '', closureCriteria: task.closureCriteria ?? '', assigneeIds: initialIds, assigneeNames: initialNames })
  const [assigneeQuery, setAssigneeQuery] = useState('')
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const [assigneeError, setAssigneeError] = useState<string | null>(null)
  const [deliverables, setDeliverables] = useState<WorkflowDeliverable[]>(() => task.deliverables ?? [])
  const [artifactKind, setArtifactKind] = useState<WorkflowDeliverable['kind']>('link')
  const [artifactName, setArtifactName] = useState('')
  const [artifactVersion, setArtifactVersion] = useState(() => nextDeliverableVersion(task.deliverables))
  const [artifactUrl, setArtifactUrl] = useState('')
  const [artifactFile, setArtifactFile] = useState<File | null>(null)
  const [approvalProcessInstanceId, setApprovalProcessInstanceId] = useState('')
  const [approvalProcessCode, setApprovalProcessCode] = useState('')
  const [approvalFileId, setApprovalFileId] = useState('')
  const [approvalSpaceId, setApprovalSpaceId] = useState('')
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [dingApprovalNote, setDingApprovalNote] = useState('')
  const [dingOverdueReason, setDingOverdueReason] = useState(task.overdueReason ?? '')
  const [dingDeliveryType, setDingDeliveryType] = useState<'STAGE' | 'FINAL'>('FINAL')
  const [dingProgress, setDingProgress] = useState('100')
  const [dingSubmitting, setDingSubmitting] = useState(false)
  const [dingError, setDingError] = useState<string | null>(null)
  const [specialReleaseReason, setSpecialReleaseReason] = useState('')
  const [specialReleaseSubmitting, setSpecialReleaseSubmitting] = useState(false)
  const [specialReleaseError, setSpecialReleaseError] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [predecessorDeliverables, setPredecessorDeliverables] = useState<PredecessorDeliverableItem[] | null>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const drawerBodyRef = useRef<HTMLDivElement>(null)
  const dingApprovals = task.approvals ?? []
  const pendingDingApproval = dingApprovals.find((approval) => approval.status === 'PENDING')
  const pendingSpecialRelease = dingApprovals.find((approval) => approval.status === 'PENDING' && approval.purpose === 'BYPASS')
  const drawerMode = mode ?? 'edit'
  const isFunctionPage = drawerMode !== 'edit'
  const specialRelease = task.specialRelease ?? null
  const blocked = !specialRelease && (task.blockedBy?.length ?? 0) > 0 && !isCompletionApproved(task)
  const final = isCompletionStatus(task.status)
  const taskDueUnfinished = task.status === '到期未完成'
  const ready = (task.status === '未开始' || task.status === '受阻') && !blocked
  const canRequestSpecialRelease = Boolean(canSubmitApproval && workflowStatus === 'published' && task.taskId && !final && blocked && !specialRelease && !pendingDingApproval)
  const displayStatus = blocked ? '受阻' : final ? completionStatusView(task.status).label : ready ? '可开始' : task.status

  useEffect(() => {
    if (focus === 'overview') {
      drawerBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const target = drawerRef.current?.querySelector<HTMLElement>(`[data-task-section="${focus}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focus, task.id])

  // 前置交付物（文档 §10）：进入任务抽屉时加载直接前置任务的交付物列表。
  useEffect(() => {
    if (!task.taskId) return
    let cancelled = false
    fetchPredecessorDeliverables(task.taskId)
      .then((items) => { if (!cancelled) setPredecessorDeliverables(items) })
      .catch(() => { if (!cancelled) setPredecessorDeliverables([]) })
    return () => { cancelled = true }
  }, [task.taskId])

  const save = () => {
    if (!draft.name.trim()) return
    if ((draft.plannedStartOverride && !draft.plannedEndOverride) || (!draft.plannedStartOverride && draft.plannedEndOverride)) {
      setScheduleError('请同时选择计划开始和计划结束日期，或同时清空。')
      return
    }
    if (draft.plannedStartOverride && draft.plannedEndOverride && draft.plannedStartOverride > draft.plannedEndOverride) {
      setScheduleError('计划结束日期不能早于计划开始日期。')
      return
    }
    const names = draft.assigneeIds.map((id, index) => members.find((member) => member.id === id)?.name ?? draft.assigneeNames[index]).filter((name): name is string => Boolean(name))
    onSave({ ...draft, name: draft.name.trim(), owner: names[0] ?? '待分配', assigneeNames: names, duration: Math.max(0, draft.duration), plannedStartOverride: draft.plannedStartOverride || undefined, plannedEndOverride: draft.plannedEndOverride || undefined })
    setScheduleError(null)
  }

  const toggleAssignee = (member: ProjectMemberOption) => {
    setAssigneeError(null)
    setDraft((current) => {
      const selected = current.assigneeIds.includes(member.id)
      if (selected && current.assigneeIds.length <= 1) {
        setAssigneeError('任务至少需要保留一名负责人')
        return current
      }
      const nextIds = selected ? current.assigneeIds.filter((id) => id !== member.id) : [...current.assigneeIds, member.id]
      const nextNames = nextIds.map((id) => members.find((option) => option.id === id)?.name ?? current.assigneeNames[current.assigneeIds.indexOf(id)]).filter((name): name is string => Boolean(name))
      return { ...current, assigneeIds: nextIds, assigneeNames: nextNames, owner: nextNames[0] ?? '待分配' }
    })
  }

  const selectedAssigneeNames = draft.assigneeIds.map((id, index) => members.find((member) => member.id === id)?.name ?? draft.assigneeNames[index]).filter((name): name is string => Boolean(name))
  const normalizedAssigneeQuery = assigneeQuery.trim().toLowerCase()
  const filteredMembers = members.filter((member) => {
    if (!normalizedAssigneeQuery) return true
    const namePinyin = pinyin(member.name, { toneType: 'none' }).replace(/\s+/g, '').toLowerCase()
    const nameInitials = pinyin(member.name, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '').toLowerCase()
    const searchText = `${member.name} ${namePinyin} ${nameInitials}`.toLowerCase()
    return searchText.includes(normalizedAssigneeQuery)
  })

  const [addingDeliverable, setAddingDeliverable] = useState(false)

  const addDeliverable = async () => {
    const name = artifactName.trim() || artifactFile?.name || ''
    if (!name) {
      setArtifactError(artifactKind === 'file' ? '请先选择文件或填写文档名称' : '请输入文档名称')
      return
    }
    if (artifactKind === 'file' && !artifactFile) {
      setArtifactError('请先选择要关联的文件')
      return
    }
    if (artifactKind === 'file' && !task.taskId) {
      setArtifactError('请先保存任务，再上传本地文件')
      return
    }
    let url: string | undefined
    if (artifactKind === 'link') {
      const value = artifactUrl.trim()
      try {
        const parsed = new URL(value)
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol')
        url = parsed.toString()
      } catch {
        setArtifactError('请输入有效的 http 或 https 链接')
        return
      }
    }
    let nextDeliverable: WorkflowDeliverable = {
      id: `deliverable-${Date.now()}`,
      kind: artifactKind,
      name,
      version: artifactVersion.trim() || nextDeliverableVersion(deliverables),
      uploader: '陈默',
      createdAt: new Date().toISOString(),
      url,
      mimeType: artifactFile?.type || undefined,
      size: artifactFile?.size,
      approvalProcessInstanceId: approvalProcessInstanceId.trim() || undefined,
      approvalProcessCode: approvalProcessCode.trim() || undefined,
      approvalFileId: approvalFileId.trim() || undefined,
      approvalSpaceId: approvalSpaceId.trim() || undefined,
    }
    if (artifactKind === 'file' && task.taskId && artifactFile) {
      setAddingDeliverable(true)
      try {
        nextDeliverable = await uploadTaskDeliverable(task.taskId, artifactFile, { name, versionLabel: artifactVersion.trim() || nextDeliverableVersion(deliverables), approvalProcessInstanceId: approvalProcessInstanceId.trim() || undefined, approvalProcessCode: approvalProcessCode.trim() || undefined, approvalFileId: approvalFileId.trim() || undefined, approvalSpaceId: approvalSpaceId.trim() || undefined })
      } catch (error) {
        setArtifactError(error instanceof Error ? error.message : '文件上传失败')
        setAddingDeliverable(false)
        return
      }
      setAddingDeliverable(false)
    }
    const next = [nextDeliverable, ...deliverables]
    setDeliverables(next)
    onSaveDeliverables(next)
    setArtifactName('')
    setArtifactVersion(nextDeliverableVersion(next))
    setArtifactUrl('')
    setArtifactFile(null)
    setApprovalProcessInstanceId('')
    setApprovalProcessCode('')
    setApprovalFileId('')
    setApprovalSpaceId('')
    setArtifactError(null)
  }

  const removeDeliverable = (deliverableId: string) => {
    const next = deliverables.filter((deliverable) => deliverable.id !== deliverableId)
    setDeliverables(next)
    onSaveDeliverables(next)
  }

  const selectArtifactKind = (kind: WorkflowDeliverable['kind']) => {
    setArtifactKind(kind)
    setArtifactUrl('')
    setArtifactFile(null)
    setArtifactError(null)
  }

  const submitDingApproval = async () => {
    if (dingSubmitting) return
    if (taskDueUnfinished && !dingOverdueReason.trim()) {
      setDingError('任务已超期，请先填写超期原因。')
      return
    }
    const progress = Number(dingProgress)
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
      setDingError('本次进度请输入 0–100 的整数。')
      return
    }
    if (dingDeliveryType === 'FINAL' && progress !== 100) {
      setDingError('最终交付的本次进度必须为 100%。')
      return
    }
    setDingSubmitting(true)
    const error = await onSubmitDingTalkApproval(dingApprovalNote.trim(), dingOverdueReason.trim(), dingDeliveryType, progress)
    setDingSubmitting(false)
    if (error) setDingError(error)
    else { setDingApprovalNote(''); setDingError(null) }
  }

  const submitSpecialReleaseRequest = async () => {
    if (specialReleaseSubmitting || !specialReleaseReason.trim()) {
      if (!specialReleaseReason.trim()) setSpecialReleaseError('请填写特殊放行原因。')
      return
    }
    setSpecialReleaseSubmitting(true)
    const error = await onSubmitSpecialRelease(specialReleaseReason.trim())
    setSpecialReleaseSubmitting(false)
    if (error) setSpecialReleaseError(error)
    else { setSpecialReleaseReason(''); setSpecialReleaseError(null) }
  }

  const refreshDingApproval = async (approvalId: string) => {
    if (dingSubmitting) return
    setDingSubmitting(true)
    const error = await onRefreshDingTalkApproval(approvalId)
    setDingSubmitting(false)
    setDingError(error)
  }

  return (
    <aside ref={drawerRef} className={`task-drawer ${isFunctionPage ? 'task-function-page' : 'task-edit-drawer'}`} data-task-mode={drawerMode} aria-label={isFunctionPage ? `任务${taskMenuCopy[drawerMode].label}` : '编辑任务'}>
      <header><div>{isFunctionPage && <span className="task-page-label">{taskMenuCopy[drawerMode].label}</span>}<span className="mono-label">{task.wbs}</span><h2>{draft.name || '未命名任务'}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label={isFunctionPage ? '返回项目工作区' : '关闭编辑任务'}><X size={19} /></button></header>
      <div ref={drawerBodyRef} className="drawer-body">
        <div className="drawer-status-line"><StatusBadge tone={blocked ? 'danger' : final ? 'success' : task.status === '进行中' ? 'accent' : 'neutral'}>{displayStatus}</StatusBadge><div className="drawer-status-actions">{canSubmitApproval && workflowStatus === 'published' && task.status === '进行中' && <span className="drawer-field-hint">须经 OA 审批通过后完成</span>}{canEditStructure && workflowStatus !== 'published' && !final && <span className="drawer-field-hint">发布后可执行</span>}{readOnly && <span className="drawer-field-hint">{readOnlyLabel}</span>}</div></div>
        {blocked && <div className="drawer-blocked-note" role="status">待前置完成：{task.blockedBy?.join('、')}</div>}
        {specialRelease && <div className="drawer-release-note" role="status">已特殊放行 · 前置任务待补做：{specialRelease.predecessors.map((predecessor) => `${predecessor.wbs} ${predecessor.name}`).join('、')}<br />放行原因：{specialRelease.reason}</div>}
        {ready && task.readyAt && <div className="drawer-ready-note" role="status">已解锁 · 正式计时自 {task.readyAt} 起</div>}
        <dl className="task-fields" data-task-section="overview"><div><dt>负责人</dt><dd className="task-assignee-summary">{assigneeNames(task).map((name) => <span className="avatar avatar-soft" key={name}>{name.slice(0, 1)}</span>)}<span>{assigneeSummary(task)}</span></dd></div><div><dt>计划工期</dt><dd>{task.milestone ? '里程碑' : `${task.duration} 个${calendarMode === 'working' ? '工作日' : '自然日'}`}</dd></div><div><dt>计划时间</dt><dd>{task.plannedStart && task.plannedEnd ? `${task.plannedStart} → ${task.plannedEnd}` : '待排期'}</dd></div><div><dt>实际开始</dt><dd>{task.actualStart ?? '未开始'}</dd></div><div><dt>实际提交完成</dt><dd>{task.actualEnd ?? '未提交'}</dd></div><div><dt>计划工时</dt><dd>{task.effort} h</dd></div><div><dt>前置依赖</dt><dd>{task.dependency ?? '无'}</dd></div><div><dt>交付要求</dt><dd>{task.closureCriteria ?? '未设置'}</dd></div></dl>
         {canEditStructure && <section className="drawer-section" data-task-section="edit"><h3>编辑任务</h3><label className="drawer-field"><span>任务名称</span><input autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="请输入具体工作任务" /></label><div className="drawer-field"><span>负责人（可多选）</span><div className="assignee-picker"><div className="assignee-tags">{selectedAssigneeNames.length > 0 ? selectedAssigneeNames.map((name, index) => <span className="assignee-tag" key={`${name}-${index}`}><span className="avatar avatar-soft">{name.slice(0, 1)}</span>{name}{draft.assigneeIds.length > 1 && <button type="button" aria-label={`移除负责人 ${name}`} onClick={() => { const member = members.find((option) => option.name === name); if (member) toggleAssignee(member) }}><X size={13} /></button>}</span>) : <span className="assignee-empty">待分配</span>}</div><button className="assignee-picker-trigger" type="button" onClick={() => setAssigneePickerOpen((open) => !open)} aria-expanded={assigneePickerOpen}><span>{selectedAssigneeNames.length > 0 ? '添加负责人' : '选择负责人'}</span><ChevronDown size={15} /></button>{assigneePickerOpen && <div className="assignee-picker-menu"><input autoFocus value={assigneeQuery} onChange={(event) => setAssigneeQuery(event.target.value)} placeholder="搜索姓名或拼音首字母" aria-label="搜索负责人" />{filteredMembers.length > 0 ? <div className="assignee-options">{filteredMembers.map((member) => <button className={`assignee-option ${draft.assigneeIds.includes(member.id) ? 'is-selected' : ''}`} type="button" key={member.id} onClick={() => toggleAssignee(member)}><span className="avatar avatar-soft">{member.name.slice(0, 1)}</span><span><strong>{member.name}</strong></span>{draft.assigneeIds.includes(member.id) && <CircleCheck size={16} />}</button>)}</div> : <p className="assignee-empty">暂无可选公司成员</p>}</div>}{assigneeError && <small className="form-error">{assigneeError}</small>}<small className="drawer-field-hint">可从全公司在职成员中选择；多人共同负责同一任务，进度、交付物和完成状态会同步。</small></div></div><label className="drawer-field"><span>计划工期（管理员分配 · {calendarMode === 'working' ? '工作日' : '自然日'}）</span><input type="number" min="0" value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: Number(event.target.value) || 0 }))} /><small className="drawer-field-hint">草稿阶段可调整；保存后自动顺延后置任务，发布后由管理员维护。</small></label><div className="drawer-field"><span>具体计划时间（可选）</span><div className="form-grid"><label className="drawer-field"><span>开始日期</span><input type="date" aria-label="计划开始日期" value={draft.plannedStartOverride} onChange={(event) => { setScheduleError(null); setDraft((current) => ({ ...current, plannedStartOverride: event.target.value })) }} /></label><label className="drawer-field"><span>结束日期</span><input type="date" aria-label="计划结束日期" value={draft.plannedEndOverride} onChange={(event) => { setScheduleError(null); setDraft((current) => ({ ...current, plannedEndOverride: event.target.value })) }} /></label></div><small className="drawer-field-hint">填写后按指定日期排期；留空则按前置依赖自动计算。保存后会自动顺延受影响的后置任务。</small>{scheduleError && <small className="form-error">{scheduleError}</small>}</div><label className="drawer-field"><span>具体工作内容</span><textarea rows={4} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="请输入这个节点需要完成的具体工作、范围和协作事项" /></label><label className="drawer-field"><span>闭环条件 / 交付物</span><textarea rows={3} value={draft.closureCriteria} onChange={(event) => setDraft((current) => ({ ...current, closureCriteria: event.target.value }))} placeholder="例如：提交测试报告、3D 模型或审批记录" /></label><button className="button button-primary button-full" type="button" onClick={save} disabled={!draft.name.trim()}>保存草稿</button>{onDelete && <button className="link-button task-delete-button" type="button" onClick={onDelete} disabled={deleting}><Trash2 size={16} />{deleting ? '删除中…' : '删除任务'}</button>}</section>}
         <section className="drawer-section" data-task-section="deliverables">
          <div className="drawer-section-head"><div><h3>{drawerMode === 'view-progress' ? '已提交交付物' : '交付物'}</h3><p>{drawerMode === 'view-progress' ? '仅查看已提交的交付物和版本记录。' : '关联文档或外部链接，保留每次提交的版本记录。'}</p></div><span className="status-badge status-accent">{deliverables.length} 个版本</span></div>
          {deliverables.length > 0 ? <div className="deliverable-list">{deliverables.map((deliverable) => <article className="deliverable-item" key={deliverable.id}><span className="deliverable-icon">{deliverable.kind === 'link' ? <Link2 size={16} /> : <FileText size={16} />}</span><div className="deliverable-copy"><strong>{deliverable.name}</strong><span>{deliverable.version} · {deliverable.uploader} · {formatDeliverableDate(deliverable.createdAt)}</span>{deliverable.url && !deliverable.url.startsWith('dingtalk://') ? <a href={resolveApiUrl(deliverable.url)} target="_blank" rel="noreferrer">打开链接</a> : deliverable.approvalProcessInstanceId && deliverable.approvalFileId ? <a href={resolveApiUrl(`/api/v1/deliverables/${deliverable.id}/download`)} target="_blank" rel="noreferrer">查看 / 下载</a> : <small>{formatFileSize(deliverable.size)} · {deliverable.url?.startsWith('dingtalk://') ? '钉钉资源引用已保存，首次查看时取回文件' : '文件元数据已保存，文件内容待接入存储后上传'}</small>}</div>{canManageDeliverables && <button className="icon-button deliverable-remove" type="button" onClick={() => removeDeliverable(deliverable.id)} aria-label={`删除交付物 ${deliverable.name}`}><Trash2 size={15} /></button>}</article>)}</div> : <p className="drawer-empty-note">尚未关联文档或链接。完成任务时，建议至少保留一条交付记录。</p>}
          {canManageDeliverables && <div className="deliverable-form">
            <label className="drawer-field"><span>关联类型</span><select value={artifactKind} onChange={(event) => selectArtifactKind(event.target.value as WorkflowDeliverable['kind'])}><option value="link">外部链接</option><option value="file">本地文件</option></select></label>
            <label className="drawer-field"><span>文档名称</span><input value={artifactName} onChange={(event) => setArtifactName(event.target.value)} placeholder={artifactKind === 'file' ? '可从文件名自动带入' : '例如：测试报告'} /></label>
            <label className="drawer-field"><span>版本</span><input value={artifactVersion} onChange={(event) => setArtifactVersion(event.target.value)} placeholder="例如：v1.0" /></label>
            {artifactKind === 'link' ? <label className="drawer-field"><span>文档链接</span><input type="url" value={artifactUrl} onChange={(event) => setArtifactUrl(event.target.value)} placeholder="https://..." /></label> : <label className="drawer-field"><span>选择文件</span><input type="file" aria-label="选择交付物文件" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) return; setArtifactFile(file); setArtifactName((current) => current || file.name); setArtifactError(null) }} /><small className="drawer-field-hint">文件会上传到 Project OS 受控存储，并立即生成可下载记录。</small></label>}
            <details className="deliverable-approval-fields"><summary>关联钉钉审批附件（可选）</summary><label className="drawer-field"><span>审批实例 ID</span><input value={approvalProcessInstanceId} onChange={(event) => setApprovalProcessInstanceId(event.target.value)} placeholder="processInstanceId" /></label><label className="drawer-field"><span>审批模板 Code</span><input value={approvalProcessCode} onChange={(event) => setApprovalProcessCode(event.target.value)} placeholder="approvalCode" /></label><label className="drawer-field"><span>审批附件 ID</span><input value={approvalFileId} onChange={(event) => setApprovalFileId(event.target.value)} placeholder="fileId" /></label><label className="drawer-field"><span>审批空间 ID</span><input value={approvalSpaceId} onChange={(event) => setApprovalSpaceId(event.target.value)} placeholder="spaceId（可选）" /></label><small className="drawer-field-hint">填写后，Agent 可在需要时从钉钉审批附件取回原文件并回传。</small></details>
            {artifactError && <div className="form-error" role="alert">{artifactError}</div>}
            <button className="button button-secondary button-full" type="button" onClick={() => void addDeliverable()} disabled={addingDeliverable}><Upload size={16} />{addingDeliverable ? '上传中…' : '关联并保存'}</button>
          </div>}
        </section>
        {task.taskId && <section className="drawer-section" data-task-section="predecessors">
          <div className="drawer-section-head"><div><h3>前置交付物</h3><p>直接前置任务产出的文件，开工前请先查看；审批中的文件以审批结果为准。</p></div><span className="status-badge status-accent">{predecessorDeliverables ? `${predecessorDeliverables.length} 个文件` : '…'}</span></div>
          {predecessorDeliverables === null ? <p className="drawer-empty-note">正在加载前置交付物…</p> : predecessorDeliverables.length === 0 ? <p className="drawer-empty-note">直接前置任务尚未提交交付物。</p> : <div className="deliverable-list">{predecessorDeliverables.map((item) => <article className="deliverable-item" key={item.id}><span className="deliverable-icon"><FileText size={16} /></span><div className="deliverable-copy"><strong>{item.name}</strong><span>{item.predecessorWbs} {item.predecessorName} · {item.versionLabel} · {item.uploaderName ?? '未知用户'} · {formatDeliverableDate(item.createdAt)}</span>{item.approvalPending && <small className="text-warning">该交付物仍在校验审批中</small>}{item.objectKey || (item.url && /^https?:/u.test(item.url)) ? <a href={item.objectKey ? resolveApiUrl(`/api/v1/deliverables/${item.id}/download`) : item.url!} target="_blank" rel="noreferrer">查看 / 下载</a> : <small>文件暂无可在线查看的存储副本</small>}</div></article>)}</div>}
        </section>}
        <section className="drawer-section" data-task-section="completion"><h3>完成情况</h3><ProgressBar value={task.progress} label={`${task.progress}%`} />{final && <div className="completion-summary"><strong>{task.status}</strong><span>实际完成：{task.actualEnd ?? '—'}</span>{task.completionNote && <p>{task.completionNote}</p>}{task.overdueReason && <p>超期原因：{task.overdueReason}</p>}</div>}</section>
        <section className="drawer-section" data-task-section="closure"><h3>{drawerMode === 'view' ? '需要交付的内容' : '闭环提交'}</h3><p className="drawer-closure-criteria">{drawerMode === 'view' ? (task.closureCriteria ?? '尚未设置需要交付的内容。') : `完成标准：${task.closureCriteria ?? '尚未设置闭环条件。'}`}</p>{drawerMode !== 'view' && canSubmitApproval && workflowStatus === 'published' && task.taskId && !final && <p className="drawer-field-hint">交付物可选；如有文件可先关联或提交，再提交 Project OS OA 审批。管理员会在“管理 → OA审批”处理，审批通过后系统自动完成本任务并解锁下游。</p>}{drawerMode !== 'view' && canSubmitApproval && workflowStatus !== 'published' && !final && <p className="drawer-field-hint">发布流程后才能提交 OA 审批。</p>}</section>
        {(canRequestSpecialRelease || drawerMode === 'special-release') && <section className="drawer-section" data-task-section="special-release">
          <div className="drawer-section-head"><div><h3>特殊放行</h3><p>前置任务尚未完成时，可申请 L2/管理员审批后先启动当前任务。</p></div><span className="status-badge status-warning">需审批</span></div>
          {canRequestSpecialRelease ? <><label className="drawer-field"><span>放行原因（必填）</span><textarea rows={3} aria-label="特殊放行原因" value={specialReleaseReason} onChange={(event) => { setSpecialReleaseReason(event.target.value); setSpecialReleaseError(null) }} placeholder="说明为什么需要跨节点推进、前置任务如何补做" /></label>
          <button className="button button-primary button-full" type="button" disabled={specialReleaseSubmitting || !specialReleaseReason.trim()} onClick={() => void submitSpecialReleaseRequest()}>{specialReleaseSubmitting ? '正在提交…' : '提交特殊放行审批'}</button>
          {specialReleaseError && <div className="form-error" role="alert">{specialReleaseError}</div>}</> : <p className="drawer-empty-note">当前任务暂不满足特殊放行条件，可能是前置任务已完成、已有审批进行中或任务已完成。</p>}
          <small className="drawer-field-hint">审批通过后当前任务进入进行中；前置任务保持原状态，特殊放行不等于任务完成。</small>
        </section>}
        {canSubmitApproval && task.taskId && (workflowStatus === 'published' || drawerMode === 'approval-history') && <section className="drawer-section" data-task-section="approval">
          <div className="drawer-section-head"><div><h3>{drawerMode === 'approval-history' ? 'OA 审批记录' : 'Project OS OA 审批'}</h3><p>{drawerMode === 'approval-history' ? '查看阶段交付、最终交付和特殊放行的审批结果。' : '提交当前交付物包，管理员在“管理 → OA审批”直接处理。'}</p></div><span className="status-badge status-accent">{dingApprovals.length > 0 ? `${dingApprovals.length} 次提交` : '未提交'}</span></div>
          {drawerMode === 'submit-approval' && <div className="drawer-empty-note">{deliverables.length > 0 ? `本次可提交 ${deliverables.length} 个交付物：${deliverables.map((deliverable) => deliverable.name).join('、')}` : '本次未关联交付物，也可以直接提交 OA 审批。'}</div>}
          {dingApprovals.length > 0 && <div className="approval-record-list">{dingApprovals.map((approval) => <article className="approval-record" key={approval.id}><StatusBadge tone={approval.status === 'PENDING' ? 'accent' : approval.status === 'APPROVED' ? 'success' : approval.status === 'REJECTED' ? 'danger' : 'neutral'}>{approvalStatusLabel[approval.status]}</StatusBadge><div className="approval-record-copy"><strong>{approval.source === 'PROJECT_OS' ? 'Project OS OA' : '钉钉 OA'} · {approval.approvalFileName ?? '任务交付物'} · {approval.purpose === 'BYPASS' ? '特殊放行' : approval.deliveryType === 'STAGE' ? '阶段交付' : '最终交付'}</strong><span>{approval.submitterName ?? '未知用户'} · 提交 {formatDeliverableDate(approval.createdAt)}{approval.completedAt ? ` · 审批完成 ${formatDeliverableDate(approval.completedAt)}` : ''}</span>{approval.status === 'APPROVED' && approval.autoCompleteStatus === 'COMPLETED' && <small>交付物已入库，任务已自动完成并解锁下游</small>}{approval.status === 'APPROVED' && approval.autoCompleteStatus === 'STAGE_RECORDED' && <small>阶段交付已同步，任务仍在进行中</small>}{approval.status === 'APPROVED' && approval.autoCompleteStatus === 'SPECIAL_RELEASED' && <small>特殊放行已通过，任务已启动；前置任务待补做</small>}{approval.status === 'APPROVED' && (approval.autoCompleteStatus === 'FAILED' || approval.autoCompleteStatus === 'SPECIAL_RELEASE_FAILED') && <small className="form-error">审批后的自动处理未执行：{approval.error ?? '校验未通过'}</small>}</div>{approval.status === 'PENDING' && approval.source !== 'PROJECT_OS' && <button className="link-button" type="button" disabled={dingSubmitting} onClick={() => void refreshDingApproval(approval.id)}>同步钉钉状态</button>}{approval.status === 'PENDING' && approval.source === 'PROJECT_OS' && <small className="drawer-field-hint">等待 L1/L2 在管理 → OA审批处理</small>}</article>)}</div>}
          {drawerMode !== 'approval-history' && canSubmitApproval && !pendingDingApproval && <div className="deliverable-form"><label className="drawer-field"><span>交付类型</span><select aria-label="交付类型" value={dingDeliveryType} onChange={(event) => { const next = event.target.value as 'STAGE' | 'FINAL'; setDingDeliveryType(next); setDingProgress(next === 'FINAL' ? '100' : String(task.progress)); setDingError(null) }}><option value="STAGE">阶段交付（可多次提交）</option><option value="FINAL">最终交付（审批通过后完成任务）</option></select><small className="drawer-field-hint">阶段交付审批通过后任务仍在进行中；最终交付审批通过后任务完成。</small></label><label className="drawer-field"><span>本次进度（%）</span><input type="number" min="0" max="100" step="1" value={dingProgress} onChange={(event) => { setDingProgress(event.target.value); setDingError(null) }} aria-label="本次进度" /></label>{taskDueUnfinished && <label className="drawer-field"><span>超期原因（必填）</span><textarea rows={3} aria-label="超期原因" value={dingOverdueReason} onChange={(event) => { setDingOverdueReason(event.target.value); setDingError(null) }} placeholder="请输入超期原因" /></label>}<label className="drawer-field"><span>交付说明</span><textarea rows={2} aria-label="交付说明" value={dingApprovalNote} onChange={(event) => setDingApprovalNote(event.target.value)} placeholder="说明本次交付内容，将随审批提交给审批人" /></label><button className="button button-primary button-full" type="button" disabled={dingSubmitting || (taskDueUnfinished && !dingOverdueReason.trim())} onClick={() => void submitDingApproval()}>{dingSubmitting ? '正在提交…' : '提交 OA 审批'}</button><small className="drawer-field-hint">提交后，L1/L2 可在“管理 → OA审批”处理；本入口不调用钉钉审批接口。</small></div>}
          {pendingDingApproval && <p className="drawer-field-hint">{pendingSpecialRelease ? '特殊放行审批进行中；通过后任务会开始，前置任务仍需补做。' : pendingDingApproval.deliveryType === 'STAGE' ? '阶段交付审批进行中；通过后会同步进度，任务仍在进行中。' : '最终交付审批进行中；通过后任务自动完成并解锁下游。'}</p>}
          {dingError && <div className="form-error" role="alert">{dingError}</div>}
        </section>}
        {!canSubmitApproval && <section className="drawer-section" data-task-section="approval"><h3>OA 审批记录</h3><div className="approval-record-list">{dingApprovals.map((approval) => <article className="approval-record" key={approval.id}><StatusBadge tone={approval.status === 'PENDING' ? 'accent' : approval.status === 'APPROVED' ? 'success' : approval.status === 'REJECTED' ? 'danger' : 'neutral'}>{approvalStatusLabel[approval.status]}</StatusBadge><div className="approval-record-copy"><strong>{approval.source === 'PROJECT_OS' ? 'Project OS OA' : '钉钉 OA'} · {approval.approvalFileName ?? '任务交付物'} · {approval.purpose === 'BYPASS' ? '特殊放行' : approval.deliveryType === 'STAGE' ? '阶段交付' : '最终交付'}</strong><span>{approval.submitterName ?? '未知用户'} · 提交 {formatDeliverableDate(approval.createdAt)}{approval.completedAt ? ` · 审批完成 ${formatDeliverableDate(approval.completedAt)}` : ''}</span>{approval.status === 'APPROVED' && approval.autoCompleteStatus === 'SPECIAL_RELEASED' && <small>特殊放行已通过，任务已启动；前置任务待补做</small>}</div></article>)}</div></section>}
        <section className="drawer-section" data-task-section="current-work"><h3>{drawerMode === 'view' ? '任务详情' : '当前工作内容'}</h3><p>{task.description ?? '尚未填写具体工作内容。'}</p></section>
        <section className="drawer-agent" data-task-section="agent"><Bot size={18} /><div><strong>Agent 建议</strong><p>该任务已连续两天低于计划进度。建议将异常数据回放拆分为独立子任务。</p><button className="link-button" type="button">应用建议</button></div></section>
      </div>
      <footer><button className="button button-secondary" type="button" onClick={onClose}><ChevronLeft size={16} />{isFunctionPage ? '返回项目工作区' : '关闭编辑'}</button></footer>
    </aside>
  )
}

function nextDeliverableVersion(deliverables: WorkflowDeliverable[] | undefined) {
  return `v${(deliverables?.length ?? 0) + 1}.0`
}

const approvalStatusLabel: Record<TaskApprovalView['status'], string> = { PENDING: '审批中', APPROVED: '已通过', REJECTED: '已拒绝', TERMINATED: '已终止' }

function formatDeliverableDate(value: string) {
  if (!value) return '未知时间'
  const [date, time] = value.split('T')
  return time ? `${date} ${time.slice(0, 5)}` : date
}

function formatFileSize(value: number | undefined) {
  if (!value) return '文件'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function ResetLayoutDialog({ onClose, onSaveDraft, onReset }: { onClose: () => void; onSaveDraft: () => void; onReset: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="reset-layout-title">
        <header className="modal-header"><div><p className="page-context">项目流程图</p><h2 id="reset-layout-title">重置排版</h2><p>将恢复上次保存的草稿布局。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭重置排版"><X size={19} /></button></header>
        <div className="modal-body">
          <div className="form-note"><strong>是否保存当前草稿？</strong><p>重置只会恢复节点位置，不会修改任务名称、负责人、工期、日期或连线内容。</p></div>
          <p className="form-note">选择“保存当前草稿”会保留当前布局并取消本次重置；选择“不保存并重置”会放弃当前未保存的布局修改。</p>
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button><button className="button button-secondary" type="button" onClick={onSaveDraft}>保存当前草稿</button><button className="button button-danger" type="button" onClick={onReset}>不保存并重置</button></footer>
      </section>
    </div>
  )
}

function WorkCalendarDialog({ calendar, onClose, onSave }: { calendar: WorkCalendarConfig; onClose: () => void; onSave: (calendar: WorkCalendarConfig) => void }) {
  const [draft, setDraft] = useState(() => ({ ...calendar, holidaysText: calendar.holidays.join('\n'), customRestDaysText: calendar.customRestDays.join('\n'), makeupWorkdaysText: calendar.makeupWorkdays.join('\n') }))
  const [error, setError] = useState<string | null>(null)
  const weekLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  const toggleWorkday = (day: number) => setDraft((current) => ({ ...current, weeklyWorkdays: current.weeklyWorkdays.includes(day) ? current.weeklyWorkdays.filter((value) => value !== day) : [...current.weeklyWorkdays, day].sort((first, second) => first - second) }))
  const save = () => {
    if (draft.mode === 'working' && draft.weeklyWorkdays.length === 0) {
      setError('工作日历至少需要配置一个每周工作日')
      return
    }
    const fields = [
      ['法定节假日', draft.holidaysText],
      ['公司自定义休息日', draft.customRestDaysText],
      ['调休工作日', draft.makeupWorkdaysText],
    ] as const
    for (const [label, value] of fields) {
      const invalid = parseDateList(value).find((date) => !isValidIsoDate(date))
      if (invalid) {
        setError(`${label}中的日期“${invalid}”格式不正确，请使用 YYYY-MM-DD`)
        return
      }
    }
    onSave(normalizeWorkCalendar({
      mode: draft.mode,
      name: draft.name,
      weeklyWorkdays: draft.weeklyWorkdays,
      holidays: parseDateList(draft.holidaysText),
      customRestDays: parseDateList(draft.customRestDaysText),
      makeupWorkdays: parseDateList(draft.makeupWorkdaysText),
    }))
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal-card calendar-modal-card" role="dialog" aria-modal="true" aria-labelledby="work-calendar-title">
        <header className="modal-header"><div><p className="page-context">项目排期</p><h2 id="work-calendar-title">工作日历配置</h2><p>保存后会重新计算所有任务日期，并在流程图中展示受影响范围。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭工作日历配置"><X size={19} /></button></header>
        <div className="modal-body">
          <div className="form-grid"><label className="form-field"><span>计算方式</span><select value={draft.mode} onChange={(event) => setDraft((current) => ({ ...current, mode: event.target.value as WorkCalendarConfig['mode'] }))}><option value="natural">自然日</option><option value="working">工作日历</option></select></label><label className="form-field"><span>日历名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：研发中心标准工作日历" /></label></div>
          <div className="calendar-mode-note">{draft.mode === 'working' ? '系统会跳过周末、法定节假日和公司自定义休息日；调休工作日会优先计入。' : '当前项目保持自然日计算，不会跳过周末。可随时切换到工作日历。'}</div>
          <fieldset className="calendar-weekdays"><legend>每周工作日</legend><div className="calendar-weekday-grid">{weekLabels.map((label, day) => <label className={`calendar-day-toggle ${draft.weeklyWorkdays.includes(day) ? 'is-selected' : ''}`} key={label}><input type="checkbox" checked={draft.weeklyWorkdays.includes(day)} onChange={() => toggleWorkday(day)} /><span>{label}</span></label>)}</div></fieldset>
          <label className="form-field"><span>法定节假日（每行一个日期）</span><textarea rows={3} value={draft.holidaysText} onChange={(event) => setDraft((current) => ({ ...current, holidaysText: event.target.value }))} placeholder="例如：2026-10-01\n2026-10-02" /></label>
          <label className="form-field"><span>公司自定义休息日（每行一个日期）</span><textarea rows={3} value={draft.customRestDaysText} onChange={(event) => setDraft((current) => ({ ...current, customRestDaysText: event.target.value }))} placeholder="例如：2026-09-30" /></label>
          <label className="form-field"><span>调休工作日（每行一个日期）</span><textarea rows={3} value={draft.makeupWorkdaysText} onChange={(event) => setDraft((current) => ({ ...current, makeupWorkdaysText: event.target.value }))} placeholder="例如：2026-10-10" /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="button" onClick={save}>保存日历并重算</button></footer>
      </section>
    </div>
  )
}

function WorkflowAuditDialog({ project, logs, loading, error, onClose, onRefresh }: { project: Project; logs: WorkflowAuditLog[]; loading: boolean; error: string | null; onClose: () => void; onRefresh: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !loading) onClose() }}>
      <section className="modal-card audit-modal-card" role="dialog" aria-modal="true" aria-labelledby="workflow-audit-title">
        <header className="modal-header"><div><p className="page-context">流程记录</p><h2 id="workflow-audit-title">流程改动日志</h2><p>{project.code} · {project.name}，仅记录流程内容、依赖和排期变更。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭流程改动日志"><X size={19} /></button></header>
        <div className="modal-body audit-modal-body">
          {error && <div className="form-error" role="alert">{error}</div>}
          {loading && logs.length === 0 ? <p className="form-note">正在读取流程日志…</p> : logs.length === 0 ? <div className="audit-empty"><History size={28} /><strong>暂无流程改动记录</strong><p>流程发生内容、依赖或排期变更后，新的记录会显示在这里。</p></div> : <div className="audit-list">{logs.map((log) => <article className="audit-entry" key={log.id}><div className="audit-entry-icon"><History size={17} /></div><div className="audit-entry-content"><div className="audit-entry-heading"><div><strong>{log.summary.headline}</strong><span>{log.actorName} · {formatAuditDate(log.createdAt)}</span></div><StatusBadge tone={log.action === 'WORKFLOW_PUBLISHED' ? 'success' : 'accent'}>{log.action === 'WORKFLOW_PUBLISHED' ? '已发布' : '已保存'}</StatusBadge></div><div className="audit-change-counts">{log.summary.nodeAddedCount > 0 && <span>新增节点 {log.summary.nodeAddedCount}</span>}{log.summary.nodeRemovedCount > 0 && <span>移除节点 {log.summary.nodeRemovedCount}</span>}{log.summary.nodeUpdatedCount > 0 && <span>修改节点 {log.summary.nodeUpdatedCount}</span>}{log.summary.layoutChangedCount > 0 && <span>布局调整 {log.summary.layoutChangedCount}</span>}{log.summary.dependencyAddedCount + log.summary.dependencyRemovedCount > 0 && <span>依赖变化 {log.summary.dependencyAddedCount + log.summary.dependencyRemovedCount}</span>}{log.summary.scheduleChangedCount > 0 && <span>排期调整 {log.summary.scheduleChangedCount}</span>}</div><ul className="audit-entry-details">{log.summary.details.map((detail, index) => <li key={`${log.id}-${index}`}>{detail}</li>)}</ul></div></article>)}</div>}
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onRefresh} disabled={loading}><History size={16} />{loading ? '读取中…' : '刷新日志'}</button><button className="button button-primary" type="button" onClick={onClose}>关闭</button></footer>
      </section>
    </div>
  )
}

function formatAuditDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function WorkflowTemplateSaveDialog({ project, workflow, loading, error, onClose, onSave }: { project: Project; workflow: Workflow; loading: boolean; error: string | null; onClose: () => void; onSave: (input: { name: string; description: string }) => Promise<void> }) {
  const [name, setName] = useState(`${project.name}流程模板`)
  const [description, setDescription] = useState('')
  const taskCount = workflow.nodes.filter((node) => node.type === 'task' || node.type === 'milestone').length
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) return
    try { await onSave({ name: name.trim(), description: description.trim() }) } catch {
      // The parent presents the API error in the dialog.
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !loading) onClose() }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="save-workflow-template-title">
        <header className="modal-header"><div><p className="page-context">流程图模板</p><h2 id="save-workflow-template-title">加入模板</h2><p>保存当前流程结构，供组织内其他项目复用。负责人和执行状态不会带入模板。</p></div><button className="icon-button" type="button" onClick={onClose} disabled={loading} aria-label="关闭加入模板"><X size={19} /></button></header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-body">
            <label className="form-field"><span>模板名称 <em>*</em></span><input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：标准研发流程" /></label>
            <label className="form-field"><span>模板说明</span><textarea rows={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明适用场景、关键节点或使用要求" /></label>
            <div className="form-note">将保存 {taskCount} 个任务节点和 {workflow.edges.length} 条依赖连线。使用模板后会生成新的草稿节点，不会修改原项目。</div>
            {error && <div className="form-error" role="alert">{error}</div>}
          </div>
          <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={loading}>取消</button><button className="button button-primary" type="submit" disabled={loading || !name.trim()}>{loading ? '保存中…' : '保存到模板库'}</button></footer>
        </form>
      </section>
    </div>
  )
}

function WorkflowTemplatePicker({ templates, loading, error, onClose, onUse }: { templates: WorkflowTemplateSummary[]; loading: boolean; error: string | null; onClose: () => void; onUse: (template: WorkflowTemplateSummary) => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !loading) onClose() }}>
      <section className="modal-card template-picker-card" role="dialog" aria-modal="true" aria-labelledby="use-workflow-template-title">
        <header className="modal-header"><div><p className="page-context">流程图模板</p><h2 id="use-workflow-template-title">使用模板</h2><p>选择模板载入当前项目草稿，节点编号会自动重新生成。</p></div><button className="icon-button" type="button" onClick={onClose} disabled={loading} aria-label="关闭使用模板"><X size={19} /></button></header>
        <div className="modal-body">
          {error && <div className="form-error" role="alert">{error}</div>}
          {loading && templates.length === 0 ? <p className="form-note">正在读取模板…</p> : templates.length === 0 ? <p className="form-note">还没有可用模板，请先由 L1/L2 在当前流程图点击“加入模板”。</p> : <div className="template-list">{templates.map((template) => <div className="template-row" key={template.id}><div className="template-row-main"><strong>{template.name}</strong>{template.description && <p>{template.description}</p>}<small>{template.nodeCount} 个任务 · {template.edgeCount} 条连线 · 更新于 {template.updatedAt.slice(0, 10)}</small></div><button className="button button-primary button-compact" type="button" onClick={() => onUse(template)} disabled={loading}>载入</button></div>)}</div>}
          <p className="form-note">载入模板会替换当前画布中的流程草稿；载入后请检查负责人、日期和依赖，再保存草稿。</p>
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={loading}>关闭</button></footer>
      </section>
    </div>
  )
}

function parseDateList(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/).map((date) => date.trim()).filter(Boolean))]
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function taskStatusView(task: Pick<Task, 'status' | 'blockedBy'>) {
  if ((task.blockedBy?.length ?? 0) > 0 && !isCompletionStatus(task.status)) return { label: '受阻', tone: 'danger' as const }
  if (task.status === '未开始') return { label: '可开始', tone: 'accent' as const }
  if (task.status === '进行中') return { label: '进行中', tone: 'accent' as const }
  if (isCompletionStatus(task.status)) return completionStatusView(task.status)
  return { label: task.status, tone: 'neutral' as const }
}
