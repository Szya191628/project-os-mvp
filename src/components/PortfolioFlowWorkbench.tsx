import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronsUpDown, CircleCheck, FileStack, FolderPlus, GitBranch, History, Maximize2, Minimize2, MoreHorizontal, Plus, Settings2, Trash2, X } from 'lucide-react'
import { pinyin } from 'pinyin-pro'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { fetchDirectoryMembers, fetchPortfolioWorkflow, fetchWorkflow, savePortfolioWorkflow } from '../api'
import { createNaturalWorkCalendar } from '../data'
import type { PortfolioFlowEdge, PortfolioFlowField, PortfolioFlowNode, PortfolioWorkflow, PortfolioWorkflowAuditLog, PortfolioWorkflowTemplate, Project, ProjectMemberOption, ProjectPortfolio, Workflow, WorkflowNode, WorkCalendarConfig } from '../types'
import { getFlowCanvasMetrics, getFlowCanvasPanScroll } from '../workflow/canvas'
import { alignSerialNodes } from '../workflow/layout'
import { LatestSaveQueue } from '../workflow/persistence'

const NODE_WIDTH = 184
const NODE_HEIGHT = 112
const COLUMN_GAP = 72
const ROW_GAP = 28
const DEFAULT_PORTFOLIO_FIELDS: PortfolioFlowField[] = ['owner', 'status', 'progress', 'date', 'duration']
const PORTFOLIO_CANVAS_GROWTH_STEP = 1200
const PORTFOLIO_CANVAS_AUTO_PAN_STEP = 24
const PORTFOLIO_CANVAS_AUTO_PAN_ZONE = 96

type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error'
type PortfolioTaskOption = { taskId: string; projectId: string; projectCode: string; projectName: string; wbs: string; name: string; owner: string; assigneeIds: string[]; assigneeNames: string[]; status: string; progress: number; plannedStart?: string; plannedEnd?: string; duration: number; effort: number; description?: string; closureCriteria?: string }
type PortfolioTaskPatch = Partial<Pick<PortfolioFlowNode, 'projectId' | 'taskId' | 'name' | 'owner' | 'assigneeIds' | 'assigneeNames' | 'plannedStart' | 'plannedEnd' | 'duration' | 'effort' | 'description' | 'closureCriteria'>>

