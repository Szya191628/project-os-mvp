import { Bell, CheckCheck, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { acknowledgeNotification, deleteNotificationsBatch, fetchNotificationTemplates, fetchServerNotifications, updateNotificationTemplate } from '../api'
import { PageHeader, SectionHeader } from '../components/UI'
import type { NotificationTemplate, ServerNotification, SystemRoleCode } from '../types'

const eventLabels: Record<string, string> = { TASK_PUBLISHED: '新任务发布', TASK_READY: '前置任务完成 / 任务解锁', TASK_DUE_SOON: '任务开始前 3 天提醒', TASK_OVERDUE: '任务延期 / 超期', TASK_ASSIGNEE_CHANGED: '负责人变更', TASK_SCHEDULE_CHANGED: '排期变更', TASK_APPROVAL_SUBMITTED: '交付物待审批', TASK_APPROVAL_VIEWED: '交付物同步（仅查看）', TASK_DELIVERABLE_SUBMITTED: '交付物已提交' }

export function NotificationsPage({ role }: { role?: SystemRoleCode }) {
  const [notifications, setNotifications] = useState<ServerNotification[]>([])
  const [templates, setTemplates] = useState<NotificationTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  const canManage = role === 'L1' || role === 'L2'

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [items, configured] = await Promise.all([fetchServerNotifications(), canManage ? fetchNotificationTemplates() : Promise.resolve([])])
        if (!cancelled) { setNotifications(items); setTemplates(configured) }
      } catch (error) { if (!cancelled) setMessage(error instanceof Error ? error.message : '通知加载失败') } finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [canManage])

  const acknowledge = async (notificationId: string) => {
    await acknowledgeNotification(notificationId)
    setNotifications((items) => items.map((item) => item.id === notificationId ? { ...item, readAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString() } : item))
  }

  const enterSelectMode = () => { setSelectMode(true); setSelectedIds([]) }
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds([]) }
  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const allSelected = notifications.length > 0 && notifications.every((item) => selectedIds.includes(item.id))
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : notifications.map((item) => item.id))

  const deleteSelected = async () => {
    if (selectedIds.length === 0) return
    if (!window.confirm(`确认删除选中的 ${selectedIds.length} 条通知？删除后不可恢复（仅从你的列表移除，其他接收人不受影响）。`)) return
    setDeleting(true)
    setMessage(null)
    try {
      const result = await deleteNotificationsBatch(selectedIds)
      setNotifications((items) => items.filter((item) => !selectedIds.includes(item.id)))
      setSelectedIds([])
      setSelectMode(false)
      setMessage(`已删除 ${result.deleted} 条通知。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '通知删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const updateTemplate = async (template: NotificationTemplate) => {
    setSaving(template.eventType); setMessage(null)
    try {
      const updated = await updateNotificationTemplate(template.eventType, template)
      setTemplates((items) => items.map((item) => item.eventType === template.eventType ? updated : item))
      setMessage('消息模板已保存，后续钉钉提醒将使用新模板。')
    } catch (error) { setMessage(error instanceof Error ? error.message : '模板保存失败') } finally { setSaving(null) }
  }

  return <div className="page page-enter">
    <PageHeader title="通知中心" description="查看任务提醒，并由 L1/L2 管理钉钉消息模板。" />
    <section className="panel table-panel">
      <SectionHeader title="我的任务提醒" meta={loading ? '正在加载…' : `${notifications.length} 条`} action={
        <span className="notification-batch-actions">
          {selectMode ? <>
            <button className="button button-secondary button-compact" type="button" onClick={toggleSelectAll}>{allSelected ? '取消全选' : '全选'}</button>
            <button className="button button-danger button-compact" type="button" disabled={selectedIds.length === 0 || deleting} onClick={() => { void deleteSelected() }}><Trash2 size={14} />删除所选（{selectedIds.length}）</button>
            <button className="button button-secondary button-compact" type="button" onClick={exitSelectMode}>取消</button>
          </> : <button className="button button-secondary button-compact" type="button" disabled={notifications.length === 0} onClick={enterSelectMode}><Trash2 size={14} />批量删除</button>}
        </span>
      } />
      {message && <div className="api-status-banner" role="status">{message}</div>}
      {notifications.length === 0 && !loading && <div className="empty-state"><Bell size={24} /><h3>暂无任务提醒</h3><p>发布任务、排期临近或负责人发生变化后，消息会显示在这里。</p></div>}
      <div className="notification-list notification-page-list">
        {notifications.map((item) => <article className={`notification-item ${item.readAt ? '' : 'is-unread'}`} key={item.id}>
          {selectMode && <input type="checkbox" className="notification-select" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`选择通知：${item.title}`} />}
          <div className="notification-main"><span className="notification-icon tone-accent"><Bell size={17} /></span><span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span><small>{eventLabels[item.eventType] ?? item.eventType} · {item.projectCode} · {item.taskName}</small><time>{item.createdAt.replace('T', ' ').slice(0, 16)}</time></span></div>
          {!selectMode && !item.acknowledgedAt && <button className="button button-secondary button-compact" type="button" onClick={() => void acknowledge(item.id)}><CheckCheck size={14} />确认收到</button>}
        </article>)}
      </div>
    </section>
    {canManage && <section className="panel notification-template-panel">
      <SectionHeader title="钉钉消息模板" meta="L1/L2 可编辑" />
      <p className="section-note">可用变量：<code>{'{{projectName}}'}</code> <code>{'{{taskName}}'}</code> <code>{'{{plannedStart}}'}</code> <code>{'{{plannedEnd}}'}</code>。</p>
      <div className="notification-template-list">
        {templates.map((template) => <div className="notification-template" key={template.eventType}>
          <div className="notification-template-heading"><strong>{eventLabels[template.eventType] ?? template.eventType}</strong><label><input type="checkbox" checked={template.enabled} onChange={(event) => setTemplates((items) => items.map((item) => item.eventType === template.eventType ? { ...item, enabled: event.target.checked } : item))} />启用</label></div>
          <label className="form-field"><span>标题</span><input value={template.titleTemplate} onChange={(event) => setTemplates((items) => items.map((item) => item.eventType === template.eventType ? { ...item, titleTemplate: event.target.value } : item))} /></label>
          <label className="form-field"><span>正文</span><textarea rows={3} value={template.bodyTemplate} onChange={(event) => setTemplates((items) => items.map((item) => item.eventType === template.eventType ? { ...item, bodyTemplate: event.target.value } : item))} /></label>
          <button className="button button-primary button-compact" type="button" disabled={saving === template.eventType} onClick={() => void updateTemplate(template)}><Save size={14} />{saving === template.eventType ? '保存中…' : '保存模板'}</button>
        </div>)}
      </div>
    </section>}
  </div>
}
