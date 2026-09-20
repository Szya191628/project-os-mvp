import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOpaqueToken, hashOpaqueToken } from '../server/src/session.ts'

test('会话令牌使用不可逆哈希保存', () => {
  const token = createOpaqueToken()
  assert.ok(token.length >= 40)
  assert.notEqual(hashOpaqueToken(token), token)
  assert.equal(hashOpaqueToken(token), hashOpaqueToken(token))
  assert.notEqual(hashOpaqueToken(token), hashOpaqueToken(`${token}-other`))
})
