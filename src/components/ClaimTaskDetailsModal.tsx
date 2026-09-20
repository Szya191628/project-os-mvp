import { CalendarDays, Clock3, FileText, UserRound, UsersRound, X } from 'lucide-react'
import { StatusBadge } from './UI'
import type { ClaimableTask, MyClaimTask } from '../types'

type ClaimTaskDetail = ClaimableTask | MyClaimTask

export function ClaimTaskDetailsModal({ task, onClose }: { task: ClaimTaskDetail; onClose: () => void }) {
  const claimedAt = 'claimedAt' in task ? task.claimedAt : null
  const claimed = Boolean(claimedAt)
  const tone = task.status === '进行中' ? 'accent' : task.status === '受阻' || task.status === '到期未完成' ? 'danger' : task.status === '已完成' || task.status === '提前结束' || task.status === '如期结束' || task.status === '超期结束' ? 'success' : 'neutral'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal-card claim-task-details-card" role="dialog" aria-modal="true" aria-labelledby="claim-task-details-title">
        <header className="modal-header">
          <div><p className="page-context">独立任务详情</p><h2 id="claim-task-details-title">{task.name}</h2><p>{claimed ? '已认领的独立任务，仍与项目流程分开。' : '认领前可先查看任务内容和交付要求。'}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭任务详情"><X size={19} /></button>
        </header>
        <div className="modal-body claim-task-details-body">
          <div className="claim-task-detail-grid">
            <DetailItem icon={<UserRound size={16} />} label="发布人" value={task.publisherName} />
            <DetailItem icon={<FileText size={16} />} label="任务状态" value={<StatusBadge tone={tone}>{claimed ? '已认领 · ' : ''}{task.status}</StatusBadge>} />
            <DetailItem icon={<CalendarDays size={16} />} label="预计时长" value={`${task.duration} 天`} />
            <DetailItem icon={<Clock3 size={16} />} label="计划工时" value={`${task.effort} 小时`} />
            <DetailItem icon={<UsersRound size={16} />} label="可认领部门" value={task.claimDepartmentNames.join('、')} />
            {claimedAt && <DetailItem icon={<CalendarDays size={16} />} label="认领日期" value={claimedAt.slice(0, 10)} />}
          </div>
          <DetailSection icon={<FileText size={17} />} title="具体工作内容" content={task.description} empty="发布人暂未填写具体工作内容。" />
          <DetailSection icon={<FileText size={17} />} title="交付物 / 完成标准" content={task.closureCriteria} empty="暂未填写交付物或完成标准。" />
          <p className="form-note">这是组织级独立任务，不属于任何项目，也不会生成项目流程节点。</p>
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>关闭</button></footer>
      </section>
    </div>
  )
}

function DetailItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return <div className="claim-task-detail-item"><span className="claim-task-detail-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong></span></div>
}

function DetailSection({ icon, title, content, empty }: { icon: React.ReactNode; title: string; content: string | null | undefined; empty: string }) {
  return <section className="claim-task-detail-section"><h3>{icon}{title}</h3><p>{content?.trim() || empty}</p></section>
}