export function PortfolioFlowWorkbench({ portfolio, projects, canEdit, onOpenProject, onHoverProject, onImportProject, onCreateProject }: { portfolio: ProjectPortfolio; projects: Project[]; canEdit: boolean; onOpenProject: (projectId: string, taskId?: string) => void; onHoverProject?: (projectId: string | null) => void; onImportProject?: (projectId: string) => Promise<void>; onCreateProject?: (portfolioId: string) => void }) {
  const [workflow, setWorkflow] = useState<PortfolioWorkflow | null>(null)
  const workflowRef = useRef<PortfolioWorkflow | null>(null)
  const savedWorkflowRef = useRef<PortfolioWorkflow | null>(null)
  const saveQueueRef = useRef<LatestSaveQueue<PortfolioWorkflow> | null>(null)
  const mountedRef = useRef(true)
  const [history, setHistory] = useState<PortfolioWorkflow[]>([])
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [layoutMessage, setLayoutMessage] = useState<string | null>(null)
  const [members, setMembers] = useState<ProjectMemberOption[]>([])
  const [taskOptions, setTaskOptions] = useState<PortfolioTaskOption[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [taskPageNodeId, setTaskPageNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgeMode, setEdgeMode] = useState(false)
  const [edgeSourceId, setEdgeSourceId] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importQuery, setImportQuery] = useState('')
  const [importingProjectId, setImportingProjectId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [templateDialog, setTemplateDialog] = useState<'save' | 'use' | null>(null)
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false)
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false)
  const [auditDialogOpen, setAuditDialogOpen] = useState(false)
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false)
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null)
  const [dragNodeId, setDragNodeId] = useState<string | null>(null)
  const [dragPosition, setDragPosition] = useState<PortfolioFlowNode['position'] | null>(null)
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number; position: PortfolioFlowNode['position'] } | null>(null)
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const canvasExpansionRef = useRef({ width: 0, height: 0, left: 0, top: 0 })
  const canvasOriginRef = useRef({ x: 0, y: 0 })
  const canvasGrowthPendingRef = useRef({ width: false, height: false, left: false, top: false })
  const [canvasExpansion, setCanvasExpansion] = useState({ width: 0, height: 0, left: 0, top: 0 })

  const enqueueSave = useCallback((snapshot: PortfolioWorkflow, immediate = false) => {
    const queue = saveQueueRef.current ?? new LatestSaveQueue<PortfolioWorkflow>(async (latest) => {
      try {
        const result = await savePortfolioWorkflow(latest)
        if (!mountedRef.current || workflowRef.current !== latest) return
        const saved = { ...latest, version: result.version, status: result.status ?? latest.status ?? 'draft', publishedLayout: result.publishedLayout ?? latest.publishedLayout, auditLogs: result.auditLogs ?? latest.auditLogs }
        workflowRef.current = saved
        savedWorkflowRef.current = saved
        setWorkflow(saved)
        setDirty(false)
        setSaveState('saved')
        setError(null)
      } catch (reason) {
        if (!mountedRef.current || workflowRef.current !== latest) return
        setSaveState('error')
        setDirty(true)
        setError(reason instanceof Error ? reason.message : '组合流程保存失败')
      }
    }, 450)
    saveQueueRef.current = queue
    queue.enqueue(snapshot, { immediate })
  }, [])

  useEffect(() => {
    let mounted = true
    saveQueueRef.current?.cancel()
    workflowRef.current = null
    const portfolioProjects = projects.filter((project) => portfolio.projectIds.includes(project.id) || project.portfolio?.id === portfolio.id)
    void Promise.all([
      fetchPortfolioWorkflow(portfolio.id),
      Promise.all(portfolioProjects.map(async (project) => {
        try {
          return toPortfolioTaskOptions(project, await fetchWorkflow(project.id))
        } catch {
          return []
        }
      })),
    ]).then(([loaded, optionGroups]) => {
      if (!mounted) return
      const options = optionGroups.flat()
      const optionByTaskId = new Map(options.map((option) => [option.taskId, option]))
      const normalized = withPortfolioWorkflowDefaults({ ...loaded, nodes: loaded.nodes.map((node) => node.type === 'task' && node.taskId && optionByTaskId.has(node.taskId) ? hydratePortfolioTask(node, optionByTaskId.get(node.taskId) as PortfolioTaskOption) : node) })
      workflowRef.current = normalized
      savedWorkflowRef.current = normalized
      setTaskOptions(options)
      setWorkflow(normalized)
      setHistory([])
      setSaveState('saved')
    }).catch((reason) => {
      if (!mounted) return
      setError(reason instanceof Error ? reason.message : '组合流程读取失败')
      setSaveState('error')
    })
    return () => { mounted = false }
  }, [portfolio.id, portfolio.projectIds, projects])

  useEffect(() => () => {
    mountedRef.current = false
    saveQueueRef.current?.cancel()
    workflowRef.current = null
  }, [])

  useEffect(() => {
    workflowRef.current = workflow
  }, [workflow])

  useEffect(() => {
    if (!canEdit) return
    let mounted = true
    void fetchDirectoryMembers().then((result) => {
      if (!mounted) return
      setMembers(result.members.filter((member) => member.status === 'ACTIVE' && !member.leftAt).map(({ id, name }) => ({ id, name })))
    }).catch(() => {
      if (mounted) setMembers([])
    })
    return () => { mounted = false }
  }, [canEdit])

  useEffect(() => {
    if (!canEdit || !dirty || !workflow) return
    const snapshot = workflowRef.current
    if (snapshot) enqueueSave(snapshot)
  }, [canEdit, dirty, enqueueSave, workflow])

  useEffect(() => {
    if (!toolbarMenuOpen) return
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (!toolbarMenuRef.current?.contains(event.target as Node)) setToolbarMenuOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [toolbarMenuOpen])

  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId) ?? null
  const taskPageNode = workflow?.nodes.find((node) => node.id === taskPageNodeId && node.type === 'task') ?? null
  const inspectorNode = selectedNode?.type === 'task' ? null : selectedNode
  const selectedEdge = workflow?.edges.find((edge) => edge.id === selectedEdgeId) ?? null
  const canvasLayout = useMemo(() => getFlowCanvasMetrics(workflow?.nodes ?? [], NODE_WIDTH, NODE_HEIGHT, canvasExpansion), [canvasExpansion, workflow?.nodes])
  const canvasSize = { width: canvasLayout.width, height: canvasLayout.height }
  const canvasOrigin = canvasLayout.origin
  const canvasOriginX = canvasOrigin.x
  const canvasOriginY = canvasOrigin.y
  useLayoutEffect(() => {
    const previousOrigin = canvasOriginRef.current
    const deltaX = canvasOriginX - previousOrigin.x
    const deltaY = canvasOriginY - previousOrigin.y
    const canvas = canvasRef.current
    if (canvas && (deltaX !== 0 || deltaY !== 0)) {
      canvas.scrollLeft = Math.max(0, canvas.scrollLeft + deltaX)
      canvas.scrollTop = Math.max(0, canvas.scrollTop + deltaY)
    }
    canvasOriginRef.current = { x: canvasOriginX, y: canvasOriginY }
  }, [canvasOriginX, canvasOriginY])
  const importableProjects = useMemo(() => {
    const query = importQuery.trim().toLowerCase()
    return projects.filter((project) => project.portfolio?.id !== portfolio.id).filter((project) => !query || `${project.name} ${project.code} ${project.department} ${project.portfolio?.name ?? '未分组项目'}`.toLowerCase().includes(query))
  }, [importQuery, portfolio.id, projects])
  const visibleFields = new Set(workflow?.visibleFields ?? DEFAULT_PORTFOLIO_FIELDS)
  const portfolioTasks = workflow?.nodes.filter((node) => node.type === 'task') ?? []
  const canPublish = portfolioTasks.length > 0 && portfolioTasks.every((node) => Boolean(node.projectId && node.taskId))

  const updateWorkflow = (next: PortfolioWorkflow, options: { trackHistory?: boolean } = {}) => {
    const previous = workflowRef.current
    if (options.trackHistory !== false && previous) setHistory((current) => [...current.slice(-9), previous])
    const draft = { ...withPortfolioWorkflowDefaults(next), status: 'draft' as const }
    workflowRef.current = draft
    setWorkflow(draft)
    setDirty(true)
    setSaveState('saving')
    setLayoutMessage(null)
  }

  const openImportDialog = () => {
    setImportQuery('')
    setImportError(null)
    setImportDialogOpen(true)
  }

  const importProject = async (projectId: string) => {
    if (!onImportProject || importingProjectId) return
    setImportingProjectId(projectId)
    setImportError(null)
    try {
      await onImportProject(projectId)
      setImportDialogOpen(false)
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : '导入项目失败')
    } finally {
      setImportingProjectId(null)
    }
  }

  const addEdgeBetween = (sourceId: string, targetId: string) => {
    if (!canEdit || !workflow || sourceId === targetId) {
      setError('连线起点和终点不能是同一个节点')
      return
    }
    if (workflow.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) {
      setError('这两个节点之间已经存在连线')
      return
    }
    if (hasPath(workflow.nodes, workflow.edges, targetId, sourceId)) {
      setError('不能创建循环依赖')
      return
    }
    const nextEdge: PortfolioFlowEdge = { id: nextAvailableId('edge', workflow.edges.map((edge) => edge.id)), source: sourceId, target: targetId, type: 'FS', lagDays: 0 }
    updateWorkflow({ ...workflow, edges: [...workflow.edges, nextEdge] })
    setSelectedEdgeId(nextEdge.id)
    setSelectedNodeId(null)
    setEdgeMode(false)
    setEdgeSourceId(null)
    setError(null)
  }

  const selectNode = (node: PortfolioFlowNode) => {
    if (edgeMode) {
      if (!edgeSourceId) {
        setEdgeSourceId(node.id)
        setSelectedNodeId(node.id)
        setSelectedEdgeId(null)
        return
      }
      if (edgeSourceId === node.id) {
        setError('连线起点和终点不能是同一个节点')
        return
      }
      addEdgeBetween(edgeSourceId, node.id)
      return
    }
    if (node.type === 'task') {
      setSelectedNodeId(node.id)
      setTaskPageNodeId(node.id)
      setSelectedEdgeId(null)
      setError(null)
      return
    }
    setSelectedNodeId(node.id)
    setSelectedEdgeId(null)
    setError(null)
  }

  const insertTaskOnEdge = (edge: PortfolioFlowEdge) => {
    if (!canEdit || !workflow) return
    const sourceNode = workflow.nodes.find((node) => node.id === edge.source)
    const targetNode = workflow.nodes.find((node) => node.id === edge.target)
    if (!sourceNode || !targetNode) return
    const taskNumber = workflow.nodes.filter((node) => node.type === 'task').length + 1
    const task: PortfolioFlowNode = { id: nextAvailableId('task', workflow.nodes.map((item) => item.id)), type: 'task', wbs: `T${taskNumber}`, name: '待填写任务', owner: '待分配', assigneeIds: [], assigneeNames: [], status: '未开始', progress: 0, duration: 1, effort: 0, description: '', closureCriteria: '', position: midpoint(sourceNode.position, targetNode.position) }
    updateWorkflow({ ...workflow, nodes: [...workflow.nodes, task], edges: [...workflow.edges.filter((candidate) => candidate.id !== edge.id), { ...edge, target: task.id }, { ...edge, id: `${task.id}-${targetNode.id}-inserted`, source: task.id, target: targetNode.id }] })
    setSelectedNodeId(task.id)
    setTaskPageNodeId(task.id)
    setSelectedEdgeId(null)
    setError(null)
  }

  const addTask = () => {
    if (!canEdit || !workflow) return
    const selectedWorkflowEdge = workflow.edges.find((edge) => edge.id === selectedEdgeId)
    if (selectedWorkflowEdge) {
      insertTaskOnEdge(selectedWorkflowEdge)
      return
    }
    const taskNumber = workflow.nodes.filter((node) => node.type === 'task').length + 1
    const node: PortfolioFlowNode = {
      id: nextAvailableId('task', workflow.nodes.map((item) => item.id)),
      type: 'task',
      wbs: `T${taskNumber}`,
      name: '待填写任务',
      owner: '待分配',
      assigneeIds: [],
      assigneeNames: [],
      status: '未开始',
      progress: 0,
      duration: 1,
      effort: 0,
      description: '',
      closureCriteria: '',
      position: findEmptyPosition(workflow.nodes),
    }
    updateWorkflow({ ...workflow, nodes: [...workflow.nodes, node] })
    setSelectedNodeId(node.id)
    setTaskPageNodeId(node.id)
    setSelectedEdgeId(null)
    setError(null)
  }

  const addParallelTask = () => {
    if (!canEdit || !workflow || !selectedEdge) return
    const sourceNode = workflow.nodes.find((node) => node.id === selectedEdge.source)
    const targetNode = workflow.nodes.find((node) => node.id === selectedEdge.target)
    if (!sourceNode || !targetNode) return
    const taskNumber = workflow.nodes.filter((node) => node.type === 'task').length + 1
    const task: PortfolioFlowNode = { id: nextAvailableId('task', workflow.nodes.map((item) => item.id)), type: 'task', wbs: `T${taskNumber}`, name: '并行任务', owner: '待分配', assigneeIds: [], assigneeNames: [], status: '未开始', progress: 0, duration: 1, effort: 0, description: '', closureCriteria: '', position: parallelPosition(sourceNode.position, targetNode.position) }
    updateWorkflow({ ...workflow, nodes: [...workflow.nodes, task], edges: [...workflow.edges, { id: `${sourceNode.id}-${task.id}-parallel`, source: sourceNode.id, target: task.id, type: 'FS', lagDays: 0 }, { id: `${task.id}-${targetNode.id}-parallel`, source: task.id, target: targetNode.id, type: 'FS', lagDays: selectedEdge.lagDays }] })
    setSelectedNodeId(task.id)
    setTaskPageNodeId(task.id)
    setSelectedEdgeId(null)
    setError(null)
  }

  const deleteSelectedTask = () => {
    if (!canEdit || !workflow || !selectedNode || selectedNode.type !== 'task') return
    if (!window.confirm('删除后不可恢复，确认删除这个组合任务吗？')) return
    const nextNodes = workflow.nodes.filter((node) => node.id !== selectedNode.id)
    updateWorkflow({ ...workflow, nodes: nextNodes, edges: workflow.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id) })
    setSelectedNodeId(null)
    setTaskPageNodeId(null)
    setError(null)
  }

  const updateTask = (patch: PortfolioTaskPatch) => {
    if (!canEdit || !workflow || !selectedNode || selectedNode.type !== 'task') return
    updateWorkflow({ ...workflow, nodes: workflow.nodes.map((node) => node.id === selectedNode.id ? { ...node, ...patch } : node) })
  }

  const deleteSelectedEdge = () => {
    if (!canEdit || !workflow || !selectedEdge) return
    updateWorkflow({ ...workflow, edges: workflow.edges.filter((edge) => edge.id !== selectedEdge.id) })
    setSelectedEdgeId(null)
    setError(null)
  }

  const updateSelectedEdge = (patch: Pick<PortfolioFlowEdge, 'source' | 'target'>) => {
    if (!canEdit || !workflow || !selectedEdge) return
    const source = patch.source || selectedEdge.source
    const target = patch.target || selectedEdge.target
    if (source === target) {
      setError('连线起点和终点不能是同一个节点')
      return
    }
    if (!workflow.nodes.some((node) => node.id === source) || !workflow.nodes.some((node) => node.id === target)) {
      setError('连线节点不存在')
      return
    }
    if (workflow.edges.some((edge) => edge.id !== selectedEdge.id && edge.source === source && edge.target === target)) {
      setError('这两个节点之间已经存在连线')
      return
    }
    const remainingEdges = workflow.edges.filter((edge) => edge.id !== selectedEdge.id)
    if (hasPath(workflow.nodes, remainingEdges, target, source)) {
      setError('不能创建循环依赖')
      return
    }
    updateWorkflow({ ...workflow, edges: workflow.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, source, target } : edge) })
    setError(null)
  }

  const clearCanvas = () => {
    if (!canEdit || !workflow || !window.confirm('清空画布将移除组合任务和全部连线，项目节点会保留。删除后不可恢复，是否继续？')) return
    updateWorkflow({ ...workflow, nodes: workflow.nodes.filter((node) => node.type === 'project'), edges: [] })
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setError(null)
  }

  const undoWorkflow = () => {
    if (!canEdit) return
    const previous = history.at(-1)
    if (!previous) return
    setHistory((current) => current.slice(0, -1))
    updateWorkflow(previous, { trackHistory: false })
    setError(null)
  }

  const rearrangeLayout = () => {
    if (!canEdit || !workflow) return
    const positions = arrangePortfolioNodes(workflow.nodes, workflow.edges)
    const nextNodes = workflow.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }))
    updateWorkflow({ ...workflow, nodes: nextNodes })
    setError(null)
  }

  const alignSerialTasks = () => {
    if (!canEdit || !workflow) return
    const alignment = alignSerialNodes(workflow.nodes, workflow.edges)
    if (alignment.alignedNodeIds.length === 0) {
      setLayoutMessage('当前没有可对齐的串联任务')
      setError(null)
      return
    }
    if (alignment.movedNodeIds.length === 0) {
      setLayoutMessage('串联任务已经在同一水平线上')
      setError(null)
      return
    }
    const nextNodes = workflow.nodes.map((node) => ({ ...node, position: alignment.positions[node.id] ?? node.position }))
    updateWorkflow({ ...workflow, nodes: nextNodes })
    setLayoutMessage(`已将 ${alignment.movedNodeIds.length} 个串联任务对齐到同一水平线，组合草稿会自动保存`)
    setError(null)
  }

  const restorePublishedLayout = () => {
    if (!canEdit || !workflow) return
    const publishedPositions = workflow.publishedLayout
    if (!publishedPositions || Object.keys(publishedPositions).length === 0) {
      setError('当前还没有已发布布局')
      return
    }
    const nextNodes = workflow.nodes.map((node) => publishedPositions[node.id] ? { ...node, position: publishedPositions[node.id] } : node)
    const changed = nextNodes.some((node, index) => node.position.x !== workflow.nodes[index]?.position.x || node.position.y !== workflow.nodes[index]?.position.y)
    if (!changed) {
      setError('当前布局已经是已发布布局')
      return
    }
    updateWorkflow({ ...workflow, nodes: nextNodes })
    setError(null)
  }

  const saveDraftNow = () => {
    const snapshot = workflowRef.current
    if (!canEdit || !snapshot) return
    const draft = { ...snapshot, status: 'draft' as const }
    workflowRef.current = draft
    setWorkflow(draft)
    setDirty(false)
    setSaveState('saving')
    enqueueSave(draft, true)
  }

  const publishWorkflow = () => {
    const snapshot = workflowRef.current
    if (!canEdit || !snapshot) return
    const tasks = snapshot.nodes.filter((node) => node.type === 'task')
    if (tasks.length === 0) {
      setError('至少添加一个组合任务后才能发布流程')
      return
    }
    if (tasks.some((node) => !node.projectId || !node.taskId)) {
      setError('所有组合任务需先绑定已有项目任务后才能发布流程')
      return
    }
    const publishedLayout = Object.fromEntries(snapshot.nodes.map((node) => [node.id, { ...node.position }]))
    const published = { ...snapshot, status: 'published' as const, publishedLayout }
    workflowRef.current = published
    setWorkflow(published)
    setDirty(false)
    setSaveState('saving')
    enqueueSave(published, true)
  }

  const saveTemplate = (name: string, description: string) => {
    if (!canEdit || !workflow) return
    const now = new Date().toISOString()
    const template: PortfolioWorkflowTemplate = { id: `portfolio-template:${now}:${workflow.templates?.length ?? 0}`, name: name.trim(), description: description.trim() || undefined, createdAt: now, updatedAt: now, nodes: workflow.nodes.map((node) => ({ ...node, position: { ...node.position } })), edges: workflow.edges.map((edge) => ({ ...edge })), calendar: workflow.calendar, visibleFields: workflow.visibleFields }
    updateWorkflow({ ...workflow, templates: [...(workflow.templates ?? []), template] })
    setTemplateDialog(null)
    setError(null)
  }

  const applyTemplate = (template: PortfolioWorkflowTemplate) => {
    if (!canEdit || !workflow) return
    updateWorkflow({ ...workflow, nodes: template.nodes.map((node) => ({ ...node, position: { ...node.position } })), edges: template.edges.map((edge) => ({ ...edge })), calendar: template.calendar ?? workflow.calendar, visibleFields: template.visibleFields ?? workflow.visibleFields })
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setTemplateDialog(null)
    setError(null)
  }

  const saveCalendar = (calendar: WorkCalendarConfig) => {
    if (!canEdit || !workflow) return
    updateWorkflow({ ...workflow, calendar })
    setCalendarDialogOpen(false)
  }

  const saveVisibleFields = (visibleFields: PortfolioFlowField[]) => {
    if (!canEdit || !workflow) return
    updateWorkflow({ ...workflow, visibleFields })
    setFieldDialogOpen(false)
  }

  const startEdgeMode = () => {
    if (!canEdit) return
    setEdgeMode((current) => !current)
    setEdgeSourceId(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setError(null)
  }

  const onNodePointerDown = (event: PointerEvent<HTMLButtonElement>, node: PortfolioFlowNode) => {
    if (!canEdit || edgeMode || event.button !== 0) return
    const canvas = event.currentTarget.closest('.portfolio-flow-canvas')
    if (!(canvas instanceof HTMLElement)) return
    const rect = canvas.getBoundingClientRect()
    const renderedPosition = toCanvasPosition(node.position, canvasOrigin)
    dragRef.current = { nodeId: node.id, offsetX: event.clientX - rect.left + canvas.scrollLeft - renderedPosition.x, offsetY: event.clientY - rect.top + canvas.scrollTop - renderedPosition.y, position: node.position }
    setDragNodeId(node.id)
    setDragPosition(node.position)
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedNodeId(node.id)
    setSelectedEdgeId(null)
  }

  const expandCanvas = (axis: 'width' | 'height' | 'left' | 'top', canvas: HTMLDivElement, targetScroll: number) => {
    if (canvasGrowthPendingRef.current[axis]) return
    canvasGrowthPendingRef.current[axis] = true
    const nextExpansion = { ...canvasExpansionRef.current, [axis]: canvasExpansionRef.current[axis] + PORTFOLIO_CANVAS_GROWTH_STEP }
    canvasExpansionRef.current = nextExpansion
    setCanvasExpansion(nextExpansion)
    window.requestAnimationFrame(() => {
      canvasGrowthPendingRef.current[axis] = false
      if (axis === 'width') canvas.scrollLeft = Math.max(0, Math.min(targetScroll, canvas.scrollWidth - canvas.clientWidth))
      if (axis === 'height') canvas.scrollTop = Math.max(0, Math.min(targetScroll, canvas.scrollHeight - canvas.clientHeight))
      if (axis === 'left') canvas.scrollLeft = Math.max(0, Math.min(targetScroll + PORTFOLIO_CANVAS_GROWTH_STEP, canvas.scrollWidth - canvas.clientWidth))
      if (axis === 'top') canvas.scrollTop = Math.max(0, Math.min(targetScroll + PORTFOLIO_CANVAS_GROWTH_STEP, canvas.scrollHeight - canvas.clientHeight))
    })
  }

  const autoPanCanvasAtEdge = (canvas: HTMLDivElement, pointer: { x: number; y: number }) => {
    const rect = canvas.getBoundingClientRect()
    const moveHorizontal = (direction: -1 | 1) => {
      const currentScroll = canvas.scrollLeft
      const maxScroll = Math.max(0, canvas.scrollWidth - canvas.clientWidth)
      const nextScroll = Math.max(0, Math.min(maxScroll, currentScroll + direction * PORTFOLIO_CANVAS_AUTO_PAN_STEP))
      if (nextScroll !== currentScroll) canvas.scrollLeft = nextScroll
      else expandCanvas(direction < 0 ? 'left' : 'width', canvas, currentScroll)
    }
    const moveVertical = (direction: -1 | 1) => {
      const currentScroll = canvas.scrollTop
      const maxScroll = Math.max(0, canvas.scrollHeight - canvas.clientHeight)
      const nextScroll = Math.max(0, Math.min(maxScroll, currentScroll + direction * PORTFOLIO_CANVAS_AUTO_PAN_STEP))
      if (nextScroll !== currentScroll) canvas.scrollTop = nextScroll
      else expandCanvas(direction < 0 ? 'top' : 'height', canvas, currentScroll)
    }
    if (pointer.x <= rect.left + PORTFOLIO_CANVAS_AUTO_PAN_ZONE) moveHorizontal(-1)
    else if (pointer.x >= rect.right - PORTFOLIO_CANVAS_AUTO_PAN_ZONE) moveHorizontal(1)
    if (pointer.y <= rect.top + PORTFOLIO_CANVAS_AUTO_PAN_ZONE) moveVertical(-1)
    else if (pointer.y >= rect.bottom - PORTFOLIO_CANVAS_AUTO_PAN_ZONE) moveVertical(1)
  }

  const onCanvasPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return
    const target = event.target
    if (target instanceof Element && (target.closest('button') || target.closest('g, path'))) return
    const canvas = event.currentTarget
    panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
    setIsPanning(true)
    canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onCanvasPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan) {
      const canvas = event.currentTarget
      const nextScroll = getFlowCanvasPanScroll({
        scroll: { x: canvas.scrollLeft, y: canvas.scrollTop },
        previousPointer: { x: pan.lastX, y: pan.lastY },
        pointer: { x: event.clientX, y: event.clientY },
      })
      pan.lastX = event.clientX
      pan.lastY = event.clientY
      const nextScrollLeft = nextScroll.x
      const nextScrollTop = nextScroll.y
      canvas.scrollLeft = Math.max(0, nextScrollLeft)
      canvas.scrollTop = Math.max(0, nextScrollTop)
      event.preventDefault()
      return
    }
    if (!canEdit || !workflow || !dragRef.current) return
    autoPanCanvasAtEdge(event.currentTarget, { x: event.clientX, y: event.clientY })
    const rect = event.currentTarget.getBoundingClientRect()
    const position = { x: Math.max(16 - canvasOrigin.x, Math.round(event.clientX - rect.left + event.currentTarget.scrollLeft - dragRef.current.offsetX - canvasOrigin.x)), y: Math.max(16 - canvasOrigin.y, Math.round(event.clientY - rect.top + event.currentTarget.scrollTop - dragRef.current.offsetY - canvasOrigin.y)) }
    dragRef.current.position = position
    setDragPosition(position)
  }

  const stopDragging = () => {
    const drag = dragRef.current
    const current = workflowRef.current
    if (drag && current) {
      const node = current.nodes.find((candidate) => candidate.id === drag.nodeId)
      if (node && (node.position.x !== drag.position.x || node.position.y !== drag.position.y)) {
        updateWorkflow({ ...current, nodes: current.nodes.map((candidate) => candidate.id === drag.nodeId ? { ...candidate, position: drag.position } : candidate) }, { trackHistory: false })
      }
    }
    dragRef.current = null
    panRef.current = null
    setIsPanning(false)
    setDragNodeId(null)
    setDragPosition(null)
  }

  if (!workflow) return <div className="portfolio-flow-loading">{saveState === 'error' ? error : '正在读取组合流程…'}</div>

  return (
    <section className={`portfolio-flow-workbench ${fullscreen ? 'is-fullscreen' : ''}`} aria-label={`${portfolio.name}组合流程图`}>
      <header className="portfolio-flow-toolbar">
        <div className="portfolio-flow-identity">
          <strong>{portfolio.code} · {portfolio.name}</strong>
          <span>{workflow.nodes.filter((node) => node.type === 'project').length} 个项目 · {workflow.nodes.filter((node) => node.type === 'task').length} 个组合任务 · {workflow.edges.length} 条连线 · v{workflow.version} · {workflow.status === 'published' ? '已发布' : '草稿'}</span>
        </div>
        <div className="portfolio-flow-toolbar-content">
          <div className="portfolio-flow-toolbar-row portfolio-flow-toolbar-row-top">
            {canEdit && (onImportProject || onCreateProject) && <div className="portfolio-flow-action-group" aria-label="项目管理">
              <span className="portfolio-flow-action-label">项目管理</span>
              <div className="portfolio-flow-action-buttons">
                {onImportProject && <button className="button button-secondary button-compact" type="button" onClick={openImportDialog}><FolderPlus size={15} />导入已有项目</button>}
                {onCreateProject && <button className="button button-secondary button-compact" type="button" onClick={() => onCreateProject(portfolio.id)}><Plus size={15} />新建项目</button>}
              </div>
            </div>}
            <div className="portfolio-flow-lifecycle" aria-label="流程发布操作">
              {canEdit && <button className="button button-secondary button-compact" type="button" onClick={saveDraftNow}>保存草稿</button>}
              {canEdit && <button className="button button-primary button-compact" type="button" onClick={publishWorkflow} disabled={!canPublish}>管理员发布</button>}
              <span className={`portfolio-flow-save-state is-${saveState}`}>{saveState === 'saving' ? '正在保存…' : saveState === 'error' ? '保存失败' : <><Check size={14} />已保存</>}</span>
              <button className="icon-button" type="button" onClick={() => setFullscreen((current) => !current)} aria-label={fullscreen ? '退出全屏画布' : '全屏画布'} title={fullscreen ? '退出全屏画布' : '全屏画布'}>{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
            </div>
          </div>
          <div className="portfolio-flow-toolbar-row portfolio-flow-toolbar-row-tools">
            {canEdit && <div className="portfolio-flow-action-group" aria-label="流程编辑">
              <span className="portfolio-flow-action-label">流程编辑</span>
              <div className="portfolio-flow-action-buttons">
                <button className="button button-secondary button-compact" type="button" onClick={addTask} title={selectedEdge ? '在选中的连线中插入任务' : '在画布空白处添加任务'}><Plus size={15} />{selectedEdge ? '在线段插入任务' : '添加任务'}</button>
                <button className="button button-secondary button-compact" type="button" onClick={addParallelTask} disabled={!selectedEdge} title={selectedEdge ? '在当前连线旁添加并行任务' : '先选择一条连线'}><Plus size={15} />添加并行分支</button>
                <button className={`button button-secondary button-compact ${edgeMode ? 'is-active' : ''}`} type="button" onClick={startEdgeMode}><GitBranch size={15} />{edgeMode ? '取消连线' : '添加连线'}</button>
              </div>
            </div>}
            <div className="portfolio-flow-action-group" aria-label="视图设置">
              <span className="portfolio-flow-action-label">视图设置</span>
              <div className="portfolio-flow-action-buttons">
                {canEdit && <button className="button button-secondary button-compact" type="button" onClick={() => setTemplateDialog('use')}><FileStack size={15} />使用模板</button>}
                {canEdit && <button className="button button-secondary button-compact" type="button" onClick={() => setTemplateDialog('save')}><FileStack size={15} />加入模板</button>}
                <button className="button button-secondary button-compact" type="button" onClick={() => setCalendarDialogOpen(true)}><CalendarDays size={15} />工作日历</button>
                <button className="button button-secondary button-compact" type="button" onClick={() => setFieldDialogOpen(true)}><Settings2 size={15} />字段配置</button>
                {canEdit && <button className="button button-secondary button-compact" type="button" onClick={alignSerialTasks} title="将同一条串联链路中的项目和组合任务移动到同一条水平线上，不改变依赖关系"><GitBranch size={15} />对齐串联任务</button>}
                {canEdit && <button className="button button-secondary button-compact" type="button" onClick={rearrangeLayout}><ChevronsUpDown size={15} />重新排版</button>}
              </div>
            </div>
            <div className="portfolio-flow-more" ref={toolbarMenuRef}>
              <button className="button button-secondary button-compact" type="button" aria-haspopup="menu" aria-expanded={toolbarMenuOpen} onClick={() => setToolbarMenuOpen((open) => !open)}><MoreHorizontal size={15} />更多</button>
              {toolbarMenuOpen && <div className="portfolio-flow-more-menu" role="menu" aria-label="更多流程操作">
                <span className="portfolio-flow-more-heading">流程记录与维护</span>
                <button className="portfolio-flow-menu-item" type="button" role="menuitem" onClick={() => { setAuditDialogOpen(true); setToolbarMenuOpen(false) }}><History size={15} />流程改动日志</button>
                {canEdit && <button className="portfolio-flow-menu-item" type="button" role="menuitem" onClick={() => { restorePublishedLayout(); setToolbarMenuOpen(false) }} disabled={!workflow.publishedLayout || Object.keys(workflow.publishedLayout).length === 0} title="恢复到最近一次已发布的节点位置"><History size={15} />恢复已发布布局</button>}
                {canEdit && <button className="portfolio-flow-menu-item" type="button" role="menuitem" onClick={() => { undoWorkflow(); setToolbarMenuOpen(false) }} disabled={history.length === 0} title="撤销最近一次修改"><History size={15} />撤销</button>}
                {canEdit && <button className="portfolio-flow-menu-item is-danger" type="button" role="menuitem" onClick={() => { clearCanvas(); setToolbarMenuOpen(false) }}><Trash2 size={15} />清空画布</button>}
              </div>}
            </div>
          </div>
        </div>
      </header>
      {edgeMode && <div className="portfolio-flow-hint" role="status">{edgeSourceId ? '已选择起点，请点击目标节点完成连线' : '请点击第一个节点作为连线起点'}</div>}
      {layoutMessage && !edgeMode && <div className="portfolio-flow-hint" role="status">{layoutMessage}</div>}
      {error && <div className="portfolio-flow-error" role="alert">{error}</div>}
      {taskPageNode ? <PortfolioTaskPage node={taskPageNode} portfolio={portfolio} members={members} taskOptions={taskOptions} canEdit={canEdit} onBack={() => { setTaskPageNodeId(null); setSelectedNodeId(null) }} onOpenProject={onOpenProject} onSave={updateTask} onDelete={deleteSelectedTask} /> : <div className={`portfolio-flow-body ${inspectorNode || selectedEdge ? 'has-inspector' : ''}`}>
        <div ref={canvasRef} className={`portfolio-flow-canvas ${isPanning ? 'is-panning' : ''}`} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={stopDragging} onPointerCancel={stopDragging} onPointerLeave={() => { if (!dragRef.current && !panRef.current) stopDragging() }} onLostPointerCapture={stopDragging}>
          <div className="portfolio-flow-stage" style={{ width: canvasSize.width, height: canvasSize.height }}>
            <svg className="portfolio-flow-edges" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} aria-hidden="true">
              <defs><marker id={`portfolio-arrow-${portfolio.id}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" /></marker></defs>
              {workflow.edges.map((edge) => {
                const source = workflow.nodes.find((node) => node.id === edge.source)
                const target = workflow.nodes.find((node) => node.id === edge.target)
                if (!source || !target) return null
                const sourcePosition = toCanvasPosition(source.id === dragNodeId ? dragPosition ?? source.position : source.position, canvasOrigin)
                const targetPosition = toCanvasPosition(target.id === dragNodeId ? dragPosition ?? target.position : target.position, canvasOrigin)
                const path = buildPath(sourcePosition, targetPosition)
                return <g key={edge.id} onClick={() => { setSelectedEdgeId(edge.id); setSelectedNodeId(null) }}><path className="portfolio-flow-edge-hit" d={path} /><path className={`portfolio-flow-edge-visual ${selectedEdgeId === edge.id ? 'is-selected' : ''}`} d={path} markerEnd={`url(#portfolio-arrow-${portfolio.id})`} /></g>
              })}
            </svg>
            {workflow.nodes.map((node) => {
              const position = toCanvasPosition(node.id === dragNodeId ? dragPosition ?? node.position : node.position, canvasOrigin)
              return <button className={`portfolio-flow-node portfolio-flow-node-${node.type} ${selectedNodeId === node.id ? 'is-selected' : ''} ${edgeSourceId === node.id ? 'is-edge-source' : ''}`} type="button" style={{ left: position.x, top: position.y }} key={node.id} onPointerDown={(event) => onNodePointerDown(event, node)} onLostPointerCapture={stopDragging} onMouseEnter={() => { if (node.type === 'project' && node.projectId) onHoverProject?.(node.projectId) }} onFocus={() => { if (node.type === 'project' && node.projectId) onHoverProject?.(node.projectId) }} onClick={() => selectNode(node)} onDoubleClick={() => { if (node.type === 'project' && node.projectId) onOpenProject(node.projectId); else selectNode(node) }} title={node.type === 'project' ? '单击查看项目，双击打开项目流程' : '打开组合任务界面'}>
                <span className="portfolio-flow-node-kicker">{node.wbs}</span>
                <strong>{node.name}</strong>
                {(visibleFields.has('owner') || visibleFields.has('status')) && <small>{[visibleFields.has('owner') ? node.owner : '', visibleFields.has('status') ? (node.type === 'project' ? projectStatusLabel(node.status) : node.status) : ''].filter(Boolean).join(' · ')}</small>}
                {visibleFields.has('progress') && <span className="portfolio-flow-progress"><i style={{ width: `${Math.max(0, Math.min(100, node.progress))}%` }} /><em>{node.progress}%</em></span>}
                {visibleFields.has('duration') && node.duration !== undefined && <small>工期 {node.duration} 个自然日</small>}
                {visibleFields.has('date') && node.plannedStart && <time><CalendarDays size={12} />{node.plannedStart}{node.plannedEnd && node.plannedEnd !== node.plannedStart ? ` → ${node.plannedEnd}` : ''}</time>}
              </button>
            })}
          </div>
        </div>
        {(inspectorNode || selectedEdge) && <aside className="portfolio-flow-inspector" aria-label="组合流程编辑面板">
          <header><div><span>{inspectorNode ? inspectorNode.wbs : '连线'}</span><h3>{inspectorNode ? inspectorNode.name : '依赖连线'}</h3></div><button className="icon-button" type="button" onClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null) }} aria-label="关闭编辑面板"><X size={17} /></button></header>
          {inspectorNode?.type === 'project' && <div className="portfolio-flow-inspector-content"><p className="drawer-empty-note">项目节点来自当前组合，项目名称、负责人、进度和排期会随项目数据自动同步。</p>{inspectorNode.projectId && <button className="button button-primary" type="button" onClick={() => onOpenProject(inspectorNode.projectId as string)}>打开项目流程</button>}</div>}
          {selectedEdge && <div className="portfolio-flow-inspector-content"><label className="form-field"><span>前置节点</span><select value={selectedEdge.source} onChange={(event) => updateSelectedEdge({ source: event.target.value, target: selectedEdge.target })}>{workflow.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label className="form-field"><span>后置节点</span><select value={selectedEdge.target} onChange={(event) => updateSelectedEdge({ source: selectedEdge.source, target: event.target.value })}>{workflow.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>{canEdit && <><button className="button button-primary button-full" type="button" onClick={() => insertTaskOnEdge(selectedEdge)}><Plus size={15} />在线段插入任务</button><button className="button button-danger" type="button" onClick={deleteSelectedEdge}><Trash2 size={15} />删除连线</button></>}</div>}
        </aside>}
      </div>}
      <footer className="portfolio-flow-legend"><span><i className="portfolio-flow-legend-dot project" />项目节点</span><span><i className="portfolio-flow-legend-dot task" />组合任务</span><span>{canEdit ? '拖动节点调整布局，修改会自动保存' : '当前为只读查看'}</span></footer>
      {importDialogOpen && <ProjectImportDialog portfolio={portfolio} projects={importableProjects} busyProjectId={importingProjectId} error={importError} onClose={() => { if (!importingProjectId) setImportDialogOpen(false) }} onSearch={setImportQuery} onImport={(projectId) => void importProject(projectId)} />}
      {templateDialog === 'save' && <PortfolioTemplateSaveDialog onClose={() => setTemplateDialog(null)} onSave={saveTemplate} />}
      {templateDialog === 'use' && <PortfolioTemplatePicker templates={workflow.templates ?? []} onClose={() => setTemplateDialog(null)} onApply={applyTemplate} />}
      {calendarDialogOpen && <PortfolioCalendarDialog calendar={workflow.calendar ?? createNaturalWorkCalendar()} canEdit={canEdit} onClose={() => setCalendarDialogOpen(false)} onSave={saveCalendar} />}
      {fieldDialogOpen && <PortfolioFieldDialog fields={workflow.visibleFields ?? DEFAULT_PORTFOLIO_FIELDS} canEdit={canEdit} onClose={() => setFieldDialogOpen(false)} onSave={saveVisibleFields} />}
      {auditDialogOpen && <PortfolioAuditDialog logs={workflow.auditLogs ?? []} version={workflow.version} onClose={() => setAuditDialogOpen(false)} />}
    </section>
  )
}

function PortfolioTemplateSaveDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, description: string) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="portfolio-template-save-title">
      <header className="modal-header"><div><p className="page-context">项目组合流程</p><h2 id="portfolio-template-save-title">加入模板</h2><p>保存当前组合流程节点、连线、字段和工作日历配置。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭加入模板"><X size={19} /></button></header>
      <div className="modal-body"><label className="form-field"><span>模板名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：研发项目组合标准流程" /></label><label className="form-field"><span>模板说明（可选）</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明这个模板适用的项目场景" /></label></div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="button" onClick={() => onSave(name, description)} disabled={!name.trim()}>保存模板</button></footer>
    </section>
  </div>
}

function PortfolioTemplatePicker({ templates, onClose, onApply }: { templates: PortfolioWorkflowTemplate[]; onClose: () => void; onApply: (template: PortfolioWorkflowTemplate) => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="portfolio-template-picker-title">
      <header className="modal-header"><div><p className="page-context">项目组合流程</p><h2 id="portfolio-template-picker-title">使用模板</h2><p>应用模板会替换当前组合流程的节点、连线和显示配置，当前内容会先作为草稿保存。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭使用模板"><X size={19} /></button></header>
      <div className="modal-body">{templates.length > 0 ? <div className="portfolio-template-list">{templates.slice().reverse().map((template) => <article className="portfolio-template-row" key={template.id}><div><strong>{template.name}</strong><span>{template.description || '无模板说明'}</span><small>{template.nodes.length} 个节点 · {template.edges.length} 条连线 · 更新于 {formatPortfolioDateTime(template.updatedAt)}</small></div><button className="button button-secondary button-compact" type="button" onClick={() => onApply(template)}>应用</button></article>)}</div> : <div className="audit-empty"><FileStack size={26} /><strong>还没有组合模板</strong><p>先点击“加入模板”保存当前流程。</p></div>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button></footer>
    </section>
  </div>
}

function PortfolioFieldDialog({ fields, canEdit, onClose, onSave }: { fields: PortfolioFlowField[]; canEdit: boolean; onClose: () => void; onSave: (fields: PortfolioFlowField[]) => void }) {
  const [selected, setSelected] = useState<PortfolioFlowField[]>(fields)
  const options: { value: PortfolioFlowField; label: string }[] = [{ value: 'owner', label: '负责人' }, { value: 'status', label: '状态' }, { value: 'progress', label: '进度' }, { value: 'date', label: '计划时间' }, { value: 'duration', label: '计划工期' }]
  const toggle = (value: PortfolioFlowField) => setSelected((current) => current.includes(value) ? current.filter((field) => field !== value) : [...current, value])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="portfolio-fields-title">
      <header className="modal-header"><div><p className="page-context">项目组合流程</p><h2 id="portfolio-fields-title">字段配置</h2><p>控制流程图节点卡片显示的信息，不会修改任务本身的数据。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭字段配置"><X size={19} /></button></header>
      <div className="modal-body"><div className="portfolio-field-options">{options.map((option) => <label className="portfolio-field-option" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} disabled={!canEdit} /><span>{option.label}</span></label>)}</div>{selected.length === 0 && <p className="form-error">至少保留一个显示字段。</p>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>关闭</button>{canEdit && <button className="button button-primary" type="button" onClick={() => onSave(selected)} disabled={selected.length === 0}>保存配置</button>}</footer>
    </section>
  </div>
}

type PortfolioCalendarDraft = {
  mode: WorkCalendarConfig['mode']
  name: string
  weeklyWorkdays: number[]
  holidays: string
  customRestDays: string
  makeupWorkdays: string
}

function PortfolioCalendarDialog({ calendar, canEdit, onClose, onSave }: { calendar: WorkCalendarConfig; canEdit: boolean; onClose: () => void; onSave: (calendar: WorkCalendarConfig) => void }) {
  const [draft, setDraft] = useState<PortfolioCalendarDraft>({ mode: calendar.mode, name: calendar.name, weeklyWorkdays: calendar.weeklyWorkdays, holidays: calendar.holidays.join(', '), customRestDays: calendar.customRestDays.join(', '), makeupWorkdays: calendar.makeupWorkdays.join(', ') })
  const [validationError, setValidationError] = useState<string | null>(null)
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const toggleWeekday = (weekday: number) => setDraft((current) => ({ ...current, weeklyWorkdays: current.weeklyWorkdays.includes(weekday) ? current.weeklyWorkdays.filter((item) => item !== weekday) : [...current.weeklyWorkdays, weekday].sort((a, b) => a - b) }))
  const save = () => {
    const lists = [draft.holidays, draft.customRestDays, draft.makeupWorkdays].map(parsePortfolioDateList)
    if (!draft.name.trim()) return setValidationError('请输入日历名称。')
    if (lists.some((list) => list.some((date) => !isPortfolioIsoDate(date)))) return setValidationError('日期请使用 YYYY-MM-DD 格式，并用逗号或换行分隔。')
    if (draft.mode === 'working' && draft.weeklyWorkdays.length === 0) return setValidationError('工作日历至少需要选择一天工作日。')
    onSave({ mode: draft.mode, name: draft.name.trim(), weeklyWorkdays: draft.weeklyWorkdays, holidays: lists[0], customRestDays: lists[1], makeupWorkdays: lists[2] })
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card calendar-modal-card" role="dialog" aria-modal="true" aria-labelledby="portfolio-calendar-title">
      <header className="modal-header"><div><p className="page-context">项目组合流程</p><h2 id="portfolio-calendar-title">工作日历</h2><p>用于组合任务的排期约定；已填写的具体日期不会因切换日历自动改写。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭工作日历"><X size={19} /></button></header>
      <div className="modal-body"><label className="form-field"><span>日历名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={!canEdit} /></label><div className="form-field"><span>排期模式</span><div className="radio-group"><label><input type="radio" checked={draft.mode === 'natural'} onChange={() => setDraft((current) => ({ ...current, mode: 'natural' }))} disabled={!canEdit} />自然日</label><label><input type="radio" checked={draft.mode === 'working'} onChange={() => setDraft((current) => ({ ...current, mode: 'working' }))} disabled={!canEdit} />工作日</label></div></div><div className="form-field"><span>每周工作日</span><div className="portfolio-weekday-options">{weekdays.map((label, weekday) => <label key={weekday}><input type="checkbox" checked={draft.weeklyWorkdays.includes(weekday)} onChange={() => toggleWeekday(weekday)} disabled={!canEdit} />{label}</label>)}</div></div><label className="form-field"><span>法定节假日</span><textarea rows={2} value={draft.holidays} onChange={(event) => setDraft((current) => ({ ...current, holidays: event.target.value }))} disabled={!canEdit} placeholder="2026-10-01, 2026-10-02" /></label><label className="form-field"><span>额外休息日</span><textarea rows={2} value={draft.customRestDays} onChange={(event) => setDraft((current) => ({ ...current, customRestDays: event.target.value }))} disabled={!canEdit} placeholder="YYYY-MM-DD" /></label><label className="form-field"><span>调休工作日</span><textarea rows={2} value={draft.makeupWorkdays} onChange={(event) => setDraft((current) => ({ ...current, makeupWorkdays: event.target.value }))} disabled={!canEdit} placeholder="YYYY-MM-DD" /></label>{validationError && <p className="form-error" role="alert">{validationError}</p>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>关闭</button>{canEdit && <button className="button button-primary" type="button" onClick={save}>保存日历</button>}</footer>
    </section>
  </div>
}

function PortfolioAuditDialog({ logs, version, onClose }: { logs: PortfolioWorkflowAuditLog[]; version: number; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card audit-modal-card" role="dialog" aria-modal="true" aria-labelledby="portfolio-audit-title">
      <header className="modal-header"><div><p className="page-context">项目组合流程 · 当前 v{version}</p><h2 id="portfolio-audit-title">流程改动日志</h2><p>记录组合流程的草稿保存、布局变化和发布操作。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭流程改动日志"><X size={19} /></button></header>
      <div className="modal-body audit-modal-body">{logs.length > 0 ? <div className="audit-list">{logs.slice().reverse().map((log) => <article className="audit-entry" key={log.id}><div className="audit-entry-icon"><History size={17} /></div><div className="audit-entry-content"><div className="audit-entry-heading"><div><strong>{log.action === 'published' ? '发布组合流程' : '保存组合流程草稿'}</strong><span>{log.actorName} · {formatPortfolioDateTime(log.createdAt)}</span></div><span>v{log.version}</span></div><div className="audit-change-counts"><span>节点 +{log.summary.addedNodes} / -{log.summary.removedNodes}</span><span>内容变更 {log.summary.changedNodes}</span><span>布局调整 {log.summary.movedNodes}</span><span>连线 +{log.summary.addedEdges} / -{log.summary.removedEdges}</span></div><ul className="audit-entry-details">{log.details.map((detail, index) => <li key={`${log.id}-${index}`}>{detail}</li>)}</ul></div></article>)}</div> : <div className="audit-empty"><History size={26} /><strong>暂时没有改动记录</strong><p>组合流程保存或发布后，记录会显示在这里。</p></div>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>
}

function withPortfolioWorkflowDefaults(workflow: PortfolioWorkflow): PortfolioWorkflow {
  return { ...workflow, status: workflow.status ?? 'draft', calendar: workflow.calendar ?? createNaturalWorkCalendar(), visibleFields: workflow.visibleFields?.length ? workflow.visibleFields : DEFAULT_PORTFOLIO_FIELDS, templates: workflow.templates ?? [], auditLogs: workflow.auditLogs ?? [] }
}

function arrangePortfolioNodes(nodes: PortfolioFlowNode[], edges: PortfolioFlowEdge[]) {
  const levels = new Map<string, number>(nodes.map((node) => [node.id, 0]))
  const incoming = new Map<string, PortfolioFlowEdge[]>()
  for (const node of nodes) incoming.set(node.id, [])
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false
    for (const edge of edges) {
      const nextLevel = (levels.get(edge.source) ?? 0) + 1
      if (nextLevel > (levels.get(edge.target) ?? 0)) { levels.set(edge.target, nextLevel); changed = true }
    }
    if (!changed) break
  }
  const columns = new Map<number, PortfolioFlowNode[]>()
  for (const node of nodes) columns.set(levels.get(node.id) ?? 0, [...(columns.get(levels.get(node.id) ?? 0) ?? []), node])
  const positions = new Map<string, PortfolioFlowNode['position']>()
  for (const [level, column] of columns) {
    column.sort((left, right) => left.position.y - right.position.y || left.name.localeCompare(right.name, 'zh-CN'))
    column.forEach((node, index) => positions.set(node.id, { x: 80 + level * (NODE_WIDTH + COLUMN_GAP), y: 80 + index * (NODE_HEIGHT + ROW_GAP) }))
  }
  return positions
}

function parsePortfolioDateList(value: string) {
  return [...new Set(value.split(/[，,\n\s]+/).map((item) => item.trim()).filter(Boolean))]
}

function isPortfolioIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function formatPortfolioDateTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function ProjectImportDialog({ portfolio, projects, busyProjectId, error, onClose, onSearch, onImport }: { portfolio: ProjectPortfolio; projects: Project[]; busyProjectId: string | null; error: string | null; onClose: () => void; onSearch: (query: string) => void; onImport: (projectId: string) => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busyProjectId) onClose() }}>
    <section className="modal-card portfolio-import-modal" role="dialog" aria-modal="true" aria-labelledby="import-project-title">
      <header className="modal-header"><div><p className="page-context">项目组合 · {portfolio.code}</p><h2 id="import-project-title">导入已有项目</h2><p>选择一个已有项目加入“{portfolio.name}”。项目只能归属于一个项目组合。</p></div><button className="icon-button" type="button" onClick={onClose} disabled={Boolean(busyProjectId)} aria-label="关闭导入项目"><X size={19} /></button></header>
      <div className="modal-body"><label className="form-field"><span>搜索项目</span><input autoFocus placeholder="搜索项目名称、编号或部门" onChange={(event) => onSearch(event.target.value)} /></label><p className="form-note">如果项目已经属于其他组合，导入后会自动从原组合移入当前组合。</p>{error && <p className="form-error" role="alert">{error}</p>}{projects.length > 0 ? <div className="portfolio-import-list">{projects.map((project) => <article className="portfolio-import-row" key={project.id}><div><strong>{project.name}</strong><span>{project.code} · {project.department} · {project.portfolio?.name ?? '未分组项目'}</span></div><button className="button button-secondary button-compact" type="button" disabled={Boolean(busyProjectId)} onClick={() => onImport(project.id)}>{busyProjectId === project.id ? '导入中…' : '导入'}</button></article>)}</div> : <div className="drawer-empty-note">没有找到可导入的项目。</div>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={Boolean(busyProjectId)}>取消</button></footer>
    </section>
  </div>
}

type PortfolioTaskDraft = {
  taskId: string
  name: string
  owner: string
  assigneeIds: string[]
  assigneeNames: string[]
  duration: number
  effort: number
  plannedStart: string
  plannedEnd: string
  description: string
  closureCriteria: string
}

function PortfolioTaskPage({ node, portfolio, members, taskOptions, canEdit, onBack, onOpenProject, onSave, onDelete }: { node: PortfolioFlowNode; portfolio: ProjectPortfolio; members: ProjectMemberOption[]; taskOptions: PortfolioTaskOption[]; canEdit: boolean; onBack: () => void; onOpenProject: (projectId: string, taskId?: string) => void; onSave: (patch: PortfolioTaskPatch) => void; onDelete: () => void }) {
  return <section className="portfolio-task-page" aria-label={`${node.name}组合任务详情`}>
    <header className="portfolio-task-page-header">
      <button className="button button-secondary button-compact" type="button" onClick={onBack}><ChevronLeft size={16} />返回组合流程</button>
      <div><p className="page-context">{portfolio.code} · {portfolio.name}</p><h2>{node.wbs} · {node.name}</h2><p>在独立界面查看和编辑组合任务，任务绑定后可继续进入所属项目的任务详情。</p></div>
    </header>
    <div className="portfolio-task-page-body"><PortfolioTaskEditor key={node.id} node={node} members={members} taskOptions={taskOptions} canEdit={canEdit} onOpenProject={onOpenProject} onSave={onSave} onDelete={onDelete} /></div>
  </section>
}

function PortfolioTaskEditor({ node, members, taskOptions, canEdit, onOpenProject, onSave, onDelete }: { node: PortfolioFlowNode; members: ProjectMemberOption[]; taskOptions: PortfolioTaskOption[]; canEdit: boolean; onOpenProject: (projectId: string, taskId?: string) => void; onSave: (patch: PortfolioTaskPatch) => void; onDelete: () => void }) {
  const ownerMember = members.find((member) => member.name === node.owner)
  const initialIds = node.assigneeIds?.length ? node.assigneeIds : ownerMember ? [ownerMember.id] : []
  const initialNames = node.assigneeNames?.length ? node.assigneeNames : node.owner && node.owner !== '待分配' ? [node.owner] : []
  const [draft, setDraft] = useState<PortfolioTaskDraft>({ taskId: node.taskId ?? '', name: node.name, owner: node.owner, assigneeIds: initialIds, assigneeNames: initialNames, duration: node.duration ?? 0, effort: node.effort ?? 0, plannedStart: node.plannedStart ?? '', plannedEnd: node.plannedEnd ?? '', description: node.description ?? '', closureCriteria: node.closureCriteria ?? '' })
  const [assigneeQuery, setAssigneeQuery] = useState('')
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [assigneeError, setAssigneeError] = useState<string | null>(null)
  const boundTask = taskOptions.find((task) => task.taskId === draft.taskId)

  const selectedAssigneeNames = draft.assigneeIds.length > 0
    ? draft.assigneeIds.map((id, index) => members.find((member) => member.id === id)?.name ?? draft.assigneeNames[index]).filter((name): name is string => Boolean(name))
    : draft.assigneeNames
  const normalizedAssigneeQuery = assigneeQuery.trim().toLowerCase()
  const filteredMembers = members.filter((member) => {
    if (!normalizedAssigneeQuery) return true
    const namePinyin = pinyin(member.name, { toneType: 'none' }).replace(/\s+/g, '').toLowerCase()
    const nameInitials = pinyin(member.name, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '').toLowerCase()
    return `${member.name} ${namePinyin} ${nameInitials}`.toLowerCase().includes(normalizedAssigneeQuery)
  })

  const selectTask = (taskId: string) => {
    const task = taskOptions.find((option) => option.taskId === taskId)
    if (!task) {
      setDraft((current) => ({ ...current, taskId }))
      return
    }
    setDraft({ taskId: task.taskId, name: task.name, owner: task.owner, assigneeIds: task.assigneeIds, assigneeNames: task.assigneeNames, duration: task.duration, effort: task.effort, plannedStart: task.plannedStart ?? '', plannedEnd: task.plannedEnd ?? '', description: task.description ?? '', closureCriteria: task.closureCriteria ?? '' })
  }

  const save = () => {
    if (!draft.name.trim()) return
    if ((draft.plannedStart && !draft.plannedEnd) || (!draft.plannedStart && draft.plannedEnd)) {
      setScheduleError('请同时选择计划开始和计划结束日期，或同时清空。')
      return
    }
    if (draft.plannedStart && draft.plannedEnd && draft.plannedStart > draft.plannedEnd) {
      setScheduleError('计划结束日期不能早于计划开始日期。')
      return
    }
    const names = draft.assigneeIds.map((id, index) => members.find((member) => member.id === id)?.name ?? draft.assigneeNames[index]).filter((name): name is string => Boolean(name))
    const fallbackNames = names.length > 0 ? names : draft.owner.trim() && draft.owner.trim() !== '待分配' ? [draft.owner.trim()] : []
    onSave(boundTask ? { projectId: boundTask.projectId, taskId: boundTask.taskId, name: boundTask.name, owner: boundTask.owner, assigneeIds: boundTask.assigneeIds, assigneeNames: boundTask.assigneeNames, duration: boundTask.duration, effort: boundTask.effort, plannedStart: boundTask.plannedStart, plannedEnd: boundTask.plannedEnd, description: boundTask.description, closureCriteria: boundTask.closureCriteria } : { projectId: undefined, taskId: draft.taskId || undefined, name: draft.name.trim(), owner: fallbackNames[0] ?? '待分配', assigneeIds: draft.assigneeIds, assigneeNames: fallbackNames, duration: Math.max(0, draft.duration), effort: Math.max(0, draft.effort), plannedStart: draft.plannedStart || undefined, plannedEnd: draft.plannedEnd || undefined, description: draft.description.trim() || undefined, closureCriteria: draft.closureCriteria.trim() || undefined })
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
      const nextNames = nextIds.map((id) => members.find((option) => option.id === id)?.name).filter((name): name is string => Boolean(name))
      return { ...current, assigneeIds: nextIds, assigneeNames: nextNames, owner: nextNames[0] ?? '待分配' }
    })
  }

  const hasBinding = Boolean(draft.taskId)

  return <div className="portfolio-flow-task-editor">
    <div className="portfolio-flow-task-status"><span className="status-badge status-accent">{node.status}</span><span>{hasBinding ? '项目任务 · 数据实时复用' : canEdit ? '先绑定已有项目任务' : '组合任务 · 只读'}</span></div>
    <dl className="task-fields"><div><dt>负责人</dt><dd>{selectedAssigneeNames.length > 0 ? selectedAssigneeNames.join('、') : '待分配'}</dd></div><div><dt>计划工期</dt><dd>{node.duration ?? 0} 个自然日</dd></div><div><dt>计划时间</dt><dd>{node.plannedStart && node.plannedEnd ? `${node.plannedStart} → ${node.plannedEnd}` : '待排期'}</dd></div><div><dt>计划工时</dt><dd>{node.effort ?? 0} h</dd></div></dl>
    <div className="portfolio-flow-inspector-content">
      <label className="form-field"><span>绑定已有项目任务</span><select value={draft.taskId} disabled={!canEdit} onChange={(event) => selectTask(event.target.value)}><option value="">未绑定（仅组合节点）</option>{draft.taskId && !boundTask && <option value={draft.taskId}>当前绑定任务不可见</option>}{taskOptions.map((task) => <option key={task.taskId} value={task.taskId}>{task.projectCode} · {task.wbs} · {task.name}</option>)}</select><small className="drawer-field-hint">绑定后复用项目任务的详情、进度、交付物和 OA 审批记录。</small></label>
      {boundTask && <><p className="drawer-empty-note">已绑定：{boundTask.projectCode} · {boundTask.wbs} · {boundTask.name}。组合节点只做流程索引，任务内容以项目任务为准。</p><button className="button button-primary button-full" type="button" onClick={() => onOpenProject(boundTask.projectId, boundTask.taskId)}>打开项目任务</button></>}
      {draft.taskId && !boundTask && <p className="form-error">当前绑定的项目任务不可见或已被删除，请重新选择。</p>}
    </div>
    {canEdit && <section className="portfolio-flow-inspector-content">
      {!hasBinding && <>
        <h4>编辑组合任务</h4>
        <label className="form-field"><span>任务名称</span><input autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="请输入具体工作任务" /></label>
        <div className="form-field"><span>负责人（可多选）</span><div className="assignee-picker"><div className="assignee-tags">{selectedAssigneeNames.length > 0 ? selectedAssigneeNames.map((name, index) => <span className="assignee-tag" key={`${name}-${index}`}><span className="avatar avatar-soft">{name.slice(0, 1)}</span>{name}{draft.assigneeIds.length > 1 && <button type="button" aria-label={`移除负责人 ${name}`} onClick={() => { const member = members.find((option) => option.name === name); if (member) toggleAssignee(member) }}><X size={13} /></button>}</span>) : <span className="assignee-empty">待分配</span>}</div><button className="assignee-picker-trigger" type="button" onClick={() => setAssigneePickerOpen((open) => !open)} aria-expanded={assigneePickerOpen}><span>{selectedAssigneeNames.length > 0 ? '添加负责人' : '选择负责人'}</span><ChevronDown size={15} /></button>{assigneePickerOpen && <div className="assignee-picker-menu"><input autoFocus value={assigneeQuery} onChange={(event) => setAssigneeQuery(event.target.value)} placeholder="搜索姓名或拼音首字母" aria-label="搜索负责人" />{filteredMembers.length > 0 ? <div className="assignee-options">{filteredMembers.map((member) => <button className={`assignee-option ${draft.assigneeIds.includes(member.id) ? 'is-selected' : ''}`} type="button" key={member.id} onClick={() => toggleAssignee(member)}><span className="avatar avatar-soft">{member.name.slice(0, 1)}</span><span><strong>{member.name}</strong></span>{draft.assigneeIds.includes(member.id) && <CircleCheck size={16} />}</button>)}</div> : <p className="assignee-empty">暂无可选公司成员</p>}</div>}</div>{assigneeError && <small className="form-error">{assigneeError}</small>}<small className="drawer-field-hint">可从全公司在职成员中选择；负责人信息会随组合流程保存。</small></div>
        <label className="form-field"><span>计划工期（自然日）</span><input type="number" min="0" value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: Number(event.target.value) || 0 }))} /></label>
        <label className="form-field"><span>计划工时（可选）</span><input type="number" min="0" step="0.5" value={draft.effort} onChange={(event) => setDraft((current) => ({ ...current, effort: Number(event.target.value) || 0 }))} /></label>
        <div className="form-field"><span>具体计划时间（可选）</span><div className="form-grid"><label className="form-field"><span>开始日期</span><input type="date" aria-label="组合任务计划开始日期" value={draft.plannedStart} onChange={(event) => { setScheduleError(null); setDraft((current) => ({ ...current, plannedStart: event.target.value })) }} /></label><label className="form-field"><span>结束日期</span><input type="date" aria-label="组合任务计划结束日期" value={draft.plannedEnd} onChange={(event) => { setScheduleError(null); setDraft((current) => ({ ...current, plannedEnd: event.target.value })) }} /></label></div><small className="drawer-field-hint">组合任务的计划日期直接保存在项目组合流程中；留空表示待排期。</small>{scheduleError && <small className="form-error">{scheduleError}</small>}</div>
        <label className="form-field"><span>具体工作内容</span><textarea rows={4} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="请输入这个任务需要完成的具体工作、范围和协作事项" /></label>
        <label className="form-field"><span>闭环条件 / 交付物</span><textarea rows={3} value={draft.closureCriteria} onChange={(event) => setDraft((current) => ({ ...current, closureCriteria: event.target.value }))} placeholder="例如：提交测试报告、3D 模型或审批记录" /></label>
        <button className="button button-primary button-full" type="button" onClick={save} disabled={!draft.name.trim()}>保存任务</button>
      </>}
      {boundTask && <button className="button button-secondary button-full" type="button" onClick={save}>保存绑定</button>}
      <button className="button button-danger button-full" type="button" onClick={onDelete}><Trash2 size={15} />删除组合任务</button>
    </section>}
    {!canEdit && !boundTask && <div className="portfolio-flow-inspector-content"><p className="drawer-empty-note">当前为只读查看。组合任务尚未绑定项目任务，无法查看项目任务详情。</p></div>}
  </div>
}

