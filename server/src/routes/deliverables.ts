import { createReadStream } from 'node:fs'
import { dirname } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db.js'
import { projectAccess, requireTaskPermission } from '../auth.js'
import { downloadApprovalAttachment } from '../dingtalkApproval.js'
import { deliverableObjectPath, fileExists, persistFile } from '../deliverables/dingtalkDelivery.js'
import { resolvePredecessorDeliverable } from '../deliverables/predecessorDelivery.js'
import { verifyDeliverableViewToken } from '../deliverables/viewLink.js'
import { requireDingTalkIntegration } from '../dingtalkPolicy.js'

type DeliverableParams = { deliverableId: string }
type PredecessorDeliverableParams = { taskId: string; deliverableId: string }

// 安全查看链接（文档 §6.3）：令牌绑定收件人 + 短有效期，打开时再次校验
// 成员在职状态与项目只读权限；不生成永久公开文件地址。
async function loadDeliverableForView(deliverableId: string, memberId: string) {
  const member = await prisma.member.findFirst({
    where: { id: memberId, status: 'ACTIVE' },
    select: { id: true, organizationId: true, memberRoles: { select: { role: { select: { code: true } } } } },
  })
  if (!member) return { error: 'view_token_member_invalid' as const }
  const actor = { memberId: member.id, organizationId: member.organizationId, roleCodes: member.memberRoles.map((item) => item.role.code) }
  const deliverable = await prisma.taskDeliverable.findFirst({
    where: { id: deliverableId, deletedAt: null, task: { project: { organizationId: member.organizationId, archivedAt: null } } },
    select: { id: true, taskId: true, name: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, approvalProcessInstanceId: true, approvalFileId: true, approvalSpaceId: true, task: { select: { projectId: true } } },
  })
  if (!deliverable) return { error: 'deliverable_not_found' as const }
  const access = await projectAccess(actor, deliverable.task.projectId)
  if (!access) return { error: 'view_permission_denied' as const }
  return { deliverable, organizationId: member.organizationId }
}

type ApprovalBackedDeliverable = {
  id: string
  taskId: string
  name: string
  objectKey: string | null
  mimeType: string | null
  sizeBytes: bigint | null
  approvalProcessInstanceId: string | null
  approvalFileId: string | null
  approvalSpaceId: string | null
}

