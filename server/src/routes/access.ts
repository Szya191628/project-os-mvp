import type { FastifyInstance } from 'fastify'
import { appendAuditLog, isGlobalL2, isL1, requireGlobalPermission, requireProjectPermission, supervisedProjectIds } from '../auth.js'
import { prisma } from '../db.js'
import { DingTalkApiError } from '../dingtalk.js'
import { syncDingTalkOrganization } from '../dingtalkSync.js'

type ProjectParams = { projectId: string }
type MemberParams = { organizationId: string; memberId: string; roleCode: string }
type OrganizationParams = { organizationId: string }
type OrgMemberParams = { organizationId: string; memberId: string }

export async function registerAccessRoutes(app: FastifyInstance) {
  app.get('/api/v1/auth/me', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const [member, organization] = await Promise.all([
      prisma.member.findUnique({ where: { id: actor.memberId }, select: { name: true } }),
      prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { dingtalkIntegrationEnabled: true } }),
    ])
    const projectL2Count = isL1(actor) || isGlobalL2(actor) ? 0 : await prisma.projectRoleGrant.count({ where: { memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } } } })
    // 主管身份：直属下属参与的项目集合（只读监督），供前端渲染"监督"标识与只读视图。
    const supervisingProjectIds = isL1(actor) || isGlobalL2(actor) ? [] : [...(await supervisedProjectIds(actor))]
    return { data: { memberId: actor.memberId, memberName: member?.name ?? '当前用户', organizationId: actor.organizationId, roleCodes: actor.roleCodes, baseRole: isL1(actor) ? 'L1' : isGlobalL2(actor) || projectL2Count > 0 ? 'L2' : 'L3', canCreateProject: isL1(actor) || isGlobalL2(actor), supervisingProjectIds, dingtalkIntegrationEnabled: organization?.dingtalkIntegrationEnabled ?? true } }
  })

  app.get<{ Params: OrganizationParams }>('/api/v1/organizations/:organizationId/members', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'role.system.manage')
    if (!actor) return
    if (request.params.organizationId !== actor.organizationId) return reply.code(403).send({ error: 'forbidden' })
    const members = await prisma.member.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        capacityHoursPerWeek: true,
        status: true,
        joinedAt: true,
        leftAt: true,
        department: { select: { id: true, name: true } },
        memberDepartments: { select: { department: { select: { id: true, name: true } } } },
        manager: { select: { id: true, name: true } },
        memberRoles: { select: { role: { select: { code: true, name: true } } } },
        projectMemberships: { select: { projectId: true, membershipRole: true, project: { select: { code: true, name: true } } } },
        projectRoleGrants: { where: { roleCode: 'L2', revokedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, projectId: true, createdAt: true, project: { select: { code: true, name: true } }, grantedBy: { select: { id: true, name: true } } } },
        externalIdentities: { where: { provider: 'DINGTALK' }, orderBy: { createdAt: 'asc' }, select: { id: true, corpId: true, userId: true, unionId: true, openId: true, lastSyncedAt: true } },
      },
    })
    return {
      data: {
        viewerId: actor.memberId,
        organizationId: actor.organizationId,
        members: members.map((member) => {
          const { memberRoles, projectMemberships, projectRoleGrants, externalIdentities, memberDepartments, ...profile } = member
          const systemBaseRole = memberRoles.some((item) => item.role.code === 'L1') ? 'L1' : memberRoles.some((item) => item.role.code === 'L2') ? 'L2' : 'L3'
          const baseRole = systemBaseRole === 'L1' || projectRoleGrants.length > 0 ? 'L2' : systemBaseRole
          return {
            ...profile,
            systemRoles: memberRoles.map((item) => item.role),
            baseRole: systemBaseRole === 'L1' ? 'L1' : baseRole,
            systemBaseRole,
            projectCount: projectMemberships.length,
            projectL2Grants: projectRoleGrants,
            dingtalkIdentities: externalIdentities,
            departments: memberDepartments.map(({ department }) => department),
          }
        }),
      },
    }
  })

  // 成员删除（离职归档）：物理删除会被审计日志/负责人等 Restrict 外键拦住，
  // 因此这里做的是安全下线——解除全部项目身份、任务分配与授权，标记 INACTIVE + leftAt。
  app.delete<{ Params: OrgMemberParams }>('/api/v1/organizations/:organizationId/members/:memberId', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'role.system.manage')
    if (!actor) return
    if (request.params.organizationId !== actor.organizationId) return reply.code(403).send({ error: 'forbidden' })
    const memberId = request.params.memberId
    if (memberId === actor.memberId) return reply.code(409).send({ error: 'cannot_delete_self' })
    const member = await prisma.member.findFirst({
      where: { id: memberId, organizationId: actor.organizationId },
      select: { id: true, name: true, status: true, ownedProjects: { select: { name: true } }, ownedPortfolios: { select: { id: true } } },
    })
    if (!member) return reply.code(404).send({ error: 'member_not_found' })
    if (member.ownedProjects.length > 0 || member.ownedPortfolios.length > 0) {
      return reply.code(409).send({ error: 'member_still_owns_resources' })
    }
    await prisma.$transaction(async (tx) => {
      await tx.projectMember.deleteMany({ where: { memberId } })
      await tx.taskAssignee.updateMany({ where: { memberId, removedAt: null }, data: { removedAt: new Date() } })
      await tx.memberRole.deleteMany({ where: { memberId } })
      await tx.projectRoleGrant.deleteMany({ where: { memberId } })
      await tx.member.updateMany({ where: { managerId: memberId }, data: { managerId: null } })
      await tx.member.update({ where: { id: memberId }, data: { status: 'INACTIVE', leftAt: new Date() } })
    })
    await appendAuditLog({ request, action: 'MEMBER_DELETED', resourceType: 'MEMBER', resourceId: memberId, afterJson: { name: member.name, previousStatus: member.status } })
    return { data: { memberId, name: member.name } }
  })

  app.post<{ Params: OrganizationParams }>('/api/v1/organizations/:organizationId/members/sync-dingtalk', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'role.system.manage')
    if (!actor) return
    if (request.params.organizationId !== actor.organizationId) return reply.code(403).send({ error: 'forbidden' })
    try {
      const result = await syncDingTalkOrganization(actor.organizationId)
      await appendAuditLog({ request, action: 'DINGTALK_MEMBER_DIRECTORY_SYNCED', resourceType: 'ORGANIZATION', resourceId: actor.organizationId, afterJson: result })
      return { data: result }
    } catch (error) {
      request.log.error({ err: error }, 'DingTalk directory sync failed')
      if (error instanceof DingTalkApiError && (error.subCode === '60011' || error.providerMessage?.includes('qyapi_get_member') || error.providerMessage?.includes('qyapi_get_department_list') || error.providerMessage?.includes('qyapi_get_department_member'))) {
        return reply.code(502).send({ error: 'dingtalk_permission_required' })
      }
      if (error instanceof DingTalkApiError && (error.apiCode === '50002' || error.apiCode === '50004' || error.providerMessage?.includes('not within the scope of authorization'))) {
        return reply.code(502).send({ error: 'dingtalk_scope_limited' })
      }
      if (error instanceof Error && error.message === 'dingtalk_app_not_configured') return reply.code(503).send({ error: 'dingtalk_not_configured' })
      if (error instanceof Error && error.message === 'dingtalk_integration_disabled') return reply.code(409).send({ error: 'dingtalk_integration_disabled' })
      return reply.code(502).send({ error: 'dingtalk_sync_failed' })
    }
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/access', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'project.member.manage')
    if (!guard) return
    const [project, grants, members, availableMembers] = await Promise.all([
      prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true, code: true, name: true } }),
      prisma.projectRoleGrant.findMany({ where: { projectId: request.params.projectId }, orderBy: { createdAt: 'asc' }, select: { id: true, memberId: true, roleCode: true, grantedById: true, parentGrantId: true, revokedAt: true, createdAt: true, member: { select: { id: true, name: true } }, grantedBy: { select: { id: true, name: true } } } }),
      prisma.projectMember.findMany({ where: { projectId: request.params.projectId }, select: { memberId: true, membershipRole: true, member: { select: { id: true, name: true, status: true, memberRoles: { select: { role: { select: { code: true, name: true } } } } } } } }),
      prisma.member.findMany({ where: { organizationId: guard.actor.organizationId, status: 'ACTIVE', NOT: { projectMemberships: { some: { projectId: request.params.projectId } } } }, orderBy: { name: 'asc' }, select: { id: true, name: true, status: true, memberRoles: { select: { role: { select: { code: true, name: true } } } } } }),
    ])
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const mapMember = (member: (typeof members)[number]['member']) => ({ ...member, systemRoles: member.memberRoles.map((item) => item.role), memberRoles: undefined })
    return { data: { project, members: members.map((membership) => ({ ...membership, member: mapMember(membership.member) })), grants, availableMembers: availableMembers.map(mapMember) } }
  })

  app.post<{ Params: ProjectParams; Body: { memberId?: string } }>('/api/v1/projects/:projectId/access/l2', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'project.role.grant')
    if (!guard) return
    const memberId = request.body?.memberId
    if (!memberId) return reply.code(400).send({ error: 'member_required' })
    const target = await prisma.member.findFirst({ where: { id: memberId, organizationId: guard.actor.organizationId, status: 'ACTIVE' }, select: { id: true, memberRoles: { select: { role: { select: { code: true } } } } } })
    if (!target) return reply.code(404).send({ error: 'member_not_found' })
    if (target.memberRoles.some((role) => role.role.code === 'L1')) return reply.code(400).send({ error: 'l1_already_has_full_access' })
    const existing = await prisma.projectRoleGrant.findFirst({ where: { projectId: request.params.projectId, memberId, roleCode: 'L2', revokedAt: null }, select: { id: true } })
    if (existing) return reply.code(409).send({ error: 'project_l2_already_granted' })
    const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const grant = await prisma.$transaction(async (tx) => {
      await tx.projectMember.upsert({ where: { projectId_memberId: { projectId: project.id, memberId } }, update: {}, create: { projectId: project.id, memberId, organizationId: guard.actor.organizationId, membershipRole: 'project_l2' } })
      return tx.projectRoleGrant.create({ data: { projectId: project.id, memberId, roleCode: 'L2', grantedById: guard.actor.memberId, parentGrantId: guard.access.grantId }, select: { id: true, projectId: true, memberId: true, roleCode: true, grantedById: true, parentGrantId: true, createdAt: true } })
    })
    await appendAuditLog({ request, action: 'PROJECT_L2_GRANTED', resourceType: 'PROJECT_ROLE_GRANT', resourceId: grant.id, projectId: project.id, afterJson: grant })
    return reply.code(201).send({ data: grant })
  })

  app.delete<{ Params: ProjectParams & { memberId: string } }>('/api/v1/projects/:projectId/access/l2/:memberId', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'project.role.revoke')
    if (!guard) return
    const grant = await prisma.projectRoleGrant.findFirst({ where: { projectId: request.params.projectId, memberId: request.params.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: guard.actor.organizationId, archivedAt: null } }, select: { id: true, projectId: true, memberId: true, roleCode: true } })
    if (!grant) return reply.code(404).send({ error: 'project_l2_grant_not_found' })
    // Guard the update with revokedAt=null so a stale/double click becomes a
    // normal 404 instead of leaking a Prisma "record not found" 500.
    const revokedAt = new Date()
    const revoked = await prisma.$transaction(async (tx) => {
      const result = await tx.projectRoleGrant.updateMany({ where: { id: grant.id, revokedAt: null }, data: { revokedAt } })
      if (result.count === 0) return null
      return tx.projectRoleGrant.findUnique({ where: { id: grant.id }, select: { id: true, projectId: true, memberId: true, roleCode: true, revokedAt: true } })
    })
    if (!revoked) return reply.code(404).send({ error: 'project_l2_grant_not_found' })
    await appendAuditLog({ request, action: 'PROJECT_L2_REVOKED', resourceType: 'PROJECT_ROLE_GRANT', resourceId: grant.id, projectId: grant.projectId, beforeJson: grant, afterJson: revoked })
    return { data: revoked }
  })

  app.post<{ Params: MemberParams }>('/api/v1/organizations/:organizationId/members/:memberId/system-roles/:roleCode', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'role.system.manage')
    if (!actor) return
    if (request.params.organizationId !== actor.organizationId) return reply.code(403).send({ error: 'forbidden' })
    if (!['L1', 'L2', 'L3'].includes(request.params.roleCode)) return reply.code(400).send({ error: 'unsupported_system_role' })
    const member = await prisma.member.findFirst({ where: { id: request.params.memberId, organizationId: actor.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return reply.code(404).send({ error: 'member_not_found' })
    const roleName = request.params.roleCode === 'L1' ? 'L1 全局管理员' : request.params.roleCode === 'L2' ? 'L2 项目经理' : 'L3 执行成员'
    const role = await prisma.role.upsert({ where: { organizationId_code: { organizationId: actor.organizationId, code: request.params.roleCode } }, update: { name: roleName }, create: { organizationId: actor.organizationId, code: request.params.roleCode, name: roleName }, select: { id: true, code: true } })
    const assigned = await prisma.memberRole.upsert({ where: { memberId_roleId: { memberId: member.id, roleId: role.id } }, update: { assignedById: actor.memberId }, create: { memberId: member.id, roleId: role.id, assignedById: actor.memberId }, select: { id: true, memberId: true, roleId: true } })
    await appendAuditLog({ request, action: 'SYSTEM_ROLE_GRANTED', resourceType: 'MEMBER_ROLE', resourceId: assigned.id, afterJson: { ...assigned, roleCode: role.code } })
    return reply.code(201).send({ data: { ...assigned, roleCode: role.code } })
  })

  app.delete<{ Params: MemberParams }>('/api/v1/organizations/:organizationId/members/:memberId/system-roles/:roleCode', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'role.system.manage')
    if (!actor) return
    if (request.params.organizationId !== actor.organizationId) return reply.code(403).send({ error: 'forbidden' })
    if (!['L1', 'L2', 'L3'].includes(request.params.roleCode)) return reply.code(400).send({ error: 'unsupported_system_role' })
    if (request.params.memberId === actor.memberId && request.params.roleCode === 'L1') return reply.code(400).send({ error: 'cannot_revoke_own_l1' })
    const role = await prisma.role.findFirst({ where: { organizationId: actor.organizationId, code: request.params.roleCode }, select: { id: true, code: true } })
    if (!role) return reply.code(404).send({ error: 'system_role_not_found' })
    const assigned = await prisma.memberRole.findUnique({ where: { memberId_roleId: { memberId: request.params.memberId, roleId: role.id } }, select: { id: true, memberId: true, roleId: true } })
    if (!assigned) return reply.code(404).send({ error: 'member_role_not_found' })
    const revokedProjectGrants = await prisma.$transaction(async (tx) => {
      await tx.memberRole.delete({ where: { id: assigned.id } })
      if (request.params.roleCode !== 'L2') return []
      const activeGrants = await tx.projectRoleGrant.findMany({ where: { memberId: request.params.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } }, select: { id: true, projectId: true, memberId: true, roleCode: true } })
      if (activeGrants.length === 0) return []
      const revokedAt = new Date()
      await tx.projectRoleGrant.updateMany({ where: { memberId: request.params.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } }, data: { revokedAt } })
      return activeGrants.map((grant) => ({ ...grant, revokedAt }))
    })
    await appendAuditLog({ request, action: 'SYSTEM_ROLE_REVOKED', resourceType: 'MEMBER_ROLE', resourceId: assigned.id, beforeJson: { ...assigned, roleCode: role.code } })
    for (const grant of revokedProjectGrants) {
      await appendAuditLog({ request, action: 'PROJECT_L2_REVOKED', resourceType: 'PROJECT_ROLE_GRANT', resourceId: grant.id, projectId: grant.projectId, beforeJson: { id: grant.id, projectId: grant.projectId, memberId: grant.memberId, roleCode: grant.roleCode }, afterJson: grant })
    }
    return { data: { ...assigned, roleCode: role.code, revoked: true, projectL2Revoked: revokedProjectGrants.length } }
  })
}
