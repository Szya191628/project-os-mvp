import { randomUUID } from 'node:crypto'

export type PortfolioFlowNodeSnapshot = {
  id: string
  type: 'project' | 'task'
  projectId?: string
  taskId?: string
  wbs: string
  name: string
  owner: string
  assigneeIds?: string[]
  assigneeNames?: string[]
  status: string
  progress: number
  plannedStart?: string
  plannedEnd?: string
  duration?: number
  effort?: number
  description?: string
  closureCriteria?: string
  positionX: number
  positionY: number
}

export type PortfolioFlowEdgeSnapshot = {
  id: string
  source: string
  target: string
  type: 'FS'
  lagDays: number
}

export type PortfolioFlowFieldSnapshot = 'owner' | 'status' | 'progress' | 'date' | 'duration'

export type PortfolioCalendarSnapshot = {
  mode: 'natural' | 'working'
  name: string
  weeklyWorkdays: number[]
  holidays: string[]
  customRestDays: string[]
  makeupWorkdays: string[]
}

export type PortfolioWorkflowTemplateSnapshot = {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  nodes: PortfolioFlowNodeSnapshot[]
  edges: PortfolioFlowEdgeSnapshot[]
  calendar?: PortfolioCalendarSnapshot
  visibleFields?: PortfolioFlowFieldSnapshot[]
}

export type PortfolioWorkflowAuditLogSnapshot = {
  id: string
  action: 'draft_saved' | 'published'
  actorName: string
  createdAt: string
  version: number
  summary: {
    addedNodes: number
    removedNodes: number
    changedNodes: number
    movedNodes: number
    addedEdges: number
    removedEdges: number
  }
  details: string[]
}

export type PortfolioWorkflowSnapshot = {
  portfolioId: string
  version: number
  status: 'draft' | 'published'
  calendar?: PortfolioCalendarSnapshot
  visibleFields?: PortfolioFlowFieldSnapshot[]
  publishedLayout?: Record<string, { x: number; y: number }>
  templates?: PortfolioWorkflowTemplateSnapshot[]
  auditLogs?: PortfolioWorkflowAuditLogSnapshot[]
  nodes: PortfolioFlowNodeSnapshot[]
  edges: PortfolioFlowEdgeSnapshot[]
}

