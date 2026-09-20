import { AlertTriangle, ArrowDownRight, ArrowUpRight, BellOff, BellRing, CalendarClock, CheckSquare2, ChevronDown, FolderKanban, Layers3, Plus, Search, Trash2, UsersRound, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, ProjectDashboardMetrics, ProjectPortfolio } from '../types'
import { LinkButton, PageHeader, ProgressBar, SectionHeader, StatusBadge } from '../components/UI'
import { PortfolioFlowWorkbench } from '../components/PortfolioFlowWorkbench'
import { ApprovalManagementDialog } from '../components/ApprovalManagementDialog'
import type { TaskStatus } from '../types'
import { loadPortfolioSelection, savePortfolioSelection } from '../portfolioSelection'

interface PortfolioPageProps {
  projects: Project[]
  portfolios: ProjectPortfolio[]
  metrics: ProjectDashboardMetrics | null
  onOpenProject: (projectId: string, taskId?: string) => void
  onCreateProject: () => void
  onCreatePortfolio: () => void
  onCreateProjectInPortfolio?: (portfolioId: string) => void
  canCreateProject?: boolean
  canCreatePortfolio?: boolean
  canManageProjects?: boolean
  onAddProjectToPortfolio?: (projectId: string, portfolioId: string) => Promise<void>
  onRemoveProjectFromPortfolio?: (projectId: string) => Promise<void>
  canManagePortfolios?: boolean
  onDeletePortfolio?: (portfolioId: string) => Promise<void>
  dingtalkIntegrationEnabled?: boolean
  canManageDingTalkIntegration?: boolean
  onDingTalkIntegrationChange?: (enabled: boolean) => Promise<void>
}

type PortfolioGroup = ProjectPortfolio & { projects: Project[]; isUngrouped?: boolean }

