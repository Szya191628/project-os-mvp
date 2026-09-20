import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpRight, Clock3, Filter, Layers3, ListTodo, RefreshCw, Search } from 'lucide-react'
import { fetchMyClaimTasks, fetchMyWorkflowTasks } from '../api'
import { ClaimTaskDetailsModal } from '../components/ClaimTaskDetailsModal'
import { PageHeader, ProgressBar, SectionHeader, StatusBadge } from '../components/UI'
import type { MyClaimTask, Project, Workflow } from '../types'
import { dedupeTaskSummaries, getTaskSummaries, groupTaskSummariesByProject, type TaskSummary } from '../workflow/taskQueries'

type TaskFilter = '全部' | '进行中' | '待开始' | '已完成' | '需关注'
type WorkflowFilter = 'all' | 'published' | 'draft'

export function MyTasksPage({ projects, workflows, currentMemberId, currentUser, onOpenTask }: { projects: Project[]; workflows: Record<string, Workflow>; currentMemberId: string; currentUser: string; onOpenTask: (projectId: string, taskId: string) => void }) {
  const [filter, setFilter] = useState<TaskFilter>('全部')
  const [workflowFilter, setWorkflowFilter] = useState<WorkflowFilter>('published')
  const [projectFilter, setProjectFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [publishedTasks, setPublishedTasks] = useState<TaskSummary[]>([])
  const [publishedLoading, setPublishedLoading] = useState(true)
  const [publishedError, setPublishedError] = useState<string | null>(null)
  const [independentTasks, setIndependentTasks] = useState<MyClaimTask[]>([])
  const [independentLoading, setIndependentLoading] = useState(true)
  const [independentError, setIndependentError] = useState<string | null>(null)
  const [detailsTask, setDetailsTask] = useState<MyClaimTask | null>(null)
  const loadPublishedTasks = async () => {
    setPublishedLoading(true)
    setPublishedError(null)
    try {
      setPublishedTasks(await fetchMyWorkflowTasks())
    } catch (error) {
      setPublishedError(error instanceof Error ? error.message : '无法读取已发布任务')
    } finally {
      setPublishedLoading(false)
    }
  }

  const loadIndependentTasks = async () => {
    setIndependentLoading(true)
    setIndependentError(null)
    try {
      setIndependentTasks(await fetchMyClaimTasks())
    } catch (error) {
      setIndependentError(error instanceof Error ? error.message : '无法读取我的独立任务')
    } finally {
      setIndependentLoading(false)
    }
  }

  useEffect(() => {
    // Published workflow tasks and resource load use the same server-side projection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPublishedTasks()
  }, [])

  useEffect(() => {
    // Load claimed independent tasks separately from project workflow tasks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadIndependentTasks()
  }, [])

  const draftWorkflowTasks = projects.flatMap((project) => {
    const workflow = workflows[project.id]
    if (!workflow) return []
    return workflow.status === 'draft' ? getTaskSummaries(project, workflow) : []
  })
  const workflowTasks = workflowFilter === 'published' ? publishedTasks : workflowFilter === 'draft' ? draftWorkflowTasks : [...publishedTasks, ...draftWorkflowTasks]
  const tasks = (workflowFilter === 'all' ? dedupeTaskSummaries(workflowTasks) : workflowTasks)
    .filter((task) => workflowFilter === 'all' || task.workflowStatus === workflowFilter)
    .filter((task) => task.assigneeIds.includes(currentMemberId) || task.ownerMemberId === currentMemberId || (task.assigneeIds.length === 0 && task.owner === currentUser))
    .sort(compareTaskStart)
  const visibleTasks = tasks.filter((task) => {
    const matchesFilter = filter === '全部'
      || (filter === '进行中' && task.status === '进行中')
      || (filter === '待开始' && (task.status === '未开始' || task.status === '受阻'))
      || (filter === '已完成' && isComplete(task))
      || (filter === '需关注' && (task.overdue || task.status === '受阻'))
    const matchesProject = projectFilter === 'all' || task.projectId === projectFilter
    const matchesQuery = `${task.name}${task.projectName}${task.projectCode}`.toLowerCase().includes(query.toLowerCase())
    return matchesFilter && matchesProject && matchesQuery
  })
  const taskGroups = groupTaskSummariesByProject(visibleTasks)
  const activeCount = tasks.filter((task) => task.status === '进行中').length
  const pendingCount = tasks.filter((task) => !isComplete(task)).length
  const attentionCount = tasks.filter((task) => task.overdue || task.status === '受阻').length
  const plannedEffort = tasks.reduce((total, task) => total + task.effort, 0)
  const publishedSourceLoading = workflowFilter !== 'draft' && publishedLoading
  const publishedSourceError = workflowFilter !== 'draft' ? publishedError : null

  return (
    <div className="page page-enter">
      <PageHeader eyebrow="执行视图" title="我的任务" description={`集中查看 ${currentUser} 在所有项目中的任务、前置约束和交付时间。`} actions={<button className="button button-secondary" type="button"><ArrowUpRight size={16} />导出任务</button>} />

      <section className="my-task-metrics" aria-label="我的任务关键指标">
        <Metric icon={<ListTodo size={18} />} label="待完成" value={pendingCount} note="包含受阻任务" />
        <Metric icon={<Clock3 size={18} />} label="进行中" value={activeCount} note="正在执行" tone="accent" />
        <Metric icon={<AlertTriangle size={18} />} label="需关注" value={attentionCount} note="临期、超期或受阻" tone={attentionCount > 0 ? 'warning' : 'success'} />
        <Metric icon={<Layers3 size={18} />} label="计划工时" value={`${plannedEffort} h`} note={`${new Set(tasks.map((task) => task.projectId)).size} 个项目`} />
      </section>

      <section className="panel my-task-panel">
        <SectionHeader title="项目流程任务" meta="默认只统计已发布且未归档的执行任务；草稿仅供预览。点击“查看流程图”可查看任务内容、交付物和 OA 提交入口。" />
        <div className="my-task-toolbar">
          <label className="compact-search"><Search size={15} /><span className="sr-only">搜索我的任务</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或项目" /></label>
          <label className="select-field"><Filter size={15} /><span className="sr-only">筛选任务版本</span><select value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value as WorkflowFilter)}><option value="published">已发布流程</option><option value="draft">草稿任务</option><option value="all">全部版本（已发布优先）</option></select></label>
          <label className="select-field"><Filter size={15} /><span className="sr-only">筛选项目</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option>{projects.filter((project) => tasks.some((task) => task.projectId === project.id)).map((project) => <option value={project.id} key={project.id}>{project.code} · {project.name}</option>)}</select></label>
        </div>
        <div className="my-task-tabs" role="tablist" aria-label="任务状态筛选">
          {(['全部', '进行中', '待开始', '已完成', '需关注'] as TaskFilter[]).map((item) => <button key={item} type="button" role="tab" aria-selected={filter === item} className={filter === item ? 'is-active' : ''} onClick={() => setFilter(item)}>{item}<span>{countForFilter(item, tasks)}</span></button>)}
        </div>
        <div className="my-task-list">
          {publishedSourceError && <div className="claim-task-error" role="alert">{publishedSourceError}<button className="link-button" type="button" onClick={() => void loadPublishedTasks()}>重试</button></div>}
          {publishedSourceLoading && <div className="empty-state"><strong>正在读取已发布执行任务…</strong><p>正在按统一任务口径汇总。</p></div>}
          {visibleTasks.length === 0 && !publishedSourceLoading && !publishedSourceError && <div className="empty-state"><span className="empty-icon"><ListTodo size={19} /></span><strong>{tasks.length === 0 ? '暂时没有分配给你的任务' : '没有匹配的任务'}</strong><p>{tasks.length === 0 ? '管理员发布流程并分配负责人后，任务会显示在这里。' : '可以调整筛选条件或搜索关键词。'}</p></div>}
          {taskGroups.map((group) => <details className="my-task-group" key={group.projectId} open>
            <summary className="my-task-group-header"><span className="my-task-group-title"><Layers3 size={16} aria-hidden="true" /><span><strong>{group.projectName}</strong><small>{group.projectCode}</small></span></span><span className="my-task-group-count">{group.tasks.length} 项任务</span></summary>
            <div className="my-task-group-list">{group.tasks.map((task) => <MyTaskRow task={task} key={`${task.projectId}-${task.id}-${task.workflowStatus}`} onOpen={() => onOpenTask(task.projectId, task.id)} />)}</div>
          </details>)}
        </div>
      </section>
      <section className="panel my-task-panel claim-task-panel">
        <SectionHeader title="我的独立任务" meta="独立认领任务 · 与项目流程任务分开" action={<button className="button button-secondary" type="button" onClick={() => void loadIndependentTasks()} disabled={independentLoading}><RefreshCw size={15} />刷新</button>} />
        {independentError && <div className="claim-task-error" role="alert">{independentError}<button className="link-button" type="button" onClick={() => void loadIndependentTasks()}>重试</button></div>}
        <div className="my-task-list">
          {independentLoading && <div className="empty-state"><strong>正在读取我的独立任务…</strong><p>正在汇总已认领的组织级任务。</p></div>}
          {!independentLoading && independentTasks.length === 0 && <div className="empty-state"><span className="empty-icon"><ListTodo size={19} /></span><strong>暂无独立任务</strong><p>在“认领任务”中认领独立任务后，会显示在这里；它不会进入任何项目流程。</p></div>}
          {!independentLoading && independentTasks.map((task) => <MyIndependentTaskRow key={task.id} task={task} onOpen={() => setDetailsTask(task)} />)}
        </div>
      </section>
      {detailsTask && <ClaimTaskDetailsModal task={detailsTask} onClose={() => setDetailsTask(null)} />}
    </div>
  )
}

