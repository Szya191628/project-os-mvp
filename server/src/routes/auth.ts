import type { FastifyInstance } from 'fastify'
import { randomInt } from 'node:crypto'
import { createOpaqueToken, createServiceSession, createSession, findOrCreateDingTalkMember, hashOpaqueToken, requireGlobalPermission, revokeSession } from '../auth.js'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { buildDingTalkAuthorizationUrl, exchangeDingTalkCode, fetchDingTalkIdentity } from '../dingtalk.js'
import { WechatApiError, clearWechatBindFailures, code2Session, createWechatBindToken, isWechatBindThrottled, recordWechatBindFailure, verifyWechatBindToken } from '../wechat.js'
import type { WechatSession } from '../wechat.js'

type DingTalkCallbackQuery = { code?: string; state?: string; error?: string }
type MemberParams = { organizationId: string; memberId: string }
type LinkIdentityBody = { corpId?: string; userId?: string; unionId?: string; openId?: string }
type WechatLoginBody = { code?: string }
type WechatBindBody = { token?: string; bindCode?: string }

const loginRedirect = (error?: string) => {
  const url = new URL('/', config.frontendOrigin)
  if (error) url.searchParams.set('auth_error', error)
  return url.toString()
}

const clean = (value: string | undefined) => value?.trim() || undefined

