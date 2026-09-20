import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isGlobalL2, isL1, visibleProjectIds } from '../auth.js'
import { prisma } from '../db.js'
import { loadPublishedWorkflowTasks } from '../publishedTasks.js'

type ResourceQuery = { from?: string; to?: string }

const completedStatuses = new Set(['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'])
const datePattern = /^\d{4}-\d{2}-\d{2}$/u
const dayMs = 24 * 60 * 60 * 1000

function dateOnly(value: Date | null | undefined) {
  return value?.toISOString().slice(0, 10) ?? null
}

function dayNumber(value: string) {
  return Date.parse(`${value}T00:00:00.000Z`)
}

function validDate(value: string | undefined) {
  if (!value || !datePattern.test(value)) return undefined
  const parsed = dayNumber(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : undefined
}

function addDays(value: string, days: number) {
  const date = new Date(dayNumber(value))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function mondayOf(value: string) {
  const date = new Date(dayNumber(value))
  const weekday = date.getUTCDay()
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1
  return addDays(value, -daysSinceMonday)
}

function roundHours(value: number) {
  return Math.round(value * 10) / 10
}

function initials(value: string) {
  return [...value.trim()].slice(0, 2).join('').toUpperCase() || 'PM'
}

function overlapDays(start: string | null, end: string | null, rangeStart: string, rangeEnd: string) {
  if (!start || !end || start > rangeEnd || end < rangeStart) return 0
  const overlapStart = start > rangeStart ? start : rangeStart
  const overlapEnd = end < rangeEnd ? end : rangeEnd
  return Math.max(0, Math.floor((dayNumber(overlapEnd) - dayNumber(overlapStart)) / dayMs) + 1)
}

async function canViewResourceLoad(actor: NonNullable<FastifyRequest['actor']>) {
  if (isL1(actor) || isGlobalL2(actor)) return true
  const grant = await prisma.projectRoleGrant.findFirst({
    where: {
      memberId: actor.memberId,
      roleCode: 'L2',
      revokedAt: null,
      project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } },
    },
    select: { id: true },
  })
  return Boolean(grant)
}

