import { AlertTriangle, Bell, CheckCheck, CircleCheck, Clock3, Rocket, X } from 'lucide-react'
import type { NotificationSettings, ProjectNotification } from '../types'

interface NotificationPanelProps {
  notifications: ProjectNotification[]
  settings: NotificationSettings
  onSettingsChange: (settings: NotificationSettings) => void
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onOpenNotification: (notification: ProjectNotification) => void
  onClose: () => void
}

export function NotificationPanel({ notifications, settings, onSettingsChange, onMarkRead, onMarkAllRead, onOpenNotification, onClose }: NotificationPanelProps) {
  const unreadCount = notifications.filter((notification) => !notification.read).length

  return (
    <div className="notification-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notification-title">
        <header className="notification-header">
          <div><p className="page-context">工作提醒</p><h2 id="notification-title">消息中心</h2><p>{unreadCount > 0 ? `${unreadCount} 条未读消息` : '暂无未读消息'}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭消息中心"><X size={18} /></button>
        </header>
        <div className="notification-toolbar">
          <label><span>临期提醒</span><select aria-label="临期提醒提前天数" value={settings.reminderDays} onChange={(event) => onSettingsChange({ reminderDays: Number(event.target.value) as NotificationSettings['reminderDays'] })}><option value="3">提前 3 天</option><option value="5">提前 5 天</option></select></label>
          <button className="link-button" type="button" onClick={onMarkAllRead} disabled={unreadCount === 0}><CheckCheck size={15} />全部已读</button>
        </div>
        <div className="notification-list">
          {notifications.length === 0 && <div className="notification-empty"><span className="empty-icon"><Bell size={19} /></span><strong>还没有消息</strong><p>发布任务或临近截止时间后，提醒会显示在这里。</p></div>}
          {notifications.map((notification) => <NotificationItem key={notification.id} notification={notification} onOpen={() => onOpenNotification(notification)} onMarkRead={() => onMarkRead(notification.id)} />)}
        </div>
      </section>
    </div>
  )
}

function NotificationItem({ notification, onOpen, onMarkRead }: { notification: ProjectNotification; onOpen: () => void; onMarkRead: () => void }) {
  const Icon = notification.type === 'task-published' ? Rocket : notification.type === 'task-ready' || notification.type === 'task-completion-review' || notification.type === 'task-completion-view' || notification.type === 'task-deliverable-submitted' ? CircleCheck : notification.type === 'task-overdue' ? AlertTriangle : Clock3
  const tone = notification.type === 'task-overdue' ? 'danger' : notification.type === 'task-due-soon' || notification.type === 'task-completion-review' ? 'warning' : notification.type === 'task-ready' ? 'success' : 'accent'

  return (
    <article className={`notification-item ${notification.read ? '' : 'is-unread'}`}>
      <button className="notification-main" type="button" onClick={onOpen}>
        <span className={`notification-icon tone-${tone}`}><Icon size={17} /></span>
        <span className="notification-copy"><strong>{notification.title}</strong><span>{notification.body}</span><small>{notification.projectCode} · {notification.projectName}{notification.taskName ? ` · ${notification.taskName}` : ''}</small><time>{formatNotificationTime(notification.createdAt)}</time></span>
        {!notification.read && <span className="notification-unread-dot" aria-label="未读" />}
      </button>
      {!notification.read && <button className="notification-read-button" type="button" onClick={onMarkRead} aria-label={`标记“${notification.title}”为已读`}><CheckCheck size={14} /></button>}
    </article>
  )
}

function formatNotificationTime(value: string) {
  if (!value) return '刚刚'
  const [date, time] = value.split('T')
  return time ? `${date} ${time.slice(0, 5)}` : date
}
