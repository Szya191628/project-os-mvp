import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { config } from './config.js'
import { createOpaqueToken, hashOpaqueToken } from './session.js'
import type { DingTalkIdentity } from './dingtalk.js'
import { hasWorkflowAuditChanges } from './workflowAudit.js'

export { createOpaqueToken, hashOpaqueToken } from './session.js'

// SUPERVISOR：部门主管（直属下属所在项目的只读监督者），介于 L2 与 L3 之间的查看层级。
export type ProjectAccessLevel = 'L1' | 'L2' | 'L3' | 'SUPERVISOR'

export type PermissionCode =
  | 'project.read'
  | 'project.create'
  | 'project.delete'
  | 'project.member.manage'
  | 'project.role.grant'
  | 'project.role.revoke'
  | 'workflow.read'
  | 'workflow.edit'
  | 'workflow.publish'
  | 'task.read'
  | 'task.configure'
  | 'task.assign'
  | 'task.execute.all'
  | 'task.execute.own'
  | 'task.complete.confirm'
  | 'task.delete'
  | 'task.restore'
  | 'deliverable.read'
  | 'deliverable.manage'
  | 'deliverable.manage.own'
  | 'dependency.read'
  | 'metrics.project.read'
  | 'metrics.portfolio.read'
  | 'portfolio.read'
  | 'portfolio.manage'
  | 'agent.use'
  | 'role.system.manage'
  | 'audit.read'

export type AuthContext = {
  memberId: string
  organizationId: string
  roleCodes: string[]
}

export type ProjectAccess = {
  level: ProjectAccessLevel
  grantId?: string
}

type MemberWithRoles = {
  id: string
  organizationId: string
  memberRoles: { role: { code: string } }[]
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: AuthContext | null
  }
}

const l2Permissions = new Set<PermissionCode>([
  'project.read', 'project.member.manage', 'project.role.grant', 'project.role.revoke',
  'workflow.read', 'workflow.edit', 'workflow.publish', 'task.read', 'task.configure',
  'task.assign', 'task.execute.all', 'task.complete.confirm', 'task.delete', 'task.restore',
  'deliverable.read', 'deliverable.manage', 'dependency.read', 'metrics.project.read',
  'metrics.portfolio.read', 'portfolio.read', 'portfolio.manage', 'agent.use',
  'audit.read',
])

const l3Permissions = new Set<PermissionCode>([
  'project.read', 'workflow.read', 'task.read', 'task.execute.own', 'deliverable.read',
  'deliverable.manage.own', 'dependency.read', 'metrics.project.read',
])

// L3 的读取范围是项目级，执行/管理类权限仍然需要任务负责人关系。
// 单独维护读取权限集合，避免放宽读取时误放大任务写入能力。
const l3ProjectTaskReadPermissions = new Set<PermissionCode>(['task.read', 'deliverable.read'])

// 部门主管：纯只读监督 —— 可看下属所在项目的完整流程图、全部任务与交付物，
// 不具备流程编辑、任务发布、任务执行、交付物管理与成员管理权限。
const supervisorPermissions = new Set<PermissionCode>([
  'project.read', 'workflow.read', 'task.read', 'deliverable.read', 'dependency.read',
  'metrics.project.read', 'audit.read',
])

export function isL1(actor: AuthContext) {
  return actor.roleCodes.includes('L1')
}

export function isGlobalL2(actor: AuthContext) {
  return !isL1(actor) && actor.roleCodes.includes('L2')
}

/** Agent is a management capability. L3 can receive fixed DingTalk notices and commands, but not query Agent. */
export async function hasAgentPermission(actor: AuthContext) {
  if (isL1(actor) || isGlobalL2(actor)) return true
  const grant = await prisma.projectRoleGrant.findFirst({
    where: { memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } } },
    select: { id: true },
  })
  return Boolean(grant)
}

export function canAtLevel(level: ProjectAccessLevel, permission: PermissionCode) {
  if (level === 'L1') return true
  if (level === 'SUPERVISOR') return supervisorPermissions.has(permission)
  return level === 'L2' ? l2Permissions.has(permission) : l3Permissions.has(permission)
}

function toAuthContext(member: MemberWithRoles): AuthContext {
  const roleCodes = member.memberRoles.map((item) => item.role.code)
  return { memberId: member.id, organizationId: member.organizationId, roleCodes: roleCodes.length > 0 ? roleCodes : ['L3'] }
}

type DingTalkIdentityKey = { userId?: string; unionId?: string; openId?: string }

