import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, Hand, ListTodo, Pencil, Plus, RefreshCw, Search, UsersRound, X } from 'lucide-react'
import { claimTask, createClaimTask, fetchClaimableTasks, fetchClaimTaskDepartments, updateClaimTask } from '../api'
import { ClaimTaskDetailsModal } from '../components/ClaimTaskDetailsModal'
import { PageHeader, ProgressBar, SectionHeader, StatusBadge } from '../components/UI'
import type { ClaimableTask } from '../types'

export function ClaimTasksPage({ canPublishTasks }: { canPublishTasks: boolean }) {
  const [tasks, setTasks] = useState<ClaimableTask[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [detailsTask, setDetailsTask] = useState<ClaimableTask | null>(null)
  const [editingTask, setEditingTask] = useState<ClaimableTask | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)

  const loadTasks = async () => {
    setLoading(true)
    setError(null)
    try {
      setTasks(await fetchClaimableTasks())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取独立待认领任务')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Initial page load synchronizes the independent claim pool with the backend.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTasks()
  }, [])

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return tasks
    return tasks.filter((task) => `${task.name}${task.publisherName}${task.description ?? ''}`.toLowerCase().includes(normalizedQuery))
  }, [query, tasks])

  const inProgressCount = tasks.filter((task) => task.status === '进行中').length
  const plannedEffort = tasks.reduce((total, task) => total + task.effort, 0)
  const publisherCount = new Set(tasks.map((task) => task.publisherName)).size

  const handleClaim = async (task: ClaimableTask) => {
    setClaimingId(task.id)
    setError(null)
    setMessage(null)
    try {
      await claimTask(task.id)
      setTasks((current) => current.filter((item) => item.id !== task.id))
      setMessage(`已认领「${task.name}」，可在“我的任务”的“我的独立任务”区域查看。`)
    } catch (claimError) {
      setError(claimErrorMessage(claimError))
      if (claimError instanceof Error && claimError.message === 'claim_task_already_claimed') void loadTasks()
    } finally {
      setClaimingId(null)
    }
  }

  const handlePublish = async (input: PublishTaskInput) => {
    setPublishing(true)
    setPublishError(null)
    setError(null)
    setMessage(null)
    try {
      await createClaimTask({
        name: input.name,
        duration: input.duration,
        effort: input.effort,
        description: input.description || undefined,
        closureCriteria: input.closureCriteria || undefined,
        departmentIds: input.departmentIds,
      })
      setPublishDialogOpen(false)
      setMessage(`已发布独立任务「${input.name}」，任务已进入待认领池。`)
      await loadTasks()
    } catch (publishFailure) {
      setPublishError(publishErrorMessage(publishFailure))
    } finally {
      setPublishing(false)
    }
  }

  const handleEdit = async (input: PublishTaskInput) => {
    if (!editingTask) return
    setUpdating(true)
    setUpdateError(null)
    setError(null)
    setMessage(null)
    try {
      await updateClaimTask(editingTask.id, { name: input.name, duration: input.duration, effort: input.effort, description: input.description, closureCriteria: input.closureCriteria, departmentIds: input.departmentIds })
      setEditingTask(null)
      setMessage(`独立任务「${input.name}」已更新。`)
      await loadTasks()
    } catch (editFailure) {
      setUpdateError(editErrorMessage(editFailure))
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="page page-enter">
      <PageHeader
        eyebrow="协作执行"
        title="认领任务"
        description="组织级独立待认领任务池。这里不展示任何项目流程任务，认领后也不会挂入项目流程。"
        actions={canPublishTasks ? <button className="button button-primary" type="button" onClick={() => { setPublishError(null); setPublishDialogOpen(true) }}><Plus size={15} />发布独立任务</button> : undefined}
      />

      <section className="my-task-metrics" aria-label="认领任务关键指标">
        <Metric icon={<Hand size={18} />} label="待认领" value={tasks.length} note="组织级独立任务" tone="accent" />
        <Metric icon={<ListTodo size={18} />} label="进行中" value={inProgressCount} note="已进入执行状态" />
        <Metric icon={<UsersRound size={18} />} label="发布人" value={publisherCount} note="当前任务发布人" />
        <Metric icon={<Clock3 size={18} />} label="计划工时" value={`${plannedEffort} h`} note="待分配工时" />
      </section>

      <section className="panel my-task-panel claim-task-panel">
        <SectionHeader title="独立待认领任务" meta="组织级任务 · 未完成 · 尚未分配负责人" />
        <div className="my-task-toolbar">
          <label className="compact-search"><Search size={15} /><span className="sr-only">搜索独立待认领任务</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或发布人" /></label>
          <button className="button button-secondary" type="button" onClick={() => void loadTasks()} disabled={loading}><RefreshCw size={15} />刷新</button>
        </div>
        {message && <div className="claim-task-message" role="status">{message}</div>}
        {error && <div className="claim-task-error" role="alert">{error}<button className="link-button" type="button" onClick={() => void loadTasks()}>重试</button></div>}
        <div className="my-task-list">
          {loading && <div className="empty-state"><strong>正在读取独立待认领任务…</strong><p>正在汇总组织级任务池。</p></div>}
          {!loading && visibleTasks.length === 0 && <div className="empty-state"><span className="empty-icon"><Hand size={19} /></span><strong>{tasks.length === 0 ? '当前没有独立待认领任务' : '没有匹配的任务'}</strong><p>{tasks.length === 0 ? 'L1/L2 发布独立任务后，会出现在这里；项目流程任务不会进入此列表。' : '可以调整搜索关键词。'}</p></div>}
          {!loading && visibleTasks.map((task) => <ClaimTaskRow key={task.id} task={task} canClaim={canPublishTasks} canEdit={canPublishTasks} claiming={claimingId === task.id} onClaim={() => void handleClaim(task)} onOpen={() => setDetailsTask(task)} onEdit={() => { setUpdateError(null); setEditingTask(task) }} />)}
        </div>
      </section>
      {detailsTask && <ClaimTaskDetailsModal task={detailsTask} onClose={() => setDetailsTask(null)} />}
      {publishDialogOpen && <PublishTaskDialog submitting={publishing} error={publishError} onClose={() => { if (!publishing) setPublishDialogOpen(false) }} onSubmit={handlePublish} />}
      {editingTask && <PublishTaskDialog mode="edit" task={editingTask} submitting={updating} error={updateError} onClose={() => { if (!updating) setEditingTask(null) }} onSubmit={handleEdit} />}
    </div>
  )
}

function claimErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return '任务认领失败'
  if (error.message === 'claim_task_already_claimed') return '该任务刚刚被其他成员认领，请刷新列表。'
  if (error.message === 'claim_task_not_claimable') return '该任务已不再符合认领条件，请刷新列表。'
  if (error.message === 'claim_task_l3_required') return '当前成员没有独立任务认领权限。'
  return error.message
}

function publishErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return '独立任务发布失败'
  if (error.message === 'forbidden') return '你没有 L1/L2 独立任务发布权限。'
  if (error.message === 'claim_task_name_required') return '请输入任务名称。'
  if (error.message === 'claim_task_departments_invalid') return '所选部门已失效或不属于当前组织，请重新选择。'
  return error.message || '独立任务发布失败'
}

function editErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return '独立任务更新失败'
  if (error.message === 'forbidden') return '你没有 L1/L2 独立任务编辑权限。'
  if (error.message === 'claim_task_not_found') return '任务已不存在或已归档，请刷新列表。'
  if (error.message === 'claim_task_name_required') return '请输入任务名称。'
  if (error.message === 'claim_task_departments_invalid') return '所选部门已失效或不属于当前组织，请重新选择。'
  return error.message || '独立任务更新失败'
}

interface PublishTaskInput {
  name: string
  duration: number
  effort: number
  description: string
  closureCriteria: string
  departmentIds: string[]
}

