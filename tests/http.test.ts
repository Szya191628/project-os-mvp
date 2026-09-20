import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRequestHeaders } from '../src/http.ts'

test('无请求体的 DELETE 不发送 JSON Content-Type', () => {
  const headers = buildRequestHeaders({ method: 'DELETE' }, 'member-1')

  assert.equal(headers.has('content-type'), false)
  assert.equal(headers.get('x-member-id'), 'member-1')
})

test('JSON 字符串请求体自动发送 Content-Type', () => {
  const headers = buildRequestHeaders({ method: 'POST', body: '{}' })

  assert.equal(headers.get('content-type'), 'application/json')
})

test('调用方显式请求头优先于默认值', () => {
  const headers = buildRequestHeaders({ method: 'POST', body: '{}', headers: { 'content-type': 'application/merge-patch+json', 'x-member-id': 'member-2' } }, 'member-1')

  assert.equal(headers.get('content-type'), 'application/merge-patch+json')
  assert.equal(headers.get('x-member-id'), 'member-2')
})
