import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { DingTalkApiError, fetchDingTalkDirectory, fetchDingTalkUserById, getDingTalkAppAccessToken, type DingTalkDirectoryUser, type DingTalkDepartment } from './dingtalk.js'
import { config } from './config.js'
import { requireDingTalkIntegration } from './dingtalkPolicy.js'

type SyncResult = {
  usersSeen: number
  membersCreated: number
  membersUpdated: number
  departmentsSynced: number
  managersSynced: number
  syncedAt: string
}

const identityKey = (value: string | null | undefined) => value?.trim() || undefined

function departmentLocalIds(user: DingTalkDirectoryUser, departmentIds: Map<string, string>) {
  return [...new Set(user.departmentIds.flatMap((departmentId) => {
    const localId = departmentIds.get(departmentId)
    return localId ? [localId] : []
  }))]
}

async function syncDepartments(departments: DingTalkDepartment[], organizationId: string, tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) {
  const existing = await tx.department.findMany({ where: { organizationId }, select: { id: true, name: true, parentId: true, externalKey: true } })
  const byExternalKey = new Map<string, (typeof existing)[number]>(existing.flatMap((department) => department.externalKey ? [[department.externalKey, department] as const] : []))
  const byNameAndParent = new Map<string, (typeof existing)[number]>(existing.map((department) => [`${department.parentId ?? 'root'}:${department.name}`, department] as const))
  const localIds = new Map<string, string>()
  const pending = new Map(departments.map((department) => [department.departmentId, department]))

  while (pending.size > 0) {
    let progressed = false
    for (const [externalKey, department] of pending) {
      const parentId = department.parentId ? localIds.get(department.parentId) : undefined
      if (department.parentId && !parentId && pending.has(department.parentId)) continue
      const nameKey = `${parentId ?? 'root'}:${department.name}`
      const current = byExternalKey.get(externalKey) ?? byNameAndParent.get(nameKey)
      const saved = current
        ? await tx.department.update({ where: { id: current.id }, data: { name: department.name, parentId, externalKey, status: 'ACTIVE' }, select: { id: true, name: true, parentId: true, externalKey: true } })
        : await tx.department.create({ data: { organizationId, name: department.name, parentId, externalKey, status: 'ACTIVE' }, select: { id: true, name: true, parentId: true, externalKey: true } })
      localIds.set(externalKey, saved.id)
      byExternalKey.set(externalKey, saved)
      byNameAndParent.set(`${saved.parentId ?? 'root'}:${saved.name}`, saved)
      pending.delete(externalKey)
      progressed = true
    }
    if (!progressed) {
      // A restricted address-book scope can omit a parent department. Keep the
      // employee department usable instead of blocking the whole sync.
      const [externalKey, department] = pending.entries().next().value as [string, DingTalkDepartment]
      const current = byExternalKey.get(externalKey) ?? byNameAndParent.get(`root:${department.name}`)
      const saved = current
        ? await tx.department.update({ where: { id: current.id }, data: { name: department.name, externalKey, status: 'ACTIVE' }, select: { id: true, name: true, parentId: true, externalKey: true } })
        : await tx.department.create({ data: { organizationId, name: department.name, externalKey, status: 'ACTIVE' }, select: { id: true, name: true, parentId: true, externalKey: true } })
      localIds.set(externalKey, saved.id)
      pending.delete(externalKey)
    }
  }
  return localIds
}