function toPortfolioTaskOptions(project: Project, workflow: Workflow): PortfolioTaskOption[] {
  const source = workflow.nodes.some((node) => node.taskId) ? workflow : workflow.publishedWorkflow ?? workflow
  return source.nodes.filter((node): node is WorkflowNode & { taskId: string } => (node.type === 'task' || node.type === 'milestone') && Boolean(node.taskId)).map((node) => ({ taskId: node.taskId, projectId: project.id, projectCode: project.code, projectName: project.name, wbs: node.wbs, name: node.name, owner: node.owner, assigneeIds: node.assigneeIds ?? [], assigneeNames: node.assigneeNames ?? [], status: node.status, progress: node.progress, plannedStart: node.plannedStart, plannedEnd: node.plannedEnd, duration: node.duration, effort: node.effort, description: node.description, closureCriteria: node.closureCriteria }))
}

function hydratePortfolioTask(node: PortfolioFlowNode, task: PortfolioTaskOption): PortfolioFlowNode {
  return { ...node, projectId: task.projectId, taskId: task.taskId, wbs: task.wbs, name: task.name, owner: task.owner, assigneeIds: task.assigneeIds, assigneeNames: task.assigneeNames, status: task.status, progress: task.progress, plannedStart: task.plannedStart, plannedEnd: task.plannedEnd, duration: task.duration, effort: task.effort, description: task.description, closureCriteria: task.closureCriteria }
}