function MyIndependentTaskRow({ task, onOpen }: { task: MyClaimTask; onOpen: () => void }) {
  const tone = independentTaskTone(task.status)
  return <button className="my-task-row my-independent-task-row" type="button" onClick={onOpen} aria-label={`查看独立任务详情 ${task.name}`}>
    <span className="my-task-status-icon"><span className={`task-status-dot tone-${tone}`} /></span>
    <span className="my-task-main"><span className="my-task-project">独立任务 · 发布人：{task.publisherName}<StatusBadge tone="accent">已认领</StatusBadge></span><strong>{task.name}</strong><span className="my-task-meta">{task.description || '暂无任务说明'}{task.closureCriteria ? ` · 交付标准：${task.closureCriteria}` : ''}</span></span>
    <span className="my-task-progress"><ProgressBar value={task.progress} label={`${task.progress}%`} /><small>{task.effort} h</small></span>
    <span className="my-task-dates"><time>认领于 {task.claimedAt?.slice(0, 10) ?? '未知日期'} · {task.duration} 天</time><StatusBadge tone={tone}>{task.status}</StatusBadge></span>
  </button>
}

function independentTaskTone(status: MyClaimTask['status']): 'neutral' | 'accent' | 'success' | 'danger' {
  if (status === '进行中') return 'accent'
  if (status === '受阻' || status === '到期未完成') return 'danger'
  if (status === '已完成' || status === '提前结束' || status === '如期结束' || status === '超期结束') return 'success'
  return 'neutral'
}

