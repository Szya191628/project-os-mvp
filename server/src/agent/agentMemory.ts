import type { Prisma } from '@prisma/client'
import type { AuthContext } from '../auth.js'
import { prisma } from '../db.js'
import { embedText, isEphemeralChitchat } from './agentMemoryUtils.js'
import type { AgentRequest, AgentRun } from './types.js'

export { embedText, isEphemeralChitchat } from './agentMemoryUtils.js'

export const AGENT_SHORT_TERM_ROUNDS = 5
const shortTermMessageLimit = AGENT_SHORT_TERM_ROUNDS * 2
const ephemeralTtlMs = 2 * 60 * 60 * 1000
const maxSummaryLength = 3200

type AgentChannel = 'web' | 'dingtalk'

type MemoryMessage = {
  role: string
  content: string
  metadata: Prisma.JsonValue | null
  ephemeral: boolean
  expiresAt: Date | null
  createdAt: Date
}

export type AgentMemoryContext = {
  conversationId: string
  summary: string | null
  recentMessages: MemoryMessage[]
  recalledMemories: Array<{ kind: string; content: string; score: number }>
  promptContext: string
  ephemeral: boolean
}

function channelFor(request: AgentRequest): AgentChannel {
  return request.channel === 'dingtalk' ? 'dingtalk' : 'web'
}

function externalConversationId(request: AgentRequest, actor: AuthContext) {
  const value = request.conversationId?.trim()
  return value ? value.slice(0, 240) : `member:${actor.memberId}`
}

