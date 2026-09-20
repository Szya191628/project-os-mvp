import { ArrowLeft, FileText, Plus, QrCode, Send } from 'lucide-react'
import { useRef, useState } from 'react'
import { resolveApiUrl, uploadTaskDeliverable } from '../api'
import type { Project, Task, WorkflowDeliverable } from '../types'

type TaskApprovalPageProps = {
  project: Project
  task: Task
  onBack: () => void
  onSaveDeliverables: (deliverables: WorkflowDeliverable[]) => void
  onSubmit: (note: string, overdueReason: string, deliveryType: 'STAGE' | 'FINAL', progress: number) => Promise<string | null>
}

export function TaskApprovalPage({ project, task, onBack, onSaveDeliverables, onSubmit }: TaskApprovalPageProps) {
  const [deliveryType, setDeliveryType] = useState<'STAGE' | 'FINAL'>('FINAL')
  const [progress, setProgress] = useState(String(task.progress))
  const [note, setNote] = useState('')
  const [overdueReason, setOverdueReason] = useState(task.overdueReason ?? '')
  const [attachments, setAttachments] = useState(task.deliverables ?? [])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dueUnfinished = task.status === '到期未完成'

  const addAttachment = async (file: File) => {
    if (!task.taskId || uploading) return
    setUploading(true)
    setError(null)
    try {
      const attachment = await uploadTaskDeliverable(task.taskId, file, { name: file.name, versionLabel: `v${attachments.length + 1}.0` })
      const next = [attachment, ...attachments]
      setAttachments(next)
      onSaveDeliverables(next)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '附件上传失败')
    } finally {
      setUploading(false)
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const progressValue = Number(progress)
    if (!Number.isInteger(progressValue) || progressValue < 0 || progressValue > 100) {
      setError('进度请输入 0–100 的整数。')
      return
    }
    if (deliveryType === 'FINAL' && progressValue !== 100) {
      setError('最终交付的进度必须为 100%。')
      return
    }
    if (dueUnfinished && !overdueReason.trim()) {
      setError('任务已超期，请填写超期原因。')
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await onSubmit(note.trim(), overdueReason.trim(), deliveryType, progressValue)
    setSubmitting(false)
    if (result) setError(result)
    else setSubmitted(true)
  }

  return <main className="task-approval-page page-enter">
    <div className="task-approval-shell">
      <button className="task-approval-back" type="button" onClick={onBack}><ArrowLeft size={16} />返回任务</button>
      <section className="task-approval-paper" aria-labelledby="task-approval-title">
        <header className="task-approval-heading">
          <div><h1 id="task-approval-title">Project OS 任务交付审批</h1><p>北京感知超源科技有限公司</p></div>
          <QrCode size={42} strokeWidth={1.2} aria-hidden="true" />
        </header>
        <form className="task-approval-form" onSubmit={(event) => void submit(event)}>
          <label className="task-approval-field"><span><em>*</em>项目编号</span><input value={project.code} readOnly /></label>
          <label className="task-approval-field"><span><em>*</em>任务编号</span><input value={task.wbs} readOnly /></label>
          <label className="task-approval-field"><span><em>*</em>任务名称</span><input value={task.name} readOnly /></label>
          <label className="task-approval-field"><span><em>*</em>进度（%）</span><input type="number" min="0" max="100" step="1" value={progress} onChange={(event) => { setProgress(event.target.value); setError(null) }} placeholder="请输入 0-100" /></label>
          <label className="task-approval-field"><span><em>*</em>交付类型</span><select value={deliveryType} onChange={(event) => { setDeliveryType(event.target.value as 'STAGE' | 'FINAL'); setProgress(event.target.value === 'FINAL' ? '100' : String(task.progress)); setError(null) }}><option value="STAGE">阶段交付</option><option value="FINAL">最终交付</option></select><small>阶段交付可多次提交；最终交付审批通过后完成任务。</small></label>
          <label className="task-approval-field"><span>交付说明</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="请输入" /></label>
          <div className="task-approval-field">
            <span>附件（可选）</span>
            <input ref={fileInputRef} className="sr-only" type="file" aria-label="添加附件" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void addAttachment(file) }} />
            <button className="task-approval-attachment-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}><Plus size={15} />{uploading ? '上传中…' : '添加附件'}</button>
            {attachments.length > 0 ? <ul className="task-approval-attachments">{attachments.map((attachment) => <li key={attachment.id}><FileText size={15} /><span>{attachment.name}<small>{attachment.version} · {attachment.uploader}</small></span>{attachment.objectKey || attachment.url ? <a href={attachment.objectKey ? resolveApiUrl(`/api/v1/deliverables/${attachment.id}/download`) : attachment.url} target="_blank" rel="noreferrer">查看</a> : null}</li>)}</ul> : <small>附件可选，可直接提交 OA 审批。</small>}
          </div>
          {dueUnfinished && <label className="task-approval-field"><span>超期原因（必填）</span><textarea rows={3} value={overdueReason} onChange={(event) => { setOverdueReason(event.target.value); setError(null) }} placeholder="请输入" /></label>}
          {error && <div className="form-error" role="alert">{error}</div>}
          {submitted && <div className="task-approval-success" role="status">已提交{deliveryType === 'STAGE' ? '阶段交付' : '最终交付'} OA 审批，等待 L1/L2 处理。</div>}
          <div className="task-approval-actions"><button className="button button-secondary" type="button" onClick={onBack}>取消</button><button className="button button-primary" type="submit" disabled={submitting || submitted}><Send size={15} />{submitting ? '提交中…' : submitted ? '已提交' : '提交 OA 审批'}</button></div>
        </form>
      </section>
    </div>
  </main>
}
