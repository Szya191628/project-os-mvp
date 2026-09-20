import type { RobotMessage } from 'dingtalk-stream'
import type { AgentAttachment } from './agent/types.js'

type RobotContent = Record<string, unknown>

export type RobotMessagePayload = Partial<Omit<RobotMessage, 'msgtype' | 'text'>> & {
  msgtype?: string
  text?: { content?: string }
  at?: { atUserIds?: string[]; isAtAll?: boolean }
  isAtAll?: boolean
  content?: RobotContent | string
  file?: RobotContent
  picture?: RobotContent
  richText?: RobotContent
  attachment?: AgentAttachment
}

export function normalizeBotCommand(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

export function isDingTalkSendResponseSuccessful(httpOk: boolean, payload: unknown) {
  if (!httpOk) return false
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true
  const record = payload as Record<string, unknown>
  const errorCode = record.errcode ?? record.errCode
  if (errorCode !== undefined && errorCode !== null && String(errorCode) !== '0') return false
  if (record.success === false || record.success === 'false') return false
  const code = record.code
  if (code !== undefined && code !== null && !['0', '200', 'ok', 'success'].includes(String(code).toLowerCase())) return false
  return true
}

export function isBotConfirmationCommand(value: string) {
  const command = normalizeBotCommand(value).replace(/[。！!？，,、]+$/u, '')
  return ['确认', '确认执行', '确认修改', '确认创建', '确认删除', '执行'].includes(command)
}

export function isBotCancellationCommand(value: string) {
  const command = normalizeBotCommand(value).replace(/[。！!？，,、]+$/u, '')
  return ['取消', '取消执行', '不要执行', '放弃'].includes(command)
}

export function isNotificationAcknowledgementCommand(value: string) {
  const command = normalizeBotCommand(value).replace(/[。！!？，,、]+$/u, '')
  return ['确认收到', '已收到', '收到任务', '收到'].includes(command)
}

export function parseProgressCommand(value: string) {
  const match = normalizeBotCommand(value).match(/^(?:进度|完成度|完成比例)\s*[:：]?\s*(\d{1,3})\s*%?$/u)
  if (!match) return undefined
  const progress = Number(match[1])
  return progress >= 0 && progress <= 100 ? progress : undefined
}

export type L3TaskQuery = { kind: 'my-tasks' } | { kind: 'task' | 'deliverables'; wbs: string }

/** L3 固定查询指令，不进入自然语言 Agent。 */
export function parseL3TaskQuery(value: string): L3TaskQuery | undefined {
  const command = normalizeBotCommand(value).replace(/[。！!？，,、]+$/u, '')
  if (/^(?:我的任务|我有哪些任务|任务列表|我的进度)$/u.test(command)) return { kind: 'my-tasks' }
  const wbs = extractTaskWbs(command)
  if (!wbs) return undefined
  if (/交付物|附件|文件|提交记录/u.test(command)) return { kind: 'deliverables', wbs }
  if (command === wbs || /查看|查询|详情|进度|状态|任务/u.test(command)) return { kind: 'task', wbs }
  return undefined
}

export function requestsTaskCompletion(value: string) {
  const command = normalizeBotCommand(value)
  // 文档 §4：`1.1，并提交完成` / `1.1，并完成任务` / `1.1，申请完成` 均视为发起完成申请。
  return /(?:并|同时|顺便)?\s*(?:将|把)?\s*(?:这个|该|当前|我的|\d+(?:\.\d+)+)?\s*任务?\s*(?:标记为|设置为|改为|确认)?\s*(?:已)?完成|(?:已完成|完成任务)|(?:并|，|,)?\s*(?:提交完成|申请完成|发起完成审批|申请完成任务)/u.test(command)
}

export function resolveAttachmentAwareIntent(value: string, attachment: AgentAttachment | undefined, fallbackIntent: string) {
  if (!attachment) return fallbackIntent
  const command = normalizeBotCommand(value)
  return /\b\d+(?:\.\d+)+\b/u.test(command) || /(?:交付物|附件|文件|文档)/u.test(command)
    ? 'deliverable-submit'
    : fallbackIntent
}

export function extractTaskWbs(value: string) {
  return normalizeBotCommand(value).match(/\b\d+(?:\.\d+)+\b/u)?.[0]
}

export function hasTaskReference(value: string) {
  return Boolean(extractTaskWbs(value))
}

export function createPendingAttachmentStore(ttlMs: number) {
  const items = new Map<string, { attachment: AgentAttachment; expiresAt: number }>()
  const valid = (key: string, now: number) => {
    const item = items.get(key)
    if (item && item.expiresAt <= now) {
      items.delete(key)
      return undefined
    }
    return item
  }
  return {
    remember(key: string, attachment: AgentAttachment, now = Date.now()) {
      items.set(key, { attachment, expiresAt: now + ttlMs })
    },
    peek(key: string, now = Date.now()) {
      return valid(key, now)?.attachment
    },
    take(key: string, now = Date.now()) {
      const item = valid(key, now)
      if (!item) return undefined
      items.delete(key)
      return item.attachment
    },
    forget(key: string) {
      items.delete(key)
    },
    prune(now = Date.now()) {
      for (const key of items.keys()) valid(key, now)
    },
  }
}

function contentObject(value: RobotMessagePayload): RobotContent {
  if (value.content && typeof value.content === 'object') return value.content
  if (typeof value.content === 'string') {
    try {
      const parsed = JSON.parse(value.content) as unknown
      if (parsed && typeof parsed === 'object') return parsed as RobotContent
    } catch {
      // Some message types contain plain text instead of JSON content.
    }
  }
  return {}
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed)
  }
  return undefined
}

