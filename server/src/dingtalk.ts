import { config } from './config.js'
import { fetchDingTalkApi } from './dingtalkUsage.js'
import { requireDingTalkIntegration } from './dingtalkPolicy.js'

type JsonRecord = Record<string, unknown>

export class DingTalkApiError extends Error {
  constructor(public readonly apiCode: string, public readonly subCode: string | undefined, public readonly providerMessage: string | undefined) {
    super(`dingtalk_api_error_${apiCode}`)
    this.name = 'DingTalkApiError'
  }
}

export type DingTalkIdentity = {
  corpId: string
  userId?: string
  unionId?: string
  openId?: string
  name?: string
  email?: string
  avatarUrl?: string
  managerUserId?: string
  departmentIds?: string[]
  profileSnapshot: JsonRecord
}

export type DingTalkDirectoryUser = {
  userId: string
  name: string
  email?: string
  avatarUrl?: string
  unionId?: string
  openId?: string
  managerUserId?: string
  departmentIds: string[]
  profileSnapshot: JsonRecord
}

export type DingTalkDepartment = {
  departmentId: string
  name: string
  parentId?: string
  profileSnapshot: JsonRecord
}

type DingTalkToken = {
  accessToken: string
  expiresIn?: number
  corpId?: string
  unionId?: string
  openId?: string
  userId?: string
}

let appTokenCache: { accessToken: string; expiresAt: number } | null = null

const asRecord = (value: unknown): JsonRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null

const stringValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

const numberValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

const stringLikeValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim()
  }
  return undefined
}

const stringArrayValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const raw = record[key]
    let values: unknown[] = []
    if (Array.isArray(raw)) values = raw
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown
        values = Array.isArray(parsed) ? parsed : raw.split(',')
      } catch {
        values = raw.split(',')
      }
    }
    const result = values.map((value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '').filter(Boolean)
    if (result.length > 0) return [...new Set(result)]
  }
  return []
}

const recordArrayValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value.map(asRecord).filter((item): item is JsonRecord => item !== null)
  }
  return []
}

const booleanValue = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (value === true || value === 'true' || value === 1 || value === '1') return true
  }
  return false
}

const unwrapResponse = (payload: JsonRecord) => {
  const nested = asRecord(payload.result) ?? asRecord(payload.data)
  return nested ?? payload
}

export function buildDingTalkAuthorizationUrl(state: string) {
  if (!config.dingtalk.enabled) throw new Error('dingtalk_not_configured')
  const url = new URL(config.dingtalk.authorizationUrl)
  url.searchParams.set('client_id', config.dingtalk.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', config.dingtalk.redirectUri)
  url.searchParams.set('scope', config.dingtalk.scope)
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  return url.toString()
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetchDingTalkApi({ operation: new URL(url).pathname, url, init: { ...init, signal: AbortSignal.timeout(config.dingtalk.requestTimeoutMs) } })
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new Error(`dingtalk_request_failed_${response.status}`)
  const record = asRecord(payload)
  if (!record) throw new Error('dingtalk_invalid_response')
  const rawErrorCode = record.errcode
  const errorCode = typeof rawErrorCode === 'string' || typeof rawErrorCode === 'number' ? String(rawErrorCode) : undefined
  if (errorCode && errorCode !== '0') {
    const subCode = stringLikeValue(record, 'sub_code', 'subCode')
    const providerMessage = stringValue(record, 'errmsg', 'sub_msg', 'subMsg')
    throw new DingTalkApiError(errorCode, subCode, providerMessage)
  }
  return unwrapResponse(record)
}

const apiIdValue = (value: string) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : value
}

