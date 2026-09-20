import { Check, Crown, LoaderCircle, Plus, ShieldCheck, UserMinus, UsersRound, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { addProjectMember, fetchProjectAccess, grantProjectL2, removeProjectMember, revokeProjectL2 } from '../api'
import type { Project, ProjectAccessData, ProjectAccessMember } from '../types'
import { StatusBadge } from './UI'

interface ProjectMembersDrawerProps {
  project: Project
  onClose: () => void
}

export function ProjectMembersDrawer({ project, onClose }: ProjectMembersDrawerProps) {
  const [access, setAccess] = useState<ProjectAccessData | null>(null)
  const [selectedMemberId, setSelectedMemberId] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setAccess(await fetchProjectAccess(project.id))
    } catch (loadError) {
      setError(messageForError(loadError))
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    // The drawer synchronizes its initial state with the project access API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const activeL2 = useMemo(() => new Set((access?.grants ?? []).filter((grant) => !grant.revokedAt && grant.roleCode === 'L2').map((grant) => grant.memberId)), [access])
  const memberRole = (member: ProjectAccessMember) => {
    if (member.member.systemRoles.some((role) => role.code === 'L1')) return 'L1'
    return activeL2.has(member.memberId) ? 'L2' : 'L3'
  }

  const runAction = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    setSavingKey(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      await load()
      setNotice(successMessage)
    } catch (actionError) {
      setError(messageForError(actionError))
    } finally {
      setSavingKey(null)
    }
  }

  const addMember = () => {
    if (!selectedMemberId) return
    const candidate = access?.availableMembers.find((member) => member.id === selectedMemberId)
    void runAction(`add-${selectedMemberId}`, () => addProjectMember(project.id, selectedMemberId), `已将 ${candidate?.name ?? '成员'} 加入项目`)
    setSelectedMemberId('')
  }

  const updateRole = (member: ProjectAccessMember, role: 'L2' | 'L3') => {
    if (role === memberRole(member) || memberRole(member) === 'L1') return
    if (role === 'L2') void runAction(`role-${member.memberId}`, () => grantProjectL2(project.id, member.memberId), `已将 ${member.member.name} 设置为项目 L2`)
    else void runAction(`role-${member.memberId}`, () => revokeProjectL2(project.id, member.memberId), `已撤销 ${member.member.name} 的项目 L2`)
  }

  const removeMember = (member: ProjectAccessMember) => {
    if (!window.confirm(`确定将 ${member.member.name} 移出项目“${project.name}”吗？系统会先检查其负责的任务。`)) return
    void runAction(`remove-${member.memberId}`, () => removeProjectMember(project.id, member.memberId), `已将 ${member.member.name} 移出项目`)
  }

  return (
    <aside className="task-drawer project-members-drawer" aria-label="项目人员">
      <header>
        <div><span className="mono-label">项目人员</span><h2>{project.name}</h2><p className="project-members-subtitle">{project.code} · 项目成员与项目级权限</p></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭项目人员"><X size={19} /></button>
      </header>
      {loading && !access ? <div className="drawer-body project-members-state"><LoaderCircle size={18} className="spin" /><span>正在读取项目成员…</span></div> : error && !access ? <div className="drawer-body project-members-state project-members-error"><ShieldCheck size={18} /><div><strong>无法查看项目人员</strong><p>{error}</p><button className="button button-secondary button-compact" type="button" onClick={() => { void load() }}>重新读取</button></div></div> : access && <div className="drawer-body">
        {error && <div className="people-error project-members-message" role="alert"><ShieldCheck size={16} /><span>{error}</span></div>}
        {notice && <div className="people-notice project-members-message" role="status"><Check size={16} /><span>{notice}</span></div>}

        <section className="drawer-section project-members-summary"><div><strong>{access.members.length}</strong><span>项目成员</span></div><div><strong>{activeL2.size}</strong><span>项目 L2</span></div><p>L2 可以管理项目成员、分配任务、调整流程并发布版本。</p></section>

        <section className="drawer-section"><div className="drawer-section-head"><div><h3>添加成员</h3><p>只显示尚未加入本项目的在职成员。</p></div><UsersRound size={18} /></div><div className="project-member-add"><select aria-label="选择项目成员" value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)} disabled={savingKey !== null}><option value="">选择成员</option>{access.availableMembers.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select><button className="button button-primary button-compact" type="button" onClick={addMember} disabled={!selectedMemberId || savingKey !== null}><Plus size={15} />添加</button></div>{access.availableMembers.length === 0 && <p className="drawer-empty-note">组织内暂无可添加的其他在职成员。</p>}</section>

        <section className="drawer-section project-members-list-section"><div className="drawer-section-head"><div><h3>已加入成员</h3><p>调整的是当前项目权限，不会改变成员的全局权限。</p></div></div><div className="project-members-list">{access.members.map((membership) => { const role = memberRole(membership); const isSaving = savingKey === `role-${membership.memberId}` || savingKey === `remove-${membership.memberId}`; return <article className="project-member-row" key={membership.memberId}><span className="avatar avatar-soft">{membership.member.name.slice(0, 2)}</span><div className="project-member-copy"><strong>{membership.member.name}</strong><small>{membership.membershipRole === 'owner' ? '项目负责人' : '项目成员'}</small></div><span className="project-member-role">{role === 'L1' ? <StatusBadge tone="success"><Crown size={12} />L1 全局</StatusBadge> : <label><span className="sr-only">{membership.member.name} 项目权限</span><select value={role} onChange={(event) => updateRole(membership, event.target.value as 'L2' | 'L3')} disabled={isSaving}><option value="L3">L3 执行成员</option><option value="L2">L2 项目经理</option></select></label>}</span>{role !== 'L1' && <button className="icon-button project-member-remove" type="button" onClick={() => removeMember(membership)} disabled={isSaving} aria-label={`移出项目：${membership.member.name}`} title="移出项目"><UserMinus size={16} /></button>}{isSaving && <LoaderCircle size={15} className="spin project-member-saving" />}</article> })}</div></section>
      </div>}
    </aside>
  )
}

function messageForError(error: unknown) {
  const message = error instanceof Error ? error.message : '操作失败，请稍后重试'
  if (message === 'forbidden') return '当前账号没有管理该项目成员的权限。'
  if (message === 'last_task_assignee') return '该成员仍是某些任务的唯一负责人，请先重新分配任务后再移出。'
  if (message === 'member_not_in_project') return '该成员尚未加入项目。'
  if (message === 'l1_already_has_full_access') return 'L1 已拥有全局权限，无需重复授予项目 L2。'
  if (message === 'project_l2_already_granted') return '该成员已经是项目 L2。'
  if (message === 'project_l2_grant_not_found') return '该成员当前没有有效的项目 L2。'
  return message
}
