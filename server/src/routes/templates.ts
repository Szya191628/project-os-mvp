import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { appendAuditLog, isGlobalL2, isL1, projectAccess, requireProjectPermission } from '../auth.js'
import { prisma } from '../db.js'
import { organizationIdFor } from './projects.js'

type TemplateNode = {
  id: string
  type: 'start' | 'task' | 'milestone' | 'end'
  wbs: string
  name: string
  duration: number
  effort: number
  description?: string
  closureCriteria?: string
  position: { x: number; y: number }
}

type TemplateEdge = { id: string; source: string; target: string; type: 'FS'; lagDays: number }

export type WorkflowTemplateSnapshot = {
  baselineStart: string
  calendar?: {
    mode: 'natural' | 'working'
    name: string
    weeklyWorkdays: number[]
    holidays: string[]
    customRestDays: string[]
    makeupWorkdays: string[]
  }
  nodes: TemplateNode[]
  edges: TemplateEdge[]
}

type WorkflowInput = {
  projectId?: string
  baselineStart?: string
  calendar?: WorkflowTemplateSnapshot['calendar']
  nodes?: Array<Partial<TemplateNode> & { id?: string; type?: string; position?: { x?: number; y?: number } }>
  edges?: Array<Partial<TemplateEdge> & { id?: string; source?: string; target?: string }>
}

type TemplateBody = { name?: string; description?: string; projectId?: string; workflow?: WorkflowInput }
type ProjectParams = { projectId: string }
type TemplateParams = { templateId: string }

const nodeTypes = new Set<TemplateNode['type']>(['start', 'task', 'milestone', 'end'])

async function requireTemplateManager(request: FastifyRequest, reply: FastifyReply, sourceProjectId?: string) {
  const actor = request.actor
  if (!actor) {
    await reply.code(401).send({ error: 'authentication_required' })
    return null
  }
  if (!isL1(actor) && !isGlobalL2(actor)) {
    const access = sourceProjectId ? await projectAccess(actor, sourceProjectId) : null
    if (access?.level === 'L2') return actor
    await reply.code(403).send({ error: 'forbidden', permission: 'workflow.template.manage' })
    return null
  }
  return actor
}

function normalizeSnapshot(input: WorkflowInput | undefined): WorkflowTemplateSnapshot {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) throw new Error('workflow_required')
  const nodeIds = new Set<string>()
  const nodes: TemplateNode[] = input.nodes.map((raw, index) => {
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `node-${index + 1}`
    const type = String(raw.type ?? '').toLowerCase() as TemplateNode['type']
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!nodeTypes.has(type)) throw new Error('invalid_template_node')
    if (nodeIds.has(id)) throw new Error('duplicate_template_node')
    if (!name) throw new Error('template_node_name_required')
    nodeIds.add(id)
    return {
      id,
      type,
      wbs: typeof raw.wbs === 'string' && raw.wbs.trim() ? raw.wbs.trim() : `1.${index + 1}`,
      name,
      duration: Math.max(0, Math.round(Number(raw.duration) || 0)),
      effort: Math.max(0, Math.round(Number(raw.effort) || 0)),
      ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
      ...(typeof raw.closureCriteria === 'string' && raw.closureCriteria.trim() ? { closureCriteria: raw.closureCriteria.trim() } : {}),
      position: { x: Number.isFinite(raw.position?.x) ? Number(raw.position?.x) : 180 + (index % 3) * 270, y: Number.isFinite(raw.position?.y) ? Number(raw.position?.y) : 80 + Math.floor(index / 3) * 150 },
    }
  })
  if (!nodes.some((node) => node.type === 'start') || !nodes.some((node) => node.type === 'end') || !nodes.some((node) => node.type === 'task' || node.type === 'milestone')) throw new Error('template_requires_start_end_task')
  const edges: TemplateEdge[] = input.edges.map((raw, index) => {
    const source = typeof raw.source === 'string' ? raw.source : ''
    const target = typeof raw.target === 'string' ? raw.target : ''
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target) || source === target) throw new Error('invalid_template_edge')
    return { id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `edge-${index + 1}`, source, target, type: 'FS', lagDays: Math.round(Number(raw.lagDays) || 0) }
  })
  const baselineStart = typeof input.baselineStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.baselineStart) ? input.baselineStart : new Date().toISOString().slice(0, 10)
  return { baselineStart, calendar: normalizeCalendar(input.calendar), nodes, edges }
}

