import type { AuthContext } from '../auth.js'
import { dirname } from 'node:path'
import { rm } from 'node:fs/promises'
import { checkTaskPermission } from '../auth.js'
import { getDingTalkAppAccessToken } from '../dingtalk.js'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { fetchDingTalkApi } from '../dingtalkUsage.js'
import { deliverableObjectPath, downloadFileFromUrl, fileExists, persistFile } from './dingtalkDelivery.js'
import { requireDingTalkIntegration } from '../dingtalkPolicy.js'

type FetchLike = typeof fetch

type PredecessorDeliverable = {
  id: string
  taskId: string
  kind: string
  name: string
  versionLabel: string
  url: string | null
  objectKey: string | null
  mimeType: string | null
  sizeBytes: bigint | null
  externalProvider: string | null
  externalId: string | null
  approvalProcessInstanceId: string | null
  approvalProcessCode: string | null
  approvalFileId: string | null
  approvalSpaceId: string | null
  createdAt: Date
  uploader: { id: string; name: string } | null
}

type PredecessorTask = { id: string; wbs: string; name: string }

export type PredecessorDeliverableResult = {
  sourceTask: PredecessorTask
  deliverable: Omit<PredecessorDeliverable, 'sizeBytes' | 'createdAt'> & { sizeBytes: number | null; createdAt: string }
  stored: boolean
  source: 'project-os-storage' | 'dingtalk-approval'
}

const asRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function errorForPermission(result: { error: string; permission?: string }) {
  return new Error(result.error === 'task_not_found' ? 'task_not_found' : `forbidden_${result.permission ?? 'task'}`)
}

async function downloadApprovalFile(input: { processInstanceId: string; fileId: string; spaceId?: string | null; name: string; mimeType?: string | null; accessToken: string; fetchImpl: FetchLike }) {
  const response = await fetchDingTalkApi({ operation: 'workflow/processInstances/spaces/files/urls/download', url: 'https://api.dingtalk.com/v1.0/workflow/processInstances/spaces/files/urls/download', fetchImpl: input.fetchImpl, init: {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': input.accessToken },
    body: JSON.stringify({ processInstanceId: input.processInstanceId, fileId: input.fileId, ...(input.spaceId ? { spaceId: input.spaceId } : {}) }),
    signal: AbortSignal.timeout(config.dingtalk.requestTimeoutMs),
  } })
  const payload = asRecord(await response.json().catch(() => null))
  if (!response.ok) throw new Error(`dingtalk_approval_download_failed_${response.status}`)
  const result = asRecord(payload?.result) ?? payload
  const downloadUrl = typeof result?.downloadUri === 'string' ? result.downloadUri : typeof result?.downloadUrl === 'string' ? result.downloadUrl : typeof result?.url === 'string' ? result.url : undefined
  if (!downloadUrl) throw new Error('dingtalk_approval_download_url_missing')
  return downloadFileFromUrl(downloadUrl, input.name, input.mimeType ?? undefined, input.fetchImpl)
}

function serializeDeliverable(deliverable: PredecessorDeliverable) {
  return {
    ...deliverable,
    sizeBytes: deliverable.sizeBytes === null ? null : Number(deliverable.sizeBytes),
    createdAt: deliverable.createdAt.toISOString(),
  }
}

async function directPredecessorTasks(taskId: string) {
  const currentNodes = await prisma.workflowNode.findMany({ where: { taskId }, select: { id: true, workflowVersionId: true } })
  if (currentNodes.length === 0) return []
  const edges = await prisma.workflowEdge.findMany({ where: { workflowVersionId: { in: currentNodes.map((node) => node.workflowVersionId) }, targetNodeId: { in: currentNodes.map((node) => node.id) } }, select: { sourceNodeId: true } })
  const sourceNodeIds = [...new Set(edges.map((edge) => edge.sourceNodeId))]
  if (sourceNodeIds.length === 0) return []
  return prisma.workflowNode.findMany({
    where: { id: { in: sourceNodeIds }, taskId: { not: null }, task: { archivedAt: null, project: { archivedAt: null } } },
    select: { id: true, taskId: true, wbs: true, name: true, task: { select: { id: true } } },
  })
}