function identityKeys(identity: DingTalkIdentity): DingTalkIdentityKey[] {
  const keys: DingTalkIdentityKey[] = []
  if (identity.userId) keys.push({ userId: identity.userId })
  if (identity.unionId) keys.push({ unionId: identity.unionId })
  if (identity.openId) keys.push({ openId: identity.openId })
  return keys
}

function selectDingTalkIdentity<T extends { memberId: string }>(matches: T[]) {
  const memberIds = [...new Set(matches.map((match) => match.memberId))]
  if (memberIds.length > 1) throw new Error('dingtalk_identity_conflict')
  return matches[0] ?? null
}

async function findDingTalkIdentity(identity: DingTalkIdentity) {
  const keys = identityKeys(identity)
  if (keys.length === 0) return null
  const matches = await prisma.externalIdentity.findMany({
    where: { provider: 'DINGTALK', corpId: identity.corpId, OR: keys },
    orderBy: { createdAt: 'asc' },
  })
  return selectDingTalkIdentity(matches)
}

const identitySnapshot = (identity: DingTalkIdentity) => identity.profileSnapshot as Prisma.InputJsonValue

/** Resolve or provision a DingTalk user for both web login and bot messages. */
export async function findOrCreateDingTalkMember(identity: DingTalkIdentity, options: { provision?: boolean } = {}) {
  const existing = await findDingTalkIdentity(identity)
  if (existing) {
    const member = await prisma.member.findFirst({ where: { id: existing.memberId, organizationId: config.dingtalk.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return null
    await prisma.externalIdentity.update({
      where: { id: existing.id },
      data: {
        userId: identity.userId ?? undefined,
        unionId: identity.unionId ?? undefined,
        openId: identity.openId ?? undefined,
        profileSnapshot: identitySnapshot(identity),
        lastSyncedAt: new Date(),
      },
    })
    return member
  }

  if (options.provision === false) return null

  const memberName = identity.name ?? `钉钉成员 ${identity.userId ?? identity.unionId ?? identity.openId ?? '未命名'}`
  return prisma.$transaction(async (tx) => {
    const identityMatches = identityKeys(identity)
    const racedIdentities = identityMatches.length === 0 ? [] : await tx.externalIdentity.findMany({ where: { provider: 'DINGTALK', corpId: identity.corpId, OR: identityMatches }, orderBy: { createdAt: 'asc' }, select: { id: true, memberId: true } })
    const racedIdentity = selectDingTalkIdentity(racedIdentities)
    if (racedIdentity) {
      const member = await tx.member.findFirst({ where: { id: racedIdentity.memberId, organizationId: config.dingtalk.organizationId, status: 'ACTIVE' }, select: { id: true } })
      if (!member) return null
      await tx.externalIdentity.update({ where: { id: racedIdentity.id }, data: { userId: identity.userId ?? undefined, unionId: identity.unionId ?? undefined, openId: identity.openId ?? undefined, profileSnapshot: identitySnapshot(identity), lastSyncedAt: new Date() } })
      return member
    }

    const member = await tx.member.create({ data: { organizationId: config.dingtalk.organizationId, name: memberName, email: identity.email, avatarUrl: identity.avatarUrl, status: 'ACTIVE' }, select: { id: true } })
    const role = await tx.role.upsert({ where: { organizationId_code: { organizationId: config.dingtalk.organizationId, code: 'L3' } }, update: { name: 'L3 执行成员' }, create: { organizationId: config.dingtalk.organizationId, code: 'L3', name: 'L3 执行成员' }, select: { id: true } })
    await tx.memberRole.create({ data: { memberId: member.id, roleId: role.id } })
    const externalIdentity = await tx.externalIdentity.create({ data: { memberId: member.id, provider: 'DINGTALK', corpId: identity.corpId, userId: identity.userId, unionId: identity.unionId, openId: identity.openId, profileSnapshot: identitySnapshot(identity), lastSyncedAt: new Date() }, select: { id: true, memberId: true, corpId: true, userId: true, unionId: true, openId: true } })
    await tx.auditLog.create({ data: { organizationId: config.dingtalk.organizationId, action: 'DINGTALK_MEMBER_AUTO_PROVISIONED', resourceType: 'MEMBER', resourceId: member.id, afterJson: { memberId: member.id, identity: externalIdentity } } })
    return member
  })
}

export async function resolveDingTalkActor(identity: { corpId: string; userId: string; unionId?: string; openId?: string; name?: string }, options: { provision?: boolean } = {}): Promise<AuthContext | null> {
  if (!config.dingtalk.organizationId || identity.corpId !== config.dingtalk.corpId) return null
  const member = await findOrCreateDingTalkMember({ corpId: identity.corpId, userId: identity.userId, unionId: identity.unionId, openId: identity.openId, name: identity.name, profileSnapshot: { source: 'dingtalk-bot', corpId: identity.corpId, userId: identity.userId, unionId: identity.unionId ?? null, openId: identity.openId ?? null, name: identity.name ?? null } }, { provision: options.provision !== false })
  if (!member) return null
  const record = await prisma.member.findFirst({ where: { id: member.id, organizationId: config.dingtalk.organizationId, status: 'ACTIVE' }, select: { id: true, organizationId: true, memberRoles: { select: { role: { select: { code: true } } } } } })
  return record ? toAuthContext(record) : null
}

async function actorFromSessionToken(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null
  const session = await prisma.session.findFirst({
    where: { tokenHash: hashOpaqueToken(token), revokedAt: null, expiresAt: { gt: new Date() }, member: { status: 'ACTIVE' } },
    select: { member: { select: { id: true, organizationId: true, memberRoles: { select: { role: { select: { code: true } } } } } } },
  })
  return session ? toAuthContext(session.member) : null
}

/** 解析 `Authorization: Bearer <token>` 中的令牌；格式非法时返回 undefined。 */
function bearerTokenFromHeader(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  const match = /^Bearer\s+(.+)$/iu.exec(raw.trim())
  return match?.[1]?.trim() || undefined
}

async function resolveActor(request: FastifyRequest): Promise<AuthContext | null> {
  // 认证优先级：cookie（Web 端）→ Authorization: Bearer（小程序 / 服务端）→ dev header。
  // Web 登录行为保持不变；Bearer 与 cookie 走同一套 session 校验（含撤销与过期）。
  const cookieActor = await actorFromSessionToken(request.cookies?.[config.sessionCookieName])
  if (cookieActor) return cookieActor
  const bearerActor = await actorFromSessionToken(bearerTokenFromHeader(request.headers.authorization))
  if (bearerActor) return bearerActor
  const header = request.headers['x-member-id']
  const requestedMemberId = Array.isArray(header) ? header[0] : header
  const memberId = config.allowDevMemberHeader ? requestedMemberId ?? config.defaultMemberId : undefined
  if (!memberId) return null
  const member = await prisma.member.findFirst({
    where: { id: memberId, status: 'ACTIVE' },
    select: {
      id: true,
      organizationId: true,
      memberRoles: { select: { role: { select: { code: true } } } },
    },
  })
  if (!member) return null
  return toAuthContext(member)
}

export async function createSession(memberId: string, request: FastifyRequest) {
  return createServiceSession(memberId, request.headers['user-agent'])
}

export async function createServiceSession(memberId: string, userAgent = 'project-os-service') {
  const token = createOpaqueToken()
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000)
  await prisma.session.create({ data: { memberId, tokenHash: hashOpaqueToken(token), expiresAt, userAgent } })
  return { token, expiresAt }
}

export async function revokeSession(token: string | undefined) {
  if (!token) return
  await prisma.session.updateMany({ where: { tokenHash: hashOpaqueToken(token), revokedAt: null }, data: { revokedAt: new Date() } })
}

export async function registerAuthHooks(app: FastifyInstance) {
  app.decorateRequest('actor', null)
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]
    // 交付物安全查看链接自带签名令牌（绑定成员+短有效期），无需会话鉴权。
    // 微信 login/bind 本身即登录动作（尚未持有会话），必须放行；bindcode 需已登录，不放行。
    if ((pathname.startsWith('/api/v1/deliverables/') && pathname.endsWith('/view')) || pathname === '/healthz' || pathname === '/readyz' || pathname === '/api/v1/auth/dingtalk/start' || pathname === '/api/v1/auth/dingtalk/callback' || pathname === '/api/v1/auth/wechat/login' || pathname === '/api/v1/auth/wechat/bind' || pathname === '/api/v1/auth/logout' || pathname === '/api/v1/dingtalk/approval/callback') return
    const actor = await resolveActor(request)
    if (!actor) {
      await reply.code(401).send({ error: 'authentication_required' })
      return
    }
    request.actor = actor
  })
}

