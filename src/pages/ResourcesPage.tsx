import { AlertTriangle, CheckCircle2, ChevronDown, Download, ExternalLink, RefreshCw, Search, UsersRound } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchResourceLoad } from '../api'
import { PageHeader, ProgressBar, SectionHeader, StatusBadge } from '../components/UI'
import type { ResourceLoadGroup, ResourceLoadMember, ResourceLoadResponse, ResourceLoadTask } from '../types'

type ResourcePageProps = {
  onOpenTask?: (projectId: string, taskId?: string) => void
}

type StatusView = {
  label: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
}

const statusViews: Record<string, StatusView> = {
  NOT_STARTED: { label: '未开始', tone: 'neutral' },
  IN_PROGRESS: { label: '进行中', tone: 'accent' },
  BLOCKED: { label: '受阻', tone: 'danger' },
  DUE_UNFINISHED: { label: '到期未完成', tone: 'danger' },
  COMPLETED: { label: '已完成', tone: 'success' },
  EARLY_FINISHED: { label: '提前结束', tone: 'success' },
  ON_TIME_FINISHED: { label: '如期结束', tone: 'success' },
  OVERDUE_FINISHED: { label: '超期结束', tone: 'warning' },
}

export function ResourcesPage({ onOpenTask }: ResourcePageProps) {
  const [resourceLoad, setResourceLoad] = useState<ResourceLoadResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null)
  const [showConflicts, setShowConflicts] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState('all')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setResourceLoad(await fetchResourceLoad())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取资源负载')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Resource load is a live management view; load it from the authorized API once on entry.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData()
  }, [loadData])

  if (loading && !resourceLoad) {
    return <div className="page page-enter"><PageHeader title="资源负载" description="正在读取组织、成员和任务的真实负载数据。" /><section className="panel resource-loading-state"><RefreshCw size={20} className="spin" /><strong>正在读取资源负载…</strong><span>将根据当前已发布流程、独立任务、任务排期和成员容量计算。</span></section></div>
  }

  if (!resourceLoad) {
    return <div className="page page-enter"><PageHeader title="资源负载" description="查看团队容量、跨项目分配与未来六周的负载冲突。" /><section className="panel resource-data-error"><AlertTriangle size={20} /><strong>资源负载暂时无法读取</strong><p>{error ?? '后端没有返回资源数据。'}</p><button className="button button-primary" type="button" onClick={() => void loadData()}><RefreshCw size={16} />重试</button></section></div>
  }

  const { summary, groups, weeks, conflicts } = resourceLoad
  const primaryConflict = conflicts[0]
  const filterOptions = [...new Map(groups.flatMap((group) => [{ id: group.id ?? 'ungrouped', name: group.name }, ...group.members.flatMap((member) => member.departments)]).map((option) => [option.id, option] as const)).values()]
  const searchSuggestions = resourceSearchSuggestions(groups)
  const visibleGroups = filterResourceGroups(groups, query, selectedGroupId)
  const visibleMemberCount = visibleGroups.reduce((count, group) => count + group.members.length, 0)
  const visibleTaskCount = new Set(visibleGroups.flatMap((group) => group.members.flatMap((member) => member.tasks.map((task) => task.id)))).size
  const utilizationPercent = summary.capacityHours > 0 ? Math.round(summary.allocatedHours / summary.capacityHours * 100) : 0
  const heatmapColumns = `minmax(14rem, 1.3fr) repeat(${weeks.length}, minmax(5.25rem, 0.7fr)) minmax(8rem, 1fr)`

  return (
    <div className="page page-enter">
      <PageHeader
        title="资源负载"
        description={`查看 ${visibleGroups.length} 个组、${visibleMemberCount} 位成员在未来六周的真实任务分配与容量。`}
        actions={
          <>
            <button className="button button-secondary" type="button" onClick={() => exportResourceLoad(resourceLoad)}><Download size={16} />导出负载</button>
            <button className="button button-primary" type="button" onClick={() => void loadData()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : undefined} />{loading ? '读取中…' : '刷新数据'}</button>
          </>
        }
      />

      <section className="resource-filters" aria-label="资源负载筛选">
        <label className="compact-search"><Search size={15} /><span className="sr-only">搜索成员、项目或任务</span><input list="resource-search-suggestions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成员、项目或任务" /></label>
        <datalist id="resource-search-suggestions">{searchSuggestions.map((suggestion) => <option value={suggestion} key={suggestion} />)}</datalist>
        <label className="select-field"><span className="sr-only">按部门或组筛选</span><select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)} aria-label="按部门或组筛选"><option value="all">全部部门 / 组</option>{filterOptions.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>
      </section>

      <section className={`resource-alert ${primaryConflict ? '' : 'resource-alert-clear'}`}>
        <span className="alert-icon">{primaryConflict ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}</span>
        <div>
          <strong>{primaryConflict ? `${primaryConflict.memberName} 在 ${primaryConflict.week.label} 周负载超出容量` : '当前没有发现负载冲突'}</strong>
          <p>{primaryConflict ? `${primaryConflict.groupName} · 已分配 ${formatHours(primaryConflict.week.allocatedHours)} / 可用 ${formatHours(primaryConflict.week.capacityHours)}（${primaryConflict.week.utilizationPercent}%）。${conflictSummary(primaryConflict.tasks)}` : `已根据 ${summary.totalTaskCount} 个任务和 ${summary.memberCount} 位在职成员的容量完成计算。`}</p>
        </div>
        {conflicts.length > 0 && <button className="button button-secondary button-compact" type="button" onClick={() => setShowConflicts((visible) => !visible)}>{showConflicts ? '收起冲突' : `查看冲突 ${conflicts.length}`}</button>}
      </section>

      {showConflicts && conflicts.length > 0 && <section className="panel resource-conflict-panel"><SectionHeader title="负载冲突明细" meta="按成员和周展示超过容量的任务组合。" /> <div className="resource-conflict-list">{conflicts.map((conflict) => <article className="resource-conflict-row" key={`${conflict.memberId}-${conflict.week.startDate}`}><div><strong>{conflict.memberName}</strong><span>{conflict.groupName} · {conflict.week.label} · {conflict.week.utilizationPercent}%</span></div><p>{conflictSummary(conflict.tasks)}</p></article>)}</div></section>}

      <section className="panel resource-assignment-panel">
        <SectionHeader title="跨项目任务负载" meta="按组查看成员、项目任务和已认领独立任务的计划工时与交付闭环信息。" action={<StatusBadge tone="accent">{visibleTaskCount} 个任务</StatusBadge>} />
        {visibleGroups.length > 0 ? <div className="resource-group-list">{visibleGroups.map((group) => <section className="resource-group" key={group.id ?? 'ungrouped'}>
          <header className="resource-group-header"><div><h3>{group.name}</h3><p>{group.memberCount} 位成员 · {group.taskCount} 个任务 · {group.pendingTaskCount} 个待完成</p></div><div className="resource-group-summary"><span>分配 <strong>{formatHours(group.plannedHours)}</strong></span><span>容量 <strong>{formatHours(group.capacityHours)}</strong></span><span>可用 <strong>{formatHours(group.availableHours)}</strong></span>{group.overloadedMemberCount > 0 && <StatusBadge tone="danger">{group.overloadedMemberCount} 人超载</StatusBadge>}</div></header>
          <div className="resource-member-list">{group.members.map((member) => <ResourceMemberRow key={member.id} member={member} expanded={expandedMemberId === member.id} onToggle={() => setExpandedMemberId((current) => current === member.id ? null : member.id)} onOpenTask={onOpenTask} />)}</div>
        </section>)}</div> : <div className="resource-empty-state"><UsersRound size={24} /><strong>暂无可见资源数据</strong><p>当前权限范围内没有在职成员或项目任务。</p></div>}
      </section>

      <section className="panel resource-heatmap-panel">
        <SectionHeader title="团队分配" meta="负载 = 已分配工时 / 可用工时；已完成任务保留在明细中，但不计入未来负载。" />
        {visibleGroups.length > 0 ? <div className="heatmap-scroll"><div className="heatmap-grid" role="table" aria-label="未来六周团队负载" style={{ gridTemplateColumns: heatmapColumns }}>
          <div className="heatmap-head heatmap-person">成员 / 组</div>{weeks.map((week) => <div className="heatmap-head" key={week.startDate}>{week.label}</div>)}<div className="heatmap-head">当前周</div>
          {visibleGroups.flatMap((group) => group.members.map((member) => <ResourceHeatmapRow key={member.id} member={member} groupName={group.name} weeks={weeks} />))}
        </div></div> : <div className="resource-empty-state"><UsersRound size={24} /><strong>没有匹配的成员</strong><p>请调整搜索内容或部门 / 组筛选。</p></div>}
        {visibleGroups.length > 0 && <footer className="heatmap-legend"><span><i className="legend-dot load-low" />低于 70%</span><span><i className="legend-dot load-balanced" />70–89%</span><span><i className="legend-dot load-high" />90–100%</span><span><i className="legend-dot load-over" />超过 100%</span></footer>}
      </section>

      <section className="panel capacity-panel"><SectionHeader title="可调配容量" meta="未来六周" /><div className="capacity-number"><UsersRound size={23} /><strong>{formatHours(summary.availableHours)}</strong><small>{summary.availableMemberCount} 位成员仍有可用容量</small></div><div className="capacity-breakdown"><span><i /><span>总分配 / 总容量</span><strong>{formatHours(summary.allocatedHours)} / {formatHours(summary.capacityHours)}</strong></span><span><i /><span>待完成任务</span><strong>{summary.pendingTaskCount} 个</strong></span><span><i /><span>未分配任务</span><strong>{summary.unassignedTaskCount} 个</strong></span></div><StatusBadge tone={conflicts.length > 0 ? 'danger' : utilizationPercent >= 90 ? 'warning' : 'accent'}>{conflicts.length > 0 ? `${summary.overloadedMemberCount} 位成员存在超载` : `整体利用率 ${utilizationPercent}%`}</StatusBadge></section>
    </div>
  )
}

