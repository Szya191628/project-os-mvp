import { createEmptyWorkflow, createNaturalWorkCalendar } from './data'
import { buildRequestHeaders } from './http'
import type { ApprovalCenterItem, ApprovalPolicyView, AuthSession, ClaimableTask, DirectoryMember, DingTalkSyncResult, MyClaimTask, NotificationTemplate, PortfolioFlowNode, PortfolioWorkflow, PortfolioWorkflowAuditLog, PortfolioWorkflowTemplate, Project, ProjectAccessData, ProjectDashboardMetrics, ProjectNotificationType, ProjectPortfolio, ProjectMemberOption, ResourceLoadResponse, ServerNotification, SystemRoleCode, TaskApprovalView, TaskStatus, Workflow, WorkflowAuditLog, WorkflowDeliverable, WorkflowNode, WorkflowNodeType, WorkflowStatus, WorkflowTemplateSummary, WorkCalendarConfig } from './types'
import { scheduleWorkflow } from './workflow/schedule'
import type { TaskSummary } from './workflow/taskQueries'
import type { AgentResult } from './agent/agentEngine'

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const DEV_MEMBER_ID = import.meta.env.VITE_MEMBER_ID

export function resolveApiUrl(path: string) {
  return path.startsWith('/') ? `${API_BASE}${path}` : path
}

type ApiResponse<T> = { data: T }

type RawProject = {
  id: string
  code: string
  name: string
  status: string
  health: string
  plannedStart: string | null
  plannedEnd: string | null
  budgetAmount: number | null
  actualCostAmount: number | null
  progress: number
  owner: { id: string; name: string; initials?: string } | null
  department: { id: string; name: string } | null
  portfolio: { id: string; code: string; name: string } | null
  memberIds: string[]
  nextMilestone: string
  approvalAutoStart?: boolean
  accessLevel?: Project['accessLevel']
}

type RawClaimableTask = Omit<ClaimableTask, 'status'> & { status: string }
type RawMyClaimTask = Omit<MyClaimTask, 'status'> & { status: string }
type RawMyWorkflowTask = Omit<TaskSummary, 'status' | 'projectStatus' | 'ownerMemberId' | 'plannedStart' | 'plannedEnd' | 'actualStart' | 'actualEnd'> & { status: string; projectStatus: string; ownerMemberId: string | null; plannedStart: string | null; plannedEnd: string | null; actualStart: string | null; actualEnd: string | null }

type RawPortfolio = {
  id: string
  code: string
  name: string
  description: string | null
  owner: { id: string; name: string } | null
  projectIds: string[]
}

type RawPortfolioWorkflow = {
  portfolioId: string
  version: number
  status?: WorkflowStatus
  calendar?: WorkCalendarConfig
  visibleFields?: PortfolioWorkflow['visibleFields']
  publishedLayout?: PortfolioWorkflow['publishedLayout']
  templates?: RawPortfolioWorkflowTemplate[]
  auditLogs?: PortfolioWorkflowAuditLog[]
  nodes: (Omit<PortfolioFlowNode, 'position'> & { positionX: number; positionY: number })[]
  edges: { id: string; source: string; target: string; type: string; lagDays: number }[]
}

type RawPortfolioWorkflowTemplate = Omit<PortfolioWorkflowTemplate, 'nodes'> & { nodes: (Omit<PortfolioFlowNode, 'position'> & { positionX: number; positionY: number })[] }

function mapPortfolioTemplate(template: RawPortfolioWorkflowTemplate): PortfolioWorkflowTemplate {
  return { ...template, nodes: template.nodes.map((node) => ({ ...node, position: { x: node.positionX, y: node.positionY } })), edges: template.edges.map((edge) => ({ ...edge, type: 'FS' as const })) }
}

type RawDashboardMetrics = {
  portfolioMetricsVisible?: boolean
  risks: { total: number; high: number; attention: number }
  resource: { allocatedHours: number; capacityHours: number; utilizationPercent: number | null; overloadedMembers: number; memberCount: number }
  milestones: { projectId: string; projectCode: string; projectName: string; taskId?: string; name: string; plannedStart: string; plannedEnd: string; status: string; overdue: boolean }[]
}

type RawVersion = {
  id: string
  versionNo: number
  status: 'DRAFT' | 'PUBLISHED'
  baselineStart: string
  calendar?: { name: string; mode: 'NATURAL' | 'WORKING'; weekdays: { weekday: number }[]; exceptions: { date: string; kind: 'HOLIDAY' | 'REST' | 'MAKEUP_WORKDAY' }[] } | null
  nodes: RawNode[]
  edges: { id: string; sourceNodeId: string; targetNodeId: string; dependencyType: string; lagDays: number }[]
}

type RawSpecialRelease = {
  workflowVersionId: string
  targetNodeId: string
  predecessorTaskIds: string[]
  predecessors: { taskId: string; nodeId: string; wbs: string; name: string; status: string }[]
  reason: string
  approvalId?: string
  requestedAt?: string
  approvedAt?: string
}

