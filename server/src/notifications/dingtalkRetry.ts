export function isRetryableDingTalkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/^dingtalk_request_failed_(429|5\d\d)$/u.test(message)) return true
  if (error instanceof TypeError) return true
  const name = error instanceof Error ? error.name : ''
  return name === 'AbortError' || name === 'TimeoutError' || /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/iu.test(message)
}
