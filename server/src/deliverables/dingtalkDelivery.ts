import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AuthContext } from '../auth.js'
import { checkTaskPermission } from '../auth.js'
import { config } from '../config.js'
import { fetchDingTalkApi } from '../dingtalkUsage.js'
import { prisma } from '../db.js'
import type { AgentAttachment } from '../agent/types.js'
import { requireDingTalkIntegration } from '../dingtalkPolicy.js'

export type DownloadedDingTalkFile = {
  name: string
  mimeType?: string
  sizeBytes: number
  bytes: Uint8Array
  sha256: string
}

type FetchLike = typeof fetch

const asRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function robotCodeFromAttachment(attachment: AgentAttachment) {
  if (attachment.robotCode?.trim()) return attachment.robotCode.trim()
  return attachment.url?.match(/^dingtalk:\/\/download\/([^:]+):/)?.[1]?.trim() || undefined
}

function downloadCodeFromAttachment(attachment: AgentAttachment) {
  return attachment.externalId?.trim() || attachment.url?.match(/^dingtalk:\/\/download\/[^:]+:(.+)$/)?.[1]?.trim()
}

function mimeTypeFromName(name: string) {
  const extension = path.extname(name).toLowerCase()
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.txt': 'text/plain',
  }
  return known[extension]
}

