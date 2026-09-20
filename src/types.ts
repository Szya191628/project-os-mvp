export type ProjectStatus = '执行中' | '有风险' | '规划中' | '已暂停'
export type TaskStatus = '未开始' | '进行中' | '已完成' | '受阻' | '到期未完成' | '提前结束' | '如期结束' | '超期结束'
export type RiskLevel = '高' | '中' | '低'

export interface ClaimableTask {
  id: string
  name: string
  status: TaskStatus
  progress: number
  effort: number
  duration: number
  plannedStart: string | null
  plannedEnd: string | null
  description: string | null
  closureCriteria: string | null
  publisherName: string
  claimDepartmentIds: string[]
  claimDepartmentNames: string[]
}

export interface MyClaimTask extends ClaimableTask {
  claimedAt: string | null
}

export type WorkflowNodeType = 'start' | 'task' | 'milestone' | 'end'
export type DependencyType = 'FS'
export type WorkflowStatus = 'draft' | 'published'
export type WorkflowCalendarMode = 'natural' | 'working'
export type ProjectNotificationType = 'task-published' | 'task-ready' | 'task-completion-review' | 'task-completion-view' | 'task-deliverable-submitted' | 'task-due-soon' | 'task-overdue' | 'task-assignee-changed' | 'task-schedule-changed'
export type CompletionApprovalStatus = 'pending' | 'approved'

export interface WorkCalendarConfig {
  mode: WorkflowCalendarMode
  name: string
  weeklyWorkdays: number[]
  holidays: string[]
  customRestDays: string[]
  makeupWorkdays: string[]
}

export interface WorkflowClosureCheck {
  id: string
  label: string
  completed: boolean
}

export type WorkflowDeliverableKind = 'file' | 'link'

export interface WorkflowDeliverable {
  id: string
  kind: WorkflowDeliverableKind
  name: string
  version: string
  uploader: string
  createdAt: string
  url?: string
  objectKey?: string
  mimeType?: string
  size?: number
  externalProvider?: string
  externalId?: string
  approvalProcessInstanceId?: string
  approvalProcessCode?: string
  approvalFileId?: string
  approvalSpaceId?: string
}

/** 任务交付 OA 审批实例的前端视图。 */
export interface TaskApprovalView {
  id: string
  source?: 'DINGTALK' | 'PROJECT_OS'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'TERMINATED'
  purpose?: 'DELIVERY' | 'BYPASS'
  deliveryType?: 'STAGE' | 'FINAL'
  /** 审批通过后的处理结果：COMPLETED 已完成 / STAGE_RECORDED 阶段成果已记录 / FAILED 校验未过 */
  autoCompleteStatus?: string | null
  submitterName?: string | null
  approvalFileName?: string | null
  error?: string | null
  createdAt: string
  completedAt?: string | null
}

/** OA 审批中心列表项；Project OS 审批可直接处理，钉钉记录按需同步。 */
export interface ApprovalCenterItem {
  id: string
  taskId: string
  processInstanceId: string
  processCode: string
  source: 'DINGTALK' | 'PROJECT_OS'
  purpose: 'DELIVERY' | 'BYPASS'
  deliveryType: 'STAGE' | 'FINAL'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'TERMINATED'
  autoCompleteStatus?: string | null
  currentStepNo: number
  submitterMemberId?: string | null
  submitterName?: string | null
  approvalFileName?: string | null
  hasAttachment: boolean
  canDecide?: boolean
  recipientType?: 'APPROVER' | 'CC' | 'MANAGER'
  error?: string | null
  createdAt: string
  completedAt?: string | null
  organizationName: string
  progress: number
  assigneeName?: string | null
  departmentNames: string[]
  project: { id: string; code: string; name: string }
  task: { nodeId: string; wbs: string; name: string } | null
  steps: { stepNo: number; stage: 'L2' | 'ADMIN'; mode: 'ANY' | 'ALL'; minApprovals: number; status: string; decidedAt: string | null }[]
}

export interface SpecialReleaseView {
  workflowVersionId: string
  targetNodeId: string
  predecessorTaskIds: string[]
  predecessors: { taskId: string; nodeId: string; wbs: string; name: string; status: string }[]
  reason: string
  approvalId?: string
  requestedAt?: string
  approvedAt?: string
}

