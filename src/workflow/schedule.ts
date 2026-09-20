import type { WorkCalendarConfig, Workflow, WorkflowEdge, WorkflowNode } from '../types'

export interface ScheduledNode {
  plannedStart: string
  plannedEnd: string
  startOffset: number
  endOffset: number
  calendarStartOffset: number
  calendarSpan: number
}

export interface ScheduleIssue {
  code: 'duplicate-node' | 'missing-node' | 'cycle' | 'invalid-duration' | 'invalid-calendar'
  message: string
  nodeIds: string[]
}

export interface ScheduleResult {
  schedules: Record<string, ScheduledNode>
  changedNodeIds: string[]
  issues: ScheduleIssue[]
}

export interface ScheduleChange {
  nodeId: string
  before?: ScheduledNode
  after?: ScheduledNode
}

const DAY_MS = 24 * 60 * 60 * 1000

export const defaultWorkCalendar: WorkCalendarConfig = {
  mode: 'natural',
  name: '项目自然日',
  weeklyWorkdays: [1, 2, 3, 4, 5],
  holidays: [],
  customRestDays: [],
  makeupWorkdays: [],
}

function toUtcDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function addDays(date: string, days: number) {
  const result = toUtcDate(date)
  result.setTime(result.getTime() + days * DAY_MS)
  return formatDate(result)
}

function normalizeDateList(values: string[] | undefined) {
  return [...new Set((values ?? []).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort()
}

export function normalizeWorkCalendar(calendar?: Partial<WorkCalendarConfig>): WorkCalendarConfig {
  const weeklyWorkdays = [...new Set((calendar?.weeklyWorkdays ?? defaultWorkCalendar.weeklyWorkdays).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((first, second) => first - second)
  return {
    mode: calendar?.mode === 'working' ? 'working' : 'natural',
    name: calendar?.name?.trim() || (calendar?.mode === 'working' ? '标准工作日历' : defaultWorkCalendar.name),
    weeklyWorkdays: weeklyWorkdays.length > 0 ? weeklyWorkdays : [...defaultWorkCalendar.weeklyWorkdays],
    holidays: normalizeDateList(calendar?.holidays),
    customRestDays: normalizeDateList(calendar?.customRestDays),
    makeupWorkdays: normalizeDateList(calendar?.makeupWorkdays),
  }
}

export function isWorkingDate(value: string, calendarInput?: Partial<WorkCalendarConfig>) {
  const calendar = normalizeWorkCalendar(calendarInput)
  if (calendar.mode === 'natural') return true
  if (calendar.makeupWorkdays.includes(value)) return true
  if (calendar.holidays.includes(value) || calendar.customRestDays.includes(value)) return false
  return calendar.weeklyWorkdays.includes(toUtcDate(value).getUTCDay())
}

function nextWorkingDate(date: string, calendar: WorkCalendarConfig) {
  if (calendar.mode === 'natural') return date
  let cursor = toUtcDate(date)
  while (!isWorkingDate(formatDate(cursor), calendar)) {
    cursor = new Date(cursor.getTime() + DAY_MS)
  }
  return formatDate(cursor)
}

export function addScheduleDays(date: string, days: number, calendarInput?: Partial<WorkCalendarConfig>) {
  const calendar = normalizeWorkCalendar(calendarInput)
  const count = Math.max(0, Math.floor(days))
  if (calendar.mode === 'natural') return addDays(date, count)
  let cursor = toUtcDate(nextWorkingDate(date, calendar))
  let remaining = count
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + DAY_MS)
    if (isWorkingDate(formatDate(cursor), calendar)) remaining -= 1
  }
  return formatDate(cursor)
}

export function calendarDateOffset(from: string, to: string) {
  return Math.max(0, Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / DAY_MS))
}

function incomingEdges(nodeId: string, edges: WorkflowEdge[]) {
  return edges.filter((edge) => edge.target === nodeId)
}

const completionStatuses = new Set<WorkflowNode['status']>(['已完成', '提前结束', '如期结束', '超期结束'])

export function isCompletionApproved(node: Pick<WorkflowNode, 'status' | 'completionApprovalStatus'>) {
  // A completed status is effective only after the DingTalk approval outcome
  // has been written back. Undefined keeps old local/demo workflow data usable.
  return completionStatuses.has(node.status) && (node.completionApprovalStatus === undefined || node.completionApprovalStatus === 'approved')
}

function effectiveFinishDate(node: WorkflowNode | undefined, schedule: ScheduledNode | undefined) {
  if (node && isCompletionApproved(node)) return node.completionConfirmedAt ?? node.actualEnd ?? schedule?.plannedEnd
  return schedule?.plannedEnd
}

function getTopologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[], issues: ScheduleIssue[]) {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({ code: 'missing-node', message: `依赖 ${edge.id} 指向不存在的节点`, nodeIds: [edge.source, edge.target] })
      continue
    }
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.get(edge.source)?.push(edge.target)
  }

  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    order.push(current)
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1
      indegree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }

  if (order.length !== nodes.length) {
    const cycleNodes = nodes.filter((node) => !order.includes(node.id)).map((node) => node.id)
    issues.push({ code: 'cycle', message: '流程存在循环依赖，无法计算排期', nodeIds: cycleNodes })
  }

  return order
}

