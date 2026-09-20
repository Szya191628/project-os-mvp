import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { isL1, projectAccess, requireProjectPermission, visibleProjectIds, type ProjectAccessLevel } from '../auth.js'
import { hasWorkflowAuditChanges, summarizeWorkflowAudit } from '../workflowAudit.js'
import { normalizePortfolioWorkflow } from '../portfolioWorkflow.js'
import { isSpecialReleaseForVersion } from '../taskRelease.js'
import { claimTaskScope } from '../claimTaskAccess.js'
import { requireClaimTaskPublishPermission } from '../auth.js'
import { loadPublishedWorkflowTasks } from '../publishedTasks.js'

export type ProjectParams = { projectId: string }

export const organizationIdFor = (request: FastifyRequest) => {
  if (request.actor?.organizationId) return request.actor.organizationId
  const header = request.headers['x-organization-id']
  return (Array.isArray(header) ? header[0] : header) ?? config.defaultOrganizationId
}

const dateOnly = (value: Date | null | undefined) => value?.toISOString().slice(0, 10) ?? null

const initials = (value: string) => value.trim().slice(0, 2).toUpperCase() || 'PM'
const completedExecutionStatuses = new Set(['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'])
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00.000Z`)
const addDays = (value: string, days: number) => {
  const date = new Date(dayNumber(value))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const inclusiveDays = (start: string, end: string) => Math.max(1, Math.floor((dayNumber(end) - dayNumber(start)) / 86400000) + 1)

const projectSummary = (project: {
  id: string
  code: string
  name: string
  status: string
  health: string
  plannedStart: Date
  plannedEnd: Date | null
  budgetAmount: unknown
  actualCostAmount: unknown
  approvalAutoStart: boolean
  owner: { id: string; name: string } | null
  department: { id: string; name: string } | null
  portfolio: { id: string; code: string; name: string } | null
  members: { memberId: string }[]
  tasks: { execution: { progress: number } | null }[]
  workflow: { id: string; draftVersionId: string | null; publishedVersionId: string | null } | null
}) => ({
  id: project.id,
  code: project.code,
  name: project.name,
  status: project.status,
  health: project.health,
  plannedStart: dateOnly(project.plannedStart),
  plannedEnd: dateOnly(project.plannedEnd),
  budgetAmount: project.budgetAmount === null ? null : Number(project.budgetAmount),
  actualCostAmount: project.actualCostAmount === null ? null : Number(project.actualCostAmount),
  approvalAutoStart: project.approvalAutoStart,
  progress: project.tasks.length === 0 ? 0 : Math.round(project.tasks.reduce((sum, task) => sum + (task.execution?.progress ?? 0), 0) / project.tasks.length),
  owner: project.owner ? { ...project.owner, initials: initials(project.owner.name) } : null,
  department: project.department,
  portfolio: project.portfolio,
  memberIds: project.members.map((member) => member.memberId),
  nextMilestone: '待规划',
  workflow: project.workflow,
})

const projectSummarySelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  health: true,
  plannedStart: true,
  plannedEnd: true,
  budgetAmount: true,
  actualCostAmount: true,
  approvalAutoStart: true,
  owner: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  portfolio: { select: { id: true, code: true, name: true } },
  members: { select: { memberId: true } },
  tasks: { where: { archivedAt: null }, select: { execution: { select: { progress: true } } } },
  workflow: { select: { id: true, draftVersionId: true, publishedVersionId: true } },
} as const

const versionSelect = {
  id: true,
  versionNo: true,
  status: true,
  baselineStart: true,
  calendar: {
    select: {
      name: true,
      mode: true,
      weekdays: { select: { weekday: true } },
      exceptions: { select: { date: true, kind: true } },
    },
  },
  nodes: {
    orderBy: { wbs: 'asc' as const },
    select: {
      id: true,
      taskId: true,
      nodeType: true,
      wbs: true,
      parentTaskId: true,
      name: true,
      durationDays: true,
      effortHours: true,
      description: true,
      closureCriteria: true,
      plannedStartOverride: true,
      plannedEndOverride: true,
      positionX: true,
      positionY: true,
      ownerMember: { select: { id: true, name: true } },
      schedules: {
        select: {
          plannedStart: true,
          plannedEnd: true,
          startOffset: true,
          endOffset: true,
          calendarSpan: true,
        },
      },
      task: {
        select: {
          execution: {
            select: {
              status: true,
              progress: true,
              actualStart: true,
              actualEnd: true,
              readyAt: true,
              completionNote: true,
              overdueReason: true,
              specialRelease: true,
              completionApprovalStatus: true,
              completionConfirmedAt: true,
            },
          },
          closureChecks: { orderBy: { sortOrder: 'asc' as const }, select: { id: true, label: true, completed: true } },
          assignees: {
            where: { removedAt: null },
            orderBy: { assignedAt: 'asc' as const },
            select: { id: true, memberId: true, assignedAt: true, member: { select: { id: true, name: true } } },
          },
          deliverables: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' as const },
            select: { id: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, externalProvider: true, externalId: true, approvalProcessInstanceId: true, approvalProcessCode: true, approvalFileId: true, approvalSpaceId: true, createdAt: true, uploader: { select: { id: true, name: true } } },
          },
          approvals: {
            orderBy: { createdAt: 'desc' as const },
            take: 5,
            select: { id: true, source: true, status: true, purpose: true, deliveryType: true, autoCompleteStatus: true, submitterName: true, approvalFileName: true, error: true, createdAt: true, completedAt: true },
          },
        },
      },
    },
  },
  edges: { select: { id: true, sourceNodeId: true, targetNodeId: true, dependencyType: true, lagDays: true } },
} as const

type VersionDetail = Prisma.WorkflowVersionGetPayload<{ select: typeof versionSelect }>

const serializeVersion = (version: VersionDetail | null) => version ? ({
  ...version,
  calendar: version.calendar ? {
    name: version.calendar.name,
    mode: version.calendar.mode,
    weekdays: version.calendar.weekdays,
    exceptions: version.calendar.exceptions.map((exception) => ({ ...exception, date: dateOnly(exception.date) })),
  } : null,
  nodes: version.nodes.map((node) => ({
    ...node,
    specialRelease: isSpecialReleaseForVersion(node.task?.execution?.specialRelease, version.id),
    schedules: node.schedules.map((schedule) => ({ ...schedule, plannedStart: dateOnly(schedule.plannedStart), plannedEnd: dateOnly(schedule.plannedEnd) })),
    task: node.task ? {
      execution: node.task.execution,
      closureChecks: node.task.closureChecks,
      assignees: node.task.assignees,
      approvals: node.task.approvals,
      deliverables: node.task.deliverables.map((deliverable) => ({ ...deliverable, sizeBytes: deliverable.sizeBytes === null ? null : Number(deliverable.sizeBytes) })),
    } : null,
  })),
}) : null

/**
 * L3 在有权访问的项目内查看完整流程节点、任务详情和交付物。
 * 写入权限仍由任务/项目写接口单独校验，不在读取序列化层放宽。
 * 保留 viewer/level 参数以兼容现有调用方和返回结构。
 */
async function serializeVersionForViewer(version: VersionDetail | null, _viewer: { memberId: string }, _level: ProjectAccessLevel) {
  void _viewer
  void _level
  return serializeVersion(version)
}

async function claimDepartmentNameMap(organizationId: string, tasks: { departmentIds: string[] }[]) {
  const departmentIds = [...new Set(tasks.flatMap((task) => task.departmentIds))]
  if (departmentIds.length === 0) return new Map<string, string>()
  const departments = await prisma.department.findMany({ where: { organizationId, id: { in: departmentIds } }, select: { id: true, name: true } })
  return new Map(departments.map((department) => [department.id, department.name]))
}

const claimDepartmentNames = (departmentIds: string[], names: Map<string, string>) => departmentIds.length === 0 ? ['全部部门'] : departmentIds.map((id) => names.get(id) ?? '已失效部门')

export async function registerProjectRoutes(app: FastifyInstance) {
  app.get('/api/v1/claim-task-departments', async (request, reply) => {
    const actor = await requireClaimTaskPublishPermission(request, reply)
    if (!actor) return
    return { data: await prisma.department.findMany({ where: { organizationId: actor.organizationId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) }
  })
  app.get('/api/v1/claim-tasks', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })

    const scope = await claimTaskScope(prisma, actor)
    const tasks = await prisma.claimTask.findMany({
      where: { organizationId: actor.organizationId, archivedAt: null, claimedByMemberId: null, OR: [{ publisherMemberId: actor.memberId }, scope] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true, progress: true, effortHours: true, durationDays: true, description: true, closureCriteria: true, departmentIds: true, publisher: { select: { name: true } } },
    })
    const departmentNames = await claimDepartmentNameMap(actor.organizationId, tasks)
    return { data: tasks.map((task) => ({ id: task.id, name: task.name, status: task.status, progress: task.progress, effort: task.effortHours, duration: task.durationDays, plannedStart: null, plannedEnd: null, description: task.description, closureCriteria: task.closureCriteria, publisherName: task.publisher.name, claimDepartmentIds: task.departmentIds, claimDepartmentNames: claimDepartmentNames(task.departmentIds, departmentNames) })) }
  })

  app.get('/api/v1/claim-tasks/mine', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })

    const tasks = await prisma.claimTask.findMany({
      where: { organizationId: actor.organizationId, archivedAt: null, claimedByMemberId: actor.memberId },
      orderBy: [{ claimedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, name: true, status: true, progress: true, effortHours: true, durationDays: true, description: true, closureCriteria: true, departmentIds: true, claimedAt: true, publisher: { select: { name: true } } },
    })
    const departmentNames = await claimDepartmentNameMap(actor.organizationId, tasks)
    return { data: tasks.map((task) => ({ id: task.id, name: task.name, status: task.status, progress: task.progress, effort: task.effortHours, duration: task.durationDays, plannedStart: null, plannedEnd: null, description: task.description, closureCriteria: task.closureCriteria, publisherName: task.publisher.name, claimDepartmentIds: task.departmentIds, claimDepartmentNames: claimDepartmentNames(task.departmentIds, departmentNames), claimedAt: task.claimedAt?.toISOString() ?? null })) }
  })

  app.get('/api/v1/my-tasks', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const visibleIds = await visibleProjectIds(actor)
    const tasks = await loadPublishedWorkflowTasks(prisma, { organizationId: actor.organizationId, projectIds: visibleIds, memberId: actor.memberId })
    return { data: tasks }
  })

  app.get('/api/v1/project-dashboard-metrics', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const visibleIds = await visibleProjectIds(actor)
    const projectFilter = visibleIds ? { id: { in: [...visibleIds] } } : {}

    const projects = await prisma.project.findMany({
      where: { organizationId, archivedAt: null, ...projectFilter },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        health: true,
        workflow: {
          select: {
            publishedVersion: { select: { id: true } },
            draftVersion: { select: { id: true } },
          },
        },
      },
    })
    const projectByVersion = new Map<string, (typeof projects)[number]>()
    for (const project of projects) {
      const version = project.workflow?.publishedVersion ?? project.workflow?.draftVersion
      if (version) projectByVersion.set(version.id, project)
    }
    const versionIds = [...projectByVersion.keys()]
    const nodes = versionIds.length === 0 ? [] : await prisma.workflowNode.findMany({
      where: { workflowVersionId: { in: versionIds }, nodeType: { in: ['TASK', 'MILESTONE'] } },
      select: {
        id: true,
        workflowVersionId: true,
        taskId: true,
        nodeType: true,
        name: true,
        ownerMemberId: true,
        effortHours: true,
        schedules: { orderBy: { computedAt: 'desc' }, take: 1, select: { plannedStart: true, plannedEnd: true } },
        task: { select: { execution: { select: { status: true } } } },
      },
    })
    const today = new Date().toISOString().slice(0, 10)
    const horizon = addDays(today, 30)
    const recentBoundary = addDays(today, -30)
    const milestones = nodes.flatMap((node) => {
      // Published workflow task nodes are projected as milestones in the
      // portfolio view.  A separate MILESTONE node remains supported for
      // compatibility, but it is no longer required to appear here.
      if (node.nodeType !== 'TASK' && node.nodeType !== 'MILESTONE') return []
      const schedule = node.schedules[0]
      const project = projectByVersion.get(node.workflowVersionId)
      if (!schedule || !project) return []
      const plannedStart = dateOnly(schedule.plannedStart)
      const plannedEnd = dateOnly(schedule.plannedEnd)
      const executionStatus = node.task?.execution?.status ?? 'NOT_STARTED'
      if (!plannedStart || !plannedEnd) return []
      // Keep the dashboard useful as a rolling view: show current/future
      // tasks and recently completed tasks, including overdue work.
      if (plannedStart > horizon || plannedEnd < recentBoundary) return []
      return [{ projectId: project.id, projectCode: project.code, projectName: project.name, taskId: node.taskId ?? undefined, name: node.name, plannedStart, plannedEnd, status: executionStatus, overdue: plannedEnd < today && !completedExecutionStatuses.has(executionStatus) }]
    }).sort((left, right) => left.plannedEnd.localeCompare(right.plannedEnd)).slice(0, 12)

    const memberIds = visibleIds ? await prisma.projectMember.findMany({ where: { projectId: { in: [...visibleIds] } }, select: { memberId: true }, distinct: ['memberId'] }) : null
    const members = await prisma.member.findMany({ where: { organizationId, status: 'ACTIVE', ...(memberIds ? { id: { in: memberIds.map((member) => member.memberId) } } : {}) }, select: { id: true, capacityHoursPerWeek: true } })
    const allocationByMember = new Map<string, number>()
    for (const node of nodes) {
      if (!node.ownerMemberId || node.effortHours <= 0 || completedExecutionStatuses.has(node.task?.execution?.status ?? 'NOT_STARTED')) continue
      const schedule = node.schedules[0]
      if (!schedule) continue
      const plannedStart = dateOnly(schedule.plannedStart)
      const plannedEnd = dateOnly(schedule.plannedEnd)
      if (!plannedStart || !plannedEnd) continue
      const overlapStart = plannedStart > today ? plannedStart : today
      const overlapEnd = plannedEnd < horizon ? plannedEnd : horizon
      if (overlapStart > overlapEnd) continue
      const share = inclusiveDays(overlapStart, overlapEnd) / inclusiveDays(plannedStart, plannedEnd)
      allocationByMember.set(node.ownerMemberId, (allocationByMember.get(node.ownerMemberId) ?? 0) + node.effortHours * share)
    }
    const capacityHours = members.reduce((sum, member) => sum + member.capacityHoursPerWeek * 30 / 7, 0)
    const allocatedHours = [...allocationByMember.values()].reduce((sum, hours) => sum + hours, 0)
    const overloadedMembers = members.filter((member) => (allocationByMember.get(member.id) ?? 0) > member.capacityHoursPerWeek * 30 / 7).length
    const roundHours = (value: number) => Math.round(value * 10) / 10
    const riskProjects = projects.filter((project) => project.health !== 'HEALTHY' || project.status === 'AT_RISK')
    const projectManagerGrantCount = isL1(actor) ? 1 : await prisma.projectRoleGrant.count({
      where: {
        memberId: actor.memberId,
        roleCode: 'L2',
        revokedAt: null,
        project: { organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } },
      },
    })
    const portfolioMetricsVisible = isL1(actor) || projectManagerGrantCount > 0
    return {
      data: {
        risks: portfolioMetricsVisible ? {
          total: riskProjects.length,
          high: projects.filter((project) => project.health === 'WARNING' || project.status === 'AT_RISK').length,
          attention: projects.filter((project) => project.health === 'ATTENTION').length,
        } : { total: 0, high: 0, attention: 0 },
        resource: portfolioMetricsVisible ? {
          allocatedHours: roundHours(allocatedHours),
          capacityHours: roundHours(capacityHours),
          utilizationPercent: capacityHours > 0 && allocatedHours > 0 ? Math.round(allocatedHours / capacityHours * 100) : null,
          overloadedMembers,
          memberCount: members.length,
        } : { allocatedHours: 0, capacityHours: 0, utilizationPercent: null, overloadedMembers: 0, memberCount: 0 },
        milestones,
        portfolioMetricsVisible,
      },
    }
  })

  app.get('/api/v1/project-portfolios', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const visibleIds = await visibleProjectIds(actor)

    const portfolios = await prisma.projectPortfolio.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        owner: { select: { id: true, name: true } },
        projects: { where: { archivedAt: null, ...(visibleIds ? { id: { in: [...visibleIds] } } : {}) }, select: { id: true }, orderBy: { code: 'asc' } },
      },
    })
    return { data: portfolios.map((portfolio) => ({ ...portfolio, projectIds: portfolio.projects.map((project) => project.id) })) }
  })

  app.get<{ Params: { portfolioId: string } }>('/api/v1/project-portfolios/:portfolioId/workflow', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const visibleIds = await visibleProjectIds(actor)
    const portfolio = await prisma.projectPortfolio.findFirst({
      where: { id: request.params.portfolioId, organizationId, archivedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        workflowSnapshot: true,
        projects: {
          where: { archivedAt: null, ...(visibleIds ? { id: { in: [...visibleIds] } } : {}) },
          orderBy: { code: 'asc' },
          select: { id: true, code: true, name: true, status: true, plannedStart: true, plannedEnd: true, owner: { select: { name: true } }, tasks: { where: { archivedAt: null }, select: { execution: { select: { progress: true } } } } },
        },
      },
    })
    if (!portfolio) return reply.code(404).send({ error: 'portfolio_not_found' })
    const workflow = normalizePortfolioWorkflow(portfolio.id, portfolio.projects, portfolio.workflowSnapshot)
    return { data: { ...workflow, portfolio: { id: portfolio.id, code: portfolio.code, name: portfolio.name } } }
  })

  app.get('/api/v1/projects', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })
    const visibleIds = await visibleProjectIds(actor)

    const projects = await prisma.project.findMany({
      where: { organizationId, archivedAt: null, ...(visibleIds ? { id: { in: [...visibleIds] } } : {}) },
      orderBy: [{ updatedAt: 'desc' }, { code: 'asc' }],
      select: projectSummarySelect,
    })
    const summaries = await Promise.all(projects.map(async (project) => {
      const summary = projectSummary(project)
      const access = await projectAccess(actor, project.id)
      const withAccess = { ...summary, accessLevel: access?.level ?? 'L3' }
      return access?.level === 'L3' ? { ...withAccess, budgetAmount: null, actualCostAmount: null, memberIds: [actor.memberId] } : withAccess
    }))
    return { data: summaries }
  })

  app.get<{ Params: ProjectParams; Querystring: { limit?: string } }>('/api/v1/projects/:projectId/audit-logs', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'audit.read')
    if (!guard) return
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const requestedLimit = Number(request.query.limit ?? 50)
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50
    const logs = await prisma.auditLog.findMany({
      where: { organizationId: guard.actor.organizationId, projectId: project.id, resourceType: 'WORKFLOW_VERSION', action: { in: ['WORKFLOW_DRAFT_SAVED', 'WORKFLOW_PUBLISHED_UPDATED', 'WORKFLOW_PUBLISHED'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, action: true, resourceType: true, resourceId: true, actorMemberId: true, beforeJson: true, afterJson: true, createdAt: true, actor: { select: { name: true } } },
    })
    const compactedLogs = logs.filter((log) => hasWorkflowAuditChanges(log.beforeJson, log.afterJson)).reduce<typeof logs>((result, log) => {
      const previous = result.at(-1)
      const sameSaveBurst = previous && previous.action === 'WORKFLOW_DRAFT_SAVED' && log.action === 'WORKFLOW_DRAFT_SAVED' && previous.resourceId === log.resourceId && previous.actorMemberId === log.actorMemberId && previous.createdAt.getTime() - log.createdAt.getTime() <= 2000
      if (sameSaveBurst) {
        previous.beforeJson = log.beforeJson
        return result
      }
      result.push(log)
      return result
    }, [])
    return {
      data: compactedLogs.slice(0, limit).map((log) => {
        const after = log.afterJson && typeof log.afterJson === 'object' ? log.afterJson as { versionNo?: unknown; status?: unknown } : null
        return {
          id: log.id,
          action: log.action,
          resourceType: log.resourceType,
          resourceId: log.resourceId,
          actorMemberId: log.actorMemberId,
          actorName: log.actor?.name ?? '系统',
          createdAt: log.createdAt.toISOString(),
          versionNo: typeof after?.versionNo === 'number' ? after.versionNo : null,
          status: typeof after?.status === 'string' ? after.status : null,
          summary: summarizeWorkflowAudit(log.action as 'WORKFLOW_DRAFT_SAVED' | 'WORKFLOW_PUBLISHED_UPDATED' | 'WORKFLOW_PUBLISHED', log.beforeJson, log.afterJson),
        }
      }),
    }
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/members', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'project.read')
    if (!guard) return
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    if (guard.access.level === 'L3') return { data: { members: [] } }
    const members = await prisma.projectMember.findMany({
      where: { projectId: request.params.projectId, member: { status: 'ACTIVE' } },
      orderBy: { member: { name: 'asc' } },
      select: { member: { select: { id: true, name: true } } },
    })
    return { data: { members: members.map(({ member }) => member) } }
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/assignee-options', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'task.configure')
    if (!guard) return
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const members = await prisma.member.findMany({
      where: { organizationId: guard.actor.organizationId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    })
    return { data: { members } }
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/workflow', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.read')
    if (!guard) return
    const organizationId = organizationIdFor(request)
    if (!organizationId) return reply.code(400).send({ error: 'organization_required' })

    const project = await prisma.project.findFirst({
      where: { id: request.params.projectId, organizationId, archivedAt: null },
      select: { id: true, code: true, name: true, workflow: { select: { id: true, draftVersionId: true, publishedVersionId: true } } },
    })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })

    // 执行/监督视图固定看已发布版本（草稿仅对可编辑角色开放）。
    const preferredVersionId = guard.access.level === 'SUPERVISOR' || guard.access.level === 'L3'
      ? (project.workflow?.publishedVersionId ?? project.workflow?.draftVersionId)
      : (project.workflow?.draftVersionId ?? project.workflow?.publishedVersionId)
    const selectedVersionId = preferredVersionId
    const selectedVersion = selectedVersionId ? await prisma.workflowVersion.findUnique({ where: { id: selectedVersionId }, select: versionSelect }) : null
    const publishedVersionId = project.workflow?.publishedVersionId
    const publishedVersion = publishedVersionId && publishedVersionId !== selectedVersionId
      ? await prisma.workflowVersion.findUnique({ where: { id: publishedVersionId }, select: versionSelect })
      : null

    return {
      data: {
        ...project,
        workflow: project.workflow ? {
          ...project.workflow,
          draftVersion: selectedVersion?.status === 'DRAFT' ? await serializeVersionForViewer(selectedVersion, guard.actor, guard.access.level) : null,
          publishedVersion: selectedVersion?.status === 'PUBLISHED' ? await serializeVersionForViewer(selectedVersion, guard.actor, guard.access.level) : await serializeVersionForViewer(publishedVersion, guard.actor, guard.access.level),
        } : null,
      },
    }
  })
}

export { dateOnly, projectSummary, projectSummarySelect, serializeVersion, serializeVersionForViewer, versionSelect }
