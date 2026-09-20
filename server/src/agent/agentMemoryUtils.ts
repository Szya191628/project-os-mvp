const embeddingDimensions = 96

export function isEphemeralChitchat(message: string) {
  const normalized = message.trim().toLowerCase()
  if (!normalized || normalized.length > 48) return false
  return /^(?:hi|hello|hey|你好|您好|嗨|哈喽|嗯|哦|好的|好吧|收到|明白|谢谢|感谢|ok|okay|行|可以)[!！。,.，?？\s]*$/i.test(normalized)
}

function tokenize(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, '')
  const tokens: string[] = normalized.match(/[\p{Script=Han}]|[a-z0-9_]+/gu) ?? []
  // Adjacent Chinese character pairs give local semantic search useful
  // overlap for short preferences and task names without an external model.
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const pair = normalized.slice(index, index + 2)
    if (/^[\p{Script=Han}]{2}$/u.test(pair)) tokens.push(pair)
  }
  return tokens
}

function hashToken(token: string) {
  let hash = 2166136261
  for (const char of token) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function embedText(text: string): number[] {
  const vector = Array.from({ length: embeddingDimensions }, () => 0)
  for (const token of tokenize(text)) {
    const hash = hashToken(token)
    vector[hash % embeddingDimensions] += 1
    // A second signed bucket reduces collisions for unrelated words.
    vector[(hash >>> 8) % embeddingDimensions] += (hash & 1) === 0 ? 0.5 : -0.5
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return magnitude > 0 ? vector.map((value) => Number((value / magnitude).toFixed(6))) : vector
}
