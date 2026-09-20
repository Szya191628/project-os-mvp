import { ClipboardCheck, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fetchApprovalPolicy, updateApprovalPolicy } from '../api'
import type { ApprovalPolicyStepView, ApprovalPolicyView } from '../types'

type ApprovalProject = { id: string; code: string; name: string }

export function ApprovalManagementDialog({ projects, onClose }: { projects: ApprovalProject[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialogRef.current?.showModal() }, [])
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [policy, setPolicy] = useState<ApprovalPolicyView | null>(null)
  const [loading, setLoading] = useState(Boolean(projects[0]))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const project = projects.find((item) => item.id === projectId)

  const selectProject = (nextProjectId: string) => {
    setProjectId(nextProjectId)
    setPolicy(null)
    setLoading(true)
    setError(null)
    setNotice(null)
  }

  useEffect(() => {
    if (!projectId) return
    let mounted = true
    void fetchApprovalPolicy(projectId).then((nextPolicy) => {
      if (mounted) setPolicy(normalizePolicy(nextPolicy))
    }).catch((reason) => {
      if (mounted) setError(reason instanceof Error ? reason.message : '读取审批配置失败')
    }).finally(() => {
      if (mounted) setLoading(false)
    })
    return () => { mounted = false }
  }, [projectId, reloadToken])

  const updateStep = (stepNo: number, patch: Partial<ApprovalPolicyStepView>) => {
    setPolicy((current) => current ? { ...current, steps: current.steps.map((step) => step.stepNo === stepNo ? { ...step, ...patch } : step) } : current)
  }

  const addStep = () => {
    setPolicy((current) => current && current.steps.length < 5 ? { ...current, steps: [...current.steps, { stepNo: current.steps.length + 1, stage: 'L2', mode: 'ANY', minApprovals: 1, approverMemberIds: [], ccMemberIds: [] }] } : current)
  }

  const removeStep = (stepNo: number) => {
    setPolicy((current) => current && current.steps.length > 1 ? { ...current, steps: current.steps.filter((step) => step.stepNo !== stepNo).map((step, index) => ({ ...step, stepNo: index + 1 })) } : current)
  }

  const save = async () => {
    if (!policy || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await updateApprovalPolicy(projectId, { enabled: policy.enabled, steps: policy.steps.map((step) => ({ ...step, mode: 'ANY' as const, minApprovals: 1 })) })
      setPolicy(normalizePolicy(saved))
      setNotice('已保存。新提交的 OA 审批将按当前项目配置进入管理中心。')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存审批配置失败'
      setError(message === 'approval_policy_approver_invalid' ? '审批人必须是当前项目可处理该层级的 L1/L2 成员。' : message === 'approval_policy_cc_invalid' ? '抄送人必须是当前可进入 OA 审批中心的管理成员。' : message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialogRef} className="modal-backdrop approval-management-backdrop" aria-labelledby="approval-management-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose() }} onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) onClose() }}>
      <section className="modal-card approval-management-modal">
        <header className="modal-header"><div><p className="page-context">项目 OA</p><h2 id="approval-management-title"><ClipboardCheck size={19} />OA审批管理后台</h2><p>设置任务负责人提交交付物审批时的审批人和抄送人。</p></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="关闭 OA审批管理后台"><X size={19} /></button></header>
        <div className="modal-body approval-management-body">
          {projects.length === 0 ? <div className="empty-state"><ClipboardCheck size={24} /><strong>暂无可管理项目</strong><p>只有 L1 或当前项目的 L2 发布者可以配置项目 OA。</p></div> : <>
            {projects.length > 1 && <label className="form-field"><span>当前项目</span><select value={projectId} onChange={(event) => selectProject(event.target.value)} disabled={saving}>{projects.map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label>}
            {project && <div className="approval-management-project"><strong>{project.code} · {project.name}</strong><span>配置只影响之后新提交的审批，已提交审批继续使用原配置。</span></div>}
            {loading && <p className="form-note">正在读取当前项目的 OA 配置…</p>}
            {!loading && error && <div className="form-error" role="alert"><p>{error}</p><button className="button button-secondary button-compact" type="button" onClick={() => { setPolicy(null); setLoading(true); setError(null); setReloadToken((value) => value + 1) }}>重新读取</button></div>}
            {!loading && policy && <>
              <label className="approval-management-switch"><input type="checkbox" checked={policy.enabled} onChange={(event) => setPolicy({ ...policy, enabled: event.target.checked })} disabled={saving} /><span><strong>启用项目 OA 审批策略</strong><small>关闭后新提交仍会进入 OA，但使用系统默认的 L2 审批策略。</small></span></label>
              <div className="approval-management-steps"><div className="approval-management-section-heading"><div><h3>审批步骤</h3><p>按顺序通过；没有指定审批人时，使用该层级的全部管理成员。</p></div><button className="button button-secondary button-compact" type="button" onClick={addStep} disabled={saving || policy.steps.length >= 5}><Plus size={15} />添加步骤</button></div>
                {policy.steps.map((step) => <ApprovalStepEditor key={step.stepNo} step={step} members={policy.memberOptions ?? []} saving={saving} onChange={(patch) => updateStep(step.stepNo, patch)} onRemove={() => removeStep(step.stepNo)} canRemove={policy.steps.length > 1} />)}
              </div>
              {notice && <div className="form-success" role="status">{notice}</div>}
            </>}
          </>}
        </div>
        <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose} disabled={saving}>关闭</button>{policy && !loading && <button className="button button-primary" type="button" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存审批配置'}</button>}</footer>
      </section>
    </dialog>
  )
}

function ApprovalStepEditor({ step, members, saving, onChange, onRemove, canRemove }: { step: ApprovalPolicyStepView; members: ApprovalPolicyView['memberOptions']; saving: boolean; onChange: (patch: Partial<ApprovalPolicyStepView>) => void; onRemove: () => void; canRemove: boolean }) {
  const approverMembers = members.filter((member) => member.eligibleStages.includes(step.stage) || step.approverMemberIds.includes(member.id))
  const ccMembers = members.filter((member) => member.eligibleStages.length > 0 || step.ccMemberIds.includes(member.id))
  const toggle = (field: 'approverMemberIds' | 'ccMemberIds', id: string) => {
    onChange({ [field]: step[field].includes(id) ? step[field].filter((value) => value !== id) : [...step[field], id] })
  }
  const move = (index: number, offset: number) => {
    const ids = [...step.approverMemberIds]
    const other = index + offset
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other], ids[index]]
    onChange({ approverMemberIds: ids })
  }
  return <article className="approval-management-step">
    <div className="approval-management-step-heading"><strong>第 {step.stepNo} 组审批</strong>{canRemove && <button className="icon-button" type="button" onClick={onRemove} disabled={saving} aria-label={`删除第 ${step.stepNo} 组`}><Trash2 size={16} /></button>}</div>
    <div className="form-grid"><label className="form-field"><span>审批层级</span><select value={step.stage} onChange={(event) => onChange({ stage: event.target.value as ApprovalPolicyStepView['stage'], approverMemberIds: [] })} disabled={saving}><option value="L2">L2 项目管理者（含 L1）</option><option value="ADMIN">L1 管理员</option></select></label><p className="form-note">审批人可多选，按下方顺序逐人审批；全部通过后才进入下一组。</p></div>
    <div className="form-grid approval-management-recipient-grid">
      <fieldset className="approval-recipient-options" disabled={saving}><legend>审批人（按勾选顺序）</legend>{approverMembers.map((member) => <label key={member.id}><input type="checkbox" checked={step.approverMemberIds.includes(member.id)} onChange={() => toggle('approverMemberIds', member.id)} />{member.name} · {member.roleLabel}</label>)}<small>可直接勾选多人；留空仍使用默认管理层级审批。</small></fieldset>
      <fieldset className="approval-recipient-options" disabled={saving}><legend>抄送人（可多选）</legend>{ccMembers.map((member) => <label key={member.id}><input type="checkbox" checked={step.ccMemberIds.includes(member.id)} onChange={() => toggle('ccMemberIds', member.id)} />{member.name} · {member.roleLabel}</label>)}<small>抄送仅供查看，不参与逐级审批。</small></fieldset>
    </div>
    {step.approverMemberIds.length > 0 && <div className="approval-recipient-order"><strong>本组审批顺序</strong><ol>{step.approverMemberIds.map((id, index) => <li key={id}><span>{members.find((member) => member.id === id)?.name ?? '成员已不可用'}</span><button type="button" className="button button-secondary button-compact" disabled={saving || index === 0} onClick={() => move(index, -1)} aria-label={`将第 ${index + 1} 位审批人上移`}>上移</button><button type="button" className="button button-secondary button-compact" disabled={saving || index === step.approverMemberIds.length - 1} onClick={() => move(index, 1)} aria-label={`将第 ${index + 1} 位审批人下移`}>下移</button></li>)}</ol></div>}
  </article>
}

function normalizePolicy(policy: ApprovalPolicyView): ApprovalPolicyView {
  return { ...policy, memberOptions: policy.memberOptions ?? [], steps: policy.steps.map((step) => ({ ...step, approverMemberIds: step.approverMemberIds ?? [], ccMemberIds: step.ccMemberIds ?? [] })) }
}