function PublishTaskDialog({ mode = 'publish', task, submitting, error, onClose, onSubmit }: { mode?: 'publish' | 'edit'; task?: ClaimableTask; submitting: boolean; error: string | null; onClose: () => void; onSubmit: (input: PublishTaskInput) => void | Promise<void> }) {
  const isEdit = mode === 'edit'
  const [form, setForm] = useState(() => ({ name: task?.name ?? '', duration: String(task?.duration ?? 1), effort: String(task?.effort ?? 8), description: task?.description ?? '', closureCriteria: task?.closureCriteria ?? '' }))
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([])
  const [departmentIds, setDepartmentIds] = useState<string[]>(() => task?.claimDepartmentIds ?? [])
  const [allDepartments, setAllDepartments] = useState(() => (task?.claimDepartmentIds ?? []).length === 0)
  const [departmentsLoading, setDepartmentsLoading] = useState(true)
  const [departmentError, setDepartmentError] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchClaimTaskDepartments().then((items) => { if (!cancelled) setDepartments(items) }).catch(() => {
      if (!cancelled) setDepartmentError('部门读取失败，请关闭窗口后重新打开。')
    }).finally(() => { if (!cancelled) setDepartmentsLoading(false) })
    return () => { cancelled = true }
  }, [])
  const update = (field: keyof typeof form, value: string) => {
    setValidationError(null)
    setForm((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    if (!form.name.trim()) {
      setValidationError('请输入任务名称。')
      return
    }
    if (!event.currentTarget.reportValidity()) return
    if (!allDepartments && departmentIds.length === 0) {
      setValidationError('请至少选择一个可认领部门，或切换为“全部部门”。')
      return
    }
    setValidationError(null)
    onSubmit({ name: form.name.trim(), duration: Math.max(0, Number(form.duration) || 0), effort: Math.max(0, Number(form.effort) || 0), description: form.description.trim(), closureCriteria: form.closureCriteria.trim(), departmentIds: allDepartments ? [] : departmentIds })
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !submitting) onClose() }}>
      <section className="modal-card claim-publish-modal" role="dialog" aria-modal="true" aria-labelledby={isEdit ? 'edit-claim-task-title' : 'publish-claim-task-title'}>
        <header className="modal-header"><div><p className="page-context">协作执行</p><h2 id={isEdit ? 'edit-claim-task-title' : 'publish-claim-task-title'}>{isEdit ? '编辑独立任务' : '发布独立任务'}</h2><p>{isEdit ? '修改后会立即更新认领任务池，已认领成员的执行状态和进度不会改变。' : '任务不属于任何项目，发布后由成员在独立认领池中接手。'}</p></div><button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label={isEdit ? '关闭编辑任务' : '关闭发布任务'}><X size={19} /></button></header>
        <form noValidate onSubmit={submit}>
          <div className="modal-body">
            <label className="form-field"><span>任务名称 <em>*</em></span><input autoFocus required aria-invalid={Boolean(validationError && !form.name.trim())} value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：整理部门月度资料" /></label>
            <fieldset disabled={submitting} className="claim-department-picker">
              <legend>可认领部门（可多选）</legend>
              <label><input type="radio" name="department-scope" checked={allDepartments} onChange={() => { setValidationError(null); setAllDepartments(true) }} />全部部门</label>
              <label><input type="radio" name="department-scope" checked={!allDepartments} onChange={() => { setValidationError(null); setAllDepartments(false) }} />指定部门</label>
              {!allDepartments && <div className="claim-department-options">
                {departmentsLoading && <p role="status">正在读取部门…</p>}
                {departmentError && <p role="alert">{departmentError}</p>}
                {!departmentsLoading && !departmentError && departments.length === 0 && <p>当前组织暂无可选部门。</p>}
                {departments.map((department) => <label key={department.id}><input type="checkbox" checked={departmentIds.includes(department.id)} onChange={(event) => { setValidationError(null); setDepartmentIds((current) => event.target.checked ? [...current, department.id] : current.filter((id) => id !== department.id)) }} />{department.name}</label>)}
              </div>}
              <p className="form-note">{allDepartments ? '当前组织所有成员均可认领。' : '至少选择一个部门；L1/L2/L3 成员属于任一所选部门即可看到并认领，不自动包含子部门。'}发布者可查看自己发布的任务。</p>
            </fieldset>
            <div className="form-grid"><label className="form-field"><span>预计天数</span><input type="number" min="0" step="1" value={form.duration} onChange={(event) => update('duration', event.target.value)} /></label><label className="form-field"><span>计划工时</span><input type="number" min="0" step="1" value={form.effort} onChange={(event) => update('effort', event.target.value)} /></label></div>
            <label className="form-field"><span>任务说明</span><textarea value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="补充执行背景、范围或上下文" /></label>
            <label className="form-field"><span>交付标准</span><textarea value={form.closureCriteria} onChange={(event) => update('closureCriteria', event.target.value)} placeholder="例如：资料整理完成并提交归档" /></label>
            <p className="form-note">{isEdit ? '独立任务不属于任何项目；编辑不会改变已认领状态、执行进度或历史交付信息。' : '发布后不生成项目流程节点、不关联任何项目，成员认领后仅作为独立任务处理。'}</p>
          </div>
          {(validationError || error) && <p className="claim-task-error" role="alert">{validationError || error}</p>}
          <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={submitting}>取消</button><button className="button button-primary" type="submit" disabled={submitting || (!allDepartments && (departmentsLoading || Boolean(departmentError)))}>{submitting ? (isEdit ? '保存中…' : '发布中…') : isEdit ? '保存修改' : '创建并发布任务'}</button></footer>
        </form>
      </section>
    </div>, document.body
  )
}