function toCanvasPosition(position: { x: number; y: number }, origin: { x: number; y: number }) {
  return { x: position.x + origin.x, y: position.y + origin.y }
}

function findEmptyPosition(nodes: PortfolioFlowNode[]) {
  const occupied = new Set(nodes.map((node) => `${Math.round(node.position.x / 20)}:${Math.round(node.position.y / 20)}`))
  for (let index = 0; index < 200; index += 1) {
    const position = { x: 80 + (index % 4) * (NODE_WIDTH + COLUMN_GAP), y: 80 + Math.floor(index / 4) * (NODE_HEIGHT + ROW_GAP) }
    if (!occupied.has(`${Math.round(position.x / 20)}:${Math.round(position.y / 20)}`)) return position
  }
  return { x: 80, y: 80 }
}

function nextAvailableId(prefix: string, existingIds: string[]) {
  const used = new Set(existingIds)
  let index = 1
  while (used.has(`${prefix}:${index}`)) index += 1
  return `${prefix}:${index}`
}

function buildPath(source: { x: number; y: number }, target: { x: number; y: number }) {
  const startX = source.x + NODE_WIDTH
  const startY = source.y + NODE_HEIGHT / 2
  const endX = target.x
  const endY = target.y + NODE_HEIGHT / 2
  if (Math.abs(startY - endY) < 1) return `M ${startX} ${startY} H ${endX}`
  const middleX = startX <= endX ? Math.round((startX + endX) / 2) : Math.max(startX, endX) + 32
  return `M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`
}

function midpoint(source: { x: number; y: number }, target: { x: number; y: number }) {
  return { x: Math.round((source.x + target.x) / 2), y: Math.round((source.y + target.y) / 2) }
}

function parallelPosition(source: { x: number; y: number }, target: { x: number; y: number }) {
  const center = midpoint(source, target)
  return { x: center.x, y: center.y + NODE_HEIGHT + ROW_GAP }
}

function hasPath(nodes: PortfolioFlowNode[], edges: PortfolioFlowEdge[], from: string, target: string) {
  const successors = new Map<string, string[]>()
  for (const node of nodes) successors.set(node.id, [])
  for (const edge of edges) successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target])
  const pending = [from]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.shift() as string
    if (current === target) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(successors.get(current) ?? []))
  }
  return false
}

function projectStatusLabel(status: string) {
  return ({ IN_PROGRESS: '执行中', AT_RISK: '有风险', PLANNED: '规划中', PAUSED: '已暂停' } as Record<string, string>)[status] ?? status
}