type RawNode = {
  id: string
  taskId: string | null
  nodeType: string
  wbs: string
  parentTaskId: string | null
  name: string
  durationDays: number
  effortHours: number
  description: string | null
  closureCriteria: string | null
  plannedStartOverride: string | null
  plannedEndOverride: string | null
  positionX: number
  positionY: number
  specialRelease: RawSpecialRelease | null
  ownerMember: { id: string; name: string } | null
  schedules: { plannedStart: string; plannedEnd: string; startOffset: number; endOffset: number; calendarSpan: number }[]
  task: {
    execution: { status: string; progress: number; actualStart: string | null; actualEnd: string | null; readyAt: string | null; completionNote: string | null; overdueReason: string | null; completionApprovalStatus: string | null; completionConfirmedAt: string | null } | null
    closureChecks: { id: string; label: string; completed: boolean }[]
    assignees: { memberId: string; member: { id: string; name: string } }[]
    deliverables: { id: string; kind: string; name: string; versionLabel: string; url: string | null; objectKey: string | null; mimeType: string | null; sizeBytes: number | null; externalProvider: string | null; externalId: string | null; approvalProcessInstanceId: string | null; approvalProcessCode: string | null; approvalFileId: string | null; approvalSpaceId: string | null; createdAt: string; uploader: { id: string; name: string } | null }[]
    approvals: { id: string; source?: string; status: string; purpose: string; deliveryType: string; autoCompleteStatus: string | null; submitterName: string | null; approvalFileName: string | null; error: string | null; createdAt: string; completedAt: string | null }[]
  } | null
}

type RawWorkflowResponse = {
  id: string
  code: string
  name: string
  workflow: {
    id: string
    draftVersionId: string | null
    publishedVersionId: string | null
    draftVersion: RawVersion | null
    publishedVersion: RawVersion | { id: string; versionNo: number; status: string; baselineStart: string } | null
  } | null
}

