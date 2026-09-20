/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma 测试替身只实现被选中的字段；不连接真实数据库。 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { config } from '../server/src/config.ts'
import { prisma } from '../server/src/db.ts'
import { registerAuthHooks } from '../server/src/auth.ts'
import { registerAuthRoutes } from '../server/src/routes/auth.ts'
import { hashOpaqueToken } from '../server/src/session.ts'

// 让 wechat 配置段在测试中处于“已配置”状态（enabled 读取 this.appId/appSecret/organizationId）。
config.wechat.appId = 'wx-test-app'
config.wechat.appSecret = 'test-secret'
config.wechat.organizationId = 'org-1'

const future = () => new Date(Date.now() + 60_000)
const past = () => new Date(Date.now() - 60_000)

/** 用假的 code2session 响应替换全局 fetch；返回恢复函数。 */
function stubFetch(handler: (url: string) => unknown) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    return new Response(JSON.stringify(handler(url)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
  return () => { globalThis.fetch = original }
}

/** 用内存替身实现被微信认证路径使用的 Prisma 方法。 */
function createHarness() {
  const restorers: (() => void)[] = []
  const stub = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key)
    Reflect.set(target, key, replacement)
    restorers.push(() => { Reflect.set(target, key, original) })
  }
  const state: any = {
    members: [
      { id: 'member-1', organizationId: 'org-1', status: 'ACTIVE', memberRoles: [{ role: { code: 'L1' } }] },
      { id: 'member-2', organizationId: 'org-1', status: 'ACTIVE', memberRoles: [{ role: { code: 'L3' } }] },
    ],
    identities: [] as any[],
    sessions: [] as any[],
    bindingCodes: [] as any[],
    auditLogs: [] as any[],
    forceConsumeMiss: false,
  }

  stub(prisma.externalIdentity, 'findFirst', async ({ where }: any) => state.identities.find((it) => it.provider === 'WECHAT' && it.openId === where.openId) ?? null)
  stub(prisma.externalIdentity, 'create', async ({ data }: any) => { const row = { id: `ext-${state.identities.length + 1}`, ...data }; state.identities.push(row); return row })
  stub(prisma.externalIdentity, 'update', async ({ where, data }: any) => { const row = state.identities.find((it) => it.id === where.id); Object.assign(row, data); return row })
  stub(prisma.member, 'findFirst', async ({ where }: any) => state.members.find((member: any) => member.id === where.id && member.status === 'ACTIVE') ?? null)
  stub(prisma.session, 'create', async ({ data }: any) => { const row = { id: `sess-${state.sessions.length + 1}`, revokedAt: null, ...data }; state.sessions.push(row); return row })
  stub(prisma.session, 'findFirst', async ({ where }: any) => {
    const row = state.sessions.find((s: any) => s.tokenHash === where.tokenHash && s.revokedAt === null && s.expiresAt > new Date())
    if (!row) return null
    const member = state.members.find((m: any) => m.id === row.memberId && m.status === 'ACTIVE')
    return member ? { member: { id: member.id, organizationId: member.organizationId, memberRoles: member.memberRoles } } : null
  })
  stub(prisma.wechatBindingCode, 'findFirst', async ({ where }: any) => state.bindingCodes.find((c: any) => c.codeHash === where.codeHash && c.consumedAt === null && c.expiresAt > new Date()) ?? null)
  stub(prisma.wechatBindingCode, 'findUnique', async ({ where }: any) => state.bindingCodes.find((c: any) => c.codeHash === where.codeHash) ?? null)
  stub(prisma.wechatBindingCode, 'updateMany', async ({ where, data }: any) => {
    if (state.forceConsumeMiss) return { count: 0 }
    const matches = state.bindingCodes.filter((c: any) => {
      if (where.id && c.id !== where.id) return false
      if (where.memberId && c.memberId !== where.memberId) return false
      if (where.consumedAt === null && c.consumedAt !== null) return false
      if (where.expiresAt?.gt && !(c.expiresAt > where.expiresAt.gt)) return false
      return true
    })
    matches.forEach((c: any) => Object.assign(c, data))
    return { count: matches.length }
  })
  stub(prisma.wechatBindingCode, 'create', async ({ data }: any) => { const row = { id: `bc-${state.bindingCodes.length + 1}`, consumedAt: null, ...data }; state.bindingCodes.push(row); return row })
  stub(prisma.auditLog, 'create', async ({ data }: any) => { state.auditLogs.push(data); return data })
  stub(prisma, '$transaction', async (callback: any) => callback(prisma))

  return { state, restorers }
}