export async function registerResourceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ResourceQuery }>('/api/v1/resources/load', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    if (!(await canViewResourceLoad(actor))) return reply.code(403).send({ error: 'forbidden', permission: 'metrics.portfolio.read' })

    const today = new Date().toISOString().slice(0, 10)
    const requestedFrom = request.query.from
    const requestedTo = request.query.to
    const from = requestedFrom ? validDate(requestedFrom) : mondayOf(today)
    const to = requestedTo ? validDate(requestedTo) : addDays(from ?? mondayOf(today), 41)
    if ((requestedFrom && !from) || (requestedTo && !to)) return reply.code(400).send({ error: 'resource_date_invalid' })
    if (!from || !to || dayNumber(to) < dayNumber(from)) return reply.code(400).send({ error: 'resource_date_range_invalid' })
    if (dayNumber(to) - dayNumber(from) > 84 * dayMs) return reply.code(400).send({ error: 'resource_date_range_too_large' })

    const allOrganizationAccess = isL1(actor) || isGlobalL2(actor)
    const visibleIds = allOrganizationAccess ? null : await visibleProjectIds(actor)
    const projectFilter = visibleIds ? { id: { in: [...visibleIds] } } : {}
    const projects = await prisma.project.findMany({
      where: { organizationId: actor.organizationId, archivedAt: null, ...projectFilter },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        members: { select: { memberId: true } },
      },
    })
    const publishedTasks = await loadPublishedWorkflowTasks(prisma, { organizationId: actor.organizationId, projectIds: visibleIds })
    const claimTasks = allOrganizationAccess ? await prisma.claimTask.findMany({
      where: { organizationId: actor.organizationId, archivedAt: null, claimedByMemberId: { not: null }, claimedBy: { status: 'ACTIVE' } },
      orderBy: [{ claimedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        closureCriteria: true,
        durationDays: true,
        effortHours: true,
        status: true,
        progress: true,
        claimedByMemberId: true,
        claimedAt: true,
        createdAt: true,
        claimedBy: { select: { name: true } },
      },
    }) : []

    const candidateMemberIds = new Set(projects.flatMap((project) => project.members.map((member) => member.memberId)))
    for (const task of publishedTasks) {
      if (task.ownerMemberId) candidateMemberIds.add(task.ownerMemberId)
      for (const assigneeId of task.assigneeIds) candidateMemberIds.add(assigneeId)
    }
    for (const claimTask of claimTasks) {
      if (claimTask.claimedByMemberId) candidateMemberIds.add(claimTask.claimedByMemberId)
    }
    const members = await prisma.member.findMany({
      where: { organizationId: actor.organizationId, status: 'ACTIVE', ...(visibleIds ? { id: { in: [...candidateMemberIds] } } : {}) },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        roleTitle: true,
        capacityHoursPerWeek: true,
        department: { select: { id: true, name: true, parentId: true } },
        memberDepartments: { select: { department: { select: { id: true, name: true, parentId: true } } } },
      },
    })
    const memberById = new Map(members.map((member) => [member.id, member]))

    const weeks = [] as { startDate: string; endDate: string; label: string; days: number }[]
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 7)) {
      const endDate = addDays(cursor, 6) < to ? addDays(cursor, 6) : to
      weeks.push({ startDate: cursor, endDate, label: `${cursor.slice(5).replace('-', '/')}`, days: Math.max(1, Math.floor((dayNumber(endDate) - dayNumber(cursor)) / dayMs) + 1) })
    }

    type ResourceTask = {
      id: string
      projectId: string
      projectCode: string
      projectName: string
      projectStatus: string
      wbs: string
      name: string
      status: string
      progress: number
      effortHours: number
      allocatedHours: number
      plannedStart: string | null
      plannedEnd: string | null
      actualStart: string | null
      actualEnd: string | null
      ownerMemberId: string | null
      ownerName: string | null
      description: string | null
      closureCriteria: string | null
      deliverableCount: number
      closureCheckCount: number
      completedClosureCheckCount: number
    }

    const taskRowsByMember = new Map<string, ResourceTask[]>()
    const weeklyAllocationByMember = new Map<string, number[]>()
    const taskIds = new Set<string>()
    const pendingTaskIds = new Set<string>()
    const unassignedTaskIds = new Set<string>()

    const memberAllocation = (memberId: string) => {
      const existing = weeklyAllocationByMember.get(memberId)
      if (existing) return existing
      const created = weeks.map(() => 0)
      weeklyAllocationByMember.set(memberId, created)
      return created
    }

    for (const publishedTask of publishedTasks) {
      taskIds.add(publishedTask.id)
      const executionStatus = publishedTask.status
      const completed = completedStatuses.has(executionStatus)
      if (!completed) pendingTaskIds.add(publishedTask.id)
      const plannedStart = publishedTask.plannedStart
      const plannedEnd = publishedTask.plannedEnd
      const assignmentIds = publishedTask.assigneeIds.filter((memberId) => memberById.has(memberId))
      if (assignmentIds.length === 0) {
        unassignedTaskIds.add(publishedTask.id)
        continue
      }

      const assignmentShare = 1 / assignmentIds.length
      const weeklyHours = weeks.map((week) => {
        if (completed || publishedTask.effort <= 0 || !plannedStart || !plannedEnd) return 0
        const taskDays = overlapDays(plannedStart, plannedEnd, plannedStart, plannedEnd)
        const weekDays = overlapDays(plannedStart, plannedEnd, week.startDate, week.endDate)
        return taskDays > 0 ? publishedTask.effort * assignmentShare * weekDays / taskDays : 0
      })
      const allocatedHours = roundHours(weeklyHours.reduce((sum, hours) => sum + hours, 0))
      const task: ResourceTask = {
        id: publishedTask.id,
        projectId: publishedTask.projectId,
        projectCode: publishedTask.projectCode,
        projectName: publishedTask.projectName,
        projectStatus: publishedTask.projectStatus,
        wbs: publishedTask.wbs,
        name: publishedTask.name,
        status: executionStatus,
        progress: publishedTask.progress,
        effortHours: publishedTask.effort,
        allocatedHours,
        plannedStart,
        plannedEnd,
        actualStart: publishedTask.actualStart,
        actualEnd: publishedTask.actualEnd,
        ownerMemberId: publishedTask.ownerMemberId,
        ownerName: publishedTask.owner,
        description: publishedTask.description,
        closureCriteria: publishedTask.closureCriteria,
        deliverableCount: publishedTask.deliverableCount,
        closureCheckCount: publishedTask.closureCheckCount,
        completedClosureCheckCount: publishedTask.completedClosureCheckCount,
      }
      for (const memberId of assignmentIds) {
        taskRowsByMember.set(memberId, [...(taskRowsByMember.get(memberId) ?? []), task])
        const allocation = memberAllocation(memberId)
        weeklyHours.forEach((hours, index) => { allocation[index] = (allocation[index] ?? 0) + hours })
      }
    }

    for (const claimTask of claimTasks) {
      const memberId = claimTask.claimedByMemberId
      if (!memberId || !memberById.has(memberId)) continue
      const taskId = `claim:${claimTask.id}`
      const status = String(claimTask.status)
      const completed = completedStatuses.has(status)
      taskIds.add(taskId)
      if (!completed) pendingTaskIds.add(taskId)
      const plannedStart = dateOnly(claimTask.claimedAt ?? claimTask.createdAt)
      const plannedEnd = plannedStart ? addDays(plannedStart, Math.max(0, claimTask.durationDays - 1)) : null
      const weeklyHours = weeks.map((week) => {
        if (completed || claimTask.effortHours <= 0 || !plannedStart || !plannedEnd) return 0
        const taskDays = overlapDays(plannedStart, plannedEnd, plannedStart, plannedEnd)
        const weekDays = overlapDays(plannedStart, plannedEnd, week.startDate, week.endDate)
        return taskDays > 0 ? claimTask.effortHours * weekDays / taskDays : 0
      })
      const task: ResourceTask = {
        id: taskId,
        projectId: '',
        projectCode: '独立任务',
        projectName: '组织级独立任务',
        projectStatus: 'INDEPENDENT',
        wbs: '独立任务',
        name: claimTask.name,
        status,
        progress: claimTask.progress,
        effortHours: claimTask.effortHours,
        allocatedHours: roundHours(weeklyHours.reduce((sum, hours) => sum + hours, 0)),
        plannedStart,
        plannedEnd,
        actualStart: null,
        actualEnd: null,
        ownerMemberId: memberId,
        ownerName: claimTask.claimedBy?.name ?? null,
        description: claimTask.description,
        closureCriteria: claimTask.closureCriteria,
        deliverableCount: 0,
        closureCheckCount: 0,
        completedClosureCheckCount: 0,
      }
      taskRowsByMember.set(memberId, [...(taskRowsByMember.get(memberId) ?? []), task])
      const allocation = memberAllocation(memberId)
      weeklyHours.forEach((hours, index) => { allocation[index] = (allocation[index] ?? 0) + hours })
    }

    const memberViews = members.map((member) => {
      const taskRows = taskRowsByMember.get(member.id) ?? []
      const allocation = weeklyAllocationByMember.get(member.id) ?? weeks.map(() => 0)
      const memberWeeks = weeks.map((week, index) => {
        const capacityHours = roundHours(member.capacityHoursPerWeek * week.days / 7)
        const allocatedHours = roundHours(allocation[index] ?? 0)
        return { startDate: week.startDate, endDate: week.endDate, label: week.label, allocatedHours, capacityHours, utilizationPercent: capacityHours > 0 ? Math.round(allocatedHours / capacityHours * 100) : 0 }
      })
      const capacityHours = roundHours(memberWeeks.reduce((sum, week) => sum + week.capacityHours, 0))
      const allocatedHours = roundHours(memberWeeks.reduce((sum, week) => sum + week.allocatedHours, 0))
      const projectNames = [...new Set(taskRows.map((task) => task.projectName))]
      const linkedDepartments = member.memberDepartments.map(({ department }) => department)
      const leafDepartments = linkedDepartments.filter((department) => !linkedDepartments.some((candidate) => candidate.parentId === department.id))
      const resourceDepartment = [...leafDepartments].sort((left, right) => {
        const leftPrimary = left.id === member.department?.id ? 0 : 1
        const rightPrimary = right.id === member.department?.id ? 0 : 1
        return leftPrimary - rightPrimary || left.name.localeCompare(right.name, 'zh-CN')
      })[0] ?? member.department
      return {
        id: member.id,
        name: member.name,
        initials: initials(member.name),
        roleTitle: member.roleTitle,
        department: resourceDepartment ? { id: resourceDepartment.id, name: resourceDepartment.name } : null,
        departments: linkedDepartments.map(({ id, name }) => ({ id, name })),
        capacityHoursPerWeek: member.capacityHoursPerWeek,
        projectCount: new Set(taskRows.map((task) => task.projectId).filter(Boolean)).size,
        taskCount: taskRows.length,
        pendingTaskCount: taskRows.filter((task) => !completedStatuses.has(task.status)).length,
        activeTaskCount: taskRows.filter((task) => task.status === 'IN_PROGRESS').length,
        blockedTaskCount: taskRows.filter((task) => task.status === 'BLOCKED').length,
        projectNames,
        plannedHours: allocatedHours,
        capacityHours,
        availableHours: roundHours(Math.max(0, capacityHours - allocatedHours)),
        weeks: memberWeeks,
        tasks: [...taskRows].sort((left, right) => `${left.projectCode}-${left.wbs}`.localeCompare(`${right.projectCode}-${right.wbs}`, 'zh-CN')),
      }
    })

    const groups = [...new Map(memberViews.map((member) => [member.department?.id ?? 'ungrouped', member.department ? { id: member.department.id, name: member.department.name } : { id: null, name: '未分组' }])).values()]
      .map((group) => {
        const groupMembers = memberViews.filter((member) => (member.department?.id ?? 'ungrouped') === (group.id ?? 'ungrouped'))
        const groupTaskIds = new Set(groupMembers.flatMap((member) => member.tasks.map((task) => task.id)))
        const groupPendingTaskIds = new Set(groupMembers.flatMap((member) => member.tasks.filter((task) => !completedStatuses.has(task.status)).map((task) => task.id)))
        return {
          ...group,
          memberCount: groupMembers.length,
          taskCount: groupTaskIds.size,
          pendingTaskCount: groupPendingTaskIds.size,
          plannedHours: roundHours(groupMembers.reduce((sum, member) => sum + member.plannedHours, 0)),
          capacityHours: roundHours(groupMembers.reduce((sum, member) => sum + member.capacityHours, 0)),
          availableHours: roundHours(groupMembers.reduce((sum, member) => sum + member.availableHours, 0)),
          overloadedMemberCount: groupMembers.filter((member) => member.weeks.some((week) => week.utilizationPercent > 100)).length,
          members: groupMembers,
        }
      })
      .sort((left, right) => left.id === null ? 1 : right.id === null ? -1 : left.name.localeCompare(right.name, 'zh-CN'))

    const conflicts = memberViews.flatMap((member) => member.weeks.filter((week) => week.utilizationPercent > 100).map((week) => ({
      memberId: member.id,
      memberName: member.name,
      groupName: member.department?.name ?? '未分组',
      week,
      tasks: member.tasks.filter((task) => !completedStatuses.has(task.status) && overlapDays(task.plannedStart, task.plannedEnd, week.startDate, week.endDate) > 0).map((task) => ({ id: task.id, projectName: task.projectName, wbs: task.wbs, name: task.name })),
    }))).sort((left, right) => right.week.utilizationPercent - left.week.utilizationPercent)

    const capacityHours = roundHours(memberViews.reduce((sum, member) => sum + member.capacityHours, 0))
    const allocatedHours = roundHours(memberViews.reduce((sum, member) => sum + member.plannedHours, 0))
    return {
      data: {
        range: { from, to },
        weeks: weeks.map(({ startDate, endDate, label }) => ({ startDate, endDate, label })),
        summary: {
          totalTaskCount: taskIds.size,
          pendingTaskCount: pendingTaskIds.size,
          unassignedTaskCount: unassignedTaskIds.size,
          memberCount: memberViews.length,
          groupCount: groups.length,
          allocatedHours,
          capacityHours,
          availableHours: roundHours(memberViews.reduce((sum, member) => sum + member.availableHours, 0)),
          availableMemberCount: memberViews.filter((member) => member.availableHours > 0).length,
          overloadedMemberCount: new Set(conflicts.map((conflict) => conflict.memberId)).size,
        },
        conflicts,
        groups,
      },
    }
  })
}