function mapPublishedLayout(raw: NonNullable<RawWorkflowResponse['workflow']>['publishedVersion'] | undefined) {
  if (!raw || !('nodes' in raw)) return undefined
  return Object.fromEntries(raw.nodes.map((node) => [node.id, { x: node.positionX, y: node.positionY }]))
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: buildRequestHeaders(init, DEV_MEMBER_ID),
  })
  const body = await response.json().catch(() => ({})) as { data?: T; error?: string }
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`)
  return body.data as T
}

const statusMap: Record<string, Project['status']> = { IN_PROGRESS: '执行中', AT_RISK: '有风险', PLANNED: '规划中', PAUSED: '已暂停' }
const projectStatusMap = statusMap
const healthMap: Record<string, Project['health']> = { HEALTHY: '健康', ATTENTION: '关注', WARNING: '预警' }
const taskStatusMap: Record<string, WorkflowNode['status']> = { NOT_STARTED: '未开始', IN_PROGRESS: '进行中', BLOCKED: '受阻', DUE_UNFINISHED: '到期未完成', COMPLETED: '已完成', EARLY_FINISHED: '提前结束', ON_TIME_FINISHED: '如期结束', OVERDUE_FINISHED: '超期结束' }

const dateOnly = (value: string | null | undefined, fallback: string) => value?.slice(0, 10) || fallback

function mapProject(raw: RawProject): Project {
  const start = dateOnly(raw.plannedStart, new Date().toISOString().slice(0, 10))
  return {
    id: raw.id,
    code: raw.code,
    name: raw.name,
    owner: raw.owner?.name ?? '待分配',
    ownerInitials: raw.owner?.initials ?? raw.owner?.name.slice(0, 2).toUpperCase() ?? 'PM',
    department: raw.department?.name ?? '未分配部门',
    status: statusMap[raw.status] ?? '规划中',
    progress: raw.progress ?? 0,
    start,
    end: dateOnly(raw.plannedEnd, start),
    budget: raw.budgetAmount ?? 0,
    actualCost: raw.actualCostAmount ?? 0,
    health: healthMap[raw.health] ?? '健康',
    portfolio: raw.portfolio ?? undefined,
    memberIds: raw.memberIds ?? [],
    nextMilestone: raw.nextMilestone ?? '待规划',
    approvalAutoStart: raw.approvalAutoStart ?? false,
    accessLevel: raw.accessLevel,
  }
}

function mapCalendar(raw: RawVersion['calendar']): WorkCalendarConfig {
  if (!raw) return createNaturalWorkCalendar()
  return {
    mode: raw.mode === 'WORKING' ? 'working' : 'natural',
    name: raw.name,
    weeklyWorkdays: raw.weekdays.map((item) => item.weekday),
    holidays: raw.exceptions.filter((item) => item.kind === 'HOLIDAY').map((item) => item.date.slice(0, 10)),
    customRestDays: raw.exceptions.filter((item) => item.kind === 'REST').map((item) => item.date.slice(0, 10)),
    makeupWorkdays: raw.exceptions.filter((item) => item.kind === 'MAKEUP_WORKDAY').map((item) => item.date.slice(0, 10)),
  }
}

function mapNode(raw: RawNode, projectId: string): WorkflowNode {
  const type = raw.nodeType.toLowerCase() as WorkflowNodeType
  const execution = raw.task?.execution
  const schedule = raw.schedules[0]
  return {
    id: raw.id,
    taskId: raw.taskId ?? undefined,
    ownerMemberId: raw.ownerMember?.id,
    assigneeIds: raw.task?.assignees.length ? raw.task.assignees.map((assignee) => assignee.memberId) : raw.ownerMember?.id ? [raw.ownerMember.id] : [],
    assigneeNames: raw.task?.assignees.length ? raw.task.assignees.map((assignee) => assignee.member.name) : raw.ownerMember?.name ? [raw.ownerMember.name] : [],
    projectId,
    type,
    wbs: raw.wbs,
    parentId: raw.parentTaskId ?? undefined,
    name: raw.name,
    owner: raw.ownerMember?.name ?? (type === 'start' || type === 'end' ? '项目组' : '待分配'),
    duration: raw.durationDays,
    effort: raw.effortHours,
    progress: execution?.progress ?? (type === 'start' ? 100 : 0),
    status: execution ? (taskStatusMap[execution.status] ?? '未开始') : type === 'start' ? '已完成' : '未开始',
    description: raw.description ?? undefined,
    closureCriteria: raw.closureCriteria ?? undefined,
    plannedStart: schedule?.plannedStart,
    plannedEnd: schedule?.plannedEnd,
    plannedStartOverride: raw.plannedStartOverride?.slice(0, 10) ?? undefined,
    plannedEndOverride: raw.plannedEndOverride?.slice(0, 10) ?? undefined,
    actualStart: execution?.actualStart?.slice(0, 10),
    actualEnd: execution?.actualEnd?.slice(0, 10),
    completionApprovalStatus: execution?.completionApprovalStatus === 'PENDING' ? 'pending' : execution?.completionApprovalStatus === 'APPROVED' ? 'approved' : undefined,
    completionConfirmedAt: execution?.completionConfirmedAt?.slice(0, 10),
    closureChecks: raw.task?.closureChecks,
    completionNote: execution?.completionNote ?? undefined,
    overdueReason: execution?.overdueReason ?? undefined,
    specialRelease: raw.specialRelease,
    deliverables: raw.task?.deliverables.map<WorkflowDeliverable>((item) => ({
      id: item.id,
      kind: item.kind === 'LINK' ? 'link' : 'file',
      name: item.name,
      version: item.versionLabel,
      uploader: item.uploader?.name ?? '未知用户',
      createdAt: item.createdAt,
      url: item.url ?? undefined,
      objectKey: item.objectKey ?? undefined,
      mimeType: item.mimeType ?? undefined,
      size: item.sizeBytes ?? undefined,
      externalProvider: item.externalProvider ?? undefined,
      externalId: item.externalId ?? undefined,
      approvalProcessInstanceId: item.approvalProcessInstanceId ?? undefined,
      approvalProcessCode: item.approvalProcessCode ?? undefined,
      approvalFileId: item.approvalFileId ?? undefined,
      approvalSpaceId: item.approvalSpaceId ?? undefined,
    })),
    approvals: raw.task?.approvals.map<TaskApprovalView>((item) => ({
      id: item.id,
      source: item.source === 'PROJECT_OS' ? 'PROJECT_OS' : 'DINGTALK',
      status: (['PENDING', 'APPROVED', 'REJECTED', 'TERMINATED'].includes(item.status) ? item.status : 'PENDING') as TaskApprovalView['status'],
      purpose: item.purpose === 'BYPASS' ? 'BYPASS' : 'DELIVERY',
      deliveryType: item.deliveryType === 'STAGE' ? 'STAGE' : 'FINAL',
      autoCompleteStatus: item.autoCompleteStatus,
      submitterName: item.submitterName,
      approvalFileName: item.approvalFileName,
      error: item.error,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
    })),
    position: { x: raw.positionX, y: raw.positionY },
  }
}

function mapVersion(raw: RawVersion, projectId: string): Workflow {
  return {
    projectId,
    baselineStart: raw.baselineStart.slice(0, 10),
    status: raw.status === 'PUBLISHED' ? 'published' : 'draft',
    version: raw.versionNo,
    nodes: raw.nodes.map((node) => mapNode(node, projectId)),
    edges: raw.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, type: 'FS', lagDays: edge.lagDays })),
    calendar: mapCalendar(raw.calendar),
  }
}

export async function fetchProjects() {
  const response = await request<ApiResponse<RawProject[]> | RawProject[]>('/api/v1/projects')
  const raw = Array.isArray(response) ? response : response.data
  return raw.map(mapProject)
}

export async function fetchMyWorkflowTasks() {
  const raw = await request<RawMyWorkflowTask[]>('/api/v1/my-tasks')
  return raw.map((task): TaskSummary => ({
    ...task,
    projectStatus: projectStatusMap[task.projectStatus] ?? '规划中',
    ownerMemberId: task.ownerMemberId ?? undefined,
    status: taskStatusMap[task.status] ?? '未开始',
    plannedStart: task.plannedStart ?? undefined,
    plannedEnd: task.plannedEnd ?? undefined,
    actualStart: task.actualStart ?? undefined,
    actualEnd: task.actualEnd ?? undefined,
  }))
}

export async function fetchAuthMe() {
  return request<AuthSession>('/api/v1/auth/me')
}

export async function updateDingTalkIntegration(enabled: boolean) {
  return request<{ enabled: boolean; loginOnlyWhenDisabled: boolean; canManage: boolean; stoppedDeliveries?: number }>('/api/v1/settings/dingtalk', { method: 'PATCH', body: JSON.stringify({ enabled }) })
}

export async function fetchServerNotifications() {
  return request<ServerNotification[]>('/api/v1/notifications')
}

export async function fetchApprovalCenter() {
  return request<ApprovalCenterItem[]>('/api/v1/approvals')
}

export async function acknowledgeNotification(notificationId: string) {
  return request<{ notificationId: string; acknowledged: boolean }>(`/api/v1/notifications/${notificationId}/acknowledge`, { method: 'POST', body: '{}' })
}

export async function deleteNotificationsBatch(ids: string[]) {
  return request<{ deleted: number }>('/api/v1/notifications/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) })
}

export async function fetchNotificationTemplates() {
  return request<NotificationTemplate[]>('/api/v1/notification-templates')
}

export async function updateNotificationTemplate(eventType: string, input: Pick<NotificationTemplate, 'titleTemplate' | 'bodyTemplate'> & { enabled: boolean }) {
  return request<NotificationTemplate>(`/api/v1/notification-templates/${eventType}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function mapServerNotificationType(eventType: string): ProjectNotificationType {
  const map: Record<string, ProjectNotificationType> = { TASK_PUBLISHED: 'task-published', TASK_READY: 'task-ready', TASK_DUE_SOON: 'task-due-soon', TASK_OVERDUE: 'task-overdue', TASK_ASSIGNEE_CHANGED: 'task-assignee-changed', TASK_SCHEDULE_CHANGED: 'task-schedule-changed', TASK_APPROVAL_SUBMITTED: 'task-completion-review', TASK_APPROVAL_VIEWED: 'task-completion-view', TASK_DELIVERABLE_SUBMITTED: 'task-deliverable-submitted' }
  return map[eventType] ?? 'task-ready'
}