export async function resolvePredecessorDeliverable(input: { actor: AuthContext; taskId: string; predecessorTaskId?: string; deliverableId?: string; accessToken?: string; fetchImpl?: FetchLike }): Promise<PredecessorDeliverableResult> {
  const guard = await checkTaskPermission(input.actor, input.taskId, 'deliverable.read')
  if (!('task' in guard)) throw errorForPermission(guard)
  const taskProjectId = guard.task?.projectId
  if (!taskProjectId) throw new Error('task_not_found')

  const predecessorNodes = await directPredecessorTasks(input.taskId)
  const predecessorIds = [...new Set(predecessorNodes.flatMap((node) => node.taskId ? [node.taskId] : []))]
  if (predecessorIds.length === 0) throw new Error('predecessor_task_not_found')
  const selectedPredecessorId = input.predecessorTaskId && predecessorIds.includes(input.predecessorTaskId) ? input.predecessorTaskId : input.predecessorTaskId ? (() => { throw new Error('predecessor_task_not_found') })() : undefined
  const deliverables = await prisma.taskDeliverable.findMany({
    where: { taskId: selectedPredecessorId ? selectedPredecessorId : { in: predecessorIds }, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, externalProvider: true, externalId: true, approvalProcessInstanceId: true, approvalProcessCode: true, approvalFileId: true, approvalSpaceId: true, createdAt: true, uploader: { select: { id: true, name: true } } },
  })
  const selected = input.deliverableId ? deliverables.find((item) => item.id === input.deliverableId) : deliverables[0]
  if (input.deliverableId && !selected) throw new Error('predecessor_deliverable_not_found')
  if (!selected) throw new Error('predecessor_deliverable_not_found')
  const sourceNode = predecessorNodes.find((node) => node.taskId === selected.taskId)
  if (!sourceNode?.taskId) throw new Error('predecessor_task_not_found')
  const sourceTask = { id: sourceNode.taskId, wbs: sourceNode.wbs, name: sourceNode.name }

  if (selected.objectKey && await fileExists(selected.objectKey)) {
    return { sourceTask, deliverable: serializeDeliverable(selected), stored: true, source: 'project-os-storage' }
  }

  if (!selected.approvalProcessInstanceId || !selected.approvalFileId) {
    if (selected.url && /^https?:\/\//iu.test(selected.url)) return { sourceTask, deliverable: serializeDeliverable(selected), stored: false, source: 'project-os-storage' }
    throw new Error('approval_attachment_reference_missing')
  }

  await requireDingTalkIntegration(input.actor.organizationId)
  const accessToken = input.accessToken ?? await getDingTalkAppAccessToken()
  const file = await downloadApprovalFile({ processInstanceId: selected.approvalProcessInstanceId, fileId: selected.approvalFileId, spaceId: selected.approvalSpaceId, name: selected.name, mimeType: selected.mimeType, accessToken, fetchImpl: input.fetchImpl ?? fetch })
  const objectKey = `${selected.id}/${file.name}`
  await persistFile(objectKey, file)
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const deliverable = await tx.taskDeliverable.update({ where: { id: selected.id }, data: { objectKey, url: `/api/v1/deliverables/${selected.id}/download`, mimeType: file.mimeType, sizeBytes: file.sizeBytes, externalProvider: selected.externalProvider ?? 'DINGTALK_APPROVAL' }, select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, externalProvider: true, externalId: true, approvalProcessInstanceId: true, approvalProcessCode: true, approvalFileId: true, approvalSpaceId: true, createdAt: true, uploader: { select: { id: true, name: true } } } })
      await tx.auditLog.create({ data: { organizationId: input.actor.organizationId, actorMemberId: input.actor.memberId, action: 'TASK_DELIVERABLE_FETCHED', resourceType: 'TASK_DELIVERABLE', resourceId: selected.id, projectId: taskProjectId, taskId: selected.taskId, afterJson: { source: 'DINGTALK_APPROVAL', approvalProcessInstanceId: selected.approvalProcessInstanceId, approvalFileId: selected.approvalFileId, sizeBytes: file.sizeBytes, sha256: file.sha256 } } })
      return deliverable
    })
    return { sourceTask, deliverable: serializeDeliverable(updated), stored: true, source: 'dingtalk-approval' }
  } catch (error) {
    await rm(dirname(deliverableObjectPath(objectKey)), { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