export async function requireGlobalPermission(request: FastifyRequest, reply: FastifyReply, permission: PermissionCode) {
  const actor = request.actor
  if (!actor) {
    await reply.code(401).send({ error: 'authentication_required' })
    return null
  }
  const allowed = isL1(actor)
    ? canAtLevel('L1', permission)
    : isGlobalL2(actor) && permission === 'project.create'
  if (!allowed) {
    await reply.code(403).send({ error: 'forbidden', permission })
    return null
  }
  return actor
}

/** 独立认领任务不属于任何项目：L1、全局 L2，以及已被授予项目 L2 的成员可以发布。 */
export async function requireClaimTaskPublishPermission(request: FastifyRequest, reply: FastifyReply) {
  const actor = request.actor
  if (!actor) {
    await reply.code(401).send({ error: 'authentication_required' })
    return null
  }
  if (isL1(actor) || isGlobalL2(actor)) return actor
  const projectL2Grant = await prisma.projectRoleGrant.findFirst({
    where: { memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } } },
    select: { id: true },
  })
  if (!projectL2Grant) {
    await reply.code(403).send({ error: 'forbidden', permission: 'claim-task.publish' })
    return null
  }
  return actor
}

export async function projectAccess(actor: AuthContext, projectId: string): Promise<ProjectAccess | null> {
  if (isL1(actor)) return { level: 'L1' }
  const grant = await prisma.projectRoleGrant.findFirst({
    where: { projectId, memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (grant) return { level: 'L2', grantId: grant.id }
  const membership = await prisma.projectMember.findUnique({ where: { projectId_memberId: { projectId, memberId: actor.memberId } }, select: { projectId: true } })
  if (membership) return { level: 'L3' }
  const assignedTask = await prisma.taskAssignee.findFirst({ where: { memberId: actor.memberId, removedAt: null, task: { projectId, project: { organizationId: actor.organizationId, archivedAt: null } } }, select: { id: true } })
  if (assignedTask) return { level: 'L3' }
  const ownedNode = await prisma.workflowNode.findFirst({ where: { ownerMemberId: actor.memberId, task: { projectId, project: { organizationId: actor.organizationId, archivedAt: null } } }, select: { id: true } })
  if (ownedNode) return { level: 'L3' }
  // 部门主管兜底：本人与项目无直接关系，但存在直属下属参与该项目 → 只读监督视图。
  // 主管自己也是项目成员/任务负责人的场景已被上面 L3 分支优先命中。
  const supervised = await supervisedProjectIds(actor)
  return supervised.has(projectId) ? { level: 'SUPERVISOR' } : null
}

/** 直属下属成员 ID（不含隔级）。 */
export async function supervisedMemberIds(actor: AuthContext) {
  const rows = await prisma.member.findMany({ where: { managerId: actor.memberId, status: 'ACTIVE' }, select: { id: true } })
  return rows.map((row) => row.id)
}

/**
 * 主管监督的项目集合：任一直属下属以 项目成员 / 任务负责人 / 节点负责人
 * 身份参与的项目。主管对这些项目只拥有 SUPERVISOR 只读视图。
 */
export async function supervisedProjectIds(actor: AuthContext): Promise<Set<string>> {
  const reportIds = await supervisedMemberIds(actor)
  if (reportIds.length === 0) return new Set()
  const scope = { project: { organizationId: actor.organizationId, archivedAt: null } }
  const [memberships, assignments, ownedNodes] = await Promise.all([
    prisma.projectMember.findMany({ where: { memberId: { in: reportIds }, ...scope }, select: { projectId: true } }),
    prisma.taskAssignee.findMany({ where: { memberId: { in: reportIds }, removedAt: null, task: scope }, select: { task: { select: { projectId: true } } } }),
    prisma.workflowNode.findMany({ where: { ownerMemberId: { in: reportIds }, task: scope }, select: { task: { select: { projectId: true } } } }),
  ])
  const ids = [
    ...memberships.map((item) => item.projectId),
    ...assignments.map((item) => item.task.projectId),
    ...ownedNodes.flatMap((item) => item.task ? [item.task.projectId] : []),
  ]
  return new Set(ids)
}

export async function requireProjectPermission(request: FastifyRequest, reply: FastifyReply, projectId: string, permission: PermissionCode) {
  const actor = request.actor
  if (!actor) {
    await reply.code(401).send({ error: 'authentication_required' })
    return null
  }
  const access = await projectAccess(actor, projectId)
  if (!access || !canAtLevel(access.level, permission)) {
    await reply.code(403).send({ error: 'forbidden', permission, projectId })
    return null
  }
  return { actor, access }
}

export async function checkTaskPermission(actor: AuthContext, taskId: string, permission: PermissionCode) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, archivedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } },
    select: {
      id: true,
      projectId: true,
      assignees: { where: { memberId: actor.memberId, removedAt: null }, select: { id: true } },
      nodes: { select: { ownerMemberId: true } },
    },
  })
  if (!task) return { error: 'task_not_found' as const }
  const access = await projectAccess(actor, task.projectId)
  if (!access) return { error: 'forbidden' as const, permission, taskId }
  if (access.level === 'L3') {
    const isAssignee = task.assignees.length > 0 || task.nodes.some((node) => node.ownerMemberId === actor.memberId)
    const canReadProjectTask = l3ProjectTaskReadPermissions.has(permission)
    if ((!canReadProjectTask && !isAssignee) || !canAtLevel(access.level, permission)) return { error: 'forbidden' as const, permission, taskId }
  } else if (!canAtLevel(access.level, permission) && !(permission === 'task.execute.own' && canAtLevel(access.level, 'task.execute.all'))) {
    return { error: 'forbidden' as const, permission, taskId }
  }
  return { actor, access, task }
}