type PortfolioProjectRow = {
  id: string
  code: string
  name: string
  status: string
  plannedStart: Date
  plannedEnd: Date | null
  owner: { name: string } | null
  tasks: { execution: { progress: number } | null }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const asTextArray = (value: unknown) => Array.isArray(value) ? value.map(asText).filter(Boolean) : []
const asNumber = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const dateOnly = (value: Date | null) => value?.toISOString().slice(0, 10)
const projectNodeId = (projectId: string) => `project:${projectId}`
const portfolioFields: PortfolioFlowFieldSnapshot[] = ['owner', 'status', 'progress', 'date', 'duration']

function defaultProjectPosition(index: number) {
  return { x: 80 + (index % 4) * 260, y: 80 + Math.floor(index / 4) * 150 }
}

function projectNode(project: PortfolioProjectRow, index: number, existing?: Partial<PortfolioFlowNodeSnapshot>): PortfolioFlowNodeSnapshot {
  const progress = project.tasks.length === 0 ? 0 : Math.round(project.tasks.reduce((sum, task) => sum + (task.execution?.progress ?? 0), 0) / project.tasks.length)
  const fallbackPosition = defaultProjectPosition(index)
  return {
    id: projectNodeId(project.id),
    type: 'project',
    projectId: project.id,
    wbs: project.code,
    name: project.name,
    owner: project.owner?.name ?? '待分配',
    status: project.status,
    progress,
    plannedStart: dateOnly(project.plannedStart),
    plannedEnd: dateOnly(project.plannedEnd),
    duration: undefined,
    description: undefined,
    positionX: asNumber(existing?.positionX, fallbackPosition.x),
    positionY: asNumber(existing?.positionY, fallbackPosition.y),
  }
}

function taskNode(raw: unknown, index: number, usedIds: Set<string>): PortfolioFlowNodeSnapshot | null {
  if (!isRecord(raw) || raw.type !== 'task') return null
  const rawId = asText(raw.id)
  const id = rawId && !usedIds.has(rawId) ? rawId : `task:${Date.now()}-${index}`
  usedIds.add(id)
  const fallbackPosition = { x: 80 + (index % 4) * 260, y: 80 + Math.floor(index / 4) * 150 }
  const progress = Math.max(0, Math.min(100, Math.round(asNumber(raw.progress, 0))))
  return {
    id,
    type: 'task',
    ...(asText(raw.projectId) ? { projectId: asText(raw.projectId) } : {}),
    ...(asText(raw.taskId) ? { taskId: asText(raw.taskId) } : {}),
    wbs: asText(raw.wbs) || `T${index + 1}`,
    name: asText(raw.name) || '待填写任务',
    owner: asText(raw.owner) || '待分配',
    assigneeIds: asTextArray(raw.assigneeIds),
    assigneeNames: asTextArray(raw.assigneeNames),
    status: asText(raw.status) || '未开始',
    progress,
    plannedStart: asText(raw.plannedStart) || undefined,
    plannedEnd: asText(raw.plannedEnd) || undefined,
    duration: Math.max(0, Math.round(asNumber(raw.duration, 0))),
    effort: Math.max(0, asNumber(raw.effort, 0)),
    description: asText(raw.description) || undefined,
    closureCriteria: asText(raw.closureCriteria) || undefined,
    positionX: asNumber(raw.positionX, fallbackPosition.x),
    positionY: asNumber(raw.positionY, fallbackPosition.y),
  }
}

function normalizeCalendar(raw: unknown): PortfolioCalendarSnapshot | undefined {
  if (!isRecord(raw)) return undefined
  const mode = raw.mode === 'working' ? 'working' : raw.mode === 'natural' ? 'natural' : null
  const name = asText(raw.name)
  if (!mode || !name) return undefined
  const days = (value: unknown) => Array.isArray(value) ? [...new Set(value.map((item) => Math.round(asNumber(item, -1))).filter((item) => item >= 0 && item <= 6))] : []
  return { mode, name, weeklyWorkdays: days(raw.weeklyWorkdays), holidays: asTextArray(raw.holidays), customRestDays: asTextArray(raw.customRestDays), makeupWorkdays: asTextArray(raw.makeupWorkdays) }
}

function normalizeFields(raw: unknown): PortfolioFlowFieldSnapshot[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const fields = [...new Set(raw.filter((item): item is PortfolioFlowFieldSnapshot => typeof item === 'string' && portfolioFields.includes(item as PortfolioFlowFieldSnapshot)))]
  return fields.length > 0 ? fields : undefined
}

function normalizePublishedLayout(raw: unknown) {
  if (!isRecord(raw)) return undefined
  const layout: Record<string, { x: number; y: number }> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const x = asNumber(value.x, Number.NaN)
    const y = asNumber(value.y, Number.NaN)
    if (Number.isFinite(x) && Number.isFinite(y)) layout[id] = { x, y }
  }
  return Object.keys(layout).length > 0 ? layout : undefined
}

function normalizeTemplateNode(raw: unknown, index: number, usedIds: Set<string>): PortfolioFlowNodeSnapshot | null {
  if (!isRecord(raw) || (raw.type !== 'project' && raw.type !== 'task')) return null
  if (raw.type === 'task') return taskNode(raw, index, usedIds)
  const rawId = asText(raw.id)
  const id = rawId && !usedIds.has(rawId) ? rawId : `project-template:${index}`
  usedIds.add(id)
  return {
    id,
    type: 'project',
    projectId: asText(raw.projectId) || undefined,
    wbs: asText(raw.wbs) || `P${index + 1}`,
    name: asText(raw.name) || '项目节点',
    owner: asText(raw.owner) || '待分配',
    status: asText(raw.status) || '规划中',
    progress: Math.max(0, Math.min(100, Math.round(asNumber(raw.progress, 0)))),
    plannedStart: asText(raw.plannedStart) || undefined,
    plannedEnd: asText(raw.plannedEnd) || undefined,
    positionX: asNumber(raw.positionX, 80 + (index % 4) * 260),
    positionY: asNumber(raw.positionY, 80 + Math.floor(index / 4) * 150),
  }
}