function parseCaption(content: RobotContent) {
  const direct = firstString(content.text, content.message, content.caption, content.title)
  if (direct) return direct
  const items = Array.isArray(content.richText) ? content.richText : []
  return items
    .map((item) => item && typeof item === 'object' ? firstString((item as RobotContent).text, (item as RobotContent).content) : undefined)
    .filter((item): item is string => Boolean(item))
    .join(' ')
    .trim() || undefined
}

function parseAttachment(value: RobotMessagePayload): AgentAttachment | undefined {
  if (value.attachment?.name) return { ...value.attachment, externalProvider: value.attachment.externalProvider ?? 'DINGTALK' }
  const content = contentObject(value)
  const file = value.file ?? value.picture ?? value.richText ?? {}
  const richItems = Array.isArray(content.richText) ? content.richText : []
  const richFile = richItems.find((item): item is RobotContent => Boolean(item && typeof item === 'object' && (item as RobotContent).downloadCode)) ?? {}
  const name = firstString(file.fileName, file.name, content.fileName, content.name, richFile.fileName, richFile.name)
  const downloadCode = firstString(file.downloadCode, file.pictureDownloadCode, content.downloadCode, content.pictureDownloadCode, richFile.downloadCode, richFile.pictureDownloadCode)
  const url = firstString(file.downloadUrl, file.url, content.downloadUrl, content.url, richFile.downloadUrl, richFile.url)
  // Stream callbacks usually expose a short-lived downloadCode rather than a
  // public URL. Keep it as a stable DingTalk resource reference so a later
  // object-storage adapter can fetch the original binary without losing it.
  const resourceUrl = url ?? (downloadCode && value.robotCode ? `dingtalk://download/${value.robotCode}:${downloadCode}` : undefined)
  if (!name && !resourceUrl) return undefined
  const mimeType = firstString(file.mimeType, file.contentType, content.mimeType, content.contentType, richFile.mimeType)
  const sizeBytes = firstNumber(file.fileSize, file.sizeBytes, content.fileSize, content.sizeBytes, richFile.fileSize)
  const kind = value.msgtype === 'picture' || value.msgtype === 'image' ? 'image' as const : 'file' as const
  return {
    name: name ?? `钉钉附件${downloadCode ? `-${downloadCode.slice(0, 8)}` : ''}`,
    kind,
    url: resourceUrl,
    mimeType,
    sizeBytes,
    externalProvider: 'DINGTALK',
    externalId: downloadCode,
    robotCode: firstString(file.robotCode, content.robotCode, richFile.robotCode, value.robotCode),
  }
}

export function parseRobotMessage(data: string): RobotMessagePayload | null {
  try {
    const value = JSON.parse(data) as Partial<RobotMessagePayload>
    if (!value || typeof value !== 'object') return null
    const message = value as RobotMessagePayload
    const content = contentObject(message)
    const caption = typeof message.text?.content === 'string' ? message.text.content : parseCaption(content)
    const attachment = parseAttachment(message)
    // Keep rejecting incomplete media payloads (for example an image with only
    // a mediaId), while accepting real file/picture callbacks that include a
    // filename or a download code.
    if (message.msgtype !== 'text' && !attachment) return null
    if (!caption && !attachment) return null
    const normalized = caption && !message.text ? { ...message, text: { content: caption } } : message
    return attachment ? { ...normalized, attachment } : normalized
  } catch {
    return null
  }
}
