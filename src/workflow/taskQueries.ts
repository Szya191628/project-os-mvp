import type { Project, TaskStatus, Workflow, WorkflowNode } from '../types'
import { scheduleWorkflow } from './schedule.ts'

export interface TaskSummary {
  id: string
  projectId: string
  projectCode: string
  projectName: string
  projectStatus: Project['status']
  workflowStatus: Workflow['status']
  wbs: string
  name: string
  owner: string
  ownerMemberId?: string
  assigneeIds: string[]
  status: TaskStatus
  progress: number
  effort: number
  plannedStart?: string
  plannedEnd?: string
  actualStart?: string
  actualEnd?: string
  blockedBy: string[]
  overdue: boolean
  milestone: boolean
}

export function getTaskSummaries(project: Project, workflow: Workflow | undefined, today = todayIso()): TaskSummary[] {
  if (!workflow) return []
  const schedule = scheduleWorkflow(workflow)
  return workflow.nodes
    .filter((node) => node.type === 'task' || node.type === 'milestone')
    .map((node) => {
      const predecessors = workflow.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => workflow.nodes.find((candidate) => candidate.id === edge.source))
        .filter((candidate): candidate is WorkflowNode => Boolean(candidate && candidate.type !== 'start' && candidate.type !== 'end'))
      const blockedBy = node.specialRelease ? [] : predecessors.filter((candidate) => !isCompletionStatus(candidate.status)).map((candidate) => candidate.name)
      const planned = schedule.schedules[node.id]
      const complete = isCompletionStatus(node.status)
      const plannedEnd = planned?.plannedEnd ?? node.plannedEnd
      return {
        id: node.id,
        projectId: node.projectId,
        projectCode: project.code,
        projectName: project.name,
        projectStatus: project.status,
        workflowStatus: workflow.status,
        wbs: node.wbs,
        name: node.name,
        owner: node.owner,
        ownerMemberId: node.ownerMemberId,
        assigneeIds: node.assigneeIds ?? [],
        status: blockedBy.length > 0 && !complete ? '受阻' : node.status,
        progress: node.progress,
        effort: node.effort,
        plannedStart: planned?.plannedStart ?? node.plannedStart,
        plannedEnd,
        actualStart: node.actualStart,
        actualEnd: node.actualEnd,
        blockedBy,
        overdue: !complete && Boolean(plannedEnd && plannedEnd < today),
        milestone: node.type === 'milestone',
      }
    })
}

export function dedupeTaskSummaries(tasks: TaskSummary[]) {
  const unique = new Map<string, TaskSummary>()
  for (const task of tasks) {
    const key = `${task.projectId}:${task.wbs}`
    const existing = unique.get(key)
    if (!existing || (existing.workflowStatus === 'draft' && task.workflowStatus === 'published')) unique.set(key, task)
  }
  return [...unique.values()]
}

export function groupTaskSummariesByProject(tasks: TaskSummary[]) {
  const groups = new Map<string, { projectId: string; projectCode: string; projectName: string; tasks: TaskSummary[] }>()
  for (const task of tasks) {
    const group = groups.get(task.projectId)
    if (group) group.tasks.push(task)
    else groups.set(task.projectId, { projectId: task.projectId, projectCode: task.projectCode, projectName: task.projectName, tasks: [task] })
  }
  return [...groups.values()]
}

export function isCompletionStatus(status: WorkflowNode['status']) {
  return status === '已完成' || status === '提前结束' || status === '如期结束' || status === '超期结束'
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}