export interface ApprovalPolicyStepView {
  stepNo: number
  stage: 'L2' | 'ADMIN'
  mode: 'ANY' | 'ALL'
  minApprovals: number
  approverMemberIds: string[]
  ccMemberIds: string[]
}

export interface ApprovalPolicyMemberOption {
  id: string
  name: string
  roleLabel: string
  eligibleStages: ('L2' | 'ADMIN')[]
}

export interface ApprovalPolicyView {
  id: string | null
  projectId: string
  version: number
  enabled: boolean
  memberOptions: ApprovalPolicyMemberOption[]
  steps: ApprovalPolicyStepView[]
}

export interface WorkflowPosition {
  x: number
  y: number
}

export interface WorkflowNode {
  id: string
  /** Database task id for task/milestone nodes. Canvas node ids and task ids differ. */
  taskId?: string
  ownerMemberId?: string
  assigneeIds?: string[]
  assigneeNames?: string[]
  projectId: string
  type: WorkflowNodeType
  wbs: string
  parentId?: string
  name: string
  owner: string
  duration: number
  effort: number
  progress: number
  status: TaskStatus
  description?: string
  closureCriteria?: string
  plannedStart?: string
  plannedEnd?: string
  plannedStartOverride?: string
  plannedEndOverride?: string
  actualStart?: string
  actualEnd?: string
  completionApprovalStatus?: CompletionApprovalStatus
  completionConfirmedAt?: string
  closureChecks?: WorkflowClosureCheck[]
  completionNote?: string
  overdueReason?: string
  specialRelease?: SpecialReleaseView | null
  deliverables?: WorkflowDeliverable[]
  approvals?: TaskApprovalView[]
  position: WorkflowPosition
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  type: DependencyType
  lagDays: number
}

export interface WorkflowBaselineNode {
  id: string
  type: WorkflowNodeType
  name: string
  duration: number
  plannedStart: string
  plannedEnd: string
}

export interface WorkflowBaseline {
  version: number
  publishedAt: string
  baselineStart: string
  calendar?: WorkCalendarConfig
  nodes: WorkflowBaselineNode[]
  edges: WorkflowEdge[]
}

export interface Workflow {
  projectId: string
  baselineStart: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /** 已发布版本；草稿工作区保留它供只读任务视图使用。 */
  publishedWorkflow?: Workflow
  /** Coordinates from the latest published version, used only to restore layout. */
  publishedLayout?: Record<string, WorkflowPosition>
  calendar?: WorkCalendarConfig
  baseline?: WorkflowBaseline
  status?: WorkflowStatus
  version?: number
  publishedAt?: string
}

export interface WorkflowAuditSummary {
  headline: string
  details: string[]
  nodeAddedCount: number
  nodeRemovedCount: number
  nodeUpdatedCount: number
  layoutChangedCount: number
  dependencyAddedCount: number
  dependencyRemovedCount: number
  scheduleChangedCount: number
}

export interface WorkflowAuditLog {
  id: string
  action: 'WORKFLOW_DRAFT_SAVED' | 'WORKFLOW_PUBLISHED_UPDATED' | 'WORKFLOW_PUBLISHED'
  resourceType: 'WORKFLOW_VERSION'
  resourceId: string
  actorMemberId?: string | null
  actorName: string
  createdAt: string
  versionNo?: number | null
  status?: string | null
  summary: WorkflowAuditSummary
}