function resourceSearchSuggestions(groups: ResourceLoadGroup[]) {
  return [...new Set(groups.flatMap((group) => [group.name, ...group.members.flatMap((member) => [member.name, ...member.departments.map((department) => department.name), ...member.projectNames, ...member.tasks.flatMap((task) => [task.wbs, task.name, task.projectCode, task.projectName])])]))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function filterResourceGroups(groups: ResourceLoadGroup[], query: string, selectedGroupId: string) {
  const term = query.trim().toLocaleLowerCase()
  return groups.flatMap((group) => {
    const selectedMembers = selectedGroupId === 'all' || (group.id ?? 'ungrouped') === selectedGroupId ? group.members : group.members.filter((member) => member.departments.some((department) => department.id === selectedGroupId))
    if (selectedMembers.length === 0) return []
    const groupMatches = !term || group.name.toLocaleLowerCase().includes(term)
    const members = groupMatches ? selectedMembers : selectedMembers.filter((member) => {
      const text = [member.name, member.roleTitle ?? '', member.department?.name ?? '', ...member.departments.map((department) => department.name), ...member.projectNames, ...member.tasks.flatMap((task) => [task.wbs, task.name, task.projectCode, task.projectName])].join(' ').toLocaleLowerCase()
      return text.includes(term)
    })
    if (members.length === 0) return []
    const taskIds = new Set(members.flatMap((member) => member.tasks.map((task) => task.id)))
    const pendingTaskIds = new Set(members.flatMap((member) => member.tasks.filter((task) => !isCompletedResourceTask(task.status)).map((task) => task.id)))
    return [{ ...group, memberCount: members.length, taskCount: taskIds.size, pendingTaskCount: pendingTaskIds.size, plannedHours: sumResourceMemberHours(members, 'plannedHours'), capacityHours: sumResourceMemberHours(members, 'capacityHours'), availableHours: sumResourceMemberHours(members, 'availableHours'), overloadedMemberCount: members.filter((member) => member.weeks.some((week) => week.utilizationPercent > 100)).length, members }]
  })
}

function sumResourceMemberHours(members: ResourceLoadMember[], key: 'plannedHours' | 'capacityHours' | 'availableHours') {
  return Math.round(members.reduce((total, member) => total + member[key], 0) * 10) / 10
}

function isCompletedResourceTask(status: string) {
  return ['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'].includes(status)
}

function groupResourceTasksByProject(tasks: ResourceLoadTask[]) {
  const groups = new Map<string, { projectId: string; projectCode: string; projectName: string; tasks: ResourceLoadTask[] }>()
  for (const task of tasks) {
    const key = task.projectId || `${task.projectCode}:${task.projectName}`
    const group = groups.get(key)
    if (group) group.tasks.push(task)
    else groups.set(key, { projectId: task.projectId, projectCode: task.projectCode, projectName: task.projectName, tasks: [task] })
  }
  return [...groups.values()]
}

function ResourceMemberRow({ member, expanded, onToggle, onOpenTask }: { member: ResourceLoadMember; expanded: boolean; onToggle: () => void; onOpenTask?: (projectId: string, taskId?: string) => void }) {
  const state = member.blockedTaskCount > 0 ? { label: `受阻 ${member.blockedTaskCount}`, tone: 'danger' as const } : member.activeTaskCount > 0 ? { label: `进行中 ${member.activeTaskCount}`, tone: 'accent' as const } : member.pendingTaskCount > 0 ? { label: '待开始', tone: 'neutral' as const } : { label: '已完成', tone: 'success' as const }
  return <article className={`resource-member-card ${expanded ? 'is-expanded' : ''}`}>
    <div className="resource-member-row"><span className="avatar avatar-soft">{member.initials}</span><div className="resource-member-person"><strong>{member.name}</strong><small>{member.roleTitle ?? '未设置职务'} · {member.departments.length > 0 ? member.departments.map((department) => department.name).join('、') : member.department?.name ?? '未分组'}</small><span>{member.projectNames.length > 0 ? member.projectNames.join('、') : '当前没有分配任务'}</span></div><div className="resource-member-stat"><strong>{member.taskCount}</strong><small>任务</small></div><div className="resource-member-stat"><strong>{member.pendingTaskCount}</strong><small>待完成</small></div><div className="resource-member-stat"><strong>{formatHours(member.plannedHours)}</strong><small>计划工时</small></div><div className="resource-member-state"><StatusBadge tone={state.tone}>{state.label}</StatusBadge></div><button className="resource-member-toggle" type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? '收起任务' : `查看任务 (${member.taskCount})`}<ChevronDown size={15} className={expanded ? 'rotate-180' : undefined} /></button></div>
    {expanded && <ResourceTaskDetails tasks={member.tasks} onOpenTask={onOpenTask} />}
  </article>
}

function ResourceTaskDetails({ tasks, onOpenTask }: { tasks: ResourceLoadTask[]; onOpenTask?: (projectId: string, taskId?: string) => void }) {
  if (tasks.length === 0) return <div className="resource-member-task-detail"><p className="resource-empty-note">当前没有分配到任务。</p></div>
  return <div className="resource-member-task-detail"><div className="resource-task-project-list">{groupResourceTasksByProject(tasks).map((group) => <details className="resource-task-project-group" key={`${group.projectId || group.projectCode}-${group.projectName}`}>
    <summary className="resource-task-project-header"><div><strong>{group.projectName}</strong><small>{group.projectCode}</small></div><span>{group.tasks.length} 个任务</span></summary>
    <div className="resource-task-list">{group.tasks.map((task) => { const status = taskStatusView(task.status); return <article className="resource-task-row" key={`${task.projectId}-${task.id}`}><div className="resource-task-main"><strong><span>{task.wbs}</span> {task.name}</strong>{task.description && <p>{task.description}</p>}{task.closureCriteria && <p><b>闭环条件：</b>{task.closureCriteria}</p>}</div><div className="resource-task-meta"><StatusBadge tone={status.tone}>{status.label}</StatusBadge><span>进度 {task.progress}%</span><span>{task.plannedStart ?? '待排期'} → {task.plannedEnd ?? '待排期'}</span></div><div className="resource-task-hours"><span>计划 {formatHours(task.effortHours)}</span><strong>本范围分摊 {formatHours(task.allocatedHours)}</strong></div><div className="resource-task-checks"><span>交付物 {task.deliverableCount} 个</span><span>闭环检查 {task.completedClosureCheckCount}/{task.closureCheckCount}</span>{task.actualEnd && <small>实际完成 {task.actualEnd}</small>}</div>{onOpenTask && task.projectId && <button className="button button-secondary button-compact resource-task-open" type="button" onClick={() => onOpenTask(task.projectId, task.id)}><ExternalLink size={14} />打开任务</button>}</article> })}</div>
  </details>)}</div></div>
}

function ResourceHeatmapRow({ member, groupName, weeks }: { member: ResourceLoadMember; groupName: string; weeks: ResourceLoadResponse['weeks'] }) {
  const current = member.weeks[0]
  return <div className="heatmap-member-group"><div className="heatmap-person member-info"><span className="avatar avatar-soft">{member.initials}</span><span><strong>{member.name}</strong><small>{groupName}</small></span></div>{weeks.map((week, index) => { const load = member.weeks[index]; return <div className={`load-cell ${load ? loadToneClass(load.utilizationPercent) : 'load-low'}`} key={`${member.id}-${week.startDate}`}><strong>{load?.utilizationPercent ?? 0}%</strong><small>{formatHours(load?.allocatedHours ?? 0)}</small></div> })}<div className="current-load"><strong>{current?.utilizationPercent ?? 0}%</strong><ProgressBar value={Math.min(100, current?.utilizationPercent ?? 0)} tone={current && current.utilizationPercent > 100 ? 'danger' : current && current.utilizationPercent >= 90 ? 'warning' : 'accent'} /></div></div>
}

function taskStatusView(status: string): StatusView {
  return statusViews[status] ?? { label: status || '未开始', tone: 'neutral' }
}

function loadToneClass(value: number) {
  if (value > 100) return 'load-over'
  if (value >= 90) return 'load-high'
  if (value >= 70) return 'load-balanced'
  return 'load-low'
}

function formatHours(value: number) {
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} h`
}

function conflictSummary(tasks: { projectName: string; wbs: string; name: string }[]) {
  if (tasks.length === 0) return '该周存在排期任务，但任务详情暂未完整关联。'
  const names = tasks.slice(0, 3).map((task) => `${task.wbs} ${task.name}`).join('、')
  return `涉及：${names}${tasks.length > 3 ? ` 等 ${tasks.length} 个任务` : ''}。`
}

function exportResourceLoad(resourceLoad: ResourceLoadResponse) {
  const rows = resourceLoad.groups.flatMap((group) => group.members.flatMap((member) => member.tasks.map((task) => [group.name, member.name, task.projectCode, task.projectName, task.wbs, task.name, taskStatusView(task.status).label, `${task.progress}%`, task.effortHours, task.allocatedHours, task.plannedStart ?? '', task.plannedEnd ?? ''])))
  const header = ['组', '成员', '项目编号', '项目名称', '任务编号', '任务名称', '状态', '进度', '计划工时', '本范围分摊工时', '计划开始', '计划完成']
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `project-os-resource-load-${resourceLoad.range.from}-${resourceLoad.range.to}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/gu, '""')}"`
}
