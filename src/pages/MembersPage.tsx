import { CheckCircle2, ContactRound, Link2, Mail, RefreshCw, Search, ShieldCheck, Trash2, UserRound, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteDirectoryMember, fetchDirectoryMembers, fetchProjects, grantProjectL2, grantSystemRole, linkDingTalkIdentity, revokeProjectL2, revokeSystemRole, syncDingTalkDirectory } from '../api'
import { PageHeader, SectionHeader, StatusBadge } from '../components/UI'
import type { DirectoryMember, Project, SystemRoleCode } from '../types'

const ALL_PROJECTS_VALUE = '__ALL_PROJECTS__'
const RESELECT_PORTFOLIO_VALUE = '__RESELECT_PORTFOLIO__'

export function MembersPage() {
  const [members, setMembers] = useState<DirectoryMember[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [viewerId, setViewerId] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [selectedPortfolioByMember, setSelectedPortfolioByMember] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [bindingMemberId, setBindingMemberId] = useState<string | null>(null)
  const [syncingDingTalk, setSyncingDingTalk] = useState(false)
  const [dingtalkUserIdByMember, setDingtalkUserIdByMember] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingDeleteMember, setPendingDeleteMember] = useState<DirectoryMember | null>(null)
  const [batchSelectMode, setBatchSelectMode] = useState(false)
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([])
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false)

  const loadMembers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [directory, projectList] = await Promise.all([fetchDirectoryMembers(), fetchProjects()])
      // 已删除（离职归档，leftAt 非空）的成员不再出现在目录里
      setMembers(directory.members.filter((member) => !member.leftAt))
      setProjects(projectList)
      setViewerId(directory.viewerId)
      setOrganizationId(directory.organizationId)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取人员信息')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Initial member directory load synchronizes this page with the backend.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMembers()
  }, [loadMembers])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return members
    return members.filter((member) => `${member.name} ${member.email ?? ''} ${(member.departments ?? []).map((department) => department.name).join(' ')} ${member.department?.name ?? ''}`.toLowerCase().includes(normalized))
  }, [members, query])

  const activeCount = members.filter((member) => member.status === 'ACTIVE').length
  const l1Count = members.filter((member) => member.baseRole === 'L1').length
  const l2Count = members.filter((member) => member.baseRole === 'L2').length

  const updateRole = async (member: DirectoryMember, nextRole: SystemRoleCode) => {
    const currentSystemRole = member.systemBaseRole ?? member.baseRole
    if (currentSystemRole === nextRole || !organizationId) return
    setSavingId(member.id)
    setError(null)
    setNotice(null)
    try {
      // Grant first so a member is never left without a global fallback role
      // if one of the cleanup requests fails. The selected system role is
      // exclusive; removing system L2 also revokes its project-level grants.
      await grantSystemRole(organizationId, member.id, nextRole)
      const revokedRoles = await Promise.all(member.systemRoles.filter((role) => role.code !== nextRole).map((role) => revokeSystemRole(organizationId, member.id, role.code)))
      await loadMembers()
      const projectL2Revoked = revokedRoles.reduce((total, result) => total + (result.projectL2Revoked ?? 0), 0)
      setNotice(`${member.name} 的全局角色已更新为 ${nextRole}${projectL2Revoked > 0 ? `，并自动撤销 ${projectL2Revoked} 个项目级 L2 授权` : ''}`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '角色更新失败')
    } finally {
      setSavingId(null)
    }
  }

  const projectGroups = useMemo(() => {
    const groups = new Map<string, { id: string; code: string; name: string; projects: Project[] }>()
    projects.forEach((project) => {
      const id = project.portfolio?.id ?? 'ungrouped'
      const current = groups.get(id) ?? { id, code: project.portfolio?.code ?? 'UNASSIGNED', name: project.portfolio?.name ?? '未分组项目', projects: [] }
      current.projects.push(project)
      groups.set(id, current)
    })
    return [...groups.values()].map((group) => ({ ...group, projects: [...group.projects].sort((a, b) => a.code.localeCompare(b.code)) })).sort((a, b) => a.name.localeCompare(b.name))
  }, [projects])

  const availableProjects = (member: DirectoryMember, groupId?: string) => {
    const grantedProjectIds = new Set(member.projectL2Grants.map((grant) => grant.projectId))
    const group = projectGroups.find((item) => item.id === groupId)
    return (group?.projects ?? projects).filter((project) => !grantedProjectIds.has(project.id))
  }

  const selectProjectGrant = (member: DirectoryMember, selection: string) => {
    if (!selection) return
    const groupId = selectedPortfolioByMember[member.id] ?? ''
    if (!groupId) {
      setSelectedPortfolioByMember((current) => ({ ...current, [member.id]: selection }))
      return
    }
    if (selection === RESELECT_PORTFOLIO_VALUE) {
      setSelectedPortfolioByMember((current) => ({ ...current, [member.id]: '' }))
      return
    }
    void grantProjectRole(member, groupId, selection)
  }

  const renderProjectGrantSelect = (member: DirectoryMember) => {
    const groupId = selectedPortfolioByMember[member.id] ?? ''
    const group = projectGroups.find((item) => item.id === groupId)
    const selectableProjects = group ? availableProjects(member, group.id) : []
    return <select value="" onChange={(event) => selectProjectGrant(member, event.target.value)} disabled={savingId === member.id || member.status !== 'ACTIVE' || projectGroups.length === 0} aria-label={group ? `给 ${member.name} 选择项目并授予项目级 L2` : `选择给 ${member.name} 授权的项目组合`}>
      {group ? <>
        <option value="">{group.code} · {group.name}{selectableProjects.length > 0 ? '：选择项目' : '：已全部授权'}</option>
        {selectableProjects.length > 0 && <option value={ALL_PROJECTS_VALUE}>全部项目</option>}
        {selectableProjects.map((project) => <option value={project.id} key={project.id}>{project.code} · {project.name}</option>)}
        <option value={RESELECT_PORTFOLIO_VALUE}>← 重新选择项目组合</option>
      </> : <>
        <option value="">选择项目组合</option>
        {projectGroups.map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}
      </>}
    </select>
  }

  const grantProjectRole = async (member: DirectoryMember, groupId: string, selection: string) => {
    if (!groupId || !selection) return
    const group = projectGroups.find((item) => item.id === groupId)
    const targets = selection === ALL_PROJECTS_VALUE ? availableProjects(member, groupId) : availableProjects(member, groupId).filter((project) => project.id === selection)
    if (!group || targets.length === 0) return
    if (selection === ALL_PROJECTS_VALUE && targets.length > 1 && !window.confirm(`确定给 ${member.name} 授予「${group.name}」内全部 ${targets.length} 个项目的项目级 L2 吗？`)) return
    setSavingId(member.id)
    setError(null)
    setNotice(null)
    try {
      await Promise.all(targets.map((project) => grantProjectL2(project.id, member.id)))
      await loadMembers()
      setSelectedPortfolioByMember((current) => ({ ...current, [member.id]: '' }))
      setNotice(`${member.name} 已获得「${group.name}」${selection === ALL_PROJECTS_VALUE ? `内全部 ${targets.length} 个项目` : `项目「${targets[0].name}」`}的项目级 L2，当前有效角色已更新为 L2`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '项目授权失败')
    } finally {
      setSavingId(null)
    }
  }

  const deleteMember = async (member: DirectoryMember) => {
    setSavingId(member.id)
    setError(null)
    setNotice(null)
    try {
      await deleteDirectoryMember(organizationId, member.id)
      setMembers((current) => current.filter((item) => item.id !== member.id))
      setNotice(`已删除成员「${member.name}」：项目授权与任务分配已解除，状态标记为离职。`)
    } catch (deleteError) {
      const code = deleteError instanceof Error ? deleteError.message : ''
      setError(code === 'member_still_owns_resources' ? '该成员仍是项目或项目组合的负责人，请先转移负责人后再删除。' : code === 'cannot_delete_self' ? '不能删除当前登录的账号。' : code || '删除失败')
    } finally {
      setSavingId(null)
    }
  }

  const confirmDeleteMember = async () => {
    if (!pendingDeleteMember) return
    const member = pendingDeleteMember
    setPendingDeleteMember(null)
    await deleteMember(member)
  }

  const enterBatchSelect = () => { setBatchSelectMode(true); setBatchSelectedIds([]) }
  const exitBatchSelect = () => { setBatchSelectMode(false); setBatchSelectedIds([]) }
  const toggleBatchSelected = (id: string) => setBatchSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const selectableMembers = filtered.filter((member) => member.id !== viewerId)
  const allSelectableSelected = selectableMembers.length > 0 && selectableMembers.every((member) => batchSelectedIds.includes(member.id))
  const toggleSelectAllBatch = () => setBatchSelectedIds(allSelectableSelected ? [] : selectableMembers.map((member) => member.id))
  const deletableSelectedCount = batchSelectedIds.filter((id) => id !== viewerId).length

  const confirmBatchDeleteMember = async () => {
    const targets = filtered.filter((member) => batchSelectedIds.includes(member.id) && member.id !== viewerId)
    if (targets.length === 0) { setPendingBatchDelete(false); return }
    setBatchDeleting(true)
    setError(null)
    setNotice(null)
    const deletedIds: string[] = []
    const deletedNames: string[] = []
    const failedNames: string[] = []
    for (const member of targets) {
      try {
        await deleteDirectoryMember(organizationId, member.id)
        deletedIds.push(member.id)
        deletedNames.push(member.name)
      } catch {
        failedNames.push(member.name)
      }
    }
    if (deletedIds.length > 0) {
      setMembers((current) => current.filter((item) => !deletedIds.includes(item.id)))
      setBatchSelectedIds((current) => current.filter((id) => !deletedIds.includes(id)))
    }
    setBatchDeleting(false)
    setPendingBatchDelete(false)
    if (failedNames.length === 0) {
      setNotice(`已删除 ${deletedIds.length} 位成员（${deletedNames.join('、')}），授权与任务分配已解除。`)
    } else {
      setNotice(`已删除 ${deletedNames.join('、')}；以下成员删除失败（可能仍是项目/组合负责人，请先转移负责人）：${failedNames.join('、')}。`)
    }
  }

  const revokeProjectRole = async (member: DirectoryMember, grant: DirectoryMember['projectL2Grants'][number]) => {
    if (!window.confirm(`确定撤销 ${member.name} 在「${grant.project.name}」中的项目级 L2 吗？`)) return
    setSavingId(member.id)
    setError(null)
    setNotice(null)
    try {
      await revokeProjectL2(grant.projectId, member.id)
      await loadMembers()
      setNotice(`${member.name} 已撤销「${grant.project.name}」的项目级 L2`)
    } catch (saveError) {
      if (saveError instanceof Error && saveError.message === 'project_l2_grant_not_found') {
        // Another administrator may have revoked this stale chip already.
        // Refresh the directory so the UI reflects the current authorization.
        try {
          await loadMembers()
          setNotice(`${member.name} 在「${grant.project.name}」的项目级 L2 已撤销或不存在`)
        } catch (refreshError) {
          setError(refreshError instanceof Error ? refreshError.message : '刷新人员信息失败')
        }
      } else {
        setError(saveError instanceof Error ? saveError.message : '撤销项目授权失败')
      }
    } finally {
      setSavingId(null)
    }
  }

  const bindDingTalkIdentity = async (member: DirectoryMember) => {
    const userId = dingtalkUserIdByMember[member.id]?.trim()
    if (!userId || !organizationId) return
    setSavingId(member.id)
    setError(null)
    setNotice(null)
    try {
      await linkDingTalkIdentity(organizationId, member.id, userId)
      await loadMembers()
      setDingtalkUserIdByMember((current) => ({ ...current, [member.id]: '' }))
      setBindingMemberId(null)
      setNotice(`${member.name} 的钉钉账号已绑定，现在可以使用钉钉登录。`)
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '钉钉账号绑定失败'
      setError(message === 'dingtalk_identity_already_mapped' ? '该钉钉账号已经绑定到其他成员。' : message === 'dingtalk_corp_id_mismatch' ? '钉钉企业不匹配，请检查当前应用配置。' : message)
    } finally {
      setSavingId(null)
    }
  }

  const syncDingTalkMembers = async () => {
    if (!organizationId) return
    setSyncingDingTalk(true)
    setError(null)
    setNotice(null)
    try {
      const result = await syncDingTalkDirectory(organizationId)
      await loadMembers()
      setNotice(`已同步钉钉通讯录：${result.usersSeen} 位成员、${result.departmentsSynced} 个部门，更新 ${result.managersSynced} 条直属主管关系。`)
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : '钉钉通讯录同步失败'
      setError(message === 'dingtalk_permission_required' ? '请在钉钉开发者后台开通“成员信息读取权限”“通讯录部门信息读取权限”和“通讯录部门成员读取权限”后再同步。' : message === 'dingtalk_scope_limited' ? '权限点已开通，但钉钉应用的通讯录授权范围尚未覆盖要同步的部门和成员。请把“研发部/全部员工”加入应用可见范围，并开通“通讯录部门成员读取权限”。' : message === 'dingtalk_not_configured' ? '钉钉应用配置不完整，暂时无法同步通讯录。' : message)
    } finally {
      setSyncingDingTalk(false)
    }
  }

  return (
    <div className="page page-enter">
      <PageHeader eyebrow="组织管理" title="人员" description="L1 可在这里授予具体项目的项目级 L2。获得项目授权后，成员在该项目的当前有效角色显示为 L2；系统基础角色仍保留，其他项目继续按项目授权判定。" actions={<><button className="button button-secondary" type="button" onClick={() => { void syncDingTalkMembers() }} disabled={syncingDingTalk || loading}><RefreshCw size={16} className={syncingDingTalk ? 'spin' : undefined} />{syncingDingTalk ? '同步中…' : '同步钉钉资料'}</button><button className="button button-secondary" type="button" onClick={() => { void loadMembers() }} disabled={loading || syncingDingTalk}><RefreshCw size={16} className={loading ? 'spin' : undefined} />刷新人员</button></>} />

      {error && <div className="people-error" role="alert"><ShieldCheck size={17} /><span>{error === 'forbidden' ? '只有 L1 全局管理员可以查看和管理全部人员。' : error}</span></div>}
      {notice && <div className="people-notice" role="status">{notice}</div>}

      <section className="people-summary" aria-label="人员统计">
        <article><span className="people-summary-icon"><ContactRound size={18} /></span><div><small>组织成员</small><strong>{members.length}</strong></div></article>
        <article><span className="people-summary-icon"><UserRound size={18} /></span><div><small>在职成员</small><strong>{activeCount}</strong></div></article>
        <article><span className="people-summary-icon"><ShieldCheck size={18} /></span><div><small>L1 管理员</small><strong>{l1Count}</strong></div></article>
        <article><span className="people-summary-icon"><ContactRound size={18} /></span><div><small>当前有效 L2</small><strong>{l2Count}</strong></div></article>
      </section>

      <section className="panel people-panel">
        <SectionHeader title="成员目录" meta="项目级 L2 授权会自动显示为当前有效 L2；授权仅作用于所选项目，不会扩大成员在其他项目的权限。" action={<span className="people-batch-actions">{batchSelectMode ? <>
          <button className="button button-secondary button-compact" type="button" onClick={toggleSelectAllBatch}>{allSelectableSelected ? '取消全选' : '全选'}</button>
          <button className="button button-danger button-compact" type="button" disabled={deletableSelectedCount === 0 || batchDeleting} onClick={() => setPendingBatchDelete(true)}><Trash2 size={14} />删除所选（{deletableSelectedCount}）</button>
          <button className="button button-secondary button-compact" type="button" onClick={exitBatchSelect}>取消</button>
        </> : <>
          <button className="button button-secondary button-compact" type="button" disabled={filtered.length === 0} onClick={enterBatchSelect}><Trash2 size={14} />批量删除</button>
          <span className="status-badge status-accent">{filtered.length} 位成员</span>
        </>}</span>} />
        <div className="people-toolbar"><label className="search-field"><Search size={17} /><span className="sr-only">搜索成员</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、邮箱或部门" /></label></div>
        {loading && members.length === 0 ? <div className="empty-state"><strong>正在读取人员信息…</strong><p>仅 L1 可以打开组织人员目录。</p></div> : filtered.length === 0 ? <div className="empty-state"><strong>没有匹配的成员</strong><p>调整搜索词后再试。</p></div> : <div className="people-list" role="table" aria-label="组织成员列表">
          <div className="people-row people-head" role="row"><span>成员</span><span>部门 / 直属主管</span><span>状态</span><span>项目级 L2（具体项目）</span><span>权限（当前有效）</span></div>
          {filtered.map((member) => <article className="people-row" role="row" key={member.id}>
            <span className="people-person">{batchSelectMode && <input type="checkbox" className="people-select" checked={batchSelectedIds.includes(member.id)} disabled={member.id === viewerId} onChange={() => toggleBatchSelected(member.id)} aria-label={`选择 ${member.name}`} title={member.id === viewerId ? '不能删除当前登录的账号' : undefined} />}<span className="avatar avatar-soft">{member.name.slice(0, 2)}</span><span><span className="people-person-name"><strong>{member.name}</strong><button type="button" className="people-delete" onClick={() => { setPendingDeleteMember(member) }} disabled={savingId === member.id || member.id === viewerId} aria-label={`删除 ${member.name}`} title={member.id === viewerId ? '不能删除当前登录的账号' : '删除成员（离职归档，解除全部项目/任务/授权关联）'}><Trash2 size={14} /></button></span>{member.email && <small><Mail size={12} />{member.email}</small>}<span className="people-identity-control">{member.dingtalkIdentities.length > 0 ? <small className="people-identity-bound"><CheckCircle2 size={12} />钉钉已绑定</small> : <small>钉钉未绑定</small>}<button type="button" className="people-identity-action" onClick={() => { setBindingMemberId((current) => current === member.id ? null : member.id); setDingtalkUserIdByMember((current) => ({ ...current, [member.id]: current[member.id] ?? '' })) }} disabled={savingId === member.id || member.status !== 'ACTIVE'}><Link2 size={12} />{member.dingtalkIdentities.length > 0 ? '更新' : '绑定'}</button>{bindingMemberId === member.id && <span className="people-identity-form"><input value={dingtalkUserIdByMember[member.id] ?? ''} onChange={(event) => setDingtalkUserIdByMember((current) => ({ ...current, [member.id]: event.target.value }))} placeholder="输入钉钉 userid" aria-label={`${member.name} 的钉钉 userid`} /><button className="button button-primary button-compact" type="button" onClick={() => { void bindDingTalkIdentity(member) }} disabled={!dingtalkUserIdByMember[member.id]?.trim() || savingId === member.id}>保存</button></span>}</span></span></span>
             <span><strong>{member.departments?.length ? member.departments.map((department) => department.name).join('、') : member.department?.name ?? '未分配部门'}</strong><small>{member.manager ? `直属主管：${member.manager.name}` : '直属主管：未同步'}</small><small>容量 {member.capacityHoursPerWeek} h/周</small></span>
            <span className="people-status-control"><StatusBadge tone={member.status === 'ACTIVE' ? 'success' : 'neutral'}>{member.status === 'ACTIVE' ? '在职' : '停用'}</StatusBadge></span>
            <span className="people-project-access"><span className="people-projects">{member.projectL2Grants.length === 0 ? <small>无项目级授权</small> : member.projectL2Grants.map((grant) => <span className="people-project" key={grant.id}><span>{grant.project.code}</span><button type="button" onClick={() => { void revokeProjectRole(member, grant) }} disabled={savingId === member.id} aria-label={`撤销 ${member.name} 的 ${grant.project.name} 项目级 L2`} title="撤销项目级 L2"><X size={12} /></button></span>)}</span><span className="people-project-grant">{renderProjectGrantSelect(member)}</span></span>
            <span className="people-role-control"><select value={member.systemBaseRole ?? member.baseRole} onChange={(event) => { void updateRole(member, event.target.value as SystemRoleCode) }} disabled={savingId === member.id || (member.id === viewerId && member.baseRole === 'L1')} aria-label={`${member.name} 系统基础角色`}><option value="L1">L1 · 全局管理员</option><option value="L2">L2 · 项目经理</option><option value="L3">L3 · 执行成员</option></select>{member.baseRole === 'L2' && (member.systemBaseRole ?? member.baseRole) !== 'L2' && <small className="people-role-effective">当前有效：L2（项目授权）</small>}{member.id === viewerId && member.baseRole === 'L1' && <small>不能撤销自己的 L1</small>}{savingId === member.id && <small>保存中…</small>}</span>
          </article>)}
        </div>}
      </section>
      {pendingDeleteMember && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingDeleteMember(null) }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-member-title" onMouseDown={(event) => event.stopPropagation()}><header className="modal-header"><div><p className="page-context">危险操作</p><h2 id="delete-member-title">确认删除成员</h2><p>即将删除成员「{pendingDeleteMember.name}」</p></div><button className="icon-button" type="button" onClick={() => setPendingDeleteMember(null)} aria-label="关闭删除确认弹窗"><X size={19} /></button></header><div className="modal-body"><p>删除后将解除该成员的项目成员身份、任务分配和系统授权。</p><p className="form-error">删除后不可恢复，请确认是否继续。</p></div><footer className="modal-footer"><button className="button button-secondary" type="button" onClick={() => setPendingDeleteMember(null)} disabled={savingId === pendingDeleteMember.id}>取消</button><button className="button button-danger" type="button" onClick={() => { void confirmDeleteMember() }} disabled={savingId === pendingDeleteMember.id}>确认删除</button></footer></section></div>}
      {pendingBatchDelete && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !batchDeleting) setPendingBatchDelete(false) }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="batch-delete-title" onMouseDown={(event) => event.stopPropagation()}><header className="modal-header"><div><p className="page-context">危险操作</p><h2 id="batch-delete-title">确认批量删除成员</h2><p>即将删除选中的 {deletableSelectedCount} 位成员</p></div><button className="icon-button" type="button" onClick={() => setPendingBatchDelete(false)} disabled={batchDeleting} aria-label="关闭批量删除确认弹窗"><X size={19} /></button></header><div className="modal-body"><p>删除后将解除这些成员的全部项目成员身份、任务分配和系统授权。</p><p className="form-error">删除后不可恢复，请确认是否继续。</p></div><footer className="modal-footer"><button className="button button-secondary" type="button" onClick={() => setPendingBatchDelete(false)} disabled={batchDeleting}>取消</button><button className="button button-danger" type="button" onClick={() => { void confirmBatchDeleteMember() }} disabled={batchDeleting}>{batchDeleting ? '删除中…' : '确认删除'}</button></footer></section></div>}
    </div>
  )
}