function findChangedNodeIds(nodes: WorkflowNode[], schedules: Record<string, ScheduledNode>) {
  return nodes.filter((node) => node.plannedStart !== schedules[node.id]?.plannedStart || node.plannedEnd !== schedules[node.id]?.plannedEnd).map((node) => node.id)
}

export function scheduleWorkflow(workflow: Workflow): ScheduleResult {
  const issues: ScheduleIssue[] = []
  const calendar = normalizeWorkCalendar(workflow.calendar)
  if (calendar.mode === 'working' && calendar.weeklyWorkdays.length === 0) {
    issues.push({ code: 'invalid-calendar', message: '工作日历至少需要配置一个每周工作日', nodeIds: [] })
  }
  const nodeIds = new Set<string>()
  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) issues.push({ code: 'duplicate-node', message: `节点 ${node.id} 重复`, nodeIds: [node.id] })
    nodeIds.add(node.id)
    if (node.duration < 0 || !Number.isFinite(node.duration)) issues.push({ code: 'invalid-duration', message: `节点“${node.name}”的工期无效`, nodeIds: [node.id] })
  }

  const order = getTopologicalOrder(workflow.nodes, workflow.edges, issues)
  const schedules: Record<string, ScheduledNode> = {}
  for (const nodeId of order) {
    const node = workflow.nodes.find((candidate) => candidate.id === nodeId)!
    const predecessors = incomingEdges(node.id, workflow.edges)
    const predecessorStarts = predecessors.map((edge) => {
      const predecessorNode = workflow.nodes.find((candidate) => candidate.id === edge.source)
      const predecessorFinish = effectiveFinishDate(predecessorNode, schedules[edge.source])
      return predecessorFinish ? addScheduleDays(predecessorFinish, edge.lagDays, calendar) : workflow.baselineStart
    }).filter(Boolean)
    const automaticStart = predecessorStarts.length > 0
      ? predecessorStarts.sort().at(-1)!
      : nextWorkingDate(workflow.baselineStart, calendar)
    const duration = node.type === 'start' || node.type === 'end' || node.type === 'milestone' ? 0 : Math.max(0, node.duration)
    const overrideStart = normalizeOverrideDate(node.plannedStartOverride)
    const overrideEnd = normalizeOverrideDate(node.plannedEndOverride)
    const hasCompleteOverride = Boolean(overrideStart && overrideEnd && overrideStart <= overrideEnd)
    const actualStart = normalizeOverrideDate(node.actualStart)
    const plannedStart = actualStart ?? (hasCompleteOverride ? overrideStart! : automaticStart)
    const plannedEnd = actualStart ? addScheduleDays(plannedStart, duration, calendar) : hasCompleteOverride ? overrideEnd! : addScheduleDays(plannedStart, duration, calendar)
    const calendarStartOffset = calendarDateOffset(workflow.baselineStart, plannedStart)
    const calendarSpan = calendarDateOffset(plannedStart, plannedEnd)
    const startOffset = calendar.mode === 'working' ? countWorkingSteps(workflow.baselineStart, plannedStart, calendar) : calendarStartOffset
    const endOffset = startOffset + duration
    schedules[node.id] = {
      startOffset,
      endOffset,
      plannedStart,
      plannedEnd,
      calendarStartOffset,
      calendarSpan,
    }
  }

  return { schedules, changedNodeIds: findChangedNodeIds(workflow.nodes, schedules), issues }
}

function normalizeOverrideDate(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function countWorkingSteps(from: string, to: string, calendar: WorkCalendarConfig) {
  if (from >= to) return 0
  let cursor = toUtcDate(from)
  const end = toUtcDate(to)
  let count = 0
  while (cursor.getTime() < end.getTime()) {
    cursor = new Date(cursor.getTime() + DAY_MS)
    if (isWorkingDate(formatDate(cursor), calendar)) count += 1
  }
  return count
}

export function diffSchedules(before: ScheduleResult, after: ScheduleResult): ScheduleChange[] {
  const nodeIds = new Set([...Object.keys(before.schedules), ...Object.keys(after.schedules)])
  return [...nodeIds].filter((nodeId) => {
    const previous = before.schedules[nodeId]
    const next = after.schedules[nodeId]
    return previous?.plannedStart !== next?.plannedStart || previous?.plannedEnd !== next?.plannedEnd
  }).map((nodeId) => ({ nodeId, before: before.schedules[nodeId], after: after.schedules[nodeId] }))
}