function normalizeEdges(raw: unknown, nodeIds: Set<string>) {
  if (!Array.isArray(raw)) return []
  const usedEdgeIds = new Set<string>()
  const edges: PortfolioFlowEdgeSnapshot[] = []
  raw.forEach((item, index) => {
    if (!isRecord(item)) return
    const source = asText(item.source)
    const target = asText(item.target)
    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) return
    const rawId = asText(item.id)
    const id = rawId && !usedEdgeIds.has(rawId) ? rawId : `edge:${index}`
    usedEdgeIds.add(id)
    edges.push({ id, source, target, type: 'FS', lagDays: Math.max(-365, Math.min(365, Math.round(asNumber(item.lagDays, 0)))) })
  })
  return edges
}

function normalizeTemplates(raw: unknown): PortfolioWorkflowTemplateSnapshot[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const templates: PortfolioWorkflowTemplateSnapshot[] = []
  raw.forEach((item, index) => {
    if (!isRecord(item)) return null
    const name = asText(item.name)
    if (!name) return null
    const usedIds = new Set<string>()
    const nodes = (Array.isArray(item.nodes) ? item.nodes : []).map((node, nodeIndex) => normalizeTemplateNode(node, nodeIndex, usedIds)).filter((node): node is PortfolioFlowNodeSnapshot => Boolean(node))
    templates.push({ id: asText(item.id) || `portfolio-template:${Date.now()}-${index}`, name, description: asText(item.description) || undefined, createdAt: asText(item.createdAt) || new Date().toISOString(), updatedAt: asText(item.updatedAt) || new Date().toISOString(), nodes, edges: normalizeEdges(item.edges, new Set(nodes.map((node) => node.id))), calendar: normalizeCalendar(item.calendar), visibleFields: normalizeFields(item.visibleFields) })
  })
  return templates.length > 0 ? templates.slice(-30) : undefined
}

function normalizeAuditLogs(raw: unknown): PortfolioWorkflowAuditLogSnapshot[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    if (!isRecord(item)) return null
    const summary = isRecord(item.summary) ? item.summary : {}
    const action = item.action === 'published' ? 'published' : item.action === 'draft_saved' ? 'draft_saved' : null
    if (!action) return null
    return { id: asText(item.id) || randomUUID(), action, actorName: asText(item.actorName) || '系统', createdAt: asText(item.createdAt) || new Date().toISOString(), version: Math.max(1, Math.round(asNumber(item.version, 1))), summary: { addedNodes: Math.max(0, Math.round(asNumber(summary.addedNodes, 0))), removedNodes: Math.max(0, Math.round(asNumber(summary.removedNodes, 0))), changedNodes: Math.max(0, Math.round(asNumber(summary.changedNodes, 0))), movedNodes: Math.max(0, Math.round(asNumber(summary.movedNodes, 0))), addedEdges: Math.max(0, Math.round(asNumber(summary.addedEdges, 0))), removedEdges: Math.max(0, Math.round(asNumber(summary.removedEdges, 0))) }, details: asTextArray(item.details).slice(0, 8) }
  }).filter((log): log is PortfolioWorkflowAuditLogSnapshot => Boolean(log)).slice(-100)
}

