import type { AuthContext } from '../auth.js'

export type AgentRequest = {
  message: string
  projectId?: string
  conversationId?: string
  channel?: 'web' | 'dingtalk'
  attachment?: AgentAttachment
}

export type AgentAttachment = {
  name: string
  kind?: 'file' | 'image' | 'link' | 'dingtalk'
  url?: string
  mimeType?: string
  sizeBytes?: number
  externalProvider?: string
  externalId?: string
  robotCode?: string
}

export type AgentRunStatus = 'completed' | 'blocked' | 'failed'
export type AgentScopeLevel = 'L1' | 'L2' | 'L3'
export type AgentFindingTone = 'danger' | 'warning' | 'success' | 'neutral'

export type AgentTaskSpec = { name: string; duration: number }

export type AgentTaskPatch = {
  name?: string
  duration?: number
  effort?: number
  description?: string | null
  closureCriteria?: string | null
  status?: string
  progress?: number
  actualStart?: string | null
  actualEnd?: string | null
  completionNote?: string | null
  overdueReason?: string | null
}

export type AgentProjectDraft = {
  name: string
  code?: string
  owner?: string
  department?: string
  start: string
  end: string
  taskSpecs: AgentTaskSpec[]
}

export type AgentTaskDraft = {
  projectId: string
  name: string
  duration: number
  effort: number
  ownerMemberId?: string
  ownerName?: string
  description?: string
  closureCriteria?: string
}

export type AgentWorkflowPreview = {
  projectId: string
  baselineStart: string
  status: 'draft'
  version: 0
  nodes: Array<{
    id: string
    projectId: string
    type: 'start' | 'task' | 'milestone' | 'end'
    wbs: string
    name: string
    owner: string
    duration: number
    effort: number
    progress: number
    status: string
    description?: string
    closureCriteria?: string
    position: { x: number; y: number }
  }>
  edges: Array<{ id: string; source: string; target: string; type: 'FS'; lagDays: number }>
}

export type AgentEvidence = {
  id: string
  title: string
  detail: string
  tone: AgentFindingTone
  projectId?: string
  taskId?: string
}

export type AgentAction = {
  id: string
  label: string
  kind: 'open-project' | 'preview-workflow' | 'create-project' | 'create-task' | 'update-task' | 'delete-task' | 'assign-task' | 'publish-workflow' | 'submit-deliverable' | 'get-predecessor-deliverable'
  projectId?: string
  taskId?: string
  workflow?: AgentWorkflowPreview
  projectDraft?: AgentProjectDraft
  taskDraft?: AgentTaskDraft
  taskPatch?: AgentTaskPatch
  memberId?: string
  memberName?: string
  assignmentMode?: 'add' | 'remove' | 'replace'
  existingMemberIds?: string[]
  deliverable?: AgentAttachment & { versionLabel?: string }
  predecessorTaskId?: string
  deliverableId?: string
  completeTask?: boolean
}

export type AgentRun = {
  runId: string
  status: AgentRunStatus
  answer: string
  evidence: AgentEvidence[]
  actions: AgentAction[]
  suggestions: string[]
  missingFields: string[]
  scopeLabel: string
  sourceLabel: string
  intent: string
  intentLabel: string
  modeLabel: string
  confidence: number
  scope: { level: AgentScopeLevel; projectIds: string[] | 'all' }
  previewWorkflow?: AgentWorkflowPreview
}

export type AgentTaskSnapshot = {
  id: string
  wbs: string
  name: string
  projectId: string
  owner: string
  effortHours: number
  durationDays: number
  progress: number
  status: string
  plannedStart: string | null
  plannedEnd: string | null
  description: string | null
  closureCriteria: string | null
  assignees: string[]
  assigneeIds: string[]
  ownerMemberId?: string
  deliverableCount: number
  incompleteClosureCheckCount: number
  isMine?: boolean
  deliverables?: Array<{ id: string; name: string; kind: string; versionLabel: string; url: string | null; objectKey?: string | null; mimeType: string | null; sizeBytes: number | null; externalProvider?: string | null; externalId?: string | null; approvalProcessInstanceId?: string | null; approvalProcessCode?: string | null; approvalFileId?: string | null; approvalSpaceId?: string | null; createdAt: string; uploader: string | null }>
  closureChecks?: Array<{ id: string; label: string; completed: boolean }>
  predecessors?: Array<{ id: string; wbs: string; name: string; status: string; progress: number; deliverables: NonNullable<AgentTaskSnapshot['deliverables']> }>
}

export type AgentProjectSnapshot = {
  id: string
  code: string
  name: string
  status: string
  health: string
  plannedStart: string | null
  plannedEnd: string | null
  progress: number
  owner: string
  budgetAmount: number | null
  actualCostAmount: number | null
  tasks: AgentTaskSnapshot[]
}

export type AgentSnapshot = {
  projects: AgentProjectSnapshot[]
  scope: { level: AgentScopeLevel; projectIds: string[] | 'all' }
  actor: Pick<AuthContext, 'memberId' | 'organizationId'>
  capabilities: { canCreateProject: boolean }
  members: Array<{ id: string; name: string }>
  today: string
}