async function ensureApprovalFileStored<T extends ApprovalBackedDeliverable>(deliverable: T, organizationId: string, memberId: string, projectId: string): Promise<T> {
  if (deliverable.objectKey || !deliverable.approvalProcessInstanceId || !deliverable.approvalFileId) return deliverable
  await requireDingTalkIntegration(organizationId)
  const file = await downloadApprovalAttachment({ processInstanceId: deliverable.approvalProcessInstanceId, attachment: { fileId: deliverable.approvalFileId, spaceId: deliverable.approvalSpaceId ?? undefined, name: deliverable.name, mimeType: deliverable.mimeType ?? undefined, size: deliverable.sizeBytes === null ? undefined : Number(deliverable.sizeBytes) } })
  const objectKey = `${deliverable.id}/${file.name}`
  const hadFile = await fileExists(objectKey)
  if (!hadFile) await persistFile(objectKey, file)
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const stored = await tx.taskDeliverable.update({ where: { id: deliverable.id }, data: { kind: 'FILE', name: file.name, url: `/api/v1/deliverables/${deliverable.id}/download`, objectKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes }, select: { id: true, taskId: true, name: true, objectKey: true, mimeType: true, sizeBytes: true, approvalProcessInstanceId: true, approvalFileId: true, approvalSpaceId: true } })
      await tx.auditLog.create({ data: { organizationId, actorMemberId: memberId, action: 'TASK_DELIVERABLE_FETCHED', resourceType: 'TASK_DELIVERABLE', resourceId: deliverable.id, projectId, taskId: deliverable.taskId, afterJson: { source: 'DINGTALK_APPROVAL', approvalProcessInstanceId: deliverable.approvalProcessInstanceId, approvalFileId: deliverable.approvalFileId, sizeBytes: file.sizeBytes, sha256: file.sha256 } } })
      return stored
    })
    return { ...deliverable, ...updated }
  } catch (error) {
    if (!hadFile) await rm(dirname(deliverableObjectPath(objectKey)), { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function registerDeliverableRoutes(app: FastifyInstance) {
  // 前置交付物列表：L3 在有权访问的项目内可读取节点关联的交付物；
  // L2/L1/主管按各自项目权限读取。文件是否仍在审批中随列表返回。
  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/predecessor-deliverables', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.read')
    if (!guard) return
    const task = await prisma.task.findFirst({
      where: { id: request.params.taskId, archivedAt: null, project: { organizationId: actor.organizationId, archivedAt: null } },
      select: {
        id: true,
        project: { select: { workflow: { select: { publishedVersionId: true } } } },
        nodes: { take: 1, select: { id: true } },
      },
    })
    if (!task?.nodes[0] || !task.project.workflow?.publishedVersionId) return { data: [] }
    const node = task.nodes[0]
    const predecessors = await prisma.workflowEdge.findMany({
      where: { workflowVersionId: task.project.workflow.publishedVersionId, targetNodeId: node.id },
      select: { sourceNode: { select: { nodeType: true, wbs: true, name: true, taskId: true } } },
    })
    const predecessorTaskIds = predecessors.map((item) => item.sourceNode.taskId).filter((id): id is string => Boolean(id))
    if (predecessorTaskIds.length === 0) return { data: [] }
    const [deliverables, pendingApprovals] = await Promise.all([
      prisma.taskDeliverable.findMany({
        where: { taskId: { in: predecessorTaskIds }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, taskId: true, kind: true, name: true, versionLabel: true, url: true, objectKey: true, mimeType: true, sizeBytes: true, externalProvider: true, externalId: true, approvalProcessInstanceId: true, createdAt: true, uploader: { select: { name: true } }, task: { select: { nodes: { take: 1, select: { wbs: true, name: true } } } } },
      }),
      prisma.taskApproval.findMany({ where: { taskId: { in: predecessorTaskIds }, status: 'PENDING' }, select: { processInstanceId: true } }),
    ])
    const pendingInstances = new Set(pendingApprovals.map((item) => item.processInstanceId))
    const predecessorByTaskId = new Map(predecessors.filter((item) => item.sourceNode.taskId).map((item) => [item.sourceNode.taskId as string, item.sourceNode]))
    return {
      data: deliverables.map((item) => ({
        id: item.id,
        name: item.name,
        versionLabel: item.versionLabel,
        url: item.url,
        objectKey: item.objectKey,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes === null ? null : Number(item.sizeBytes),
        createdAt: item.createdAt,
        uploaderName: item.uploader?.name ?? null,
        predecessorWbs: predecessorByTaskId.get(item.taskId)?.wbs ?? null,
        predecessorName: predecessorByTaskId.get(item.taskId)?.name ?? null,
        approvalPending: item.externalProvider === 'DINGTALK_APPROVAL' && item.approvalProcessInstanceId ? pendingInstances.has(item.approvalProcessInstanceId) : false,
      })),
    }
  })

  app.get<{ Params: PredecessorDeliverableParams }>('/api/v1/tasks/:taskId/predecessor-deliverables/:deliverableId', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    try {
      const result = await resolvePredecessorDeliverable({ actor, taskId: request.params.taskId, deliverableId: request.params.deliverableId })
      return { data: result }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'predecessor_deliverable_failed'
      const status = detail === 'task_not_found' || detail === 'predecessor_task_not_found' || detail === 'predecessor_deliverable_not_found' ? 404 : detail.startsWith('forbidden_') ? 403 : detail === 'approval_attachment_reference_missing' || detail === 'dingtalk_integration_disabled' ? 409 : 502
      return reply.code(status).send({ error: detail })
    }
  })

  app.get<{ Params: DeliverableParams }>('/api/v1/deliverables/:deliverableId/download', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    let deliverable = await prisma.taskDeliverable.findFirst({
      where: { id: request.params.deliverableId, deletedAt: null, task: { project: { organizationId: actor.organizationId, archivedAt: null } } },
      select: { id: true, taskId: true, name: true, objectKey: true, mimeType: true, sizeBytes: true, approvalProcessInstanceId: true, approvalFileId: true, approvalSpaceId: true },
    })
    if (!deliverable) return reply.code(404).send({ error: 'deliverable_not_found' })
    const guard = await requireTaskPermission(request, reply, deliverable.taskId, 'deliverable.read')
    if (!guard) return
    if (!deliverable.objectKey && deliverable.approvalProcessInstanceId && deliverable.approvalFileId) {
      try {
        deliverable = await ensureApprovalFileStored(deliverable, actor.organizationId, actor.memberId, guard.task!.projectId)
      } catch (error) {
        if (error instanceof Error && error.message === 'dingtalk_integration_disabled') return reply.code(409).send({ error: error.message })
        return reply.code(502).send({ error: 'deliverable_file_fetch_failed' })
      }
    }
    if (!deliverable.objectKey) return reply.code(404).send({ error: 'deliverable_file_not_stored' })
    const filePath = deliverableObjectPath(deliverable.objectKey)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return reply.code(404).send({ error: 'deliverable_file_not_stored' })
    } catch {
      return reply.code(404).send({ error: 'deliverable_file_not_stored' })
    }
    const safeName = deliverable.name.split('').map((character) => /[\\/:*?"<>|]/u.test(character) || character.charCodeAt(0) < 32 ? '_' : character).join('')
    return reply.type(deliverable.mimeType || 'application/octet-stream').header('content-disposition', `attachment; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(deliverable.name)}`).send(createReadStream(filePath))
  })

  app.get<{ Params: DeliverableParams; Querystring: { token?: string } }>('/api/v1/deliverables/:deliverableId/view', async (request, reply) => {
    const token = request.query.token ?? ''
    const verified = verifyDeliverableViewToken(token)
    if (!verified || verified.deliverableId !== request.params.deliverableId) {
      return reply.code(403).send({ error: 'view_token_invalid' })
    }
    const loaded = await loadDeliverableForView(verified.deliverableId, verified.memberId)
    if ('error' in loaded) {
      return reply.code(loaded.error === 'deliverable_not_found' ? 404 : 403).send({ error: loaded.error })
    }
    let deliverable = loaded.deliverable
    if (!deliverable.objectKey && deliverable.approvalProcessInstanceId && deliverable.approvalFileId) {
      try {
        deliverable = await ensureApprovalFileStored(deliverable, loaded.organizationId, verified.memberId, deliverable.task.projectId)
      } catch (error) {
        if (error instanceof Error && error.message === 'dingtalk_integration_disabled') return reply.code(409).send({ error: error.message })
        return reply.code(502).send({ error: 'deliverable_file_fetch_failed' })
      }
    }
    if (!deliverable.objectKey) {
      // 链接型交付物：跳转到原始地址；文件未落盘则提示。
      if (deliverable.url && /^https?:/u.test(deliverable.url)) return reply.redirect(deliverable.url)
      return reply.code(404).send({ error: 'deliverable_file_not_stored' })
    }
    const filePath = deliverableObjectPath(deliverable.objectKey)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return reply.code(404).send({ error: 'deliverable_file_not_stored' })
    } catch {
      return reply.code(404).send({ error: 'deliverable_file_not_stored' })
    }
    const safeName = deliverable.name.split('').map((character) => /[\\/:*?"<>|]/u.test(character) || character.charCodeAt(0) < 32 ? '_' : character).join('')
    return reply.type(deliverable.mimeType || 'application/octet-stream').header('content-disposition', `inline; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(deliverable.name)}`).send(createReadStream(filePath))
  })
}
