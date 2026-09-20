import { Filter, LayoutGrid, List, MoreHorizontal, Plus, Search, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import type { Project, ProjectPortfolio } from '../types'
import { PageHeader, ProgressBar, StatusBadge } from '../components/UI'

type ProjectAction = { kind: 'delete' | 'join' | 'leave'; project: Project }

interface ProjectsPageProps {
  projects: Project[]
  portfolios: ProjectPortfolio[]
  onOpenProject: (projectId: string) => void
  onCreateProject: () => void
  canCreateProject?: boolean
  canManageProjects?: boolean
  onDeleteProject?: (projectId: string) => Promise<void>
  onUpdateProjectPortfolio?: (projectId: string, portfolioId: string | null) => Promise<void>
  /** 当前用户以部门主管身份监督（只读）的项目 */
  supervisingProjectIds?: string[]
  currentMemberId?: string
}

export function ProjectsPage({ projects, portfolios, onOpenProject, onCreateProject, canCreateProject = false, canManageProjects = false, onDeleteProject, onUpdateProjectPortfolio, supervisingProjectIds = [], currentMemberId = '' }: ProjectsPageProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('全部状态')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<ProjectAction | null>(null)
  const [selectedPortfolioId, setSelectedPortfolioId] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const filtered = useMemo(() => projects.filter((project) => {
    const matchesQuery = `${project.name}${project.code}${project.owner}${project.department}`.toLowerCase().includes(query.toLowerCase())
    const matchesStatus = status === '全部状态' || project.status === status
    return matchesQuery && matchesStatus
  }), [projects, query, status])

  const openProjectAction = (kind: ProjectAction['kind'], project: Project) => {
    setOpenMenuId(null)
    setActionError(null)
    setSelectedPortfolioId(kind === 'join' ? portfolios[0]?.id ?? '' : '')
    setPendingAction({ kind, project })
  }

  const confirmAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!pendingAction || busy) return
    if (pendingAction.kind === 'join' && !selectedPortfolioId) return
    setBusy(true)
    setActionError(null)
    try {
      if (pendingAction.kind === 'delete') await onDeleteProject?.(pendingAction.project.id)
      else await onUpdateProjectPortfolio?.(pendingAction.project.id, pendingAction.kind === 'join' ? selectedPortfolioId : null)
      setPendingAction(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '项目操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page page-enter">
      <PageHeader title="项目" description="从立项到收尾，管理每个项目的计划、执行与复盘。" actions={canCreateProject ? <button className="button button-primary" type="button" onClick={onCreateProject}><Plus size={17} />新建项目</button> : undefined} />
      <div className="toolbar">
        <label className="search-field"><Search size={17} /><span className="sr-only">搜索项目</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、编号或负责人" /></label>
        <label className="select-field"><Filter size={16} /><span className="sr-only">项目状态</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option>全部状态</option><option>执行中</option><option>有风险</option><option>规划中</option><option>已暂停</option></select></label>
        <span className="result-count">{filtered.length} 个项目</span>
        <div className="view-toggle" aria-label="视图切换"><button className="is-active" type="button" aria-label="列表视图"><List size={17} /></button><button type="button" aria-label="网格视图"><LayoutGrid size={17} /></button></div>
      </div>

      <section className="panel table-panel">
        <div className="data-table project-table" role="table" aria-label="项目列表">
          <div className="table-row table-head" role="row"><span>项目</span><span>状态</span><span>负责人</span><span>进度</span><span>周期</span><span>下个里程碑</span><span aria-label="操作" /></div>
          {filtered.map((project) => (
            <div className="table-row project-table-row" role="row" tabIndex={0} key={project.id} onClick={() => onOpenProject(project.id)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProject(project.id) } }}>
              <button className="project-cell project-cell-link" type="button" onClick={(event) => { event.stopPropagation(); onOpenProject(project.id) }}><span className={`project-monogram mono-${project.health}`}>{project.name.slice(0, 1)}</span><span><strong>{project.name}</strong><small>{project.code} · {project.department}</small><small className="project-portfolio-label">项目组合：{project.portfolio?.name ?? '未分组'}</small></span></button>
              <span><StatusBadge tone={project.status === '有风险' ? 'danger' : project.status === '执行中' ? 'success' : project.status === '规划中' ? 'accent' : 'neutral'}>{project.status}</StatusBadge>{supervisingProjectIds.includes(project.id) && !project.memberIds.includes(currentMemberId) && <StatusBadge tone="accent">监督</StatusBadge>}</span>
              <span className="owner-cell"><span className="avatar avatar-soft">{project.ownerInitials}</span>{project.owner}</span>
              <span className="table-progress"><ProgressBar value={project.progress} /><small>{project.progress}%</small></span>
              <span className="date-cell"><time>{project.start.slice(5).replace('-', '.')}</time><small>至 {project.end.slice(5).replace('-', '.')}</small></span>
              <span className="milestone-cell">{project.nextMilestone}</span>
              <span className="project-row-actions" onClick={(event) => event.stopPropagation()}>
                <button className="icon-button" type="button" aria-label={`打开${project.name}操作菜单`} aria-expanded={openMenuId === project.id} onClick={() => setOpenMenuId((current) => current === project.id ? null : project.id)}><MoreHorizontal size={18} /></button>
                {openMenuId === project.id && <div className="project-action-menu" role="menu">
                  {canManageProjects ? <>
                    <button type="button" role="menuitem" onClick={() => openProjectAction(project.portfolio ? 'leave' : 'join', project)}>{project.portfolio ? `退出「${project.portfolio.name}」` : '加入项目组合'}</button>
                    <button className="project-action-danger" type="button" role="menuitem" onClick={() => openProjectAction('delete', project)}>删除项目</button>
                  </> : <span className="project-action-disabled">当前账号无项目管理权限</span>}
                </div>}
              </span>
            </div>
          ))}
        </div>
        {filtered.length === 0 && <div className="empty-state"><FolderEmptyIcon /><strong>没有匹配的项目</strong><p>调整搜索词或状态筛选后再试。</p><button className="button button-secondary" type="button" onClick={() => { setQuery(''); setStatus('全部状态') }}>清除筛选</button></div>}
      </section>

      {pendingAction && <ProjectActionDialog action={pendingAction} portfolios={portfolios} selectedPortfolioId={selectedPortfolioId} onSelectPortfolio={setSelectedPortfolioId} busy={busy} error={actionError} onClose={() => { if (!busy) setPendingAction(null) }} onSubmit={confirmAction} />}
    </div>
  )
}