export function normalizePortfolioWorkflow(portfolioId: string, projects: PortfolioProjectRow[], raw: unknown): PortfolioWorkflowSnapshot {
  const source = isRecord(raw) ? raw : {}
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : []
  const sourceByProjectId = new Map<string, Partial<PortfolioFlowNodeSnapshot>>()
  for (const node of sourceNodes) {
    if (!isRecord(node) || node.type !== 'project') continue
    const projectId = asText(node.projectId)
    if (projectId) sourceByProjectId.set(projectId, node as Partial<PortfolioFlowNodeSnapshot>)
  }

  const usedIds = new Set(projects.map((project) => projectNodeId(project.id)))
  const nodes = projects.map((project, index) => projectNode(project, index, sourceByProjectId.get(project.id)))
  sourceNodes.forEach((rawNode, index) => {
    const node = taskNode(rawNode, index, usedIds)
    if (node) nodes.push(node)
  })

  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = normalizeEdges(source.edges, nodeIds)

  return {
    portfolioId,
    version: Math.max(1, Math.round(asNumber(source.version, 1))),
    status: source.status === 'published' ? 'published' : 'draft',
    calendar: normalizeCalendar(source.calendar),
    visibleFields: normalizeFields(source.visibleFields),
    publishedLayout: normalizePublishedLayout(source.publishedLayout),
    templates: normalizeTemplates(source.templates),
    auditLogs: normalizeAuditLogs(source.auditLogs),
    nodes,
    edges,
  }
}

export function portfolioWorkflowInput(value: unknown) {
  if (!isRecord(value)) return null
  return {
    version: Math.max(1, Math.round(asNumber(value.version, 1))),
    status: value.status === 'published' ? 'published' : 'draft',
    calendar: value.calendar,
    visibleFields: value.visibleFields,
    publishedLayout: value.publishedLayout,
    templates: value.templates,
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
  }
}

export function appendPortfolioWorkflowAuditLog(previous: unknown, next: PortfolioWorkflowSnapshot, actorName: string) {
  const before = isRecord(previous) ? previous : {}
  const beforeNodes = Array.isArray(before.nodes) ? before.nodes.filter(isRecord) : []
  const beforeById = new Map(beforeNodes.map((node) => [asText(node.id), node]))
  const afterById = new Map(next.nodes.map((node) => [node.id, node]))
  const addedNodes = next.nodes.filter((node) => !beforeById.has(node.id)).length
  const removedNodes = beforeNodes.filter((node) => !afterById.has(asText(node.id))).length
  const changedNodes = next.nodes.filter((node) => {
    const old = beforeById.get(node.id)
    return old && (asText(old.name) !== node.name || asText(old.owner) !== node.owner || asText(old.status) !== node.status || asNumber(old.progress, 0) !== node.progress || asText(old.plannedStart) !== (node.plannedStart ?? '') || asText(old.plannedEnd) !== (node.plannedEnd ?? ''))
  }).length
  const movedNodes = next.nodes.filter((node) => {
    const old = beforeById.get(node.id)
    return old && (asNumber(old.positionX, node.positionX) !== node.positionX || asNumber(old.positionY, node.positionY) !== node.positionY)
  }).length
  const beforeEdges = Array.isArray(before.edges) ? before.edges.filter(isRecord).map((edge) => `${asText(edge.source)}>${asText(edge.target)}`) : []
  const afterEdges = next.edges.map((edge) => `${edge.source}>${edge.target}`)
  const beforeEdgeSet = new Set(beforeEdges)
  const afterEdgeSet = new Set(afterEdges)
  const addedEdges = afterEdges.filter((edge) => !beforeEdgeSet.has(edge)).length
  const removedEdges = beforeEdges.filter((edge) => !afterEdgeSet.has(edge)).length
  const details: string[] = []
  if (addedNodes) details.push(`新增 ${addedNodes} 个节点`)
  if (removedNodes) details.push(`删除 ${removedNodes} 个节点`)
  if (changedNodes) details.push(`修改 ${changedNodes} 个节点内容`)
  if (movedNodes) details.push(`调整 ${movedNodes} 个节点布局`)
  if (addedEdges) details.push(`新增 ${addedEdges} 条连线`)
  if (removedEdges) details.push(`删除 ${removedEdges} 条连线`)
  if (details.length === 0) details.push('保存流程管理配置')
  const log: PortfolioWorkflowAuditLogSnapshot = { id: randomUUID(), action: next.status === 'published' ? 'published' : 'draft_saved', actorName: actorName || '系统', createdAt: new Date().toISOString(), version: next.version, summary: { addedNodes, removedNodes, changedNodes, movedNodes, addedEdges, removedEdges }, details }
  next.auditLogs = [...(next.auditLogs ?? []), log].slice(-100)
}