export async function runAgentQueryApi(input: { message: string; projectId?: string; conversationId?: string }) {
  const response = await request<AgentResult & { runId: string; status: 'completed' | 'blocked' | 'failed'; scope: { level: 'L1' | 'L2' | 'L3'; projectIds: string[] | 'all' } }>('/api/v1/agent/query', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response
}

export function beginDingTalkLogin() {
  window.location.assign(`${API_BASE}/api/v1/auth/dingtalk/start`)
}

export async function logout() {
  return request<{ loggedOut: boolean }>('/api/v1/auth/logout', { method: 'POST', body: '{}' })
}

export async function fetchProjectPortfolios() {
  const response = await request<ApiResponse<RawPortfolio[]> | RawPortfolio[]>('/api/v1/project-portfolios')
  const raw = Array.isArray(response) ? response : response.data
  return raw.map((portfolio): ProjectPortfolio => ({ id: portfolio.id, code: portfolio.code, name: portfolio.name, description: portfolio.description ?? undefined, owner: portfolio.owner?.name, projectIds: portfolio.projectIds ?? [] }))
}

export async function fetchPortfolioWorkflow(portfolioId: string): Promise<PortfolioWorkflow> {
  const response = await request<RawPortfolioWorkflow>(`/api/v1/project-portfolios/${portfolioId}/workflow`)
  return {
    portfolioId: response.portfolioId,
    version: response.version,
    status: response.status ?? 'draft',
    calendar: response.calendar,
    visibleFields: response.visibleFields,
    publishedLayout: response.publishedLayout,
    templates: response.templates?.map(mapPortfolioTemplate),
    auditLogs: response.auditLogs,
    nodes: response.nodes.map((node) => ({ ...node, position: { x: node.positionX, y: node.positionY } })),
    edges: response.edges.map((edge) => ({ ...edge, type: 'FS' as const })),
  }
}

export async function savePortfolioWorkflow(workflow: PortfolioWorkflow) {
  const response = await request<{ version: number; status?: WorkflowStatus; publishedLayout?: PortfolioWorkflow['publishedLayout']; auditLogs?: PortfolioWorkflowAuditLog[] }>(`/api/v1/project-portfolios/${workflow.portfolioId}/workflow`, {
    method: 'PUT',
    body: JSON.stringify({
      version: workflow.version,
      status: workflow.status ?? 'draft',
      calendar: workflow.calendar,
      visibleFields: workflow.visibleFields,
      publishedLayout: workflow.publishedLayout,
      templates: workflow.templates?.map(({ nodes, ...template }) => ({ ...template, nodes: nodes.map(({ position, ...node }) => ({ ...node, positionX: position.x, positionY: position.y })), edges: template.edges })),
      nodes: workflow.nodes.map(({ position, ...node }) => ({ ...node, positionX: position.x, positionY: position.y })),
      edges: workflow.edges,
    }),
  })
  return response
}

export async function fetchProjectDashboardMetrics(): Promise<ProjectDashboardMetrics> {
  const response = await request<ApiResponse<RawDashboardMetrics> | RawDashboardMetrics>('/api/v1/project-dashboard-metrics')
  const raw = 'data' in response ? response.data : response
  return {
    portfolioMetricsVisible: raw.portfolioMetricsVisible ?? true,
    risks: raw.risks,
    resource: raw.resource,
    milestones: raw.milestones.map((milestone) => ({ ...milestone, status: taskStatusMap[milestone.status] ?? '未开始' as TaskStatus })),
  }
}

export async function fetchResourceLoad(input: { from?: string; to?: string } = {}): Promise<ResourceLoadResponse> {
  const params = new URLSearchParams()
  if (input.from) params.set('from', input.from)
  if (input.to) params.set('to', input.to)
  const query = params.toString()
  return request<ResourceLoadResponse>(`/api/v1/resources/load${query ? `?${query}` : ''}`)
}

export async function fetchDirectoryMembers() {
  const me = await fetchAuthMe()
  const response = await request<{ viewerId: string; organizationId: string; members: DirectoryMember[] }>(`/api/v1/organizations/${me.organizationId}/members`)
  return response
}

export async function syncDingTalkDirectory(organizationId: string) {
  return request<DingTalkSyncResult>(`/api/v1/organizations/${organizationId}/members/sync-dingtalk`, { method: 'POST', body: '{}' })
}

export async function linkDingTalkIdentity(organizationId: string, memberId: string, userId: string) {
  return request<{ id: string; memberId: string; provider: 'DINGTALK'; corpId: string; userId: string }>(`/api/v1/organizations/${organizationId}/members/${memberId}/external-identities/dingtalk`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export async function grantSystemRole(organizationId: string, memberId: string, roleCode: SystemRoleCode) {
  return request<{ id: string; memberId: string; roleId: string; roleCode: SystemRoleCode }>(`/api/v1/organizations/${organizationId}/members/${memberId}/system-roles/${roleCode}`, { method: 'POST', body: '{}' })
}

export async function revokeSystemRole(organizationId: string, memberId: string, roleCode: SystemRoleCode) {
  return request<{ id: string; memberId: string; roleId: string; roleCode: SystemRoleCode; revoked: boolean; projectL2Revoked?: number }>(`/api/v1/organizations/${organizationId}/members/${memberId}/system-roles/${roleCode}`, { method: 'DELETE' })
}

export async function deleteDirectoryMember(organizationId: string, memberId: string) {
  return request<{ memberId: string; name: string }>(`/api/v1/organizations/${organizationId}/members/${memberId}`, { method: 'DELETE' })
}

export async function fetchProjectAccess(projectId: string) {
  return request<ProjectAccessData>(`/api/v1/projects/${projectId}/access`)
}

export async function fetchProjectAssigneeOptions(projectId: string) {
  const response = await request<{ members: ProjectMemberOption[] }>(`/api/v1/projects/${projectId}/assignee-options`)
  return response.members
}

export async function addProjectMember(projectId: string, memberId: string) {
  return request<{ projectId: string; memberId: string; membershipRole: string }>(`/api/v1/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify({ memberId }) })
}

export async function removeProjectMember(projectId: string, memberId: string) {
  return request<{ projectId: string; memberId: string; membershipRole: string; removed: boolean }>(`/api/v1/projects/${projectId}/members/${memberId}`, { method: 'DELETE' })
}

export async function grantProjectL2(projectId: string, memberId: string) {
  return request<ProjectAccessGrantResponse>(`/api/v1/projects/${projectId}/access/l2`, { method: 'POST', body: JSON.stringify({ memberId }) })
}

export async function revokeProjectL2(projectId: string, memberId: string) {
  return request<ProjectAccessGrantResponse & { revoked: boolean }>(`/api/v1/projects/${projectId}/access/l2/${memberId}`, { method: 'DELETE' })
}

type ProjectAccessGrantResponse = { id: string; projectId: string; memberId: string; roleCode: 'L2'; grantedById: string; parentGrantId?: string | null; createdAt: string }

export async function fetchWorkflow(projectId: string) {
  const raw = await request<RawWorkflowResponse>(`/api/v1/projects/${projectId}/workflow`)
  const draftVersion = raw.workflow?.draftVersion
  const publishedVersion = raw.workflow?.publishedVersion && 'nodes' in raw.workflow.publishedVersion ? raw.workflow.publishedVersion : null
  const version = draftVersion ?? publishedVersion
  if (!version) return createEmptyWorkflow(projectId, new Date().toISOString().slice(0, 10))
  const mapped = mapVersion(version, projectId)
  if (publishedVersion && publishedVersion !== version) mapped.publishedWorkflow = mapVersion(publishedVersion, projectId)
  const publishedLayout = mapPublishedLayout(raw.workflow?.publishedVersion)
  if (publishedLayout) mapped.publishedLayout = publishedLayout
  return mapped
}

export async function fetchClaimableTasks() {
  const raw = await request<RawClaimableTask[]>('/api/v1/claim-tasks')
  return raw.map((task): ClaimableTask => ({ ...task, claimDepartmentIds: task.claimDepartmentIds ?? [], claimDepartmentNames: task.claimDepartmentNames ?? ['部门信息不可用'], status: taskStatusMap[task.status] ?? '未开始' }))
}

export async function fetchMyClaimTasks() {
  const raw = await request<RawMyClaimTask[]>('/api/v1/claim-tasks/mine')
  return raw.map((task): MyClaimTask => ({ ...task, claimDepartmentIds: task.claimDepartmentIds ?? [], claimDepartmentNames: task.claimDepartmentNames ?? ['部门信息不可用'], status: taskStatusMap[task.status] ?? '未开始' }))
}

export async function claimTask(taskId: string) {
  return request<{ claimTaskId: string; memberId: string; claimed: boolean }>(`/api/v1/claim-tasks/${taskId}/claim`, { method: 'POST', body: '{}' })
}

export async function fetchClaimTaskDepartments() {
  return request<{ id: string; name: string }[]>('/api/v1/claim-task-departments')
}

export async function createClaimTask(input: { name: string; duration?: number; effort?: number; description?: string; closureCriteria?: string; departmentIds?: string[] }) {
  return request<{ claimTaskId: string; name: string; published: boolean }>('/api/v1/claim-tasks', { method: 'POST', body: JSON.stringify(input) })
}

export async function updateClaimTask(taskId: string, input: { name: string; duration: number; effort: number; description?: string; closureCriteria?: string; departmentIds?: string[] }) {
  return request<{ claimTaskId: string; name: string; updated: boolean }>(`/api/v1/claim-tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(input) })
}

export async function fetchWorkflowAuditLogs(projectId: string) {
  return request<WorkflowAuditLog[]>(`/api/v1/projects/${projectId}/audit-logs`)
}

function workflowPayload(workflow: Workflow) {
  const schedules = scheduleWorkflow(workflow).schedules
  return {
    baselineStart: workflow.baselineStart,
    calendar: workflow.calendar,
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      wbs: node.wbs,
      parentId: node.parentId,
      name: node.name,
      owner: node.owner,
      assigneeIds: node.assigneeIds,
      duration: node.duration,
      effort: node.effort,
      description: node.description,
      closureCriteria: node.closureCriteria,
      plannedStartOverride: node.plannedStartOverride ?? null,
      plannedEndOverride: node.plannedEndOverride ?? null,
      position: node.position,
      progress: node.progress,
      status: node.status,
      actualStart: node.actualStart,
      actualEnd: node.actualEnd,
      completionApprovalStatus: node.completionApprovalStatus,
      completionConfirmedAt: node.completionConfirmedAt,
      completionNote: node.completionNote,
      overdueReason: node.overdueReason,
      closureChecks: node.closureChecks,
      deliverables: node.deliverables,
      schedule: schedules[node.id],
    })),
    edges: workflow.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, lagDays: edge.lagDays })),
  }
}