async function buildHarnessApp() {
  const app = Fastify()
  await app.register(cookie)
  await registerAuthHooks(app)
  await registerAuthRoutes(app)
  app.get('/api/v1/ping', async (request) => ({ data: { memberId: request.actor?.memberId ?? null } }))
  return app
}

after(async () => { await prisma.$disconnect() })

test('已绑定成员静默登录发 token；Bearer 可访问受保护接口且 cookie 优先', async () => {
  const { state, restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-1', session_key: 'sk-1' }))
  try {
    state.identities.push({ id: 'ext-1', memberId: 'member-1', provider: 'WECHAT', corpId: 'wx-test-app', openId: 'openid-1' })

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-1' } })
    assert.equal(login.statusCode, 200, login.body)
    const data = login.json().data
    assert.equal(data.bindRequired, undefined)
    assert.ok(data.token, '已绑定成员应拿到会话 token')
    assert.ok(data.expiresAt)

    const bearer = await app.inject({ method: 'GET', url: '/api/v1/ping', headers: { authorization: `Bearer ${data.token}` } })
    assert.equal(bearer.statusCode, 200, bearer.body)
    assert.equal(bearer.json().data.memberId, 'member-1')

    // 优先级：cookie → Bearer。两者都带且指向不同成员时，应取 cookie。
    state.sessions.push({ id: 'sess-cookie', tokenHash: hashOpaqueToken('cookie-token'), memberId: 'member-1', revokedAt: null, expiresAt: future() })
    state.sessions.push({ id: 'sess-bearer', tokenHash: hashOpaqueToken('bearer-token'), memberId: 'member-2', revokedAt: null, expiresAt: future() })
    const priority = await app.inject({ method: 'GET', url: '/api/v1/ping', headers: { authorization: 'Bearer bearer-token', cookie: 'project_os_session=cookie-token' } })
    assert.equal(priority.statusCode, 200, priority.body)
    assert.equal(priority.json().data.memberId, 'member-1', 'cookie 应优先于 Bearer')

    // bindcode 不在白名单：未登录 401；已登录可签发 6 位码。
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bindcode' })).statusCode, 401)
    const issued = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bindcode', headers: { authorization: `Bearer ${data.token}` } })
    assert.equal(issued.statusCode, 200, issued.body)
    assert.match(issued.json().data.code, /^\d{6}$/u)
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('未绑定成员登录返回 bindRequired 与短时绑定令牌', async () => {
  const { restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-2' }))
  try {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-2' } })
    assert.equal(login.statusCode, 200, login.body)
    const data = login.json().data
    assert.equal(data.bindRequired, true)
    assert.ok(data.token, '绑定令牌用于把本次 openid 传给绑定接口')
    assert.ok(data.expiresAt)
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('绑定码可将 openid 绑定到成员并返回新会话', async () => {
  const { state, restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-2' }))
  try {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-2' } })
    const bindToken = login.json().data.token
    state.bindingCodes.push({ id: 'bc-1', memberId: 'member-1', codeHash: hashOpaqueToken('123456'), expiresAt: future(), consumedAt: null })

    const bound = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '123456' } })
    assert.equal(bound.statusCode, 200, bound.body)
    assert.ok(bound.json().data.token)

    assert.equal(state.identities.length, 1)
    assert.equal(state.identities[0].openId, 'openid-2')
    assert.equal(state.identities[0].memberId, 'member-1')
    assert.equal(state.identities[0].corpId, 'wx-test-app')
    assert.notEqual(state.bindingCodes[0].consumedAt, null, '绑定码应被标记为已消费')
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('绑定码过期与重复使用被拒绝', async () => {
  const { state, restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-3' }))
  try {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-3' } })
    const bindToken = login.json().data.token

    // 过期码：findFirst（expiresAt > now）不命中 → 统一按无效处理。
    state.bindingCodes.push({ id: 'bc-expired', memberId: 'member-1', codeHash: hashOpaqueToken('111111'), expiresAt: past(), consumedAt: null })
    const expired = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '111111' } })
    assert.equal(expired.statusCode, 400, expired.body)
    assert.equal(expired.json().error, 'wechat_bind_code_invalid')

    // 重复使用：命中后原子消费返回 0 → 与单请求路径统一为 400，不暴露「已消费」状态。
    state.bindingCodes.push({ id: 'bc-live', memberId: 'member-1', codeHash: hashOpaqueToken('222222'), expiresAt: future(), consumedAt: null })
    state.forceConsumeMiss = true
    const reused = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '222222' } })
    assert.equal(reused.statusCode, 400, reused.body)
    assert.equal(reused.json().error, 'wechat_bind_code_invalid')
    assert.equal(state.identities.length, 0, '消费失败时不得写入身份')
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('并发抢同一绑定码时落败方返回 400，不泄露已消费状态', async () => {
  const { state, restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-race' }))
  try {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-race' } })
    const bindToken = login.json().data.token
    state.bindingCodes.push({ id: 'bc-race', memberId: 'member-1', codeHash: hashOpaqueToken('654321'), expiresAt: future(), consumedAt: null })

    // 两个请求并发使用同一绑定码：恰好一个成功，另一个必须返回 400（而非 409）。
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '654321' } }),
      app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '654321' } }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b)
    assert.deepEqual(statuses, [200, 400], `${first.statusCode}:${first.body} | ${second.statusCode}:${second.body}`)
    const loser = first.statusCode === 200 ? second : first
    assert.equal(loser.json().error, 'wechat_bind_code_invalid')
    assert.equal(state.identities.length, 1, '同一绑定码只能成功绑定一次')
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('绑定失败次数超过阈值后限流（防暴力猜测）', async () => {
  const { state, restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-throttle' }))
  const originalMax = config.wechat.bindCodeMaxAttempts
  try {
    config.wechat.bindCodeMaxAttempts = 2
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-t' } })
    const bindToken = login.json().data.token

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const miss = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '000000' } })
      assert.equal(miss.statusCode, 400, miss.body)
      assert.equal(miss.json().error, 'wechat_bind_code_invalid')
    }
    const limited = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/bind', payload: { token: bindToken, bindCode: '000000' } })
    assert.equal(limited.statusCode, 429, limited.body)
    assert.equal(limited.json().error, 'wechat_bind_too_many_attempts')
    assert.equal(state.bindingCodes.length, 0)
  } finally {
    config.wechat.bindCodeMaxAttempts = originalMax
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('session 撤销后 Bearer 立即失效', async () => {
  const { state, restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ openid: 'openid-1' }))
  try {
    state.identities.push({ id: 'ext-1', memberId: 'member-1', provider: 'WECHAT', corpId: 'wx-test-app', openId: 'openid-1' })
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'code-1' } })
    const token = login.json().data.token

    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ping', headers: { authorization: `Bearer ${token}` } })).statusCode, 200)

    const row = state.sessions.find((s: any) => s.tokenHash === hashOpaqueToken(token))
    row.revokedAt = new Date()
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ping', headers: { authorization: `Bearer ${token}` } })).statusCode, 401)
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})

test('code2session 业务错误映射为 wechat_code_invalid', async () => {
  const { restorers } = createHarness()
  const app = await buildHarnessApp()
  const restoreFetch = stubFetch(() => ({ errcode: 40029, errmsg: 'invalid code' }))
  try {
    const failed = await app.inject({ method: 'POST', url: '/api/v1/auth/wechat/login', payload: { code: 'expired' } })
    assert.equal(failed.statusCode, 401, failed.body)
    assert.equal(failed.json().error, 'wechat_code_invalid')
    assert.equal(failed.body.includes('invalid code'), false, '不得回显微信错误原文')
  } finally {
    await app.close()
    restoreFetch()
    restorers.reverse().forEach((restore) => restore())
  }
})