function ProjectActionDialog({ action, portfolios, selectedPortfolioId, onSelectPortfolio, busy, error, onClose, onSubmit }: { action: ProjectAction; portfolios: ProjectPortfolio[]; selectedPortfolioId: string; onSelectPortfolio: (id: string) => void; busy: boolean; error: string | null; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const isDelete = action.kind === 'delete'
  const isJoin = action.kind === 'join'
  const title = isDelete ? '删除项目' : isJoin ? '加入项目组合' : '退出项目组合'
  const canSubmit = !isJoin || Boolean(selectedPortfolioId)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal-card project-action-dialog" role="dialog" aria-modal="true" aria-labelledby="project-action-title">
      <header className="modal-header"><div><p className="page-context">项目操作</p><h2 id="project-action-title">{title}</h2><p>{action.project.name} · {action.project.code}</p></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭项目操作"><X size={19} /></button></header>
      <form onSubmit={onSubmit}>
        <div className="modal-body">
          {isDelete ? <p>确认删除该项目？项目会被软删除并从当前项目列表隐藏，流程和任务数据不会立即清除。</p> : isJoin ? <label className="form-field"><span>目标项目组合 <em>*</em></span>{portfolios.length > 0 ? <select autoFocus value={selectedPortfolioId} onChange={(event) => onSelectPortfolio(event.target.value)}><option value="" disabled>请选择项目组合</option>{portfolios.map((portfolio) => <option value={portfolio.id} key={portfolio.id}>{portfolio.name} · {portfolio.code}</option>)}</select> : <p className="drawer-empty-note">当前没有可加入的项目组合，请先创建项目组合。</p>}</label> : <p>确认退出当前项目组合“{action.project.portfolio?.name}”？退出后项目将显示为未分组。</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className={`button ${isDelete ? 'button-danger' : 'button-primary'}`} type="submit" disabled={busy || !canSubmit}>{busy ? '处理中…' : isDelete ? '确认删除' : isJoin ? '加入项目组合' : '确认退出'}</button></footer>
      </form>
    </section>
  </div>
}

function FolderEmptyIcon() {
  return <span className="empty-icon"><Search size={22} /></span>
}
