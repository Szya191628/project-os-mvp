export type TaskMenuAction = 'view' | 'view-progress' | 'direct-start' | 'submit-approval' | 'special-release' | 'edit' | 'approval-history'

export type TaskMenuInput = {
  hasTaskId: boolean
  isCompleted: boolean
  isNotStarted: boolean
  hasBlockingPredecessors: boolean
  hasPendingApproval: boolean
  hasSpecialRelease: boolean
  canDirectStart: boolean
  isL3: boolean
  isOwnTask: boolean
  canViewProgress: boolean
  canSubmitApproval: boolean
  canEdit: boolean
}

export function getTaskMenuActions(input: TaskMenuInput): TaskMenuAction[] {
  if (!input.hasTaskId) return []
  const canDirectStart = input.canDirectStart && !input.isL3 && input.isNotStarted && !input.isCompleted
  if (!input.isL3 && !input.isOwnTask) {
    const actions: TaskMenuAction[] = []
    if (input.canViewProgress) actions.push('view-progress')
    if (canDirectStart) actions.push('direct-start')
    if (input.canEdit) actions.push('edit')
    return actions
  }
  const actions: TaskMenuAction[] = ['view']
  if (!input.isL3 && input.canViewProgress) actions.push('view-progress')
  if (!input.isOwnTask) return input.canViewProgress ? [...actions, 'view-progress'] : actions
  if (canDirectStart) actions.push('direct-start')
  if (input.canSubmitApproval && !input.isCompleted) actions.push('submit-approval')
  if (input.canSubmitApproval && !input.isCompleted && input.hasBlockingPredecessors && !input.hasPendingApproval && !input.hasSpecialRelease) actions.push('special-release')
  if (!input.isL3 && input.canEdit) actions.push('edit')
  actions.push('approval-history')
  return actions
}