function ClaimTaskRow({ task, canClaim, canEdit, claiming, onClaim, onOpen, onEdit }: { task: ClaimableTask; canClaim: boolean; canEdit: boolean; claiming: boolean; onClaim: () => void; onOpen: () => void; onEdit: () => void }) {
  const tone = task.status === '受阻' ? 'danger' : task.status === '进行中' ? 'accent' : 'neutral'
  return <article className="claim-task-row">
    <button className="claim-task-main" type="button" onClick={onOpen} aria-label={`查看任务详情 ${task.name}`}>
      <span className="my-task-status-icon"><span className={`task-status-dot tone-${tone}`} /></span>
      <span className="my-task-main"><span className="my-task-project">组织级任务 · 发布人：{task.publisherName}<StatusBadge tone="neutral">待认领</StatusBadge></span><strong>{task.name}</strong><span className="my-task-meta">{task.description || '暂无任务说明'} · {task.status} · 可认领部门：{task.claimDepartmentNames.join('、')}</span></span>
      <span className="claim-task-progress"><ProgressBar value={task.progress} label={`${task.progress}%`} /><small>{task.effort} h</small></span>
      <span className="claim-task-dates"><time>{task.duration} 天 · 无项目排期</time><StatusBadge tone={tone}>{task.status}</StatusBadge></span>
    </button>
    <div className="claim-task-actions">{canEdit && <button className="button button-secondary" type="button" onClick={onEdit}><Pencil size={15} />编辑</button>}{canClaim ? <button className="button button-primary" type="button" onClick={onClaim} disabled={claiming}><Hand size={15} />{claiming ? '认领中…' : '认领'}</button> : <span className="form-note">等待符合部门要求的成员认领</span>}</div>
  </article>
}

function Metric({ icon, label, value, note, tone = 'neutral' }: { icon: ReactNode; label: string; value: string | number; note: string; tone?: 'neutral' | 'accent' }) {
  return <article className={`my-task-metric tone-${tone}`}><span className="my-task-metric-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span></article>
}
