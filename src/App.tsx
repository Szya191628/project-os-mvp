import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createEmptyWorkflow } from './data'
import { assignProjectPortfolio, createProject as createProjectApi, createProjectPortfolio, deleteProject as deleteProjectApi, deleteProjectPortfolio as deleteProjectPortfolioApi, fetchAuthMe, fetchProjectDashboardMetrics, fetchProjectPortfolios, fetchProjects, fetchServerNotifications, fetchWorkflow, logout, mapServerNotificationType, publishWorkflow as publishWorkflowApi, savePublishedWorkflow, saveWorkflowDraft, updateDingTalkIntegration as updateDingTalkIntegrationApi } from './api'
import { Shell } from './components/Shell'
import { NotificationPanel } from './components/NotificationPanel'
import type { ViewId } from './components/CommandPalette'
import { ProjectCreateDialog, type NewProjectInput } from './components/ProjectCreateDialog'
import { ProjectPortfolioCreateDialog } from './components/ProjectPortfolioCreateDialog'
import type { AuthSession, NotificationSettings, Project, ProjectDashboardMetrics, ProjectNotification, ProjectPortfolio, Workflow } from './types'
import { buildDueNotifications, createWorkflowNotifications, defaultNotificationSettings, mergeNotifications } from './notifications'
import { LoginPage } from './pages/LoginPage'
import { getProjectCapabilities } from './projectAccess'
import { LatestSaveQueue, persistWorkflowSnapshot } from './workflow/persistence'

const PortfolioPage = lazy(() => import('./pages/PortfolioPage').then(({ PortfolioPage }) => ({ default: PortfolioPage })))
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then(({ ProjectsPage }) => ({ default: ProjectsPage })))
const ProjectWorkspacePage = lazy(() => import('./pages/ProjectWorkspacePage').then(({ ProjectWorkspacePage }) => ({ default: ProjectWorkspacePage })))
const MyTasksPage = lazy(() => import('./pages/MyTasksPage').then(({ MyTasksPage }) => ({ default: MyTasksPage })))
const ResourcesPage = lazy(() => import('./pages/ResourcesPage').then(({ ResourcesPage }) => ({ default: ResourcesPage })))
const TimesheetsPage = lazy(() => import('./pages/TimesheetsPage').then(({ TimesheetsPage }) => ({ default: TimesheetsPage })))
const RisksPage = lazy(() => import('./pages/RisksPage').then(({ RisksPage }) => ({ default: RisksPage })))
const CostsPage = lazy(() => import('./pages/CostsPage').then(({ CostsPage }) => ({ default: CostsPage })))
const MembersPage = lazy(() => import('./pages/MembersPage').then(({ MembersPage }) => ({ default: MembersPage })))
const AgentPage = lazy(() => import('./pages/AgentPage').then(({ AgentPage }) => ({ default: AgentPage })))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage').then(({ NotificationsPage }) => ({ default: NotificationsPage })))
const ClaimTasksPage = lazy(() => import('./pages/ClaimTasksPage').then(({ ClaimTasksPage }) => ({ default: ClaimTasksPage })))
const ApprovalCenterPage = lazy(() => import('./pages/ApprovalCenterPage').then(({ ApprovalCenterPage }) => ({ default: ApprovalCenterPage })))

const managementViewIds = new Set<ViewId>(['resources', 'timesheets', 'risks', 'costs', 'members'])
type WorkflowSaveRequest = { workflow: Workflow; previousWorkflow?: Workflow }