export interface WorkflowTemplateSummary {
  id: string
  name: string
  description?: string | null
  nodeCount: number
  edgeCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectNotification {
  id: string
  projectId: string
  projectCode: string
  projectName: string
  taskId?: string
  taskName?: string
  type: ProjectNotificationType
  title: string
  body: string
  createdAt: string
  read: boolean
  dueDate?: string
}

export interface NotificationSettings {
  reminderDays: 3 | 5
}

export interface ServerNotification {
  id: string
  projectId: string | null
  taskId: string | null
  projectCode: string
  projectName: string
  taskName: string
  eventType: string
  title: string
  body: string
  dueDate: string | null
  createdAt: string
  readAt: string | null
  acknowledgedAt: string | null
  delivery?: { status: string; sentAt: string | null } | null
}

export interface NotificationTemplate {
  eventType: string
  channel: string
  titleTemplate: string
  bodyTemplate: string
  enabled: boolean
  customized: boolean
  updatedAt: string | null
}

export interface Member {
  id: string
  name: string
  initials: string
  capacity: number
  allocation: number
  skills: string[]
}

export type SystemRoleCode = 'L1' | 'L2' | 'L3'
export type ProjectAccessLevel = 'L1' | 'L2' | 'L3' | 'SUPERVISOR'

export interface AuthSession {
  memberId: string
  memberName?: string
  organizationId: string
  roleCodes: SystemRoleCode[]
  baseRole: SystemRoleCode
  canCreateProject?: boolean
  /** 组织级钉钉业务交互开关；关闭时仅保留 OAuth 登录。 */
  dingtalkIntegrationEnabled?: boolean
  /** 部门主管监督的项目（直属下属参与、本人非成员）——这些项目对当前用户只读。 */
  supervisingProjectIds?: string[]
}

export interface DingTalkSyncResult {
  usersSeen: number
  membersCreated: number
  membersUpdated: number
  departmentsSynced: number
  managersSynced: number
  syncedAt: string
}

export interface DirectoryMember {
  id: string
  name: string
  email?: string | null
  avatarUrl?: string | null
  capacityHoursPerWeek: number
  status: 'ACTIVE' | 'INACTIVE'
  joinedAt?: string | null
  leftAt?: string | null
  department?: { id: string; name: string } | null
  departments: { id: string; name: string }[]
  manager?: { id: string; name: string } | null
  systemRoles: { code: SystemRoleCode; name: string }[]
  baseRole: SystemRoleCode
  systemBaseRole?: SystemRoleCode
  projectCount: number
  projectL2Grants: {
    id: string
    projectId: string
    createdAt: string
    project: { code: string; name: string }
    grantedBy: { id: string; name: string }
  }[]
  dingtalkIdentities: {
    id: string
    corpId: string
    userId?: string | null
    unionId?: string | null
    openId?: string | null
    lastSyncedAt?: string | null
  }[]
}

export interface ProjectAccessMember {
  memberId: string
  membershipRole: string
  member: {
    id: string
    name: string
    status: 'ACTIVE' | 'INACTIVE'
    systemRoles: { code: string; name: string }[]
  }
}

export interface ProjectAccessGrant {
  id: string
  projectId: string
  memberId: string
  roleCode: 'L2'
  grantedById: string
  parentGrantId?: string | null
  revokedAt?: string | null
  createdAt: string
  member: { id: string; name: string }
  grantedBy: { id: string; name: string }
}

export interface ProjectAccessData {
  project: { id: string; code: string; name: string }
  members: ProjectAccessMember[]
  grants: ProjectAccessGrant[]
  availableMembers: ProjectAccessMember['member'][]
}

/** Lightweight active project member option used by task assignment controls. */
export interface ProjectMemberOption {
  id: string
  name: string
}

export interface ProjectPortfolioRef {
  id: string
  code: string
  name: string
}

export interface ProjectPortfolio {
  id: string
  code: string
  name: string
  description?: string
  owner?: string
  projectIds: string[]
}

export type PortfolioFlowNodeType = 'project' | 'task'

export interface PortfolioFlowNode {
  id: string
  type: PortfolioFlowNodeType
  projectId?: string
  /** Database task id for a portfolio task bound to an existing project task. */
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
  position: WorkflowPosition
}

export interface PortfolioFlowEdge {
  id: string
  source: string
  target: string
  type: DependencyType
  lagDays: number
}

export type PortfolioFlowField = 'owner' | 'status' | 'progress' | 'date' | 'duration'

export interface PortfolioWorkflowTemplate {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  nodes: PortfolioFlowNode[]
  edges: PortfolioFlowEdge[]
  calendar?: WorkCalendarConfig
  visibleFields?: PortfolioFlowField[]
}

export interface PortfolioWorkflowAuditLog {
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

export interface PortfolioWorkflow {
  portfolioId: string
  version: number
  status?: WorkflowStatus
  calendar?: WorkCalendarConfig
  visibleFields?: PortfolioFlowField[]
  publishedLayout?: Record<string, WorkflowPosition>
  templates?: PortfolioWorkflowTemplate[]
  auditLogs?: PortfolioWorkflowAuditLog[]
  nodes: PortfolioFlowNode[]
  edges: PortfolioFlowEdge[]
}

export interface ProjectDashboardMilestone {
  projectId: string
  projectCode: string
  projectName: string
  taskId?: string
  name: string
  plannedStart: string
  plannedEnd: string
  status: TaskStatus
  overdue: boolean
}

export interface ProjectDashboardMetrics {
  portfolioMetricsVisible: boolean
  risks: {
    total: number
    high: number
    attention: number
  }
  resource: {
    allocatedHours: number
    capacityHours: number
    utilizationPercent: number | null
    overloadedMembers: number
    memberCount: number
  }
  milestones: ProjectDashboardMilestone[]
}

export interface ResourceLoadWeek {
  startDate: string
  endDate: string
  label: string
}

export interface ResourceLoadTask {
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

export interface ResourceLoadMemberWeek extends ResourceLoadWeek {
  allocatedHours: number
  capacityHours: number
  utilizationPercent: number
}

export interface ResourceLoadMember {
  id: string
  name: string
  initials: string
  roleTitle: string | null
  department: { id: string; name: string } | null
  departments: { id: string; name: string }[]
  capacityHoursPerWeek: number
  projectCount: number
  taskCount: number
  pendingTaskCount: number
  activeTaskCount: number
  blockedTaskCount: number
  projectNames: string[]
  plannedHours: number
  capacityHours: number
  availableHours: number
  weeks: ResourceLoadMemberWeek[]
  tasks: ResourceLoadTask[]
}

export interface ResourceLoadGroup {
  id: string | null
  name: string
  memberCount: number
  taskCount: number
  pendingTaskCount: number
  plannedHours: number
  capacityHours: number
  availableHours: number
  overloadedMemberCount: number
  members: ResourceLoadMember[]
}

export interface ResourceLoadConflict {
  memberId: string
  memberName: string
  groupName: string
  week: ResourceLoadMemberWeek
  tasks: { id: string; projectName: string; wbs: string; name: string }[]
}

export interface ResourceLoadResponse {
  range: { from: string; to: string }
  weeks: ResourceLoadWeek[]
  summary: {
    totalTaskCount: number
    pendingTaskCount: number
    unassignedTaskCount: number
    memberCount: number
    groupCount: number
    allocatedHours: number
    capacityHours: number
    availableHours: number
    availableMemberCount: number
    overloadedMemberCount: number
  }
  conflicts: ResourceLoadConflict[]
  groups: ResourceLoadGroup[]
}

export interface Project {
  id: string
  code: string
  name: string
  owner: string
  ownerInitials: string
  department: string
  status: ProjectStatus
  progress: number
  start: string
  end: string
  budget: number
  actualCost: number
  health: '健康' | '关注' | '预警'
  portfolio?: ProjectPortfolioRef
  memberIds: string[]
  nextMilestone: string
  approvalAutoStart?: boolean
  accessLevel?: ProjectAccessLevel
}

export interface Task {
  id: string
  /** Database task id used by task-level write APIs. */
  taskId?: string
  ownerMemberId?: string
  assigneeIds?: string[]
  assigneeNames?: string[]
  projectId: string
  parentId?: string
  wbs: string
  name: string
  owner: string
  startOffset: number
  duration: number
  progress: number
  status: TaskStatus
  dependency?: string
  milestone?: boolean
  level: number
  effort: number
  plannedStart?: string
  plannedEnd?: string
  plannedStartOverride?: string
  plannedEndOverride?: string
  actualStart?: string
  actualEnd?: string
  completionApprovalStatus?: CompletionApprovalStatus
  completionConfirmedAt?: string
  closureCriteria?: string
  description?: string
  closureChecks?: WorkflowClosureCheck[]
  completionNote?: string
  overdueReason?: string
  specialRelease?: SpecialReleaseView | null
  deliverables?: WorkflowDeliverable[]
  blockedBy?: string[]
  pendingApprovalBy?: string[]
  readyAt?: string
  calendarStartOffset?: number
  calendarSpan?: number
  approvals?: TaskApprovalView[]
}

export interface Risk {
  id: string
  projectId: string
  title: string
  owner: string
  probability: number
  impact: number
  level: RiskLevel
  response: string
  due: string
}

export interface TimesheetEntry {
  id: string
  member: string
  project: string
  task: string
  monday: number
  tuesday: number
  wednesday: number
  thursday: number
  friday: number
  status: '草稿' | '待审批' | '已确认'
}
