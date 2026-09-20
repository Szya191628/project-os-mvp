import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

// 交付物安全查看链接（文档 §6.3）：
// - 令牌 = base64url(deliverableId|memberId|过期时间) + HMAC-SHA256 签名
// - 令牌绑定到收件人成员，短有效期（默认 7 天）
// - 点击时服务端再次校验成员状态与项目只读权限，不生成永久公开文件地址
const TOKEN_TTL_MS = config.approval.viewTokenTtlMs

const base64Url = (value: Buffer) => value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
const fromBase64Url = (value: string) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function sign(payload: string) {
  return base64Url(createHmac('sha256', config.approval.viewTokenSecret).update(payload).digest())
}

export function createDeliverableViewToken(deliverableId: string, memberId: string, now = Date.now()) {
  const expiresAt = now + TOKEN_TTL_MS
  const payload = `${deliverableId}|${memberId}|${expiresAt}`
  return `${base64Url(Buffer.from(payload, 'utf8'))}.${sign(payload)}`
}

export function verifyDeliverableViewToken(token: string): { deliverableId: string; memberId: string } | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  let payload: string
  try { payload = fromBase64Url(encoded).toString('utf8') } catch { return null }
  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [deliverableId, memberId, expiresAtText] = payload.split('|')
  const expiresAt = Number(expiresAtText)
  if (!deliverableId || !memberId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
  return { deliverableId, memberId }
}

export function createDeliverableViewLink(deliverableId: string, memberId: string) {
  return `${config.apiOrigin}/api/v1/deliverables/${deliverableId}/view?token=${createDeliverableViewToken(deliverableId, memberId)}`
}