export async function saveWorkflowDraft(workflow: Workflow) {
  await request(`/api/v1/projects/${workflow.projectId}/workflow/draft`, { method: 'PUT', body: JSON.stringify(workflowPayload(workflow)) })
}

export async function fetchWorkflowTemplates() {
  return request<WorkflowTemplateSummary[]>('/api/v1/workflow-templates')
}

export async function createWorkflowTemplate(input: { name: string; description?: string; workflow: Workflow }) {
  return request<WorkflowTemplateSummary>('/api/v1/workflow-templates', { method: 'POST', body: JSON.stringify({ name: input.name, description: input.description, projectId: input.workflow.projectId, workflow: workflowPayload(input.workflow) }) })
}

export async function loadWorkflowTemplate(projectId: string, templateId: string) {
  return request<Workflow>(`/api/v1/projects/${projectId}/workflow/templates/${templateId}/use`, { method: 'POST', body: '{}' })
}

export async function savePublishedWorkflow(workflow: Workflow) {
  await request(`/api/v1/projects/${workflow.projectId}/workflow/published`, { method: 'PUT', body: JSON.stringify(workflowPayload(workflow)) })
}

export async function publishWorkflow(projectId: string) {
  await request(`/api/v1/projects/${projectId}/workflow/publish`, { method: 'POST', body: '{}' })
}