export async function requireTaskPermission(request: FastifyRequest, reply: FastifyReply, taskId: string, permission: PermissionCode) {
  const actor = request.actor
  if (!actor) {
    await reply.code(401).send({ error: 'authentication_required' })
    return null
  }
  const result = await checkTaskPermission(actor, taskId, permission)
  if ('error' in result) {
    await reply.code(result.error === 'task_not_found' ? 404 : 403).send({ error: result.error, ...(result.error === 'forbidden' ? { permission, taskId } : {}) })
    return null
  }
  return result
}

export async function visibleProjectIds(actor: AuthContext) {
  if (isL1(actor)) return null
  const [grants, memberships, assignments, ownedNodes, supervisedProjects] = await Promise.all([
    prisma.projectRoleGrant.findMany({ where: { memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } } }, select: { projectId: true } }),
    prisma.projectMember.findMany({ where: { memberId: actor.memberId, project: { organizationId: actor.organizationId, archivedAt: null } }, select: { projectId: true } }),
    prisma.taskAssignee.findMany({ where: { memberId: actor.memberId, removedAt: null, task: { project: { organizationId: actor.organizationId, archivedAt: null } } }, select: { task: { select: { projectId: true } } } }),
    prisma.workflowNode.findMany({ where: { ownerMemberId: actor.memberId, task: { project: { organizationId: actor.organizationId, archivedAt: null } } }, select: { task: { select: { projectId: true } } } }),
    supervisedProjectIds(actor),
  ])
  return new Set([...grants.map((item) => item.projectId), ...memberships.map((item) => item.projectId), ...assignments.map((item) => item.task.projectId), ...ownedNodes.flatMap((item) => item.task ? [item.task.projectId] : []), ...supervisedProjects])
}