async function consumeOAuthState(state: string) {
  const stateHash = hashOpaqueToken(state)
  const now = new Date()
  const consumed = await prisma.$transaction(async (tx) => {
    const result = await tx.oAuthState.updateMany({ where: { stateHash, provider: 'DINGTALK', consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } })
    if (result.count === 0) return null
    return tx.oAuthState.findUnique({ where: { stateHash }, select: { redirectUri: true } })
  })
  return consumed
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get('/api/v1/auth/dingtalk/start', async (_request, reply) => {
    if (!config.dingtalk.enabled) return reply.redirect(loginRedirect('dingtalk_not_configured'))
    const state = createOpaqueToken()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await prisma.oAuthState.create({ data: { provider: 'DINGTALK', stateHash: hashOpaqueToken(state), redirectUri: config.dingtalk.redirectUri, expiresAt } })
    try {
      return reply.redirect(buildDingTalkAuthorizationUrl(state))
    } catch {
      return reply.redirect(loginRedirect('dingtalk_not_configured'))
    }
  })

  app.get<{ Querystring: DingTalkCallbackQuery }>('/api/v1/auth/dingtalk/callback', async (request, reply) => {
    if (request.query.error) return reply.redirect(loginRedirect('dingtalk_authorization_denied'))
    const code = clean(request.query.code)
    const state = clean(request.query.state)
    if (!code || !state) return reply.redirect(loginRedirect('dingtalk_invalid_callback'))
    const oauthState = await consumeOAuthState(state)
    if (!oauthState || oauthState.redirectUri !== config.dingtalk.redirectUri) return reply.redirect(loginRedirect('dingtalk_invalid_state'))
    try {
      const token = await exchangeDingTalkCode(code)
      const identity = await fetchDingTalkIdentity(token)
      if (identity.corpId !== config.dingtalk.corpId) return reply.redirect(loginRedirect('dingtalk_corp_id_mismatch'))
      const member = await findOrCreateDingTalkMember(identity)
      if (!member) return reply.redirect(loginRedirect('member_not_mapped'))
      const session = await createSession(member.id, request)
      reply.setCookie(config.sessionCookieName, session.token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.sessionTtlSeconds })
      return reply.redirect(loginRedirect())
    } catch {
      return reply.redirect(loginRedirect('dingtalk_login_failed'))
    }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await revokeSession(request.cookies?.[config.sessionCookieName])
    reply.clearCookie(config.sessionCookieName, { path: '/' })
    return { data: { loggedOut: true } }
  })

  app.post<{ Params: MemberParams; Body: LinkIdentityBody }>('/api/v1/organizations/:organizationId/members/:memberId/external-identities/dingtalk', async (request, reply) => {
    const actor = await requireGlobalPermission(request, reply, 'role.system.manage')
    if (!actor) return
    if (request.params.organizationId !== actor.organizationId) return reply.code(403).send({ error: 'forbidden' })
    const corpId = clean(request.body?.corpId) ?? clean(config.dingtalk.corpId)
    const userId = clean(request.body?.userId)
    if (!corpId || !userId) return reply.code(400).send({ error: 'dingtalk_corp_id_and_user_id_required' })
    if (config.dingtalk.corpId && corpId !== config.dingtalk.corpId) return reply.code(400).send({ error: 'dingtalk_corp_id_mismatch' })
    const member = await prisma.member.findFirst({ where: { id: request.params.memberId, organizationId: actor.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return reply.code(404).send({ error: 'member_not_found' })
    const existing = await prisma.externalIdentity.findFirst({ where: { provider: 'DINGTALK', corpId, userId }, select: { id: true, memberId: true, corpId: true, userId: true, unionId: true, openId: true } })
    if (existing && existing.memberId !== member.id) return reply.code(409).send({ error: 'dingtalk_identity_already_mapped' })
    const identity = existing
      ? await prisma.externalIdentity.update({ where: { id: existing.id }, data: { unionId: clean(request.body?.unionId), openId: clean(request.body?.openId), lastSyncedAt: new Date() }, select: { id: true, memberId: true, provider: true, corpId: true, userId: true, unionId: true, openId: true } })
      : await prisma.externalIdentity.create({ data: { memberId: member.id, provider: 'DINGTALK', corpId, userId, unionId: clean(request.body?.unionId), openId: clean(request.body?.openId), lastSyncedAt: new Date() }, select: { id: true, memberId: true, provider: true, corpId: true, userId: true, unionId: true, openId: true } })
    await prisma.auditLog.create({ data: { organizationId: actor.organizationId, actorMemberId: actor.memberId, action: existing ? 'DINGTALK_IDENTITY_UPDATED' : 'DINGTALK_IDENTITY_LINKED', resourceType: 'EXTERNAL_IDENTITY', resourceId: identity.id, afterJson: identity, requestId: request.id } })
    return reply.code(existing ? 200 : 201).send({ data: identity })
  })

  // ---- 微信小程序认证（方案 §5）----
  // 静默登录：wx.login() code → code2session → openid → 命中已绑定身份则发会话令牌；
  // 未命中返回 bindRequired，并附带短时绑定令牌（承载本次 openid）供绑定使用。
  app.post<{ Body: WechatLoginBody }>('/api/v1/auth/wechat/login', async (request, reply) => {
    if (!config.wechat.enabled) return reply.code(503).send({ error: 'wechat_not_configured' })
    const code = clean(request.body?.code)
    if (!code) return reply.code(400).send({ error: 'wechat_code_required' })

    let session: WechatSession
    try {
      session = await code2Session(code)
    } catch (error) {
      // 仅记录归类后的错误信息，绝不回显 code / AppSecret。
      request.log.warn({ err: error instanceof Error ? error.message : 'wechat_code2session_failed' }, '微信 code2session 失败')
      if (error instanceof WechatApiError && error.apiCode === 40029) return reply.code(401).send({ error: 'wechat_code_invalid' })
      return reply.code(502).send({ error: 'wechat_code2session_failed' })
    }

    const identity = await prisma.externalIdentity.findFirst({
      where: { provider: 'WECHAT', corpId: config.wechat.appId, openId: session.openId },
      orderBy: { createdAt: 'asc' },
      select: { memberId: true },
    })
    if (!identity) {
      const token = createWechatBindToken(session.openId)
      const expiresAt = new Date(Date.now() + config.wechat.bindTokenTtlMs)
      return { data: { bindRequired: true, token, expiresAt } }
    }

    const member = await prisma.member.findFirst({ where: { id: identity.memberId, organizationId: config.wechat.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return reply.code(403).send({ error: 'member_not_mapped' })
    const created = await createServiceSession(member.id, 'wechat-miniprogram')
    return { data: { token: created.token, expiresAt: created.expiresAt } }
  })

  // 绑定：用 Web 端签发的 6 位绑定码把本次微信 openid 写入对应成员的身份表。
  app.post<{ Body: WechatBindBody }>('/api/v1/auth/wechat/bind', async (request, reply) => {
    if (!config.wechat.enabled) return reply.code(503).send({ error: 'wechat_not_configured' })
    const bindToken = clean(request.body?.token)
    const bindCode = clean(request.body?.bindCode)
    if (!bindToken || !bindCode) return reply.code(400).send({ error: 'wechat_bind_params_required' })

    const claimed = verifyWechatBindToken(bindToken)
    if (!claimed) return reply.code(401).send({ error: 'wechat_bind_token_invalid' })
    const { openId } = claimed

    if (isWechatBindThrottled(openId)) return reply.code(429).send({ error: 'wechat_bind_too_many_attempts' })
    if (!/^\d{6}$/u.test(bindCode)) {
      recordWechatBindFailure(openId)
      return reply.code(400).send({ error: 'wechat_bind_code_invalid' })
    }

    const now = new Date()
    const codeHash = hashOpaqueToken(bindCode)
    const bindingCode = await prisma.wechatBindingCode.findFirst({
      where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
      select: { id: true, memberId: true },
    })
    // 不存在 / 已过期 / 已消费统一按无效处理，避免暴露绑定码状态。
    if (!bindingCode) {
      recordWechatBindFailure(openId)
      return reply.code(400).send({ error: 'wechat_bind_code_invalid' })
    }

    const existingIdentity = await prisma.externalIdentity.findFirst({
      where: { provider: 'WECHAT', corpId: config.wechat.appId, openId },
      select: { id: true, memberId: true },
    })
    // 该 openid 已绑定到其他成员：拒绝，防止把已有身份挪到别人名下。
    if (existingIdentity && existingIdentity.memberId !== bindingCode.memberId) return reply.code(409).send({ error: 'wechat_identity_already_mapped' })
    const member = await prisma.member.findFirst({ where: { id: bindingCode.memberId, organizationId: config.wechat.organizationId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return reply.code(404).send({ error: 'member_not_found' })

    try {
      await prisma.$transaction(async (tx) => {
        // 原子消费绑定码：并发下只有一个请求能成功，避免一码多用。
        const consumed = await tx.wechatBindingCode.updateMany({ where: { id: bindingCode.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } })
        if (consumed.count === 0) throw new Error('wechat_bind_code_consumed')
        if (existingIdentity) {
          await tx.externalIdentity.update({ where: { id: existingIdentity.id }, data: { memberId: member.id, corpId: config.wechat.appId, openId, lastSyncedAt: now } })
        } else {
          await tx.externalIdentity.create({ data: { memberId: member.id, provider: 'WECHAT', corpId: config.wechat.appId, openId, profileSnapshot: { source: 'wechat-miniprogram', appId: config.wechat.appId }, lastSyncedAt: now } })
        }
      })
    } catch (error) {
      // 并发落败（码已被抢先消费）与单请求路径统一为 400 wechat_bind_code_invalid，
      // 不暴露「码存在且已被消费」的状态；只有真正的身份冲突才返回 409。
      if (error instanceof Error && error.message === 'wechat_bind_code_consumed') {
        recordWechatBindFailure(openId)
        return reply.code(400).send({ error: 'wechat_bind_code_invalid' })
      }
      throw error
    }

    clearWechatBindFailures(openId)
    await prisma.auditLog.create({ data: { organizationId: config.wechat.organizationId, actorMemberId: member.id, action: existingIdentity ? 'WECHAT_IDENTITY_REBOUND' : 'WECHAT_IDENTITY_LINKED', resourceType: 'EXTERNAL_IDENTITY', resourceId: member.id, afterJson: { provider: 'WECHAT', appId: config.wechat.appId, openId, memberId: member.id } } })
    const created = await createServiceSession(member.id, 'wechat-miniprogram')
    return { data: { token: created.token, expiresAt: created.expiresAt } }
  })

  // 绑定码签发：需已登录（命中 auth 钩子，未登录会被 401 拦截）。
  // 6 位数字，默认 10 分钟有效；库内只存哈希，返回明文码给当前成员在小程序侧输入。
  app.post('/api/v1/auth/wechat/bindcode', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + config.wechat.bindCodeTtlMs)

    let generated: { code: string; codeHash: string } | null = null
    for (let attempt = 0; attempt < 5 && !generated; attempt += 1) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const candidateHash = hashOpaqueToken(candidate)
      const clash = await prisma.wechatBindingCode.findUnique({ where: { codeHash: candidateHash }, select: { id: true } })
      if (!clash) generated = { code: candidate, codeHash: candidateHash }
    }
    if (!generated) return reply.code(503).send({ error: 'wechat_bind_code_generation_failed' })
    const issued = generated

    await prisma.$transaction(async (tx) => {
      // 同一成员只保留最新一个有效绑定码，旧码立即作废，减少可被猜中的活跃码数量。
      await tx.wechatBindingCode.updateMany({ where: { memberId: actor.memberId, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } })
      await tx.wechatBindingCode.create({ data: { memberId: actor.memberId, codeHash: issued.codeHash, expiresAt } })
    })
    await prisma.auditLog.create({ data: { organizationId: actor.organizationId, actorMemberId: actor.memberId, action: 'WECHAT_BIND_CODE_ISSUED', resourceType: 'MEMBER', resourceId: actor.memberId, afterJson: { expiresAt: expiresAt.toISOString() }, requestId: request.id } })
    return { data: { code: issued.code, expiresAt } }
  })
}