function parseDingTalkDirectoryUser(payload: JsonRecord, fallbackUserId?: string): DingTalkDirectoryUser {
  const userId = stringLikeValue(payload, 'userid', 'userId', 'user_id') ?? fallbackUserId
  if (!userId) throw new Error('dingtalk_user_id_missing')
  return {
    userId,
    name: stringValue(payload, 'name', 'nick', 'nickname') ?? userId,
    email: stringValue(payload, 'org_email', 'orgEmail', 'email'),
    avatarUrl: stringValue(payload, 'avatar', 'avatarUrl', 'avatar_url'),
    unionId: stringLikeValue(payload, 'unionid', 'unionId', 'union_id'),
    openId: stringLikeValue(payload, 'openid', 'openId', 'open_id'),
    managerUserId: stringLikeValue(payload, 'manager_userid', 'managerUserid', 'managerUserId'),
    departmentIds: stringArrayValue(payload, 'dept_id_list', 'deptIdList', 'department_ids', 'departmentIds'),
    profileSnapshot: payload,
  }
}

export async function fetchDingTalkUserById(accessToken: string, userId: string) {
  const url = new URL(config.dingtalk.userDetailsUrl)
  url.searchParams.set('access_token', accessToken)
  const payload = await requestJson(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'zh_CN', userid: userId }),
  })
  return parseDingTalkDirectoryUser(payload, userId)
}

export async function fetchDingTalkDepartmentIds(accessToken: string, departmentId: string) {
  const url = new URL(config.dingtalk.departmentListIdsUrl)
  url.searchParams.set('access_token', accessToken)
  const payload = await requestJson(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dept_id: apiIdValue(departmentId) }),
  })
  return stringArrayValue(payload, 'dept_id_list', 'deptIdList', 'department_id_list', 'departmentIds')
}

export async function fetchDingTalkDepartment(accessToken: string, departmentId: string) {
  const url = new URL(config.dingtalk.departmentDetailsUrl)
  url.searchParams.set('access_token', accessToken)
  const payload = await requestJson(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'zh_CN', dept_id: apiIdValue(departmentId) }),
  })
  const resolvedId = stringLikeValue(payload, 'dept_id', 'deptId', 'id') ?? departmentId
  const name = stringValue(payload, 'name', 'dept_name', 'departmentName')
  if (!name) throw new Error('dingtalk_department_name_missing')
  const parentId = stringLikeValue(payload, 'parent_id', 'parentId')
  return { departmentId: resolvedId, name, parentId: parentId && !['0', '-1'].includes(parentId) ? parentId : undefined, profileSnapshot: payload } satisfies DingTalkDepartment
}

async function fetchDingTalkUsersInDepartment(accessToken: string, departmentId: string) {
  const users: DingTalkDirectoryUser[] = []
  let cursor = 0
  const seenCursors = new Set<number>()
  while (!seenCursors.has(cursor)) {
    seenCursors.add(cursor)
    const url = new URL(config.dingtalk.departmentUsersUrl)
    url.searchParams.set('access_token', accessToken)
    const payload = await requestJson(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cursor, size: 100, order_field: 'modify_desc', contain_access_limit: false, language: 'zh_CN', dept_id: apiIdValue(departmentId) }),
    })
    users.push(...recordArrayValue(payload, 'list', 'user_list', 'users').map((item) => parseDingTalkDirectoryUser(item)))
    if (!booleanValue(payload, 'has_more', 'hasMore')) break
    const nextCursor = Number(payload.next_cursor ?? payload.nextCursor)
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) break
    cursor = nextCursor
  }
  return users
}

async function enrichDingTalkDirectoryUsers(accessToken: string, users: DingTalkDirectoryUser[]) {
  const enrichedUsers: DingTalkDirectoryUser[] = []
  // DingTalk may throttle concurrent contact-detail requests. Keep this
  // sequential so a sync does not silently lose manager relationships.
  const batchSize = 1
  for (let index = 0; index < users.length; index += batchSize) {
    const batch = await Promise.all(users.slice(index, index + batchSize).map(async (user) => {
      try {
        const detail = await fetchDingTalkUserById(accessToken, user.userId)
        return {
          ...user,
          name: detail.name || user.name,
          email: detail.email ?? user.email,
          avatarUrl: detail.avatarUrl ?? user.avatarUrl,
          unionId: detail.unionId ?? user.unionId,
          openId: detail.openId ?? user.openId,
          managerUserId: detail.managerUserId ?? user.managerUserId,
          departmentIds: [...new Set([...user.departmentIds, ...detail.departmentIds])],
          profileSnapshot: { ...user.profileSnapshot, ...detail.profileSnapshot },
        } satisfies DingTalkDirectoryUser
      } catch {
        // Keep the base directory record when a detail is outside the app scope.
        return user
      }
    }))
    enrichedUsers.push(...batch)
  }
  return enrichedUsers
}

