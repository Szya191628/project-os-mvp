export function buildRequestHeaders(init?: RequestInit, devMemberId?: string) {
  const headers = new Headers(init?.headers)
  if (typeof init?.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (devMemberId && !headers.has('x-member-id')) headers.set('x-member-id', devMemberId)
  return headers
}
