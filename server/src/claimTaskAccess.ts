import type { Prisma } from '@prisma/client'
import type { AuthContext } from './auth.js'

export function canClaimIndependentTask(actor: AuthContext) {
  return actor.roleCodes.some((role) => role === 'L1' || role === 'L2' || role === 'L3')
}

export async function claimTaskScope(db: Prisma.TransactionClient, actor: AuthContext): Promise<Prisma.ClaimTaskWhereInput> {
  const member = await db.member.findFirst({
    where: { id: actor.memberId, organizationId: actor.organizationId, status: 'ACTIVE' },
    select: { departmentId: true, memberDepartments: { select: { departmentId: true } } },
  })
  const departmentIds = member ? [...new Set([...(member.departmentId ? [member.departmentId] : []), ...member.memberDepartments.map((item) => item.departmentId)])] : []
  return { OR: [{ departmentIds: { isEmpty: true } }, { departmentIds: { hasSome: departmentIds } }] }
}