export async function fetchDingTalkDirectory(accessToken: string, rootDepartmentIds = [config.dingtalk.rootDepartmentId]) {
  const departmentIds = new Set<string>(rootDepartmentIds)
  const pendingDepartmentIds = [...departmentIds]
  while (pendingDepartmentIds.length > 0) {
    const departmentId = pendingDepartmentIds.shift()!
    const children = await fetchDingTalkDepartmentIds(accessToken, departmentId)
    for (const childId of children) {
      if (departmentIds.has(childId)) continue
      departmentIds.add(childId)
      pendingDepartmentIds.push(childId)
    }
  }

  const departments: DingTalkDepartment[] = []
  const usersById = new Map<string, DingTalkDirectoryUser>()
  for (const departmentId of departmentIds) {
    departments.push(await fetchDingTalkDepartment(accessToken, departmentId))
    for (const user of await fetchDingTalkUsersInDepartment(accessToken, departmentId)) {
      const previous = usersById.get(user.userId)
      usersById.set(user.userId, previous ? {
        ...previous,
        unionId: user.unionId ?? previous.unionId,
        openId: user.openId ?? previous.openId,
        managerUserId: user.managerUserId ?? previous.managerUserId,
        departmentIds: [...new Set([...previous.departmentIds, ...user.departmentIds, departmentId])],
        profileSnapshot: user.profileSnapshot,
      } : { ...user, departmentIds: [...new Set([...user.departmentIds, departmentId])] })
    }
  }
  return { departments, users: await enrichDingTalkDirectoryUsers(accessToken, [...usersById.values()]) }
}

export async function exchangeDingTalkCode(code: string): Promise<DingTalkToken> {
  if (!config.dingtalk.enabled) throw new Error('dingtalk_not_configured')
  const payload = await requestJson(config.dingtalk.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: config.dingtalk.clientId, clientSecret: config.dingtalk.clientSecret, code, grantType: 'authorization_code' }),
  })
  const accessToken = stringValue(payload, 'accessToken', 'access_token')
  if (!accessToken) throw new Error('dingtalk_token_missing')
  return {
    accessToken,
    expiresIn: numberValue(payload, 'expireIn', 'expiresIn', 'expires_in'),
    corpId: stringValue(payload, 'corpId', 'corp_id'),
    unionId: stringValue(payload, 'unionId', 'union_id'),
    openId: stringValue(payload, 'openId', 'open_id'),
    userId: stringValue(payload, 'userId', 'userid', 'user_id'),
  }
}

export async function fetchDingTalkIdentity(token: DingTalkToken): Promise<DingTalkIdentity> {
  const payload = await requestJson(config.dingtalk.userInfoUrl, {
    method: 'GET',
    headers: { 'x-acs-dingtalk-access-token': token.accessToken },
  })
  const corpId = stringValue(payload, 'corpId', 'corp_id') ?? token.corpId ?? config.dingtalk.corpId
  const userId = stringValue(payload, 'userId', 'userid', 'user_id') ?? token.userId
  const unionId = stringValue(payload, 'unionId', 'union_id') ?? token.unionId
  const openId = stringValue(payload, 'openId', 'open_id') ?? token.openId
  if (!corpId || (!userId && !unionId && !openId)) throw new Error('dingtalk_identity_missing')
  return {
    corpId,
    userId,
    unionId,
    openId,
    name: stringValue(payload, 'name', 'nick', 'nickname'),
    email: stringValue(payload, 'email'),
    avatarUrl: stringValue(payload, 'avatarUrl', 'avatar_url', 'avatar'),
    profileSnapshot: payload,
  }
}