function MyTaskRow({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const status = statusView(task)
  return <button className="my-task-row" type="button" onClick={onOpen} aria-label={`打开流程图查看 ${task.wbs} ${task.name}`}>
    <span className="my-task-status-icon"><span className={`task-status-dot tone-${status.tone}`} /></span>
    <span className="my-task-main"><span className="my-task-project">{task.workflowStatus === 'published' && <StatusBadge tone="accent">已发布</StatusBadge>}{task.workflowStatus === 'draft' && <StatusBadge tone="neutral">草稿</StatusBadge>}</span><strong>{task.wbs} {task.name}</strong><span className="my-task-meta">负责人：{task.owner}{task.blockedBy.length > 0 ? ` · 待前置：${task.blockedBy.join('、')}` : ''}</span></span>
    <span className="my-task-progress"><ProgressBar value={task.progress} label={`${task.progress}%`} /><small>{task.effort} h</small></span>
    <span className="my-task-dates"><time>{task.plannedStart ?? '待排期'} → {task.plannedEnd ?? '待排期'}</time><StatusBadge tone={status.tone}>{status.label}</StatusBadge></span>
    <span className="my-task-open-label">查看流程图 <ArrowUpRight className="my-task-open" size={16} aria-hidden="true" /></span>
  </button>
}

function Metric({ icon, label, value, note, tone = 'neutral' }: { icon: ReactNode; label: string; value: string | number; note: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' }) {
  return <article className={`my-task-metric tone-${tone}`}><span className="my-task-metric-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span></article>
}

function statusView(task: TaskSummary) {
  if (task.overdue && !isComplete(task)) return { label: '已超期', tone: 'danger' as const }
  if (task.status === '受阻') return { label: '受阻', tone: 'danger' as const }
  if (task.status === '进行中') return { label: '进行中', tone: 'accent' as const }
  if (isComplete(task)) return { label: task.status, tone: 'success' as const }
  return { label: '待开始', tone: 'neutral' as const }
}

function countForFilter(filter: TaskFilter, tasks: TaskSummary[]) {
  if (filter === '全部') return tasks.length
  if (filter === '进行中') return tasks.filter((task) => task.status === '进行中').length
  if (filter === '待开始') return tasks.filter((task) => task.status === '未开始' || task.status === '受阻').length
  if (filter === '已完成') return tasks.filter(isComplete).length
  return tasks.filter((task) => task.overdue || task.status === '受阻').length
}

function isComplete(task: TaskSummary) {
  return task.status === '已完成' || task.status === '提前结束' || task.status === '如期结束' || task.status === '超期结束'
}

function compareTaskStart(left: TaskSummary, right: TaskSummary) {
  const startOrder = (left.plannedStart ?? '9999-12-31').localeCompare(right.plannedStart ?? '9999-12-31')
  if (startOrder !== 0) return startOrder
  const projectOrder = left.projectCode.localeCompare(right.projectCode)
  return projectOrder !== 0 ? projectOrder : left.wbs.localeCompare(right.wbs, undefined, { numeric: true })
}