export function PortfolioPage({ projects, portfolios, metrics, onOpenProject, onCreateProject, onCreatePortfolio, onCreateProjectInPortfolio, canCreateProject = false, canCreatePortfolio = false, canManageProjects = false, onRemoveProjectFromPortfolio, onAddProjectToPortfolio, canManagePortfolios = false, onDeletePortfolio, dingtalkIntegrationEnabled = true, canManageDingTalkIntegration = false, onDingTalkIntegrationChange }: PortfolioPageProps) {
  const active = projects.filter((project) => project.status === '执行中' || project.status === '有风险').length
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<{ project: Project; portfolioName: string } | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [pendingPortfolioDeletion, setPendingPortfolioDeletion] = useState<ProjectPortfolio | null>(null)
  const [deletingPortfolio, setDeletingPortfolio] = useState(false)
  const [deletePortfolioError, setDeletePortfolioError] = useState<string | null>(null)
  const [approvalManagementOpen, setApprovalManagementOpen] = useState(false)
  const [dingtalkSaving, setDingTalkSaving] = useState(false)
  const [dingtalkError, setDingTalkError] = useState<string | null>(null)
  const [portfolioSelection, setPortfolioSelection] = useState(() => loadPortfolioSelection())
  const hoveredProject = projects.find((project) => project.id === hoveredProjectId)
  const visibleMilestones = metrics?.milestones.filter((milestone) => !hoveredProjectId || milestone.projectId === hoveredProjectId) ?? []
  const groups = useMemo<PortfolioGroup[]>(() => {
    const grouped = portfolios.map((portfolio) => ({ ...portfolio, projects: projects.filter((project) => project.portfolio?.id === portfolio.id) }))
    const ungrouped = projects.filter((project) => !project.portfolio)
    return ungrouped.length > 0 ? [...grouped, { id: 'ungrouped', code: 'UNASSIGNED', name: '未分组项目', description: '尚未归入项目组合的独立项目', projectIds: ungrouped.map((project) => project.id), projects: ungrouped, isUngrouped: true }] : grouped
  }, [portfolios, projects])
  const selectedPortfolioId = portfolios.some((portfolio) => portfolio.id === portfolioSelection) ? portfolioSelection : portfolios[0]?.id ?? ''
  const selectedPortfolio = portfolios.find((portfolio) => portfolio.id === selectedPortfolioId)
  const selectedPortfolioProjects = selectedPortfolio ? projects.filter((project) => project.portfolio?.id === selectedPortfolio.id) : []
  const approvalProjects = (selectedPortfolio ? selectedPortfolioProjects : projects).filter((project) => project.accessLevel === 'L1' || project.accessLevel === 'L2')
  const selectPortfolio = (portfolioId: string) => {
    setPortfolioSelection(portfolioId)
    savePortfolioSelection(portfolioId)
  }

  const requestRemove = (project: Project, portfolioName: string) => {
    setRemoveError(null)
    setPendingRemoval({ project, portfolioName })
  }

  const confirmRemove = async () => {
    if (!pendingRemoval || !onRemoveProjectFromPortfolio || removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await onRemoveProjectFromPortfolio(pendingRemoval.project.id)
      setPendingRemoval(null)
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : '移出项目组合失败')
    } finally {
      setRemoving(false)
    }
  }

  const requestDeletePortfolio = (portfolio: ProjectPortfolio) => {
    setDeletePortfolioError(null)
    setPendingPortfolioDeletion(portfolio)
  }

  const confirmDeletePortfolio = async () => {
    if (!pendingPortfolioDeletion || !onDeletePortfolio || deletingPortfolio) return
    setDeletingPortfolio(true)
    setDeletePortfolioError(null)
    try {
      await onDeletePortfolio(pendingPortfolioDeletion.id)
      setPendingPortfolioDeletion(null)
    } catch (error) {
      setDeletePortfolioError(error instanceof Error ? error.message : '删除项目组合失败')
    } finally {
      setDeletingPortfolio(false)
    }
  }

  const toggleDingTalkIntegration = async () => {
    if (!canManageDingTalkIntegration || !onDingTalkIntegrationChange || dingtalkSaving) return
    setDingTalkSaving(true)
    setDingTalkError(null)
    try {
      await onDingTalkIntegrationChange(!dingtalkIntegrationEnabled)
    } catch (error) {
      setDingTalkError(error instanceof Error ? error.message : '钉钉设置保存失败')
    } finally {
      setDingTalkSaving(false)
    }
  }

  return (
    <div className="page page-enter">
      <PageHeader
        title="项目组合"
        description="一个项目组合可以包含多个独立项目，统一查看整体健康度、进度、资源与资金使用。"
        eyebrow="2026 下半年 · 感知起源科技"
        actions={<div className="page-actions">{approvalProjects.length > 0 && <button className="button button-secondary" type="button" onClick={() => setApprovalManagementOpen(true)}><CheckSquare2 size={17} />OA审批管理后台</button>}{canCreatePortfolio && <button className="button button-secondary" type="button" onClick={onCreatePortfolio}><Layers3 size={17} />新建项目组合</button>}{canCreateProject && <button className="button button-primary" type="button" onClick={onCreateProject}><Plus size={17} />新建项目</button>}</div>}
      />

      <section className="metric-strip" aria-label="项目组合关键指标">
        <article className="metric-block"><span className="metric-icon"><FolderKanban size={18} /></span><div><p>执行中项目</p><strong>{active}</strong><small><ArrowUpRight size={13} /> 共 {projects.length} 个项目</small></div></article>
        <article className="metric-block"><span className="metric-icon"><AlertTriangle size={18} /></span><div><p>待关注风险</p><strong>{metrics && !metrics.portfolioMetricsVisible ? '无权限' : metrics ? metrics.risks.total : '读取中'}</strong><small className={metrics && metrics.portfolioMetricsVisible && metrics.risks.high > 0 ? 'text-warning' : ''}><ArrowUpRight size={13} />{metrics && !metrics.portfolioMetricsVisible ? ' 仅 L1/L2 可查看组合风险' : metrics ? metrics.risks.high > 0 ? ` ${metrics.risks.high} 项高风险` : ' 暂无高风险' : ' 正在读取风险数据'}</small></div></article>
        <article className="metric-block"><span className="metric-icon"><UsersRound size={18} /></span><div><p>资源利用率</p><strong>{metrics && !metrics.portfolioMetricsVisible ? '无权限' : metrics?.resource.utilizationPercent === null ? '暂无数据' : metrics ? `${metrics.resource.utilizationPercent}%` : '读取中'}</strong><small><ArrowDownRight size={13} />{metrics && !metrics.portfolioMetricsVisible ? ' 仅 L1/L2 可查看全员负载' : metrics ? metrics.resource.utilizationPercent === null ? ` 暂无已分配计划工时 · ${metrics.resource.memberCount} 位成员` : ` ${metrics.resource.allocatedHours} h / ${metrics.resource.capacityHours} h · ${metrics.resource.overloadedMembers} 人超负载` : ' 正在读取资源数据'}</small></div></article>
      </section>

      <section className={`panel dingtalk-integration-card ${dingtalkIntegrationEnabled ? '' : 'is-disabled'}`} aria-labelledby="dingtalk-integration-title">
        <span className="dingtalk-integration-icon" aria-hidden="true">{dingtalkIntegrationEnabled ? <BellRing size={19} /> : <BellOff size={19} />}</span>
        <div className="dingtalk-integration-copy">
          <div className="dingtalk-integration-heading"><h2 id="dingtalk-integration-title">钉钉提醒与业务交互</h2><StatusBadge tone={dingtalkIntegrationEnabled ? 'accent' : 'neutral'}>{dingtalkIntegrationEnabled ? '已开启' : '已关闭'}</StatusBadge></div>
          <p>{dingtalkIntegrationEnabled ? '任务发布、进度和审批提醒可通过钉钉发送。' : '已切换为 Project OS 独立模式，仅保留钉钉登录。'}</p>
          <small>{dingtalkIntegrationEnabled ? '关闭后不会发送新的钉钉提醒，也不会创建或同步钉钉审批。' : '不会发送提醒、创建或同步钉钉审批、同步通讯录或处理机器人业务消息；Project OS 内部 OA 与站内通知继续可用。'}</small>
        </div>
        <div className="dingtalk-integration-actions">
          {canManageDingTalkIntegration ? <button className={`dingtalk-integration-toggle ${dingtalkIntegrationEnabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={dingtalkIntegrationEnabled} disabled={dingtalkSaving} onClick={() => void toggleDingTalkIntegration()}><span className="dingtalk-toggle-track" aria-hidden="true"><span /></span><span>{dingtalkSaving ? '保存中…' : dingtalkIntegrationEnabled ? '关闭钉钉交互' : '开启钉钉交互'}</span></button> : <span className="dingtalk-integration-readonly">仅 L1 可修改</span>}
          {dingtalkError && <small className="dingtalk-integration-error" role="alert">{dingtalkError}</small>}
        </div>
      </section>

      <div className="portfolio-layout">
        <div className="portfolio-main-column">
          <section className="panel portfolio-flow-panel">
            <SectionHeader title="组合流程图" meta="每个项目作为节点，可添加组合任务和依赖连线" action={portfolios.length > 0 ? <PortfolioSelector portfolios={portfolios} value={selectedPortfolioId} onChange={selectPortfolio} /> : undefined} />
            {selectedPortfolio ? <PortfolioFlowWorkbench key={`${selectedPortfolio.id}-${selectedPortfolioProjects.length}`} portfolio={selectedPortfolio} projects={projects} canEdit={canManagePortfolios} onOpenProject={onOpenProject} onHoverProject={setHoveredProjectId} onImportProject={onAddProjectToPortfolio ? (projectId) => onAddProjectToPortfolio(projectId, selectedPortfolio.id) : undefined} onCreateProject={onCreateProjectInPortfolio} /> : <div className="empty-state"><span className="empty-icon"><Layers3 size={22} /></span><strong>还没有项目组合</strong><p>先新建一个项目组合，再把多个项目加入流程图。</p>{canCreatePortfolio && <button className="button button-secondary" type="button" onClick={onCreatePortfolio}>新建项目组合</button>}</div>}
          </section>

          <section className="panel portfolio-projects">
            <SectionHeader title="项目组合清单" meta={`${portfolios.length} 个组合 · ${projects.length} 个项目`} action={<LinkButton>查看全部项目</LinkButton>} />
            <div className="portfolio-group-grid">
              {groups.map((group) => <PortfolioGroupCard group={group} onOpenProject={onOpenProject} onHoverProject={setHoveredProjectId} canManageProjects={canManageProjects} onRequestRemove={requestRemove} canManagePortfolios={canManagePortfolios} onRequestDelete={requestDeletePortfolio} key={group.id} />)}
            </div>
          </section>
        </div>

        <aside className="portfolio-aside">
          <section className="panel milestone-panel">
            <SectionHeader title={hoveredProject ? `${hoveredProject.name} · 里程碑` : '临近里程碑'} meta={hoveredProject ? '当前项目 · 任务节点状态' : '全部项目 · 任务节点状态'} />
            <ol className="timeline-list">
              {!metrics && <li><span className="timeline-empty">正在读取里程碑…</span></li>}
              {visibleMilestones.map((milestone) => { const status = milestoneStatusView(milestone.status, milestone.overdue); return <li key={`${milestone.projectId}-${milestone.taskId ?? milestone.name}`}><time>{formatMilestoneDate(milestone.plannedEnd)}</time><span><strong>{milestone.name}</strong><small>{milestone.projectName} · {milestone.plannedStart} 至 {milestone.plannedEnd}</small></span><StatusBadge tone={status.tone}>{status.label}</StatusBadge></li> })}
              {metrics && visibleMilestones.length === 0 && <li><span className="timeline-empty">{hoveredProject ? '当前项目暂无任务里程碑' : '暂无任务里程碑'}</span></li>}
            </ol>
          </section>

          <section className="panel portfolio-note">
            <div className="note-heading"><span className="agent-dot" /><span>Project Agent 摘要</span></div>
            <p>项目组合用于汇总多个项目的进度、风险和资源；进入具体项目后，再查看该项目自己的流程图和任务排期。</p>
            <button className="link-button" type="button">查看分析依据</button>
          </section>
        </aside>
      </div>
      {pendingRemoval && <RemoveProjectDialog project={pendingRemoval.project} portfolioName={pendingRemoval.portfolioName} busy={removing} error={removeError} onClose={() => { if (!removing) setPendingRemoval(null) }} onConfirm={() => void confirmRemove()} />}
      {pendingPortfolioDeletion && <DeletePortfolioDialog portfolio={pendingPortfolioDeletion} busy={deletingPortfolio} error={deletePortfolioError} onClose={() => { if (!deletingPortfolio) setPendingPortfolioDeletion(null) }} onConfirm={() => void confirmDeletePortfolio()} />}
      {approvalManagementOpen && <ApprovalManagementDialog projects={approvalProjects} onClose={() => setApprovalManagementOpen(false)} />}
    </div>
  )
}

function PortfolioSelector({ portfolios, value, onChange }: { portfolios: ProjectPortfolio[]; value: string; onChange: (portfolioId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const selected = portfolios.find((portfolio) => portfolio.id === value) ?? portfolios[0]
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = portfolios.filter((portfolio) => !normalizedQuery || `${portfolio.code} ${portfolio.name}`.toLowerCase().includes(normalizedQuery))

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [open])

  const choose = (portfolioId: string) => {
    onChange(portfolioId)
    setQuery('')
    setOpen(false)
  }

  return <div className="portfolio-flow-selector"><span>当前组合</span><div className="portfolio-selector" ref={containerRef}><button className="portfolio-selector-trigger" type="button" aria-label="选择项目组合" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}><span>{selected ? `${selected.code} · ${selected.name}` : '选择项目组合'}</span><ChevronDown size={15} /></button>{open && <div className="portfolio-selector-menu" role="listbox" aria-label="项目组合列表"><label className="portfolio-selector-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); if (event.key === 'Enter' && filtered[0]) choose(filtered[0].id) }} placeholder="搜索组合名称或编号" aria-label="搜索组合名称或编号" /></label>{filtered.length > 0 ? <div className="portfolio-selector-options">{filtered.map((portfolio) => <button className={`portfolio-selector-option ${portfolio.id === selected?.id ? 'is-selected' : ''}`} type="button" role="option" aria-selected={portfolio.id === selected?.id} key={portfolio.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(portfolio.id)}><strong>{portfolio.code} · {portfolio.name}</strong>{portfolio.description && <small>{portfolio.description}</small>}</button>)}</div> : <p className="portfolio-selector-empty">没有匹配的项目组合</p>}</div>}</div></div>
}

function PortfolioGroupCard({ group, onOpenProject, onHoverProject, canManageProjects, onRequestRemove, canManagePortfolios, onRequestDelete }: { group: PortfolioGroup; onOpenProject: (projectId: string) => void; onHoverProject: (projectId: string | null) => void; canManageProjects: boolean; onRequestRemove: (project: Project, portfolioName: string) => void; canManagePortfolios: boolean; onRequestDelete: (portfolio: ProjectPortfolio) => void }) {
  const progress = group.projects.length === 0 ? 0 : Math.round(group.projects.reduce((sum, project) => sum + project.progress, 0) / group.projects.length)
  const atRisk = group.projects.some((project) => project.health === '预警' || project.status === '有风险')
  return (
    <article className="portfolio-group-card">
      <header className="portfolio-group-head"><div><p className="page-context">{group.code}</p><h3>{group.name}</h3><p>{group.description || '多个独立项目的统一管理视图'}</p></div><div className="portfolio-group-head-actions"><StatusBadge tone={atRisk ? 'danger' : 'success'}>{atRisk ? '需关注' : '健康'}</StatusBadge>{canManagePortfolios && !group.isUngrouped && <button className="portfolio-group-delete" type="button" aria-label={`删除项目组合${group.name}`} title="删除项目组合" onClick={() => onRequestDelete(group)}><Trash2 size={16} /></button>}</div></header>
      <div className="portfolio-group-summary"><span>{group.projects.length} 个项目</span><ProgressBar value={progress} /><strong>{progress}%</strong></div>
      <div className="portfolio-group-projects">
        {group.projects.length === 0 ? <p className="drawer-empty-note">组合暂时还没有项目，创建项目时可直接选择该组合。</p> : <div>{group.projects.map((project) => <div className="portfolio-group-project" role="button" tabIndex={0} key={project.id} onMouseEnter={() => onHoverProject(project.id)} onFocus={() => onHoverProject(project.id)} onClick={() => onOpenProject(project.id)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProject(project.id) } }}><span className={`health-dot health-${project.health}`} /><span className="portfolio-project-name"><strong>{project.name}</strong><small>{project.code} · {project.department}</small></span><span className="portfolio-project-progress"><ProgressBar value={project.progress} /><small>{project.progress}%</small></span><span className="portfolio-project-date"><CalendarClock size={14} />{project.nextMilestone}</span>{canManageProjects && !group.isUngrouped && <button className="portfolio-project-remove" type="button" aria-label={`将${project.name}移出${group.name}`} title="移出项目组合" onClick={(event) => { event.stopPropagation(); onRequestRemove(project, group.name) }} onKeyDown={(event) => event.stopPropagation()}><Trash2 size={16} /></button>}</div>)}</div>}
      </div>
    </article>
  )
}

function RemoveProjectDialog({ project, portfolioName, busy, error, onClose, onConfirm }: { project: Project; portfolioName: string; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card project-action-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-project-from-portfolio-title">
      <header className="modal-header"><div><p className="page-context">项目组合操作</p><h2 id="remove-project-from-portfolio-title">移出项目组合</h2><p>{project.name} · {project.code}</p></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭移出项目组合"><X size={19} /></button></header>
      <div className="modal-body"><p>确认将“{project.name}”从“{portfolioName}”中移出？项目本身及其流程、任务数据不会被删除。</p>{error && <p className="form-error" role="alert">{error}</p>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button button-danger" type="button" onClick={onConfirm} disabled={busy}>{busy ? '处理中…' : '确认移出'}</button></footer>
    </section>
  </div>
}

function DeletePortfolioDialog({ portfolio, busy, error, onClose, onConfirm }: { portfolio: ProjectPortfolio; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card project-action-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-portfolio-title">
      <header className="modal-header"><div><p className="page-context">项目组合操作</p><h2 id="delete-portfolio-title">删除项目组合</h2><p>{portfolio.name} · {portfolio.code}</p></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭删除项目组合"><X size={19} /></button></header>
      <div className="modal-body"><p>确认删除项目组合“{portfolio.name}”？组合中的项目会保留，并自动变为未分组项目；流程、任务和项目数据不会被删除。</p>{error && <p className="form-error" role="alert">{error}</p>}</div>
      <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button button-danger" type="button" onClick={onConfirm} disabled={busy}>{busy ? '处理中…' : '确认删除'}</button></footer>
    </section>
  </div>
}

function formatMilestoneDate(value: string) {
  return value.slice(5).replace('-', '.')
}

function milestoneStatusView(status: TaskStatus, overdue: boolean) {
  if (overdue || status === '到期未完成' || status === '超期结束') return { label: '已超期', tone: 'danger' as const }
  if (status === '进行中') return { label: '进行中', tone: 'accent' as const }
  if (status === '已完成' || status === '提前结束' || status === '如期结束') return { label: '已完成', tone: 'success' as const }
  if (status === '受阻') return { label: '受阻', tone: 'warning' as const }
  return { label: '未开始', tone: 'neutral' as const }
}
