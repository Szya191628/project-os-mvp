import { prisma } from './db.js'

export const DINGTALK_INTEGRATION_DISABLED = 'dingtalk_integration_disabled'

/**
 * 读取组织级钉钉业务交互开关。
 *
 * 没有组织 ID 时只代表当前调用尚未解析到组织，保持原有配置校验，
 * 避免把 OAuth 登录流程误判为业务交互；所有已归属组织的业务调用
 * 都必须显式传入组织 ID。
 */
export async function isDingTalkIntegrationEnabled(organizationId: string | null | undefined) {
  if (!organizationId) return true
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { dingtalkIntegrationEnabled: true } })
  return organization?.dingtalkIntegrationEnabled ?? true
}

export async function requireDingTalkIntegration(organizationId: string | null | undefined) {
  if (!(await isDingTalkIntegrationEnabled(organizationId))) throw new Error(DINGTALK_INTEGRATION_DISABLED)
}