export async function syncDingTalkOrganization(organizationId: string): Promise<SyncResult> {
  await requireDingTalkIntegration(organizationId)
  const accessToken = await getDingTalkAppAccessToken()
  const linkedIdentities = await prisma.externalIdentity.findMany({ where: { provider: 'DINGTALK', corpId: config.dingtalk.corpId, member: { organizationId }, userId: { not: null } }, select: { userId: true } })
  let directory
  try {
    directory = await fetchDingTalkDirectory(accessToken)
  } catch (error) {
    if (!(error instanceof DingTalkApiError) || error.apiCode !== '50004') throw error
    const scopedRoots = new Set<string>()
    for (const identity of linkedIdentities.slice(0, 20)) {
      if (!identity.userId) continue
      try {
        const user = await fetchDingTalkUserById(accessToken, identity.userId)
        user.departmentIds.forEach((departmentId) => scopedRoots.add(departmentId))
      } catch {
        // Keep the original error if no linked user reveals an authorized scope.
      }
    }
    if (scopedRoots.size === 0) throw error
    directory = await fetchDingTalkDirectory(accessToken, [...scopedRoots])
  }
  const syncedAt = new Date().toISOString()

  return prisma.$transaction(async (tx) => {
    const departmentIds = await syncDepartments(directory.departments, organizationId, tx)
    const role = await tx.role.findUnique({ where: { organizationId_code: { organizationId, code: 'L3' } }, select: { id: true } })
    if (!role) throw new Error('l3_role_not_configured')

    const identities = await tx.externalIdentity.findMany({ where: { provider: 'DINGTALK', corpId: config.dingtalk.corpId, member: { organizationId } }, select: { id: true, memberId: true, corpId: true, userId: true, unionId: true, openId: true } })
    const memberIdByIdentity = new Map<string, string>()
    for (const identity of identities) {
      for (const value of [identity.userId, identity.unionId, identity.openId]) {
        const key = identityKey(value)
        if (key) memberIdByIdentity.set(key, identity.memberId)
      }
    }
    const memberIdByDingTalkUserId = new Map<string, string>()
    let membersCreated = 0
    let membersUpdated = 0

    for (const user of directory.users) {
      const memberDepartmentIds = departmentLocalIds(user, departmentIds)
      const departmentId = memberDepartmentIds[0]
      const mappedMemberId = memberIdByIdentity.get(user.userId) ?? memberIdByIdentity.get(user.unionId ?? '') ?? memberIdByIdentity.get(user.openId ?? '')
      const member = mappedMemberId
        ? await tx.member.update({ where: { id: mappedMemberId }, data: { name: user.name, email: user.email, avatarUrl: user.avatarUrl, ...(departmentId ? { departmentId } : {}) }, select: { id: true } })
        : await tx.member.create({ data: { organizationId, name: user.name, email: user.email, avatarUrl: user.avatarUrl, departmentId }, select: { id: true } })
      memberIdByDingTalkUserId.set(user.userId, member.id)
      memberIdByIdentity.set(user.userId, member.id)
      if (memberDepartmentIds.length > 0) {
        await tx.memberDepartment.deleteMany({ where: { memberId: member.id, departmentId: { notIn: memberDepartmentIds } } })
        await tx.memberDepartment.createMany({ data: memberDepartmentIds.map((departmentId) => ({ memberId: member.id, departmentId })), skipDuplicates: true })
      }
      if (mappedMemberId) membersUpdated += 1
      else {
        membersCreated += 1
        await tx.memberRole.create({ data: { memberId: member.id, roleId: role.id } })
      }

      const currentIdentity = identities.find((identity) => identity.memberId === member.id && [identity.userId, identity.unionId, identity.openId].some((value) => value && [user.userId, user.unionId, user.openId].includes(value)))
      if (currentIdentity) {
        await tx.externalIdentity.update({ where: { id: currentIdentity.id }, data: { corpId: config.dingtalk.corpId, userId: user.userId, unionId: user.unionId, openId: user.openId, profileSnapshot: user.profileSnapshot as Prisma.InputJsonValue, lastSyncedAt: new Date(syncedAt) } })
      } else {
        await tx.externalIdentity.create({ data: { memberId: member.id, provider: 'DINGTALK', corpId: config.dingtalk.corpId, userId: user.userId, unionId: user.unionId, openId: user.openId, profileSnapshot: user.profileSnapshot as Prisma.InputJsonValue, lastSyncedAt: new Date(syncedAt) } })
      }
    }

    let managersSynced = 0
    for (const user of directory.users) {
      const memberId = memberIdByDingTalkUserId.get(user.userId)
      if (!memberId) continue
      const managerId = user.managerUserId ? memberIdByDingTalkUserId.get(user.managerUserId) ?? null : null
      if (managerId && managerId !== memberId) managersSynced += 1
      await tx.member.update({ where: { id: memberId }, data: { managerId: managerId === memberId ? null : managerId } })
    }

    return { usersSeen: directory.users.length, membersCreated, membersUpdated, departmentsSynced: directory.departments.length, managersSynced, syncedAt }
  })
}
