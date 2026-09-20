import { ArrowLeftRight, Check, ChevronDown, CircleHelp, ClipboardCheck, CornerUpLeft, FileCheck2, Filter, FolderKanban, MoreHorizontal, RefreshCw, Search, Settings2, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { decideApproval, fetchApprovalCenter, refreshTaskApproval } from '../api'
import { SectionHeader, StatusBadge } from '../components/UI'
import type { ApprovalCenterItem, Project, SystemRoleCode } from '../types'

type ApprovalTab = 'pending' | 'processed' | 'mine' | 'cc'
type PurposeFilter = 'all' | ApprovalCenterItem['purpose']
type SortOrder = 'desc' | 'asc'

const tabLabels: Array<{ id: ApprovalTab; label: string }> = [
  { id: 'pending', label: '待处理' },
  { id: 'processed', label: '已处理' },
  { id: 'mine', label: '我发起的' },
  { id: 'cc', label: '抄送我的' },
]

export function ApprovalCenterPage({ projects, role, currentMemberId, onOpenProject }: { projects: Project[]; role: SystemRoleCode; currentMemberId: string; onOpenProject: (projectId: string, taskId?: string) => void }) {
  const [items, setItems] = useState<ApprovalCenterItem[]>([])
  const [tab, setTab] = useState<ApprovalTab>('pending')
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [purposeFilter, setPurposeFilter] = useState<PurposeFilter>('all')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [query, setQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [detailSize, setDetailSize] = useState<'small' | 'medium' | 'large'>('medium')
  const [loading, setLoading] = useState(true)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [decisionId, setDecisionId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const managedProjects = role === 'L1' ? projects : projects.filter((project) => project.accessLevel === 'L2')

  const load = async () => {
    setLoading(true)
    setMessage(null)
    try {
      setItems(await fetchApprovalCenter())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '审批中心加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // The approval center performs its initial remote read once when the page mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [])

  const pendingItems = items.filter((item) => item.status === 'PENDING')
  const processedItems = items.filter((item) => item.status !== 'PENDING')
  const mineItems = items.filter((item) => item.submitterMemberId === currentMemberId)
  const ccItems = items.filter((item) => item.recipientType === 'CC')
  const tabItems = tab === 'cc' ? ccItems : tab === 'pending' ? pendingItems : tab === 'processed' ? processedItems : mineItems
  const projectOptions = useMemo(() => [...new Map(items.map((item) => [item.project.id, item.project])).values()], [items])
  const visibleItems = [...tabItems.filter((item) => {
    const taskText = `${item.task?.wbs ?? ''} ${item.task?.name ?? ''} ${item.project.code} ${item.project.name} ${item.submitterName ?? ''} ${item.approvalFileName ?? ''}`.toLowerCase()
    const matchesQuery = taskText.includes(query.trim().toLowerCase())
    const matchesStatus = statusFilter === 'all' || item.status === statusFilter
    const matchesProject = projectFilter === 'all' || item.project.id === projectFilter
    const matchesPurpose = purposeFilter === 'all' || item.purpose === purposeFilter
    return matchesQuery && matchesStatus && matchesProject && matchesPurpose
  })].sort((left, right) => {
    const delta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    return sortOrder === 'desc' ? -delta : delta
  })
  const selectedItem = selectedItemId ? items.find((item) => item.id === selectedItemId) ?? null : null

  const sync = async (item: ApprovalCenterItem) => {
    setRefreshingId(item.id)
    setMessage(null)
    try {
      await refreshTaskApproval(item.taskId, item.id)
      await load()
      setMessage('已同步钉钉 OA 审批状态。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同步审批状态失败')
    } finally {
      setRefreshingId(null)
    }
  }

  const decide = async (item: ApprovalCenterItem, outcome: 'APPROVED' | 'REJECTED') => {
    const actionLabel = outcome === 'APPROVED' ? '同意' : '拒绝'
    if (!window.confirm(`确认${actionLabel}“${item.task?.wbs ?? ''} ${item.task?.name ?? '这条审批'}”吗？`)) return
    const comment = outcome === 'REJECTED' ? window.prompt('拒绝原因（可选）') ?? undefined : undefined
    setDecisionId(item.id)
    setMessage(null)
    try {
      await decideApproval(item.id, outcome, comment)
      await load()
      setMessage(`已${actionLabel}，审批状态已更新。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '审批处理失败')
    } finally {
      setDecisionId(null)
    }
  }

  return <div className="page page-enter approval-priority-page">
    <header className="approval-priority-header">
      <div className="approval-priority-title"><h1>优先处理</h1><button className="icon-button" type="button" aria-label="审批说明" title="审批说明"><CircleHelp size={16} /></button></div>
      <button className="icon-button" type="button" onClick={() => void load()} disabled={loading} aria-label="刷新审批列表" title={loading ? '刷新中' : '刷新列表'}><RefreshCw size={17} className={loading ? 'spin' : undefined} /></button>
    </header>

    <div className="approval-priority-toolbar">
      <label className="approval-toolbar-select"><span>全部分类</span><select value={purposeFilter} onChange={(event) => setPurposeFilter(event.target.value as PurposeFilter)}><option value="all">全部分类</option><option value="DELIVERY">交付审批</option><option value="BYPASS">特殊放行</option></select><ChevronDown size={14} /></label>
      <label className="approval-toolbar-select"><span>创建时间</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}><option value="desc">从晚到早</option><option value="asc">从早到晚</option></select><ChevronDown size={14} /></label>
      <button className={`approval-toolbar-button ${filterOpen ? 'is-active' : ''}`} type="button" onClick={() => setFilterOpen((open) => !open)}><Filter size={15} />筛选</button>
      <div className="approval-batch-wrap"><button className={`approval-toolbar-button ${batchOpen ? 'is-active' : ''}`} type="button" onClick={() => setBatchOpen((open) => !open)}><span>批量处理</span><ChevronDown size={14} /></button>{batchOpen && <div className="approval-batch-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setBatchOpen(false); setMessage('批量处理需要先勾选审批记录，当前暂未选择记录。') }}>批量同意</button><button type="button" role="menuitem" onClick={() => { setBatchOpen(false); setMessage('批量处理需要先勾选审批记录，当前暂未选择记录。') }}>批量拒绝</button></div>}</div>
    </div>
    {filterOpen && <div className="approval-filter-panel"><label className="compact-search"><Search size={15} /><span className="sr-only">搜索审批</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、任务或发起人" /></label><label className="select-field"><span className="sr-only">筛选项目</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option>{projectOptions.map((project) => <option value={project.id} key={project.id}>{project.code} · {project.name}</option>)}</select></label><label className="select-field"><span className="sr-only">筛选状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="PENDING">审批中</option><option value="APPROVED">已通过</option><option value="REJECTED">已拒绝</option><option value="TERMINATED">已终止</option></select></label></div>}

    <div className="approval-priority-labels"><div className="approval-label-actions"><button className="approval-label-button" type="button" onClick={() => setMessage('标签管理将在审批分类设置中维护。')}><Settings2 size={15} />标签管理<span className="approval-label-dot" /></button><span className="approval-deadline-pill">今日截止 {pendingItems.length}</span></div><div className="approval-priority-tabs" role="tablist" aria-label="审批记录分类">{tabLabels.map((item) => { const count = item.id === 'cc' ? ccItems.length : item.id === 'pending' ? pendingItems.length : item.id === 'processed' ? processedItems.length : mineItems.length; return <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>{item.label}<span>{count}</span></button> })}</div></div>
    {message && <div className="api-status-banner" role="status">{message}</div>}

    <section className="approval-priority-list" aria-label="审批待办">
      {loading && <div className="empty-state"><ClipboardCheck size={24} /><strong>正在读取审批记录…</strong><p>只读取 Project OS 已同步的审批数据，不会自动轮询钉钉。</p></div>}
      {!loading && visibleItems.length === 0 && <div className="empty-state"><ClipboardCheck size={24} /><strong>{items.length === 0 ? '暂无 OA 审批记录' : '没有匹配的审批记录'}</strong><p>{items.length === 0 ? '任务负责人提交交付审批后，记录会自动出现在这里。' : '可以切换审批分类、项目或搜索条件。'}</p></div>}
      {!loading && visibleItems.map((item) => <ApprovalRow key={item.id} item={item} selected={selectedItemId === item.id} refreshing={refreshingId === item.id} deciding={decisionId === item.id} canApproveAdmin={role === 'L1'} onSelect={() => setSelectedItemId(item.id)} onOpen={() => onOpenProject(item.project.id, item.task?.nodeId)} onSync={() => void sync(item)} onDecision={(outcome) => void decide(item, outcome)} />)}
      {!loading && visibleItems.length > 0 && <p className="approval-list-end">- 已展示全部待办 -</p>}
    </section>

    <section className="panel approval-policy-panel"><SectionHeader title="审批流程管理" meta="L1/L2 可进入项目设置，维护项目级审批人和审批顺序。" /><div className="approval-policy-note"><FileCheck2 size={18} /><p>任务交付审批沿用项目级策略。被指定的审批人负责处理，抄送人可以查看但不能代替审批；请在项目页或项目组合页打开「OA审批管理后台」配置。</p></div><div className="approval-project-list">{managedProjects.slice(0, 8).map((project) => <div className="approval-project-row" key={project.id}><span className="approval-project-icon"><FolderKanban size={16} /></span><span><strong>{project.code} · {project.name}</strong><small>{project.owner} · {project.status}</small></span><button className="link-button" type="button" onClick={() => onOpenProject(project.id)}>打开项目设置</button></div>)}{managedProjects.length === 0 && <p className="section-note">当前授权范围内暂无可管理项目。</p>}</div></section>

    {selectedItem && <ApprovalDetailDrawer item={selectedItem} size={detailSize} canApproveAdmin={role === 'L1'} deciding={decisionId === selectedItem.id} refreshing={refreshingId === selectedItem.id} onClose={() => setSelectedItemId(null)} onSizeChange={setDetailSize} onOpenProject={() => onOpenProject(selectedItem.project.id, selectedItem.task?.nodeId)} onSync={() => void sync(selectedItem)} onDecision={(outcome) => void decide(selectedItem, outcome)} />}
  </div>
}

function ApprovalRow({ item, selected, refreshing, deciding, canApproveAdmin, onSelect, onOpen, onSync, onDecision }: { item: ApprovalCenterItem; selected: boolean; refreshing: boolean; deciding: boolean; canApproveAdmin: boolean; onSelect: () => void; onOpen: () => void; onSync: () => void; onDecision: (outcome: 'APPROVED' | 'REJECTED') => void }) {
  const currentStep = item.steps.find((step) => step.stepNo === item.currentStepNo)
  const canDecide = item.canDecide ?? (canApproveAdmin || currentStep?.stage !== 'ADMIN')
  const isPendingProjectOs = item.status === 'PENDING' && item.source === 'PROJECT_OS'
  return <article className={`approval-priority-card ${selected ? 'is-selected' : ''}`} onClick={onSelect} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect() }}>
    <div className="approval-card-heading"><span className="approval-card-icon"><ClipboardCheck size={17} /></span><div><strong>{approvalTitle(item)}</strong><span className="approval-company-tag">✦ {item.organizationName}</span></div></div>
    <div className="approval-card-fields"><ApprovalField label="项目编号" value={item.project.code} /><ApprovalField label="任务编号" value={item.task?.wbs ?? '—'} /><ApprovalField label="任务名称" value={item.task?.name ?? '未命名任务'} /><ApprovalField label="创建时间" value={formatDateTime(item.createdAt)} /><ApprovalField label="进度 (%)" value={`${item.progress}`} /><ApprovalField label="交付类型" value={item.deliveryType === 'STAGE' ? '阶段交付' : '最终交付'} /><ApprovalField label="来源" value={item.source === 'PROJECT_OS' ? 'OA审批' : '钉钉 OA'} /></div>
    <div className="approval-card-actions"><StatusBadge tone={statusTone(item.status)}>{approvalStatusLabel(item.status)}</StatusBadge>{item.recipientType && item.recipientType !== 'MANAGER' && <StatusBadge tone="neutral">{item.recipientType === 'CC' ? '抄送' : '指定审批人'}</StatusBadge>}<button className="link-button" type="button" onClick={(event) => { event.stopPropagation(); onSelect() }}>查看详情</button>{isPendingProjectOs && canDecide && <><button className="button button-primary button-compact" type="button" disabled={deciding} onClick={(event) => { event.stopPropagation(); onDecision('APPROVED') }}>{deciding ? '处理中…' : '同意'}</button><button className="button button-danger button-compact" type="button" disabled={deciding} onClick={(event) => { event.stopPropagation(); onDecision('REJECTED') }}>拒绝</button></>}{isPendingProjectOs && !canDecide && <small className="approval-center-wait">{item.recipientType === 'CC' ? '抄送，仅查看' : '等待指定审批人处理'}</small>}{item.status === 'PENDING' && item.source === 'DINGTALK' && <button className="link-button" type="button" disabled={refreshing} onClick={(event) => { event.stopPropagation(); onSync() }}>{refreshing ? '同步中…' : '同步钉钉状态'}</button>}<button className="icon-button approval-card-more" type="button" aria-label="打开审批操作" onClick={(event) => { event.stopPropagation(); onOpen() }}><MoreHorizontal size={17} /></button></div>
  </article>
}

function ApprovalDetailDrawer({ item, size, canApproveAdmin, deciding, refreshing, onClose, onSizeChange, onOpenProject, onSync, onDecision }: { item: ApprovalCenterItem; size: 'small' | 'medium' | 'large'; canApproveAdmin: boolean; deciding: boolean; refreshing: boolean; onClose: () => void; onSizeChange: (size: 'small' | 'medium' | 'large') => void; onOpenProject: () => void; onSync: () => void; onDecision: (outcome: 'APPROVED' | 'REJECTED') => void }) {
  const currentStep = item.steps.find((step) => step.stepNo === item.currentStepNo)
  const canDecide = item.status === 'PENDING' && item.source === 'PROJECT_OS' && (item.canDecide ?? (canApproveAdmin || currentStep?.stage !== 'ADMIN'))
  const pendingLabel = item.canDecide === false ? item.recipientType === 'CC' ? '抄送，仅查看' : '等待指定审批人处理' : '等待我处理'
  return <aside className={`task-drawer approval-detail-drawer approval-detail-${size}`} aria-label="审批详情">
    <header><strong>详情</strong><div className="approval-detail-header-actions"><div className="approval-detail-size" role="group" aria-label="详情宽度">{(['small', 'medium', 'large'] as const).map((value) => <button type="button" key={value} className={size === value ? 'is-active' : ''} onClick={() => onSizeChange(value)}>{value === 'small' ? '小' : value === 'medium' ? '中' : '大'}</button>)}</div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭详情"><X size={18} /></button></div></header>
    <div className="drawer-body approval-detail-body"><div className="approval-detail-hero"><h2>{approvalTitle(item)}</h2><p>{item.organizationName}</p><StatusBadge tone={statusTone(item.status)}>{item.status === 'PENDING' ? pendingLabel : approvalStatusLabel(item.status)}</StatusBadge></div><section className="approval-detail-section"><h3>审批详情</h3><dl className="approval-detail-fields"><ApprovalField label="项目编号" value={item.project.code} /><ApprovalField label="任务编号" value={item.task?.wbs ?? '—'} /><ApprovalField label="任务名称" value={item.task?.name ?? '未命名任务'} /><ApprovalField label="进度（%）" value={`${item.progress}`} /><ApprovalField label="交付类型" value={item.deliveryType === 'STAGE' ? '阶段交付' : '最终交付'} /><ApprovalField label="所在部门" value={item.departmentNames.length > 0 ? item.departmentNames.join('、') : '未设置部门'} /><ApprovalField label="负责人" value={item.assigneeName ?? '待分配'} /></dl></section><section className="approval-detail-section"><h3>流程</h3><ol className="approval-timeline"><li className="approval-timeline-item is-done"><span className="approval-timeline-marker"><Check size={13} /></span><div><strong>发起申请</strong><small>{item.submitterName ?? '未知用户'} · {formatDateTime(item.createdAt)}</small></div></li>{item.steps.map((step) => { const done = step.status === 'APPROVED'; const rejected = step.status === 'REJECTED'; return <li className={`approval-timeline-item ${done ? 'is-done' : rejected ? 'is-rejected' : step.stepNo === item.currentStepNo ? 'is-current' : ''}`} key={step.stepNo}><span className="approval-timeline-marker">{done ? <Check size={13} /> : step.stepNo}</span><div><strong>{step.stage === 'ADMIN' ? '管理员' : '项目管理者'} · {step.mode === 'ALL' ? '会签' : '或签'}</strong><small>{done ? '已完成' : rejected ? '已拒绝' : step.stepNo === item.currentStepNo ? '等待审批' : '待进入'}</small></div></li> })}</ol></section>{item.processInstanceId && <section className="approval-detail-section approval-detail-meta"><span>审批实例 ID</span><code>{item.processInstanceId}</code><span>ProcessCode</span><code>{item.processCode}</code></section>}</div>
    <footer className="approval-detail-footer"><div className="approval-detail-secondary-actions"><button className="button button-secondary button-compact" type="button" disabled title="当前版本暂不支持撤销"><Undo2 size={15} />撤销</button><button className="button button-secondary button-compact" type="button" disabled title="当前版本暂不支持转交"><ArrowLeftRight size={15} />转交</button><button className="button button-secondary button-compact" type="button" disabled title="当前版本暂不支持退回"><CornerUpLeft size={15} />退回</button><button className="button button-secondary button-compact" type="button" onClick={onOpenProject}><MoreHorizontal size={15} />更多</button></div><div className="approval-detail-primary-actions">{item.status === 'PENDING' && item.source === 'DINGTALK' && <button className="button button-secondary button-compact" type="button" disabled={refreshing} onClick={onSync}>{refreshing ? '同步中…' : '同步'}</button>}{canDecide && <><button className="button button-danger button-compact" type="button" disabled={deciding} onClick={() => onDecision('REJECTED')}>拒绝</button><button className="button button-primary button-compact" type="button" disabled={deciding} onClick={() => onDecision('APPROVED')}><Check size={15} />同意</button></>}</div></footer>
  </aside>
}

function ApprovalField({ label, value }: { label: string; value: string }) {
  return <div className="approval-detail-field"><dt>{label}</dt><dd>{value}</dd></div>
}

function approvalTitle(item: ApprovalCenterItem) {
  return `${item.submitterName ?? '未知用户'}提交的${item.source === 'PROJECT_OS' ? 'Project OS' : '钉钉'} 任务交付审批`
}

function statusTone(status: ApprovalCenterItem['status']): 'accent' | 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'PENDING') return 'warning'
  if (status === 'APPROVED') return 'success'
  if (status === 'REJECTED') return 'danger'
  return 'neutral'
}

function approvalStatusLabel(status: ApprovalCenterItem['status']) {
  return { PENDING: '审批中', APPROVED: '已通过', REJECTED: '已拒绝', TERMINATED: '已终止' }[status]
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.replace('T', ' ').slice(0, 16)
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replace('/', '-').replace('/', ' ')
}