export default function App() {
  const [view, setView] = useState<ViewId>('portfolio')
  const [projectList, setProjectList] = useState<Project[]>([])
  const projectListRef = useRef(projectList)
  const [portfolioList, setPortfolioList] = useState<ProjectPortfolio[]>([])
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [dashboardMetrics, setDashboardMetrics] = useState<ProjectDashboardMetrics | null>(null)
  const [workflows, setWorkflows] = useState<Record<string, Workflow>>({})
  const workflowsRef = useRef(workflows)
  const [savedWorkflows, setSavedWorkflows] = useState<Record<string, Workflow>>({})
  const savedWorkflowsRef = useRef(savedWorkflows)
  const saveQueuesRef = useRef<Record<string, LatestSaveQueue<WorkflowSaveRequest>>>({})
  const [dataLoading, setDataLoading] = useState(true)
  const [apiError, setApiError] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<ProjectNotification[]>(() => readStorage('project-os.notifications', []))
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(() => readNotificationSettings())
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createDialogPortfolioId, setCreateDialogPortfolioId] = useState<string | undefined>()
  const [portfolioDialogOpen, setPortfolioDialogOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)

  useEffect(() => { workflowsRef.current = workflows }, [workflows])
  useEffect(() => { savedWorkflowsRef.current = savedWorkflows }, [savedWorkflows])
  useEffect(() => { projectListRef.current = projectList }, [projectList])
  useEffect(() => { writeStorage('project-os.notifications', notifications) }, [notifications])
  useEffect(() => { writeStorage('project-os.notification-settings', notificationSettings) }, [notificationSettings])
  useEffect(() => {
    const dueNotifications = projectList.flatMap((project) => buildDueNotifications(project, workflows[project.id], notificationSettings))
    // Date-sensitive reminders are materialized into the persisted message list when projects or calendar settings change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotifications((current) => mergeNotifications(current, dueNotifications, workflows))
  }, [projectList, workflows, notificationSettings])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setDataLoading(true)
      setApiError(null)
      let session: AuthSession
      try {
        session = await fetchAuthMe()
      } catch (error) {
        if (!cancelled) {
          setAuthSession(null)
          setAuthRequired(true)
          setAuthError(error instanceof Error && error.message === 'authentication_required' ? new URLSearchParams(window.location.search).get('auth_error') : 'api_unavailable')
          setApiError(null)
          setDataLoading(false)
        }
        return
      }

      if (cancelled) return
      setAuthSession(session)
      setAuthRequired(false)
      setAuthError(null)

      try {
        const [loadedProjects, loadedPortfolios, loadedMetrics, serverNotifications] = await Promise.all([fetchProjects(), fetchProjectPortfolios(), fetchProjectDashboardMetrics(), fetchServerNotifications()])
        if (cancelled) return
        setProjectList(loadedProjects)
        setPortfolioList(loadedPortfolios)
        setDashboardMetrics(loadedMetrics)
        const mappedNotifications = serverNotifications.filter((item) => item.projectId).map((item): ProjectNotification => ({ id: item.id, projectId: item.projectId as string, projectCode: item.projectCode, projectName: item.projectName, taskId: item.taskId ?? undefined, taskName: item.taskName || undefined, type: mapServerNotificationType(item.eventType), title: item.title, body: item.body, createdAt: item.createdAt, read: Boolean(item.readAt), dueDate: item.dueDate ?? undefined }))
        setNotifications((current) => mergeNotifications(current, mappedNotifications, {}))
        const target = loadedProjects.find((project) => project.id === selectedProjectId) ?? loadedProjects[0]
        if (target) setSelectedProjectId(target.id)
        if (target) {
          const workflow = await fetchWorkflow(target.id)
          if (!cancelled) {
            const loadedWorkflows = { [target.id]: workflow }
            workflowsRef.current = { ...workflowsRef.current, ...loadedWorkflows }
            savedWorkflowsRef.current = { ...savedWorkflowsRef.current, ...loadedWorkflows }
            setWorkflows(workflowsRef.current)
            setSavedWorkflows(savedWorkflowsRef.current)
          }
        } else if (!cancelled) {
          workflowsRef.current = {}
          savedWorkflowsRef.current = {}
          setWorkflows(workflowsRef.current)
          setSavedWorkflows(savedWorkflowsRef.current)
        }
      } catch (error) {
        if (!cancelled) {
          if (error instanceof Error && error.message === 'authentication_required') {
            setAuthSession(null)
            setAuthRequired(true)
            setAuthError(null)
            setApiError(null)
          } else {
            setApiError(error instanceof Error ? error.message : '无法读取后端数据')
          }
        }
      } finally {
        if (!cancelled) setDataLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
    // The initial load intentionally runs once; later project navigation loads only the selected workflow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadWorkflow = async (projectId: string) => {
    try {
      const workflow = await fetchWorkflow(projectId)
      workflowsRef.current = { ...workflowsRef.current, [projectId]: workflow }
      savedWorkflowsRef.current = { ...savedWorkflowsRef.current, [projectId]: workflow }
      setWorkflows(workflowsRef.current)
      setSavedWorkflows(savedWorkflowsRef.current)
      setApiError(null)
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '无法读取流程数据')
    }
  }

  const refreshProjectList = async () => {
    const [loadedProjects, loadedPortfolios, loadedMetrics] = await Promise.all([fetchProjects(), fetchProjectPortfolios(), fetchProjectDashboardMetrics()])
    projectListRef.current = loadedProjects
    setProjectList(loadedProjects)
    setPortfolioList(loadedPortfolios)
    setDashboardMetrics(loadedMetrics)
    if (selectedProjectId && !loadedProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(loadedProjects[0]?.id ?? '')
      setSelectedTaskId(null)
    }
  }

  const openProject = (projectId: string, taskId?: string) => {
    setSelectedProjectId(projectId)
    setSelectedTaskId(taskId ?? null)
    setView('project')
    if (!workflowsRef.current[projectId]) void loadWorkflow(projectId)
  }

  const applyAgentWorkflowPreview = (preview: Workflow) => {
    const project = projectListRef.current.find((candidate) => candidate.id === preview.projectId)
    if (!project) {
      setApiError('流程草稿对应的项目不在当前页面授权范围内')
      return
    }
    const nextWorkflow: Workflow = { ...preview, status: 'draft', calendar: preview.calendar ?? workflowsRef.current[preview.projectId]?.calendar }
    workflowsRef.current = { ...workflowsRef.current, [preview.projectId]: nextWorkflow }
    setWorkflows(workflowsRef.current)
    setSelectedProjectId(preview.projectId)
    setSelectedTaskId(null)
    setView('project')
    setApiError(null)
  }

  const createProject = async (input: NewProjectInput): Promise<Project | undefined> => {
    try {
      const newProject = await createProjectApi(input)
      projectListRef.current = [newProject, ...projectListRef.current.filter((project) => project.id !== newProject.id)]
      setProjectList(projectListRef.current)
      setDashboardMetrics(await fetchProjectDashboardMetrics())
      setSelectedProjectId(newProject.id)
      setCreateDialogOpen(false)
      setCreateDialogPortfolioId(undefined)
      setView('project')
      await loadWorkflow(newProject.id)
      return newProject
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '项目创建失败')
      return undefined
    }
  }

  const createPortfolio = async (input: { name: string; code: string; description: string; projectIds: string[] }) => {
    try {
      const created = await createProjectPortfolio(input)
      setPortfolioList((current) => [created, ...current])
      const refreshedProjects = await fetchProjects()
      setProjectList(refreshedProjects)
      setDashboardMetrics(await fetchProjectDashboardMetrics())
      setPortfolioDialogOpen(false)
      setApiError(null)
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '项目组合创建失败')
    }
  }

  const deleteProject = async (projectId: string) => {
    saveQueuesRef.current[projectId]?.cancel()
    await deleteProjectApi(projectId)
    await refreshProjectList()
    if (selectedProjectId === projectId) setView('projects')
  }

  const updateProjectPortfolio = async (projectId: string, portfolioId: string | null) => {
    await assignProjectPortfolio(projectId, portfolioId)
    await refreshProjectList()
  }

  const openCreateProject = (portfolioId?: string) => {
    setCreateDialogPortfolioId(portfolioId)
    setCreateDialogOpen(true)
  }

  const deleteProjectPortfolio = async (portfolioId: string) => {
    await deleteProjectPortfolioApi(portfolioId)
    await refreshProjectList()
  }

  const handleWorkflowChange = (nextWorkflow: Workflow) => {
    const previousWorkflow = workflowsRef.current[nextWorkflow.projectId]
    const nextWorkflows = { ...workflowsRef.current, [nextWorkflow.projectId]: nextWorkflow }
    workflowsRef.current = nextWorkflows
    setWorkflows(nextWorkflows)
    const project = projectList.find((candidate) => candidate.id === nextWorkflow.projectId)
    if (!project) return
    const generated = createWorkflowNotifications(project, previousWorkflow, nextWorkflow)
    if (generated.length > 0) setNotifications((current) => mergeNotifications(current, generated, nextWorkflows))
    enqueueWorkflowSave({ workflow: nextWorkflow, previousWorkflow })
  }

  const replaceWorkflow = (nextWorkflow: Workflow) => {
    saveQueuesRef.current[nextWorkflow.projectId]?.cancel()
    const nextWorkflows = { ...workflowsRef.current, [nextWorkflow.projectId]: nextWorkflow }
    workflowsRef.current = nextWorkflows
    setWorkflows(nextWorkflows)
    savedWorkflowsRef.current = { ...savedWorkflowsRef.current, [nextWorkflow.projectId]: nextWorkflow }
    setSavedWorkflows(savedWorkflowsRef.current)
  }

  const persistWorkflow = async (workflow: Workflow, previousWorkflow?: Workflow) => {
    try {
      const persistedWorkflow = await persistWorkflowSnapshot(workflow, previousWorkflow, {
        saveDraft: saveWorkflowDraft,
        savePublished: savePublishedWorkflow,
        publish: publishWorkflowApi,
        reload: fetchWorkflow,
      })
      // Only advance the saved snapshot when this request is still the latest local workflow.
      // An older autosave may resolve after a newer change and must not become the reset target.
      if (workflowsRef.current[workflow.projectId] === workflow) {
        const nextWorkflows = { ...workflowsRef.current, [workflow.projectId]: persistedWorkflow }
        workflowsRef.current = nextWorkflows
        setWorkflows(nextWorkflows)
        savedWorkflowsRef.current = { ...savedWorkflowsRef.current, [workflow.projectId]: persistedWorkflow }
        setSavedWorkflows(savedWorkflowsRef.current)
      }
      if (workflowsRef.current[workflow.projectId] === workflow) setApiError(null)
    } catch (error) {
      // Publishing can fail after the draft save. Re-read the server state so the
      // editor does not remain in a false published state or keep stale task IDs.
      if (workflow.status === 'published' && workflowsRef.current[workflow.projectId] === workflow) {
        try {
          const refreshed = await fetchWorkflow(workflow.projectId)
          if (workflowsRef.current[workflow.projectId] === workflow) {
            const nextWorkflows = { ...workflowsRef.current, [workflow.projectId]: refreshed }
            workflowsRef.current = nextWorkflows
            setWorkflows(nextWorkflows)
            savedWorkflowsRef.current = { ...savedWorkflowsRef.current, [workflow.projectId]: refreshed }
            setSavedWorkflows(savedWorkflowsRef.current)
          }
        } catch {
          // Keep the original publish error when the recovery read also fails.
        }
      }
      if (workflowsRef.current[workflow.projectId] === workflow) setApiError(error instanceof Error ? error.message : '流程保存失败')
    }
  }

  const enqueueWorkflowSave = (request: WorkflowSaveRequest) => {
    const projectId = request.workflow.projectId
    const queue = saveQueuesRef.current[projectId] ?? new LatestSaveQueue<WorkflowSaveRequest>((latest) => persistWorkflow(latest.workflow, latest.previousWorkflow))
    saveQueuesRef.current[projectId] = queue
    queue.enqueue(request)
  }

  const markNotificationRead = (id: string) => setNotifications((current) => current.map((notification) => notification.id === id ? { ...notification, read: true } : notification))
  const markAllNotificationsRead = () => setNotifications((current) => current.some((notification) => !notification.read) ? current.map((notification) => ({ ...notification, read: true })) : current)
  const openNotification = (notification: ProjectNotification) => {
    markNotificationRead(notification.id)
    setNotificationsOpen(false)
    openProject(notification.projectId, notification.taskId)
  }

  const handleLogout = async () => {
    try {
      await logout()
    } finally {
      Object.values(saveQueuesRef.current).forEach((queue) => queue.cancel())
      saveQueuesRef.current = {}
      setAuthSession(null)
      setAuthRequired(true)
      setAuthError(null)
      setProjectList([])
      setPortfolioList([])
      setDashboardMetrics(null)
      setWorkflows({})
      setSavedWorkflows({})
      savedWorkflowsRef.current = {}
      setSelectedProjectId('')
      setSelectedTaskId(null)
      setView('portfolio')
    }
  }

  const changeDingTalkIntegration = async (enabled: boolean) => {
    const settings = await updateDingTalkIntegrationApi(enabled)
    setAuthSession((current) => current ? { ...current, dingtalkIntegrationEnabled: settings.enabled } : current)
  }

  const selectedProject = projectList.find((project) => project.id === selectedProjectId) ?? projectList[0]
  const selectedWorkflow = selectedProject ? (workflows[selectedProject.id] ?? createEmptyWorkflow(selectedProject.id, selectedProject.start)) : null
  const canCreateProject = authSession?.canCreateProject ?? (authSession?.baseRole === 'L1' || authSession?.baseRole === 'L2')
  const canCreatePortfolio = authSession?.baseRole === 'L1'
  const canManageMembers = authSession?.baseRole === 'L1'
  const canUseAgent = authSession?.baseRole === 'L1' || authSession?.baseRole === 'L2'
  const canViewPortfolioManagement = authSession?.baseRole === 'L1' || authSession?.baseRole === 'L2'
  const canManageApprovals = authSession?.baseRole === 'L1' || (authSession?.baseRole === 'L2' && projectList.some((project) => project.accessLevel === 'L2'))
  const currentUserRoleLabel = authSession?.baseRole === 'L1' ? 'L1 · 全局管理员' : authSession?.baseRole === 'L2' ? 'L2 · 项目经理' : 'L3 · 执行成员'
  // 部门主管只读监督：下属参与、本人非成员的项目 → 流程视图整体只读；
  // 主管本人作为成员/任务负责人的项目仍按原有 L3 执行视图。
  const supervisingProjectIds = authSession?.supervisingProjectIds ?? []
  const isSupervisorOnly = (projectId: string) => projectList.find((item) => item.id === projectId)?.accessLevel === 'SUPERVISOR' || (supervisingProjectIds.includes(projectId) && !projectList.find((item) => item.id === projectId)?.memberIds.includes(authSession?.memberId ?? ''))
  const selectedProjectCapabilities = getProjectCapabilities(selectedProject?.accessLevel)
  const canNavigateToView = (nextView: ViewId) => {
    if (managementViewIds.has(nextView) && !canViewPortfolioManagement) return false
    if (nextView === 'members' && !canManageMembers) return false
    if (nextView === 'approvals' && !canManageApprovals) return false
    if (nextView === 'agent' && !canUseAgent) return false
    return true
  }
  const navigateView = (nextView: ViewId) => {
    if (!canNavigateToView(nextView)) return
    setView(nextView)
    // 进入项目组合页时刷新项目/组合/仪表盘指标，保证里程碑与健康度实时反映最新项目状态
    if (nextView === 'portfolio') void refreshProjectList()
  }
  const visibleView = canNavigateToView(view) ? view : 'portfolio'

  if (authRequired) return <LoginPage error={authError} />

  const page = {
     portfolio: <PortfolioPage projects={projectList} portfolios={portfolioList} metrics={dashboardMetrics} onOpenProject={openProject} onCreateProject={() => openCreateProject()} onCreateProjectInPortfolio={openCreateProject} onCreatePortfolio={() => setPortfolioDialogOpen(true)} canCreateProject={canCreateProject} canCreatePortfolio={canCreatePortfolio} canManageProjects={authSession?.baseRole === 'L1' || authSession?.baseRole === 'L2'} onRemoveProjectFromPortfolio={async (projectId) => updateProjectPortfolio(projectId, null)} onAddProjectToPortfolio={async (projectId, portfolioId) => updateProjectPortfolio(projectId, portfolioId)} canManagePortfolios={authSession?.baseRole === 'L1'} onDeletePortfolio={deleteProjectPortfolio} dingtalkIntegrationEnabled={authSession?.dingtalkIntegrationEnabled ?? true} canManageDingTalkIntegration={authSession?.baseRole === 'L1'} onDingTalkIntegrationChange={changeDingTalkIntegration} />,
    projects: <ProjectsPage projects={projectList} portfolios={portfolioList} onOpenProject={openProject} onCreateProject={() => openCreateProject()} canCreateProject={canCreateProject} canManageProjects={authSession?.baseRole === 'L1'} onDeleteProject={deleteProject} onUpdateProjectPortfolio={updateProjectPortfolio} supervisingProjectIds={supervisingProjectIds} currentMemberId={authSession?.memberId ?? ''} />,
    project: selectedProject && selectedWorkflow ? <ProjectWorkspacePage key={`${selectedProject.id}-${selectedTaskId ?? 'none'}`} project={selectedProject} workflow={selectedWorkflow} lastSavedWorkflow={savedWorkflows[selectedProject.id]} initialTaskId={selectedTaskId} currentMemberId={authSession?.memberId} capabilities={selectedProjectCapabilities} onWorkflowChange={handleWorkflowChange} onWorkflowReload={replaceWorkflow} readOnly={isSupervisorOnly(selectedProject.id)} /> : <section className="panel empty-state"><h2>{dataLoading ? '正在读取项目数据…' : '请选择一个项目'}</h2><p>{apiError ?? '项目数据将从后端数据库加载。'}</p></section>,
    mytasks: <MyTasksPage projects={projectList} workflows={workflows} currentMemberId={authSession?.memberId ?? ''} currentUser={authSession?.memberName ?? '当前用户'} onOpenTask={openProject} />,
    claimtasks: <ClaimTasksPage canPublishTasks={authSession?.baseRole === 'L1' || authSession?.baseRole === 'L2'} />,
    resources: <ResourcesPage onOpenTask={openProject} />,
    timesheets: <TimesheetsPage />,
    risks: <RisksPage />,
    costs: <CostsPage />,
    approvals: <ApprovalCenterPage projects={projectList} role={authSession?.baseRole ?? 'L3'} currentMemberId={authSession?.memberId ?? ''} onOpenProject={openProject} />,
    members: <MembersPage />,
    notifications: <NotificationsPage role={authSession?.baseRole} />,
    agent: <AgentPage projects={projectList} workflows={workflows} currentProjectId={selectedProject?.id} actorRole={authSession?.baseRole === 'L3' ? 'executor' : canUseAgent ? 'publisher' : 'viewer'} onApplyWorkflowPreview={applyAgentWorkflowPreview} onCreateProject={canCreateProject ? (input) => createProject(input) : undefined} onRefreshProject={async (projectId) => { if (projectId) await loadWorkflow(projectId) }} onOpenProject={(projectId, taskId) => {
      const targetProjectId = projectId ?? selectedProject?.id
      if (targetProjectId) openProject(targetProjectId, taskId)
    }} />,
  }[visibleView]

  const unreadCount = notifications.filter((notification) => !notification.read).length

  return <>
    <Shell activeView={visibleView} onNavigate={navigateView} notificationUnreadCount={unreadCount} onOpenNotifications={() => setNotificationsOpen(true)} onLogout={handleLogout} canManageMembers={canManageMembers} canUseAgent={canUseAgent} canViewPortfolioManagement={canViewPortfolioManagement} canManageApprovals={canManageApprovals} currentUserName={authSession?.memberName} currentUserRoleLabel={currentUserRoleLabel}>{apiError && <div className="api-status-banner" role="status">后端数据提示：{apiError}</div>}<Suspense fallback={<section className="panel empty-state" role="status"><p>正在加载页面…</p></section>}>{page}</Suspense></Shell>
    {createDialogOpen && <ProjectCreateDialog portfolios={portfolioList} allowPortfolioSelection={canCreatePortfolio} initialPortfolioId={createDialogPortfolioId} onClose={() => { setCreateDialogOpen(false); setCreateDialogPortfolioId(undefined) }} onCreate={createProject} />}
    {portfolioDialogOpen && <ProjectPortfolioCreateDialog projects={projectList} onClose={() => setPortfolioDialogOpen(false)} onCreate={createPortfolio} />}
    {notificationsOpen && <NotificationPanel notifications={notifications} settings={notificationSettings} onSettingsChange={setNotificationSettings} onMarkRead={markNotificationRead} onMarkAllRead={markAllNotificationsRead} onOpenNotification={openNotification} onClose={() => setNotificationsOpen(false)} />}
  </>
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function writeStorage<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Local storage is an enhancement for the prototype; the in-memory state remains usable.
  }
}

function readNotificationSettings(): NotificationSettings {
  const value = readStorage<Partial<NotificationSettings>>('project-os.notification-settings', defaultNotificationSettings)
  return { reminderDays: value.reminderDays === 5 ? 5 : 3 }
}