export async function createProject(input: { name: string; code: string; owner: string; department: string; start: string; end: string; portfolioId?: string }) {
  const raw = await request<RawProject>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name: input.name, code: input.code || undefined, ownerName: input.owner, departmentName: input.department, plannedStart: input.start, plannedEnd: input.end, portfolioId: input.portfolioId }) })
  return mapProject(raw)
}

export async function deleteProject(projectId: string) {
  return request<{ projectId: string; archived: boolean }>(`/api/v1/projects/${projectId}`, { method: 'DELETE' })
}

export async function createProjectPortfolio(input: { name: string; code?: string; description?: string; projectIds?: string[] }) {
  const raw = await request<RawPortfolio>('/api/v1/project-portfolios', { method: 'POST', body: JSON.stringify(input) })
  return { id: raw.id, code: raw.code, name: raw.name, description: raw.description ?? undefined, owner: raw.owner?.name, projectIds: raw.projectIds ?? input.projectIds ?? [] } satisfies ProjectPortfolio
}

export async function deleteProjectPortfolio(portfolioId: string) {
  return request<{ portfolioId: string; archived: boolean; ungroupedProjectCount: number }>(`/api/v1/project-portfolios/${portfolioId}`, { method: 'DELETE' })
}

export async function assignProjectPortfolio(projectId: string, portfolioId: string | null) {
  return request<RawProject>(`/api/v1/projects/${projectId}/portfolio`, { method: 'PUT', body: JSON.stringify({ portfolioId }) })
}