export function safeDeliverableName(name: string) {
  const normalized = name.trim().split('').map((character) => /[\\/:*?"<>|]/u.test(character) || character.charCodeAt(0) < 32 ? '_' : character).join('').replace(/\s+/gu, ' ')
  return (normalized || '钉钉交付物').slice(0, 180)
}

export function deliverableObjectPath(objectKey: string) {
  const root = path.resolve(config.deliverables.storageDir)
  const target = path.resolve(root, objectKey)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('deliverable_storage_path_invalid')
  return target
}

export async function downloadFileFromUrl(downloadUrl: string, name: string, mimeType: string | undefined, fetchImpl: FetchLike = fetch): Promise<DownloadedDingTalkFile> {
  const parsedUrl = new URL(downloadUrl)
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new Error('dingtalk_download_url_invalid')
  const fileResponse = await fetchImpl(parsedUrl, { signal: AbortSignal.timeout(Math.max(config.dingtalk.requestTimeoutMs, 30000)) })
  if (!fileResponse.ok) throw new Error(`dingtalk_file_download_failed_${fileResponse.status}`)
  const contentLength = Number(fileResponse.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > config.deliverables.maxSizeBytes) throw new Error('deliverable_file_too_large')
  const bytes = new Uint8Array(await fileResponse.arrayBuffer())
  if (bytes.byteLength > config.deliverables.maxSizeBytes) throw new Error('deliverable_file_too_large')
  if (bytes.byteLength === 0) throw new Error('deliverable_file_empty')
  return {
    name: safeDeliverableName(name),
    mimeType: mimeType?.trim() || mimeTypeFromName(name) || fileResponse.headers.get('content-type')?.split(';', 1)[0]?.trim() || undefined,
    sizeBytes: bytes.byteLength,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function downloadDingTalkFile(attachment: AgentAttachment, accessToken: string, fetchImpl: FetchLike = fetch): Promise<DownloadedDingTalkFile> {
  const robotCode = robotCodeFromAttachment(attachment)
  const downloadCode = downloadCodeFromAttachment(attachment)
  if (!robotCode || !downloadCode) throw new Error('dingtalk_download_reference_missing')
  const metadataResponse = await fetchDingTalkApi({ operation: 'robot/messageFiles/download', url: 'https://api.dingtalk.com/v1.0/robot/messageFiles/download', fetchImpl, init: {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    body: JSON.stringify({ downloadCode, robotCode }),
    signal: AbortSignal.timeout(config.dingtalk.requestTimeoutMs),
  } })
  const metadataPayload = asRecord(await metadataResponse.json().catch(() => null))
  if (!metadataResponse.ok) throw new Error(`dingtalk_download_metadata_failed_${metadataResponse.status}`)
  const downloadUrl = typeof metadataPayload?.downloadUrl === 'string' ? metadataPayload.downloadUrl : typeof metadataPayload?.download_url === 'string' ? metadataPayload.download_url : undefined
  if (!downloadUrl) throw new Error('dingtalk_download_url_missing')
  // DingTalk returns a short-lived OSS URL. It may use HTTP, but it must be
  // an absolute URL returned by DingTalk rather than a caller-supplied URL.
  return downloadFileFromUrl(downloadUrl, attachment.name, attachment.mimeType, fetchImpl)
}

export async function fileExists(objectKey: string | null) {
  if (!objectKey) return false
  try {
    const info = await stat(deliverableObjectPath(objectKey))
    return info.isFile()
  } catch {
    return false
  }
}

export async function persistFile(objectKey: string, file: DownloadedDingTalkFile) {
  const target = deliverableObjectPath(objectKey)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, file.bytes, { flag: 'wx' })
  try {
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function permissionError(result: { error: string; permission?: string }) {
  return new Error(result.error === 'task_not_found' ? 'task_not_found' : `forbidden_${result.permission ?? 'task'}`)
}

export async function executeDingTalkTaskDelivery(input: { actor: AuthContext; taskId: string; attachment: AgentAttachment & { versionLabel?: string }; accessToken: string; completeTask?: boolean }) {
  await requireDingTalkIntegration(input.actor.organizationId)
  const deliveryGuard = await checkTaskPermission(input.actor, input.taskId, 'deliverable.manage.own')
  if (!('task' in deliveryGuard)) throw permissionError(deliveryGuard)
  const taskProjectId = deliveryGuard.task!.projectId
  if (input.completeTask) {
    const completionGuard = await checkTaskPermission(input.actor, input.taskId, 'task.execute.own')
    if (!('task' in completionGuard)) throw permissionError(completionGuard)
  }
  if ((input.attachment.externalProvider ?? 'DINGTALK').toUpperCase() !== 'DINGTALK') throw new Error('dingtalk_attachment_required')
  const externalId = downloadCodeFromAttachment(input.attachment)
  if (!externalId) throw new Error('dingtalk_download_reference_missing')
  const existing = await prisma.taskDeliverable.findFirst({
    where: { taskId: input.taskId, externalProvider: 'DINGTALK', externalId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, uploaderMemberId: true, externalProvider: true, externalId: true, createdAt: true },
  })
  if (existing?.objectKey && await fileExists(existing.objectKey)) {
    return { deliverable: existing, taskCompleted: false, approvalRequired: Boolean(input.completeTask), alreadyStored: true }
  }

  const file = await downloadDingTalkFile(input.attachment, input.accessToken)
  const deliverableId = existing?.id ?? randomUUID()
  const objectKey = `${deliverableId}/${file.name}`
  const hadFile = await fileExists(objectKey)
  await persistFile(objectKey, file)
  // 文档 §6.1：交付物保存与 TASK_DELIVERABLE_SUBMITTED 事件同一事务（钉钉机器人路径）。
  const [submitter, execution] = await Promise.all([
    prisma.member.findUnique({ where: { id: input.actor.memberId }, select: { name: true } }),
    prisma.taskExecution.findUnique({ where: { taskId: input.taskId }, select: { progress: true } }),
  ])
  try {
    const result = await prisma.$transaction(async (tx) => {
      let deliverable
      if (existing) {
        deliverable = await tx.taskDeliverable.update({
          where: { id: deliverableId },
          data: { name: file.name, kind: 'FILE', versionLabel: input.attachment.versionLabel?.trim() || existing.versionLabel || 'v1', url: `/api/v1/deliverables/${deliverableId}/download`, objectKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes, uploaderMemberId: input.actor.memberId },
          select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, uploaderMemberId: true, externalProvider: true, externalId: true, createdAt: true },
        })
      } else {
        deliverable = await tx.taskDeliverable.create({
          data: { id: deliverableId, taskId: input.taskId, kind: 'FILE', name: file.name, versionLabel: input.attachment.versionLabel?.trim() || 'v1', url: `/api/v1/deliverables/${deliverableId}/download`, objectKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes, uploaderMemberId: input.actor.memberId, externalProvider: 'DINGTALK', externalId },
          select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, uploaderMemberId: true, externalProvider: true, externalId: true, createdAt: true },
        })
      }
      if (!existing) {
        await tx.outboxEvent.create({ data: { organizationId: input.actor.organizationId, aggregateType: 'TASK_DELIVERABLE', aggregateId: deliverable.id, eventType: 'TASK_DELIVERABLE_SUBMITTED', dedupeKey: `task-deliverable-submitted:${deliverable.id}`, payload: { taskId: input.taskId, projectId: taskProjectId, deliverableId: deliverable.id, deliverableName: deliverable.name, submitterMemberId: input.actor.memberId, submitterName: submitter?.name ?? '任务负责人', progress: execution?.progress ?? 0 } } })
      }
      await tx.auditLog.create({ data: { organizationId: input.actor.organizationId, actorMemberId: input.actor.memberId, action: existing ? 'TASK_DELIVERABLE_STORED' : 'TASK_DELIVERABLE_ADDED', resourceType: 'TASK_DELIVERABLE', resourceId: deliverable.id, projectId: taskProjectId, taskId: input.taskId, afterJson: { deliverableId: deliverable.id, name: deliverable.name, sizeBytes: file.sizeBytes, sha256: file.sha256, source: 'DINGTALK' } } })
      return { deliverable }
    })
    return { deliverable: result.deliverable, taskCompleted: false, approvalRequired: Boolean(input.completeTask), alreadyStored: false }
  } catch (error) {
    if (!hadFile) await rm(path.dirname(deliverableObjectPath(objectKey)), { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function readStoredDeliverable(objectKey: string) {
  return readFile(deliverableObjectPath(objectKey))
}