/**
 * Resolve the stable employee identity used by Stream robot callbacks.
 *
 * OAuth's `/contact/users/me` response is intentionally app-scoped and may
 * only contain unionId/openId.  Stream callbacks expose senderStaffId, which
 * is the employee userId used by the contact API.  Enriching the callback
 * before member resolution lets both paths converge on the same identity row.
 */
export async function fetchDingTalkIdentityByUserId(accessToken: string, userId: string): Promise<DingTalkIdentity> {
  const payload = await fetchDingTalkUserById(accessToken, userId)
  const unionId = stringValue(payload.profileSnapshot, 'unionid', 'unionId', 'union_id')
  const openId = stringValue(payload.profileSnapshot, 'openid', 'openId', 'open_id')
  if (!unionId && !openId) throw new Error('dingtalk_user_details_missing_identity')
  return {
    corpId: config.dingtalk.corpId,
    userId: payload.userId,
    unionId,
    openId,
    name: payload.name,
    email: payload.email,
    avatarUrl: payload.avatarUrl,
    managerUserId: payload.managerUserId,
    departmentIds: payload.departmentIds,
    profileSnapshot: { source: 'dingtalk-contact-user', userId, ...payload.profileSnapshot },
  }
}

export async function getDingTalkAppAccessToken() {
  await requireDingTalkIntegration(config.dingtalk.organizationId)
  if (appTokenCache && appTokenCache.expiresAt > Date.now()) return appTokenCache.accessToken
  if (!config.dingtalk.corpId || !config.dingtalk.bot.clientId || !config.dingtalk.bot.clientSecret) throw new Error('dingtalk_app_not_configured')
  const payload = await requestJson(config.dingtalk.appAccessTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: config.dingtalk.bot.clientId, appSecret: config.dingtalk.bot.clientSecret }),
  })
  const accessToken = stringValue(payload, 'accessToken', 'access_token')
  if (!accessToken) throw new Error('dingtalk_app_token_missing')
  const expireIn = numberValue(payload, 'expireIn', 'expiresIn', 'expires_in') ?? 7200
  appTokenCache = { accessToken, expiresAt: Date.now() + Math.max(60, expireIn - 60) * 1000 }
  return accessToken
}

export type DingTalkOtoSendResult = {
  processQueryKey: string | undefined
  invalidStaffIds: string[]
  flowControlledStaffIds: string[]
}

export async function sendDingTalkOtoMarkdown(userIdOrIds: string | string[], title: string, text: string, organizationId = config.dingtalk.organizationId): Promise<DingTalkOtoSendResult> {
  await requireDingTalkIntegration(organizationId)
  if (!config.dingtalk.bot.proactiveEnabled) throw new Error('dingtalk_proactive_notifications_disabled')
  const userIds = [...new Set((Array.isArray(userIdOrIds) ? userIdOrIds : [userIdOrIds]).map((userId) => userId.trim()).filter(Boolean))]
  if (userIds.length === 0) throw new Error('dingtalk_recipient_missing')
  const accessToken = await getDingTalkAppAccessToken()
  const payload = await requestJson(config.dingtalk.bot.otoMessageUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    body: JSON.stringify({
      robotCode: config.dingtalk.bot.clientId,
      userIds,
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: title.slice(0, 100), text: text.slice(0, 4000) }),
    }),
  })
  const invalidStaffIds = Array.isArray(payload.invalidStaffIdList) ? payload.invalidStaffIdList.filter((item): item is string => typeof item === 'string') : []
  const flowControlledStaffIds = Array.isArray(payload.flowControlledStaffIdList) ? payload.flowControlledStaffIdList.filter((item): item is string => typeof item === 'string') : []
  return {
    processQueryKey: stringValue(payload, 'processQueryKey', 'messageId'),
    invalidStaffIds,
    flowControlledStaffIds,
  }
}
