import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

// 微信小程序认证适配层（方案 §5）：只做 code2session 与短时绑定令牌，
// 不触碰任何业务逻辑。敏感信息（AppSecret / session_key）仅在此处使用，
// 绝不写入日志、错误信息或响应体。
type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null

const stringValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** 微信业务错误（errcode != 0）。错误消息只保留错误码，不回显 provider 原文中的敏感内容。 */
export class WechatApiError extends Error {
  constructor(public readonly apiCode: number, public readonly providerMessage: string | undefined) {
    super(`wechat_api_error_${apiCode}`)
    this.name = 'WechatApiError'
  }
}

export type WechatSession = {
  openId: string
  unionId?: string
  sessionKey?: string
}

/**
 * 调用微信 jscode2session 用临时登录凭证 code 换取 openid。
 *
 * @param code 小程序 wx.login() 返回的一次性 code
 * @returns openid（必需）、unionid / session_key（可选）
 * @throws Error 未配置 / 网络超时 / 网络失败 / 响应非法 / openid 缺失
 * @throws WechatApiError 微信返回业务错误码（如 40029 code 失效）
 */
export async function code2Session(code: string): Promise<WechatSession> {
  if (!config.wechat.enabled) throw new Error('wechat_not_configured')

  // 组装请求 URL；secret 只存在于本请求，不进入任何日志或异常信息。
  const url = new URL(config.wechat.code2sessionUrl)
  url.searchParams.set('appid', config.wechat.appId)
  url.searchParams.set('secret', config.wechat.appSecret)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')

  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(config.wechat.requestTimeoutMs) })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('wechat_request_timeout', { cause: error })
    throw new Error('wechat_request_failed', { cause: error })
  }

  const payload = await response.json().catch(() => null) as unknown
  // 微信 HTTP 层通常返回 200，业务错误通过 errcode 表达；这里同时兜底非 2xx。
  if (!response.ok) throw new Error(`wechat_request_failed_${response.status}`)
  const record = asRecord(payload)
  if (!record) throw new Error('wechat_invalid_response')

  const rawErrCode = record.errcode
  const errorCode = typeof rawErrCode === 'number'
    ? rawErrCode
    : typeof rawErrCode === 'string' && rawErrCode.trim() ? Number(rawErrCode) : 0
  if (Number.isFinite(errorCode) && errorCode !== 0) {
    throw new WechatApiError(errorCode, stringValue(record, 'errmsg'))
  }

  const openId = stringValue(record, 'openid')
  if (!openId) throw new Error('wechat_openid_missing')
  return { openId, unionId: stringValue(record, 'unionid'), sessionKey: stringValue(record, 'session_key') }
}

const base64Url = (value: Buffer) => value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
const fromBase64Url = (value: string) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function signBindPayload(payload: string) {
  return base64Url(createHmac('sha256', config.wechat.bindTokenSecret).update(payload).digest())
}

/**
 * 签发短时绑定令牌：未绑定成员登录时返回给小程序，仅承载 openid 与 AppID。
 * 采用 HMAC-SHA256 无状态签名（对标交付物查看链接 viewLink.ts），无需额外存储。
 */
export function createWechatBindToken(openId: string, now = Date.now()) {
  const expiresAt = now + config.wechat.bindTokenTtlMs
  const payload = `wechat-bind|${openId}|${config.wechat.appId}|${expiresAt}`
  return `${base64Url(Buffer.from(payload, 'utf8'))}.${signBindPayload(payload)}`
}

/** 校验绑定令牌，返回其承载的 openid；签名不符、AppID 不符或已过期时返回 null。 */
export function verifyWechatBindToken(token: string): { openId: string } | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  let payload: string
  try {
    payload = fromBase64Url(encoded).toString('utf8')
  } catch {
    return null
  }
  const expected = signBindPayload(payload)
  const provided = Buffer.from(signature)
  const computed = Buffer.from(expected)
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return null
  const [scope, openId, appId, expiresAtText] = payload.split('|')
  const expiresAt = Number(expiresAtText)
  if (scope !== 'wechat-bind' || !openId || appId !== config.wechat.appId) return null
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
  return { openId }
}

// 绑定码只有 6 位数字（百万级空间）。为防止暴力枚举，对同一 openid 的失败尝试
// 做滑动窗口限流：窗口内失败次数达到阈值即拒绝后续尝试（默认 5 次 / 10 分钟），
// 使单窗口内猜中概率降到可忽略量级。MVP 单实例用进程内计数即可；多实例部署时
// 应替换为 Redis 等共享存储（此处以 Map 抽象，替换成本低）。
type BindAttempt = { count: number; windowStart: number }
const bindFailures = new Map<string, BindAttempt>()

export function isWechatBindThrottled(openId: string, now = Date.now()) {
  const record = bindFailures.get(openId)
  if (!record) return false
  if (now - record.windowStart >= config.wechat.bindCodeAttemptWindowMs) {
    bindFailures.delete(openId)
    return false
  }
  return record.count >= config.wechat.bindCodeMaxAttempts
}

export function recordWechatBindFailure(openId: string, now = Date.now()) {
  const record = bindFailures.get(openId)
  if (!record || now - record.windowStart >= config.wechat.bindCodeAttemptWindowMs) {
    bindFailures.set(openId, { count: 1, windowStart: now })
    return
  }
  record.count += 1
}

/** 绑定成功后清零该 openid 的失败计数。 */
export function clearWechatBindFailures(openId: string) {
  bindFailures.delete(openId)
}