export async function appendAuditLog(input: { request: FastifyRequest; action: string; resourceType: string; resourceId: string; projectId?: string; taskId?: string; beforeJson?: unknown; afterJson?: unknown }) {
  const actor = input.request.actor
  if (!actor) return
  if (input.resourceType === 'WORKFLOW_VERSION' && ['WORKFLOW_DRAFT_SAVED', 'WORKFLOW_PUBLISHED_UPDATED', 'WORKFLOW_PUBLISHED'].includes(input.action) && !hasWorkflowAuditChanges(input.beforeJson, input.afterJson)) return
  // 一次拖动、插入或排期联动可能在短时间内触发多次草稿保存。
  // 用同一版本的最近一条日志承接后续快照，避免一次用户操作产生多条重复记录。
  if (input.action === 'WORKFLOW_DRAFT_SAVED' && input.projectId) {
    const recent = await prisma.auditLog.findFirst({
      where: { organizationId: actor.organizationId, actorMemberId: actor.memberId, projectId: input.projectId, resourceType: input.resourceType, resourceId: input.resourceId, action: input.action, createdAt: { gte: new Date(Date.now() - 2000) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (recent) {
      await prisma.auditLog.update({ where: { id: recent.id }, data: { afterJson: input.afterJson === undefined || input.afterJson === null ? undefined : input.afterJson as Prisma.InputJsonValue, requestId: input.request.id, createdAt: new Date() } })
      return
    }
  }
  await prisma.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorMemberId: actor.memberId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      projectId: input.projectId,
      taskId: input.taskId,
      beforeJson: input.beforeJson === undefined || input.beforeJson === null ? undefined : input.beforeJson as Prisma.InputJsonValue,
      afterJson: input.afterJson === undefined || input.afterJson === null ? undefined : input.afterJson as Prisma.InputJsonValue,
      requestId: input.request.id,
    },
  })
}