function normalizeCalendar(calendar: WorkflowTemplateSnapshot['calendar'] | undefined) {
  if (!calendar) return undefined
  return {
    mode: calendar.mode === 'working' ? 'working' as const : 'natural' as const,
    name: typeof calendar.name === 'string' && calendar.name.trim() ? calendar.name.trim() : '项目自然日',
    weeklyWorkdays: Array.isArray(calendar.weeklyWorkdays) ? calendar.weeklyWorkdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [1, 2, 3, 4, 5],
    holidays: cleanDates(calendar.holidays),
    customRestDays: cleanDates(calendar.customRestDays),
    makeupWorkdays: cleanDates(calendar.makeupWorkdays),
  }
}

function cleanDates(values: unknown) {
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)))] : []
}

function cloneSnapshot(snapshot: WorkflowTemplateSnapshot, projectId: string, baselineStart: string) {
  const idMap = new Map(snapshot.nodes.map((node) => [node.id, randomUUID()]))
  return {
    projectId,
    baselineStart,
    status: 'draft' as const,
    version: 0,
    calendar: snapshot.calendar,
    nodes: snapshot.nodes.map((node) => ({
      id: idMap.get(node.id)!, projectId, type: node.type, wbs: node.wbs, name: node.name, owner: node.type === 'start' || node.type === 'end' ? '项目组' : '待分配', duration: node.duration, effort: node.effort, progress: node.type === 'start' ? 100 : 0, status: node.type === 'start' ? '已完成' as const : '未开始' as const, description: node.description, closureCriteria: node.closureCriteria, position: node.position,
    })),
    edges: snapshot.edges.map((edge) => ({ id: randomUUID(), source: idMap.get(edge.source)!, target: idMap.get(edge.target)!, type: edge.type, lagDays: edge.lagDays })),
  }
}

function templateSummary(template: { id: string; name: string; description: string | null; snapshot: unknown; createdAt: Date; updatedAt: Date }) {
  const snapshot = template.snapshot as Partial<WorkflowTemplateSnapshot>
  return { id: template.id, name: template.name, description: template.description, nodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.filter((node) => node && node.type !== 'start' && node.type !== 'end').length : 0, edgeCount: Array.isArray(snapshot.edges) ? snapshot.edges.length : 0, createdAt: template.createdAt.toISOString(), updatedAt: template.updatedAt.toISOString() }
}

export async function registerTemplateRoutes(app: FastifyInstance) {
  app.get('/api/v1/workflow-templates', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const templates = await prisma.workflowTemplate.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }] })
    return { data: templates.map(templateSummary) }
  })

  app.post<{ Body: TemplateBody }>('/api/v1/workflow-templates', async (request, reply) => {
    const body = request.body as TemplateBody | undefined
    const actor = await requireTemplateManager(request, reply, body?.projectId ?? body?.workflow?.projectId)
    if (!actor) return
    const name = request.body?.name?.trim()
    if (!name) return reply.code(400).send({ error: 'template_name_required' })
    if (name.length > 80) return reply.code(400).send({ error: 'template_name_too_long' })
    if ((request.body?.description?.length ?? 0) > 500) return reply.code(400).send({ error: 'template_description_too_long' })
    let snapshot: WorkflowTemplateSnapshot
    try { snapshot = normalizeSnapshot(request.body?.workflow) } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid_template_workflow' }) }
    try {
      const template = await prisma.workflowTemplate.create({ data: { organizationId: organizationIdFor(request), name, description: request.body?.description?.trim() || null, snapshot: snapshot as never } })
      await appendAuditLog({ request, action: 'WORKFLOW_TEMPLATE_CREATED', resourceType: 'WORKFLOW_TEMPLATE', resourceId: template.id, afterJson: { name: template.name, nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length } })
      return reply.code(201).send({ data: templateSummary(template) })
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unique constraint')) return reply.code(409).send({ error: 'template_name_exists' })
      throw error
    }
  })

  app.post<{ Params: ProjectParams & TemplateParams }>('/api/v1/projects/:projectId/workflow/templates/:templateId/use', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.edit')
    if (!guard) return
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true, plannedStart: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const template = await prisma.workflowTemplate.findFirst({ where: { id: request.params.templateId, organizationId: guard.actor.organizationId } })
    if (!template) return reply.code(404).send({ error: 'workflow_template_not_found' })
    const workflow = cloneSnapshot(template.snapshot as unknown as WorkflowTemplateSnapshot, project.id, project.plannedStart.toISOString().slice(0, 10))
    await appendAuditLog({ request, action: 'WORKFLOW_TEMPLATE_USED', resourceType: 'WORKFLOW_TEMPLATE', resourceId: template.id, projectId: project.id, afterJson: { templateId: template.id, nodeCount: workflow.nodes.length, edgeCount: workflow.edges.length } })
    return { data: workflow }
  })
}

export { cloneSnapshot, normalizeSnapshot }
