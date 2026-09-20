import type { AgentProjectSnapshot, AgentScopeLevel } from './types.js'

const completedStatuses = new Set(['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'])

export function resolveDeliverableTarget(message: string, projects: AgentProjectSnapshot[], scopeLevel: AgentScopeLevel) {
  const wbs = message.match(/\b\d+(?:\.\d+)+\b/u)?.[0]
  const normalized = message.toLowerCase()
  const tasks = projects.flatMap((project) => project.tasks)
  const explicit = tasks.find((task) => (wbs && task.wbs === wbs) || normalized.includes(task.name.toLowerCase()))
  if (explicit) return explicit
  if (scopeLevel !== 'L3') return undefined
  const ownActiveTasks = tasks.filter((task) => task.isMine && !completedStatuses.has(task.status))
  return ownActiveTasks.length === 1 ? ownActiveTasks[0] : undefined
}