export async function createTask(projectId: string, input: { name: string; duration?: number; effort?: number; ownerMemberId?: string; description?: string; closureCriteria?: string }) {
  return request<{ taskId: string; nodeId: string; versionId: string }>(`/api/v1/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(input) })
}

export async function updateTask(taskId: string, input: Record<string, unknown>) {
  return request<{ taskId: string; nodeId: string | null }>(`/api/v1/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(input) })
}

export async function directStartTask(taskId: string) {
  return request<{ taskId: string; nodeId: string | null }>(`/api/v1/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status: '进行中', forceStart: true }) })
}

export async function addTaskDeliverable(taskId: string, input: { name: string; kind?: string; versionLabel?: string; url?: string; mimeType?: string; sizeBytes?: number; externalProvider?: string; externalId?: string; approvalProcessInstanceId?: string; approvalProcessCode?: string; approvalFileId?: string; approvalSpaceId?: string }) {
  return request<{ id: string; taskId: string; name: string }>(`/api/v1/tasks/${taskId}/deliverables`, { method: 'POST', body: JSON.stringify(input) })
}

export async function uploadTaskDeliverable(taskId: string, file: File, input: { name?: string; versionLabel?: string; approvalProcessInstanceId?: string; approvalProcessCode?: string; approvalFileId?: string; approvalSpaceId?: string } = {}) {
  const form = new FormData()
  form.append('file', file, file.name)
  if (input.name?.trim()) form.append('name', input.name.trim())
  if (input.versionLabel?.trim()) form.append('versionLabel', input.versionLabel.trim())
  for (const [key, value] of Object.entries({ approvalProcessInstanceId: input.approvalProcessInstanceId, approvalProcessCode: input.approvalProcessCode, approvalFileId: input.approvalFileId, approvalSpaceId: input.approvalSpaceId })) if (value?.trim()) form.append(key, value.trim())
  const raw = await request<{ id: string; taskId: string; kind: string; name: string; versionLabel: string; url: string | null; objectKey: string | null; mimeType: string | null; sizeBytes: number | null; uploaderMemberId: string | null; approvalProcessInstanceId: string | null; approvalProcessCode: string | null; approvalFileId: string | null; approvalSpaceId: string | null; uploader?: { name: string } | null; createdAt: string }>(`/api/v1/tasks/${taskId}/deliverables/upload`, { method: 'POST', body: form })
  return { id: raw.id, kind: 'file' as const, name: raw.name, version: raw.versionLabel, uploader: raw.uploader?.name ?? '当前用户', createdAt: raw.createdAt, url: raw.url ?? undefined, objectKey: raw.objectKey ?? undefined, mimeType: raw.mimeType ?? undefined, size: raw.sizeBytes ?? undefined, approvalProcessInstanceId: raw.approvalProcessInstanceId ?? undefined, approvalProcessCode: raw.approvalProcessCode ?? undefined, approvalFileId: raw.approvalFileId ?? undefined, approvalSpaceId: raw.approvalSpaceId ?? undefined }
}

export async function fetchPredecessorDeliverable(taskId: string, deliverableId: string) {
  return request<{ sourceTask: { id: string; wbs: string; name: string }; deliverable: { id: string; name: string; url: string | null; objectKey: string | null } }>(`/api/v1/tasks/${taskId}/predecessor-deliverables/${deliverableId}`)
}

/** 提交任务交付 OA 审批；工作空间使用 Project OS 内部审批，不调用钉钉审批接口。 */
export async function submitTaskApproval(taskId: string, input: { note?: string; overdueReason?: string; progress?: number; deliveryType?: 'STAGE' | 'FINAL'; source?: 'PROJECT_OS' | 'DINGTALK' }) {
  return request<{ id: string; taskId: string; processInstanceId: string; source: 'PROJECT_OS' | 'DINGTALK'; deliveryType: 'STAGE' | 'FINAL'; status: string; createdAt: string }>(`/api/v1/tasks/${taskId}/approvals`, { method: 'POST', body: JSON.stringify(input) })
}

/** L1/L2 在管理中心处理 Project OS 内部 OA 审批。 */
export async function decideApproval(approvalId: string, outcome: 'APPROVED' | 'REJECTED', comment?: string) {
  return request<{ approvalId: string; status: string; processInstanceId: string; currentStepNo: number }>(`/api/v1/approvals/${approvalId}/decision`, { method: 'POST', body: JSON.stringify({ outcome, comment }) })
}

/** 提交特殊放行审批：仅允许任务负责人发起，审批仍由 L2/管理员处理。 */
export async function submitSpecialReleaseApproval(taskId: string, reason: string, approverUserIds?: string[], source?: 'PROJECT_OS' | 'DINGTALK') {
  return request<{ id: string; taskId: string; processInstanceId: string; purpose: 'BYPASS'; status: string; createdAt: string }>(`/api/v1/tasks/${taskId}/special-release-approvals`, { method: 'POST', body: JSON.stringify({ reason, approverUserIds, source }) })
}

/** 手动同步一次审批状态（本地开发收不到事件回调时的兜底）。 */
export async function refreshTaskApproval(taskId: string, approvalId: string) {
  return request<{ status: string }>(`/api/v1/tasks/${taskId}/approvals/${approvalId}/refresh`, { method: 'POST', body: '{}' })
}

/** 前置交付物列表（文档 §10）：直接前置任务产出的文件，含审批中标记。 */
export type PredecessorDeliverableItem = {
  id: string
  name: string
  versionLabel: string
  url: string | null
  objectKey: string | null
  mimeType: string | null
  sizeBytes: number | null
  createdAt: string
  uploaderName: string | null
  predecessorWbs: string | null
  predecessorName: string | null
  approvalPending: boolean
}

export async function fetchPredecessorDeliverables(taskId: string) {
  return request<PredecessorDeliverableItem[]>(`/api/v1/tasks/${taskId}/predecessor-deliverables`)
}

/** 项目开关：审批通过后后续任务是否自动进入"进行中"。 */
export async function updateProjectApprovalSettings(projectId: string, approvalAutoStart: boolean) {
  return request<{ id: string; approvalAutoStart: boolean }>(`/api/v1/projects/${projectId}/approval-settings`, { method: 'PATCH', body: JSON.stringify({ approvalAutoStart }) })
}

export async function fetchApprovalPolicy(projectId: string) {
  return request<ApprovalPolicyView>(`/api/v1/projects/${projectId}/approval-policy`)
}

export async function updateApprovalPolicy(projectId: string, input: { enabled: boolean; steps: Array<Pick<ApprovalPolicyView['steps'][number], 'stepNo' | 'stage' | 'mode' | 'minApprovals'> & Partial<Pick<ApprovalPolicyView['steps'][number], 'approverMemberIds' | 'ccMemberIds'>>> }) {
  return request<ApprovalPolicyView>(`/api/v1/projects/${projectId}/approval-policy`, { method: 'PUT', body: JSON.stringify(input) })
}

export async function deleteTask(taskId: string) {
  return request<{ taskId: string; archived: boolean; affectedEdgeCount: number }>(`/api/v1/tasks/${taskId}`, { method: 'DELETE' })
}

export async function addTaskAssignee(taskId: string, memberId: string) {
  return request<{ id: string; taskId: string; memberId: string }>(`/api/v1/tasks/${taskId}/assignees`, { method: 'POST', body: JSON.stringify({ memberId }) })
}

export async function removeTaskAssignee(taskId: string, memberId: string) {
  return request<{ id: string; taskId: string; memberId: string; removedAt: string }>(`/api/v1/tasks/${taskId}/assignees/${memberId}`, { method: 'DELETE' })
}
