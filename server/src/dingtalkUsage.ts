import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { prisma } from './db.js'

type FetchLike = typeof fetch

export class DingTalkApiBudgetExceededError extends Error {
  constructor(public readonly limit: number) {
    super('dingtalk_api_budget_exceeded')
    this.name = 'DingTalkApiBudgetExceededError'
  }
}

function currentPeriodStart(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(value)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  return new Date(Date.UTC(year, month - 1, 1))
}

function budgetLimit() {
  return Math.max(1, config.dingtalk.apiBudget.monthlyLimit - config.dingtalk.apiBudget.reserve)
}

function endpointOf(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value.slice(0, 300)
  }
}

export async function reserveDingTalkApiCall(organizationId = config.dingtalk.organizationId) {
  if (!organizationId || !config.dingtalk.apiBudget.enabled) return
  const periodStart = currentPeriodStart()
  const limit = budgetLimit()
  await prisma.$transaction(async (tx) => {
    const usage = await tx.dingTalkApiUsage.upsert({
      where: { organizationId_periodStart: { organizationId, periodStart } },
      update: {},
      create: { organizationId, periodStart },
      select: { id: true },
    })
    const updated = await tx.dingTalkApiUsage.updateMany({ where: { id: usage.id, requestCount: { lt: limit } }, data: { requestCount: { increment: 1 } } })
    if (updated.count === 0) throw new DingTalkApiBudgetExceededError(limit)
  })
}

export async function recordDingTalkApiCall(input: { operation: string; url: string; outcome: 'SUCCESS' | 'FAILED' | 'BLOCKED'; status?: number; error?: string; organizationId?: string }) {
  const organizationId = input.organizationId ?? config.dingtalk.organizationId
  if (!organizationId) return
  const afterJson: Record<string, string | number> = { operation: input.operation, endpoint: endpointOf(input.url), outcome: input.outcome }
  if (input.status !== undefined) afterJson.httpStatus = input.status
  if (input.error) afterJson.error = input.error.slice(0, 300)
  await prisma.auditLog.create({ data: { organizationId, action: 'DINGTALK_API_CALL', resourceType: 'DINGTALK_API', resourceId: randomUUID(), afterJson } }).catch(() => undefined)
}

export async function fetchDingTalkApi(input: { operation: string; url: string | URL; init?: RequestInit; fetchImpl?: FetchLike; organizationId?: string }) {
  const url = String(input.url)
  try {
    await reserveDingTalkApiCall(input.organizationId)
  } catch (error) {
    await recordDingTalkApiCall({ operation: input.operation, url, outcome: 'BLOCKED', error: error instanceof Error ? error.message : 'dingtalk_api_budget_exceeded', organizationId: input.organizationId })
    throw error
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, input.init)
    await recordDingTalkApiCall({ operation: input.operation, url, outcome: response.ok ? 'SUCCESS' : 'FAILED', status: response.status, organizationId: input.organizationId })
    return response
  } catch (error) {
    await recordDingTalkApiCall({ operation: input.operation, url, outcome: 'FAILED', error: error instanceof Error ? error.message : 'dingtalk_request_failed', organizationId: input.organizationId })
    throw error
  }
}
