import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { config } from './config.js'
import { getDingTalkAppAccessToken } from './dingtalk.js'
import { fetchDingTalkApi } from './dingtalkUsage.js'
import { downloadFileFromUrl, type DownloadedDingTalkFile } from './deliverables/dingtalkDelivery.js'

type JsonRecord = Record<string, unknown>
type FetchLike = typeof fetch

const asRecord = (value: unknown): JsonRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null

function stringValue(record: JsonRecord | null, ...keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

async function callJson(url: string, init: RequestInit, accessToken: string, fetchImpl: FetchLike = fetch) {
  const response = await fetchDingTalkApi({ operation: new URL(url).pathname, url, fetchImpl, init: {
    ...init,
    headers: { ...(init.headers ?? {}), 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    signal: AbortSignal.timeout(config.dingtalk.requestTimeoutMs),
  } })
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new Error(`dingtalk_approval_api_failed_${response.status}`)
  const record = asRecord(payload)
  if (!record) throw new Error('dingtalk_approval_invalid_response')
  // 新版 api.dingtalk.com 错误形如 { code: 'xxx', message: '...' }
  const code = stringValue(record, 'code', 'errcode')
  if (code && code !== '0' && code !== 'ok') throw new Error(`dingtalk_approval_error_${code}`)
  return asRecord(record.result) ?? record
}

export type ApprovalFormValue = { name: string; value: string }

/**
 * 创建钉钉 OA 审批实例（工作流实例写权限）。
 * 审批人由上层按项目权限解析；未传入时才使用审批模板默认路由。
 */
export async function createDingTalkApprovalInstance(input: { processCode: string; originatorUserId: string; formComponentValues: ApprovalFormValue[]; approverUserIds?: string[]; deptId?: string; fetchImpl?: FetchLike }) {
  if (!input.processCode) throw new Error('dingtalk_approval_process_code_missing')
  if (!input.originatorUserId) throw new Error('dingtalk_originator_user_missing')
  const accessToken = await getDingTalkAppAccessToken()
  const body: JsonRecord = {
    processCode: input.processCode,
    originatorUserId: input.originatorUserId,
    formComponentValues: input.formComponentValues.map((item) => ({ name: item.name, value: item.value })),
  }
  if (input.deptId) body.deptId = Number(input.deptId) || input.deptId
  if (input.approverUserIds && input.approverUserIds.length > 0) {
    body.approvers = input.approverUserIds.map((userId) => ({ actionType: 'NONE', userId }))
  }
  const result = await callJson(config.approval.createInstanceUrl, { method: 'POST', body: JSON.stringify(body) }, accessToken, input.fetchImpl)
  const processInstanceId = stringValue(result, 'processInstanceId', 'process_instance_id')
  if (!processInstanceId) throw new Error('dingtalk_process_instance_id_missing')
  return { processInstanceId }
}

export type DingTalkApprovalInstance = {
  status: 'RUNNING' | 'TERMINATED' | 'COMPLETED' | 'UNKNOWN'
  result: 'agree' | 'refuse' | undefined
  formComponentValues: ApprovalFormValue[]
  raw: JsonRecord
}

/** 查询审批实例详情（工作流实例读权限），用于轮询兜底与手动刷新。 */
export async function fetchDingTalkApprovalInstance(processInstanceId: string, fetchImpl: FetchLike = fetch): Promise<DingTalkApprovalInstance> {
  const accessToken = await getDingTalkAppAccessToken()
  const url = new URL(config.approval.getInstanceUrl)
  url.searchParams.set('processInstanceId', processInstanceId)
  const raw = await callJson(url.toString(), { method: 'GET' }, accessToken, fetchImpl)
  const statusText = (stringValue(raw, 'status') ?? '').toUpperCase()
  const status: DingTalkApprovalInstance['status'] = statusText === 'RUNNING' || statusText === 'TERMINATED' || statusText === 'COMPLETED' ? statusText as DingTalkApprovalInstance['status'] : 'UNKNOWN'
  const result = stringValue(raw, 'result') as DingTalkApprovalInstance['result'] | undefined
  const formComponentValues: ApprovalFormValue[] = []
  const components = Array.isArray(raw.formComponentValues) ? raw.formComponentValues : []
  for (const component of components) {
    const record = asRecord(component)
    const name = stringValue(record, 'name', 'label') ?? ''
    const value = stringValue(record, 'value') ?? ''
    if (name) formComponentValues.push({ name, value })
  }
  return { status, result, formComponentValues, raw }
}

export type ApprovalAttachmentRef = { fileId: string; spaceId?: string; name: string; mimeType?: string; size?: number }

/**
 * 从审批表单里提取全部交付物附件引用（文档 §5.3：允许一次上传多个附件）。
 * 钉钉附件控件的 value 是 JSON（对象或数组），包含 fileId/spaceId/fileName/fileType/size。
 */
export function extractApprovalAttachments(formComponentValues: ApprovalFormValue[], fieldName = config.approval.attachmentField): ApprovalAttachmentRef[] {
  const candidates = formComponentValues.filter((item) => item.name === fieldName || /附件|attachment|file/iu.test(item.name))
  const seen = new Set<string>()
  const results: ApprovalAttachmentRef[] = []
  for (const candidate of candidates) {
    if (!candidate.value.trim().startsWith('{') && !candidate.value.trim().startsWith('[')) continue
    let parsed: unknown
    try { parsed = JSON.parse(candidate.value) } catch { continue }
    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      const record = asRecord(item)
      const fileId = stringValue(record, 'fileId', 'file_id')
      if (!fileId || seen.has(fileId)) continue
      seen.add(fileId)
      results.push({
        fileId,
        spaceId: stringValue(record, 'spaceId', 'space_id'),
        name: stringValue(record, 'fileName', 'file_name', 'name') ?? '钉钉审批附件',
        mimeType: undefined,
        size: (() => { const size = record?.size; return typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.floor(size) : undefined })(),
      })
    }
  }
  return results
}

/** 兼容旧调用：取第一个附件引用。 */
export function extractApprovalAttachment(formComponentValues: ApprovalFormValue[], fieldName = config.approval.attachmentField): ApprovalAttachmentRef | null {
  return extractApprovalAttachments(formComponentValues, fieldName)[0] ?? null
}

/**
 * 外部审批实例发现（文档 §8）：按模板 processCode 拉取近期实例 ID 列表，
 * 用于回调丢失 / L3 直接在钉钉 OA 发起时的补偿补建。幂等由 processInstanceId 唯一键保证。
 */
export async function fetchRecentApprovalInstanceIds(input: { startTimeMs: number; fetchImpl?: FetchLike }): Promise<string[]> {
  if (!config.approval.enabled) return []
  const accessToken = await getDingTalkAppAccessToken()
  const instanceIds: string[] = []
  let nextToken = 0
  for (let page = 0; page < 5; page += 1) {
    const raw = await callJson(config.approval.getInstanceListUrl, {
      method: 'POST',
      body: JSON.stringify({
        processCode: config.approval.processCode,
        startTime: input.startTimeMs,
        endTime: Date.now(),
        nextToken,
        maxResults: 20,
      }),
    }, accessToken, input.fetchImpl ?? fetch)
    const list = Array.isArray(raw.list) ? raw.list : Array.isArray(raw.result) ? raw.result : []
    for (const item of list) {
      const id = typeof item === 'string' ? item.trim() : stringValue(asRecord(item), 'processInstanceId', 'process_instance_id')
      if (id) instanceIds.push(id)
    }
    const next = raw.nextToken
    const parsedNextToken = typeof next === 'number' ? next : typeof next === 'string' && next.trim() && /^\d+$/u.test(next.trim()) ? Number(next.trim()) : undefined
    if (parsedNextToken === undefined || list.length === 0 || parsedNextToken === nextToken) break
    nextToken = parsedNextToken
  }
  return instanceIds
}

/** 审批附件下载（审批附件/钉盘下载权限）并落入本地交付物目录。 */
export async function downloadApprovalAttachment(input: { processInstanceId: string; attachment: ApprovalAttachmentRef; fetchImpl?: FetchLike }): Promise<DownloadedDingTalkFile> {
  const accessToken = await getDingTalkAppAccessToken()
  const response = await fetchDingTalkApi({ operation: new URL(config.approval.downloadFileUrl).pathname, url: config.approval.downloadFileUrl, fetchImpl: input.fetchImpl, init: {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    body: JSON.stringify({ processInstanceId: input.processInstanceId, fileId: input.attachment.fileId, ...(input.attachment.spaceId ? { spaceId: input.attachment.spaceId } : {}) }),
    signal: AbortSignal.timeout(config.dingtalk.requestTimeoutMs),
  } })
  const payload = asRecord(await response.json().catch(() => null))
  if (!response.ok) throw new Error(`dingtalk_approval_download_failed_${response.status}`)
  const result = asRecord(payload?.result) ?? payload
  const downloadUrl = stringValue(result, 'downloadUri', 'downloadUrl', 'url')
  if (!downloadUrl) throw new Error('dingtalk_approval_download_url_missing')
  return downloadFileFromUrl(downloadUrl, input.attachment.name, input.attachment.mimeType, input.fetchImpl ?? fetch)
}

// ---------------------------------------------------------------------------
// 钉钉事件订阅加解密（审批状态变更回调 bpms_instance_change）。
// 协议：msg_signature = sha1(sort(token, timestamp, nonce, encrypt).join(''))，
// 密文 = base64(iv(16) + aes-256-cbc(random(16) + len(4) + payload + corpid))。
// ---------------------------------------------------------------------------

function callbackKey() {
  if (!config.approval.callbackAesKey) throw new Error('dingtalk_callback_not_configured')
  const key = Buffer.from(config.approval.callbackAesKey, 'base64')
  if (key.length !== 32) throw new Error('dingtalk_callback_aes_key_invalid')
  return key
}

export function verifyDingTalkEventSignature(input: { token: string; timestamp: string; nonce: string; encrypt: string; signature: string }) {
  const expected = createHash('sha1').update([input.token, input.timestamp, input.nonce, input.encrypt].sort().join('')).digest('hex')
  return expected === input.signature
}

export function decryptDingTalkEvent(encrypt: string): { message: string; corpId: string | undefined } {
  const key = callbackKey()
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()])
  const length = plain.readUInt32BE(16)
  const message = plain.subarray(20, 20 + length).toString('utf8')
  const corpId = plain.subarray(20 + length).toString('utf8') || undefined
  return { message, corpId }
}

export function encryptDingTalkReply(corpId: string): { encrypt: string; signature: string; timestamp: string; nonce: string } {
  const key = callbackKey()
  const random = Buffer.from('0123456789abcdef')
  const payload = Buffer.from('success', 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const data = Buffer.concat([random, length, payload, Buffer.from(corpId, 'utf8')])
  const padded = Buffer.concat([data, Buffer.alloc((16 - (data.length % 16)) || 16, 16 - (data.length % 16) || 16)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypt = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
  const timestamp = `${Date.now()}`
  const nonce = `${Date.now() % 100000}`
  const signature = createHash('sha1').update([config.approval.callbackToken, timestamp, nonce, encrypt].sort().join('')).digest('hex')
  return { encrypt, signature, timestamp, nonce }
}
