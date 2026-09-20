import type { ProjectAccessLevel } from './types'

export interface ProjectCapabilities {
  accessLevel: ProjectAccessLevel
  canViewWorkflow: boolean
  canEditWorkflow: boolean
  canPublishWorkflow: boolean
  canUseWorkflowTemplates: boolean
  canManageWorkflowTemplates: boolean
  canManageProjectMembers: boolean
  canViewProjectMembers: boolean
  canManageProjectSettings: boolean
  canEditTaskStructure: boolean
  canViewAudit: boolean
  canExecuteOwnTask: boolean
  canManageOwnDeliverables: boolean
  canManageAllDeliverables: boolean
  canSubmitApproval: boolean
}

/**
 * Project-level capability interface used by workspace controls.
 * The server remains the source of truth; this module only keeps the UI
 * consistent with the server's project access level.
 */
export function getProjectCapabilities(accessLevel: ProjectAccessLevel = 'L3'): ProjectCapabilities {
  const isManager = accessLevel === 'L1' || accessLevel === 'L2'
  const isSupervisor = accessLevel === 'SUPERVISOR'
  const isExecutor = accessLevel === 'L3'

  return {
    accessLevel,
    canViewWorkflow: true,
    canEditWorkflow: isManager,
    canPublishWorkflow: isManager,
    canUseWorkflowTemplates: isManager,
    canManageWorkflowTemplates: isManager,
    canManageProjectMembers: isManager,
    canViewProjectMembers: isManager || isSupervisor,
    canManageProjectSettings: isManager,
    canEditTaskStructure: isManager,
    canViewAudit: isManager || isSupervisor,
    canExecuteOwnTask: isManager || isExecutor,
    canManageOwnDeliverables: isManager || isExecutor,
    canManageAllDeliverables: isManager,
    canSubmitApproval: isManager || isExecutor,
  }
}