function clip(value: string, limit: number) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`
}

function asMetadata(value: Prisma.JsonValue | null) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Prisma.JsonValue> : {}
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) return 0
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
}

function parseEmbedding(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number')
}

function extractLongTermMemories(message: string, result: AgentRun) {
  const memories: Array<{ kind: string; content: string }> = []
  const text = message.trim()
  if (text.length >= 6 && /(偏好|喜欢|习惯|默认|以后|不要|不需要|请记住|记住|称呼|格式)/.test(text)) {
    memories.push({ kind: 'preference', content: clip(text, 600) })
  }
  if (text.length >= 8 && /(经验|踩坑|教训|总结|注意|复盘|以后.*(?:任务|项目)|这类.*(?:任务|项目))/.test(text)) {
    memories.push({ kind: 'task_experience', content: clip(text, 600) })
  }
  if (/(经验|踩坑|教训|复盘)/.test(text) && result.answer.trim()) {
    memories.push({ kind: 'task_experience', content: clip(`任务经验：${result.answer}`, 900) })
  }
  return memories
}

async function getConversation(actor: AuthContext, request: AgentRequest) {
  const channel = channelFor(request)
  const externalId = externalConversationId(request, actor)
  return prisma.agentConversation.upsert({
    where: { organizationId_memberId_channel_externalId: { organizationId: actor.organizationId, memberId: actor.memberId, channel, externalId } },
    update: { lastActiveAt: new Date() },
    create: { organizationId: actor.organizationId, memberId: actor.memberId, channel, externalId },
  })
}

function buildPromptContext(summary: string | null, recentMessages: MemoryMessage[], recalledMemories: AgentMemoryContext['recalledMemories']) {
  const sections: string[] = []
  if (recalledMemories.length > 0) sections.push(`长期记忆（语义召回，仅在相关时使用）：\n${recalledMemories.map((item) => `- ${item.content}`).join('\n')}`)
  if (summary?.trim()) sections.push(`中期会话摘要（旧对话已压缩）：\n${clip(summary, maxSummaryLength)}`)
  if (recentMessages.length > 0) {
    sections.push(`最近 ${AGENT_SHORT_TERM_ROUNDS} 轮对话：\n${recentMessages.map((item) => `${item.role === 'user' ? '用户' : 'Agent'}：${clip(item.content, 900)}`).join('\n')}`)
  }
  return sections.length > 0
    ? `[Project OS Agent 记忆上下文]\n${sections.join('\n\n')}\n\n以上内容仅用于理解当前请求；以当前授权范围内的实时数据为准。`
    : ''
}

export async function prepareAgentMemory(actor: AuthContext, request: AgentRequest): Promise<AgentMemoryContext> {
  const conversation = await getConversation(actor, request)
  const now = new Date()
  await prisma.agentConversationMessage.deleteMany({ where: { conversationId: conversation.id, ephemeral: true, expiresAt: { lte: now } } })
  await prisma.agentMemory.deleteMany({ where: { organizationId: actor.organizationId, memberId: actor.memberId, expiresAt: { lte: now } } })

  const messages = await prisma.agentConversationMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' }, take: shortTermMessageLimit * 4 })
  const recentMessages = messages.reverse().filter((item) => !item.ephemeral && (!item.expiresAt || item.expiresAt > now)).slice(-shortTermMessageLimit)
  const embedding = embedText(request.message)
  const candidates = await prisma.agentMemory.findMany({ where: { organizationId: actor.organizationId, memberId: actor.memberId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { updatedAt: 'desc' }, take: 100 })
  const recalledMemories = candidates
    .map((item) => ({ kind: item.kind, content: item.content, score: cosineSimilarity(embedding, parseEmbedding(item.embedding)) }))
    .filter((item) => item.score >= 0.18)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)

  return {
    conversationId: conversation.id,
    summary: conversation.summary,
    recentMessages,
    recalledMemories,
    promptContext: buildPromptContext(conversation.summary, recentMessages, recalledMemories),
    ephemeral: isEphemeralChitchat(request.message),
  }
}

function summarizeMessages(previous: string | null, messages: MemoryMessage[]) {
  const lines = messages.flatMap((message) => {
    const metadata = asMetadata(message.metadata)
    if (message.role === 'user') return [`用户需求：${clip(message.content, 500)}`]
    const evidence = Array.isArray(metadata.evidence)
      ? metadata.evidence.map((item) => typeof item === 'object' && item && 'detail' in item ? String(item.detail) : '').filter(Boolean).slice(0, 2).join('；')
      : ''
    const actions = Array.isArray(metadata.actions)
      ? metadata.actions.map((item) => typeof item === 'object' && item && 'label' in item ? String(item.label) : '').filter(Boolean).slice(0, 2).join('、')
      : ''
    return [`任务进度/工具结果：${clip(message.content, 600)}${evidence ? `；依据：${clip(evidence, 400)}` : ''}${actions ? `；待确认动作：${clip(actions, 240)}` : ''}`]
  })
  const uniqueLines = [...new Set([...(previous?.split('\n') ?? []), ...lines].map((line) => line.trim()).filter(Boolean))]
  const combined = uniqueLines.join('\n')
  return combined.length <= maxSummaryLength ? combined : `${combined.slice(0, maxSummaryLength - 1)}…`
}

async function saveLongTermMemories(actor: AuthContext, conversationId: string, memories: Array<{ kind: string; content: string }>) {
  for (const memory of memories) {
    const embedding = embedText(memory.content)
    const candidates = await prisma.agentMemory.findMany({ where: { organizationId: actor.organizationId, memberId: actor.memberId, kind: memory.kind }, orderBy: { updatedAt: 'desc' }, take: 40 })
    const duplicate = candidates.find((candidate) => cosineSimilarity(embedding, parseEmbedding(candidate.embedding)) >= 0.92)
    if (duplicate) {
      await prisma.agentMemory.update({ where: { id: duplicate.id }, data: { content: memory.content, embedding: embedding as Prisma.InputJsonValue, sourceConversationId: conversationId } })
    } else {
      await prisma.agentMemory.create({ data: { organizationId: actor.organizationId, memberId: actor.memberId, kind: memory.kind, content: memory.content, embedding: embedding as Prisma.InputJsonValue, sourceConversationId: conversationId } })
    }
  }
}

export async function recordAgentTurn(actor: AuthContext, request: AgentRequest, result: AgentRun, context: AgentMemoryContext) {
  const now = new Date()
  const ephemeral = context.ephemeral
  const expiresAt = ephemeral ? new Date(now.getTime() + ephemeralTtlMs) : null
  await prisma.agentConversationMessage.createMany({ data: [
    { conversationId: context.conversationId, role: 'user', content: clip(request.message, 4000), ephemeral, expiresAt },
    { conversationId: context.conversationId, role: 'assistant', content: clip(result.answer, 6000), metadata: { runId: result.runId, intent: result.intent, status: result.status, evidence: result.evidence.slice(0, 8), actions: result.actions.slice(0, 8) } as Prisma.InputJsonValue, ephemeral, expiresAt },
  ] })

  const allMessages = await prisma.agentConversationMessage.findMany({ where: { conversationId: context.conversationId, ephemeral: false }, orderBy: { createdAt: 'asc' }, take: 200 })
  if (allMessages.length > shortTermMessageLimit) {
    const summaryMessages = allMessages.slice(0, allMessages.length - shortTermMessageLimit)
    const summary = summarizeMessages(context.summary, summaryMessages)
    await prisma.agentConversation.update({ where: { id: context.conversationId }, data: { summary, summaryUpdatedAt: now, lastActiveAt: now } })
  } else {
    await prisma.agentConversation.update({ where: { id: context.conversationId }, data: { lastActiveAt: now } })
  }
  await saveLongTermMemories(actor, context.conversationId, extractLongTermMemories(request.message, result))
}

export function promptWithMemory(message: string, context: AgentMemoryContext | null) {
  return context?.promptContext ? `${context.promptContext}\n\n用户当前消息：${message}` : message
}
