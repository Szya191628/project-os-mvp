import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { isL1, requireProjectPermission, requireTaskPermission } from '../auth.js'
import { submitTaskApproval, submitTaskSpecialReleaseApproval, refreshTaskApproval, applyApprovalOutcome, decideProjectOsApproval, ensureTaskApprovalForDingTalkSubmission } from '../approvals.js'
import { decryptDingTalkEvent, encryptDingTalkReply, verifyDingTalkEventSignature } from '../dingtalkApproval.js'
import { isDingTalkIntegrationEnabled } from '../dingtalkPolicy.js'
import { canDecideApprovalStep } from '../approvalRecipientAccess.js'

type TaskParams = { taskId: string }
type ApprovalPolicyStepInput = { stage?: string; mode?: string; minApprovals?: number; approverMemberIds?: string[]; ccMemberIds?: string[] }
type ApprovalCenterQuery = { status?: string; mine?: string }
type ApprovalPolicyMemberOption = { id: string; name: string; roleLabel: string; eligibleStages: ('L2' | 'ADMIN')[] }
type ApprovalPolicyRecord = { id: string; projectId: string; version: number; enabled: boolean; steps: { stepNo: number; stage: string; mode: string; minApprovals: number; approverMemberIds: Prisma.JsonValue; ccMemberIds: Prisma.JsonValue }[] }

const approvalStatuses = new Set(['PENDING', 'APPROVED', 'REJECTED', 'TERMINATED'])

function stringIds(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))] : []
}

function approvalRecipientsFromSnapshot(value: Prisma.JsonValue | null, stepNo: number) {
  if (!Array.isArray(value)) return { approverMemberIds: [], ccMemberIds: [] }
  const step = value.find((item) => item && typeof item === 'object' && !Array.isArray(item) && Number((item as Record<string, unknown>).stepNo) === stepNo)
  const record = step && typeof step === 'object' && !Array.isArray(step) ? step as Record<string, unknown> : {}
  return { approverMemberIds: stringIds(record.approverMemberIds), ccMemberIds: stringIds(record.ccMemberIds) }
}

async function approvalPolicyMemberOptions(projectId: string, organizationId: string): Promise<ApprovalPolicyMemberOption[]> {
  const members = await prisma.member.findMany({
    where: { organizationId, status: 'ACTIVE' },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      memberRoles: { select: { role: { select: { code: true } } } },
      projectRoleGrants: { where: { projectId, roleCode: 'L2', revokedAt: null }, select: { id: true } },
      projectMemberships: { where: { projectId }, select: { projectId: true } },
    },
  })
  return members.map((member) => {
    const roleCodes = new Set(member.memberRoles.map(({ role }) => role.code))
    const isL1Member = roleCodes.has('L1')
    const isL2Member = !isL1Member && member.projectRoleGrants.length > 0 && member.projectMemberships.length > 0
    return { id: member.id, name: member.name, roleLabel: isL1Member ? 'L1 全局管理员' : isL2Member ? 'L2 项目管理者' : 'L3 执行成员', eligibleStages: isL1Member ? ['L2', 'ADMIN'] : isL2Member ? ['L2'] : [] }
  })
}

function formatApprovalPolicy(policy: ApprovalPolicyRecord | null, projectId: string, memberOptions: ApprovalPolicyMemberOption[]) {
  return {
    id: policy?.id ?? null,
    projectId,
    version: policy?.version ?? 0,
    enabled: policy?.enabled ?? true,
    memberOptions,
    steps: policy?.steps.map((step) => ({ stepNo: step.stepNo, stage: step.stage, mode: step.mode, minApprovals: step.minApprovals, approverMemberIds: stringIds(step.approverMemberIds), ccMemberIds: stringIds(step.ccMemberIds) })) ?? [{ stepNo: 1, stage: 'L2', mode: 'ANY', minApprovals: 1, approverMemberIds: [], ccMemberIds: [] }],
  }
}

async function requireApprovalManager(request: FastifyRequest, reply: FastifyReply) {
  const actor = request.actor
  if (!actor) {
    await reply.code(401).send({ error: 'authentication_required' })
    return null
  }
  if (isL1(actor)) return { actor, projectIds: null as Set<string> | null }
  const projectL2 = await prisma.projectRoleGrant.findMany({ where: { memberId: actor.memberId, roleCode: 'L2', revokedAt: null, project: { organizationId: actor.organizationId, archivedAt: null, members: { some: { memberId: actor.memberId } } } }, select: { projectId: true } })
  const projectIds = new Set(projectL2.map((item) => item.projectId))
  if (projectIds.size === 0) {
    await reply.code(403).send({ error: 'forbidden', permission: 'approval.manage' })
    return null
  }
  return { actor, projectIds }
}

function normalizeApprovalPolicySteps(input: ApprovalPolicyStepInput[] | undefined) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5) throw new Error('approval_policy_steps_required')
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || [item.approverMemberIds, item.ccMemberIds].some((ids) => ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())))) throw new Error('approval_policy_step_invalid')
    const stage = item.stage === 'ADMIN' ? 'ADMIN' : item.stage === 'L2' ? 'L2' : undefined
    const mode = item.mode === 'ALL' ? 'ALL' : item.mode === 'ANY' || item.mode === undefined ? 'ANY' : undefined
    const minApprovals = item.minApprovals === undefined ? 1 : Math.floor(item.minApprovals)
    if (!stage || !mode || !Number.isFinite(minApprovals) || minApprovals < 1 || minApprovals > 100) throw new Error('approval_policy_step_invalid')
    return { stepNo: index + 1, stage: stage as 'L2' | 'ADMIN', mode: mode as 'ANY' | 'ALL', minApprovals, approverMemberIds: stringIds(item.approverMemberIds), ccMemberIds: stringIds(item.ccMemberIds) }
  })

}

function validateApprovalPolicyRecipients(steps: ReturnType<typeof normalizeApprovalPolicySteps>, memberOptions: ApprovalPolicyMemberOption[]) {
  const optionById = new Map(memberOptions.map((member) => [member.id, member]))
  for (const step of steps) {
    if (step.approverMemberIds.some((memberId) => !optionById.get(memberId)?.eligibleStages.includes(step.stage))) throw new Error('approval_policy_approver_invalid')
    if (step.ccMemberIds.some((memberId) => !optionById.get(memberId)?.eligibleStages.length)) throw new Error('approval_policy_cc_invalid')
  }
}

export async function registerApprovalRoutes(app: FastifyInstance) {
  // OA 审批中心：L1 查看组织范围，L2 查看自己有项目权限的审批。
  // Project OS 内部审批可直接在此同意/拒绝；历史或外部钉钉实例仍按需同步状态。
  app.get<{ Querystring: ApprovalCenterQuery }>('/api/v1/approvals', async (request, reply) => {
    const manager = await requireApprovalManager(request, reply)
    if (!manager) return
    const { actor, projectIds } = manager
    const requestedStatus = request.query.status?.trim().toUpperCase()
    if (requestedStatus && !approvalStatuses.has(requestedStatus)) return reply.code(400).send({ error: 'invalid_approval_status' })
    const approvals = await prisma.taskApproval.findMany({
      where: {
        ...(requestedStatus ? { status: requestedStatus } : {}),
        ...(request.query.mine === 'true' ? { submitterMemberId: actor.memberId } : {}),
        task: {
          archivedAt: null,
          project: {
            organizationId: actor.organizationId,
            archivedAt: null,
            ...(projectIds ? { id: { in: [...projectIds] } } : {}),
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        taskId: true,
        processInstanceId: true,
        processCode: true,
        source: true,
        purpose: true,
        deliveryType: true,
        status: true,
        autoCompleteStatus: true,
        currentStepNo: true,
        policySnapshot: true,
        submitterMemberId: true,
        submitterName: true,
        approvalFileName: true,
        approvalFileId: true,
        error: true,
        createdAt: true,
        completedAt: true,
        _count: { select: { packageLinks: true } },
        steps: {
          orderBy: { stepNo: 'asc' },
          select: { stepNo: true, stage: true, mode: true, minApprovals: true, status: true, decidedAt: true },
        },
        task: {
          select: {
            project: { select: { id: true, code: true, name: true, organization: { select: { name: true } } } },
            execution: { select: { progress: true } },
            assignees: {
              where: { removedAt: null },
              orderBy: { assignedAt: 'asc' },
              take: 1,
              select: {
                member: {
                  select: {
                    name: true,
                    department: { select: { id: true, name: true } },
                    memberDepartments: { select: { department: { select: { id: true, name: true } } } },
                  },
                },
              },
            },
            nodes: {
              where: { workflowVersion: { status: 'PUBLISHED' }, taskId: { not: null } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, wbs: true, name: true },
            },
          },
        },
      },
    })
    return {
      data: approvals.map((approval) => ({
        id: approval.id,
        taskId: approval.taskId,
        processInstanceId: approval.processInstanceId,
        processCode: approval.processCode,
        source: approval.source === 'PROJECT_OS' ? 'PROJECT_OS' : 'DINGTALK',
        purpose: approval.purpose,
        deliveryType: approval.deliveryType,
        status: approval.status,
        autoCompleteStatus: approval.autoCompleteStatus,
        currentStepNo: approval.currentStepNo,
        submitterMemberId: approval.submitterMemberId,
        submitterName: approval.submitterName,
        approvalFileName: approval.approvalFileName,
        hasAttachment: Boolean(approval.approvalFileId) || approval._count.packageLinks > 0,
        error: approval.error,
        createdAt: approval.createdAt.toISOString(),
        completedAt: approval.completedAt?.toISOString() ?? null,
        organizationName: approval.task.project.organization.name,
        progress: approval.task.execution?.progress ?? 0,
        assigneeName: approval.task.assignees[0]?.member.name ?? null,
        departmentNames: [...new Set([
          ...(approval.task.assignees[0]?.member.memberDepartments.map(({ department }) => department.name) ?? []),
          ...(approval.task.assignees[0]?.member.department?.name ? [approval.task.assignees[0].member.department.name] : []),
        ])],
        ...(() => {
          const recipients = approvalRecipientsFromSnapshot(approval.policySnapshot, approval.currentStepNo)
          const currentStep = approval.steps.find((step) => step.stepNo === approval.currentStepNo)
          const designatedApprover = recipients.approverMemberIds.includes(actor.memberId)
          const designatedCc = approval.steps.some((step) => step.stepNo <= approval.currentStepNo && approvalRecipientsFromSnapshot(approval.policySnapshot, step.stepNo).ccMemberIds.includes(actor.memberId))
          return {
            canDecide: approval.status === 'PENDING' && canDecideApprovalStep(actor.memberId, isL1(actor), { ...recipients, stage: currentStep?.stage }),
            recipientType: designatedApprover ? 'APPROVER' : designatedCc ? 'CC' : 'MANAGER',
          }
        })(),
        project: { id: approval.task.project.id, code: approval.task.project.code, name: approval.task.project.name },
        task: approval.task.nodes[0] ? { nodeId: approval.task.nodes[0].id, wbs: approval.task.nodes[0].wbs, name: approval.task.nodes[0].name } : null,
        steps: approval.steps.map((step) => ({ ...step, decidedAt: step.decidedAt?.toISOString() ?? null })),
      })),
    }
  })

  // Project OS 内部 OA 审批：L1 全局处理，L2 仅处理自己被授权的项目。
  app.post<{ Params: { approvalId: string }; Body: { outcome?: 'APPROVED' | 'REJECTED'; comment?: string } }>('/api/v1/approvals/:approvalId/decision', async (request, reply) => {
    const manager = await requireApprovalManager(request, reply)
    if (!manager) return
    const { actor, projectIds } = manager
    const approval = await prisma.taskApproval.findFirst({
      where: {
        id: request.params.approvalId,
        task: {
          archivedAt: null,
          project: { organizationId: actor.organizationId, archivedAt: null, ...(projectIds ? { id: { in: [...projectIds] } } : {}) },
        },
      },
      select: { source: true, status: true, steps: { where: { status: 'PENDING' }, orderBy: { stepNo: 'asc' }, take: 1, select: { stage: true } } },
    })
    if (!approval) return reply.code(404).send({ error: 'approval_not_found' })
    if (approval.source !== 'PROJECT_OS') return reply.code(409).send({ error: 'project_os_approval_required' })
    if (approval.status !== 'PENDING') return reply.code(409).send({ error: 'approval_not_pending' })
    if (approval.steps[0]?.stage === 'ADMIN' && !isL1(actor)) return reply.code(403).send({ error: 'approval_admin_stage_required' })
    const outcome = request.body?.outcome
    if (outcome !== 'APPROVED' && outcome !== 'REJECTED') return reply.code(400).send({ error: 'approval_outcome_invalid' })
    try {
      const result = await decideProjectOsApproval({ organizationId: actor.organizationId, approvalId: request.params.approvalId, actorMemberId: actor.memberId, outcome, comment: request.body?.comment })
      return { data: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_decision_failed'
      const status = message === 'approval_not_found' ? 404 : message === 'approval_approver_required' ? 403 : ['approval_not_pending', 'project_os_approval_required', 'task_already_completed'].includes(message) ? 409 : 500
      return reply.code(status).send({ error: message })
    }
  })

  // 提交 Project OS OA 审批（工作空间默认使用）；保留 source=DINGTALK 兼容机器人和外部调用。
  app.post<{ Params: TaskParams; Body: { note?: string; overdueReason?: string; approverUserIds?: string[]; progress?: number; deliveryType?: 'STAGE' | 'FINAL'; source?: 'PROJECT_OS' | 'DINGTALK' } }>('/api/v1/tasks/:taskId/approvals', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.execute.own')
    if (!guard) return
    try {
      const actorMember = await prisma.member.findFirst({ where: { id: actor.memberId }, select: { name: true } })
      const approval = await submitTaskApproval({
        organizationId: actor.organizationId,
        actorMemberId: actor.memberId,
        actorName: actorMember?.name ?? '未知用户',
        taskId: request.params.taskId,
        note: request.body?.note,
        overdueReason: request.body?.overdueReason,
        progress: request.body?.progress,
        deliveryType: request.body?.deliveryType,
        source: request.body?.source,
        approverUserIds: request.body?.approverUserIds?.map((item) => item.trim()).filter(Boolean),
      })
      return reply.code(201).send({ data: approval })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_submit_failed'
      const status = ['task_not_found', 'task_node_not_found'].includes(message) ? 404
        : ['workflow_not_published', 'dingtalk_identity_missing', 'task_assignee_missing', 'dingtalk_approval_not_configured', 'dingtalk_approver_missing', 'dingtalk_approver_not_allowed', 'dingtalk_integration_disabled', 'overdue_reason_required', 'approval_pending_exists'].includes(message) ? 409
        : message === 'task_already_completed' ? 409
        : 502
      return reply.code(status).send({ error: message })
    }
  })

  // 申请特殊放行：允许负责人在前置任务未完成时申请启动当前任务，审批权仍只属于 L2/管理员。
  app.post<{ Params: TaskParams; Body: { reason?: string; approverUserIds?: string[]; source?: 'PROJECT_OS' | 'DINGTALK' } }>('/api/v1/tasks/:taskId/special-release-approvals', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.execute.own')
    if (!guard) return
    try {
      const actorMember = await prisma.member.findFirst({ where: { id: actor.memberId }, select: { name: true } })
      const approval = await submitTaskSpecialReleaseApproval({
        organizationId: actor.organizationId,
        actorMemberId: actor.memberId,
        actorName: actorMember?.name ?? '未知用户',
        taskId: request.params.taskId,
        reason: request.body?.reason ?? '',
        approverUserIds: request.body?.approverUserIds?.map((item) => item.trim()).filter(Boolean),
        source: request.body?.source,
      })
      return reply.code(201).send({ data: approval })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'special_release_submit_failed'
      const status = ['task_not_found', 'task_node_not_found'].includes(message) ? 404
        : ['workflow_not_published', 'dingtalk_identity_missing', 'task_assignee_missing', 'dingtalk_approval_not_configured', 'dingtalk_approver_missing', 'dingtalk_approver_not_allowed', 'dingtalk_integration_disabled', 'special_release_reason_required', 'special_release_not_needed', 'special_release_already_approved', 'approval_pending_exists'].includes(message) ? 409
        : message === 'task_already_completed' ? 409
        : 502
      return reply.code(status).send({ error: message })
    }
  })

  app.get<{ Params: TaskParams }>('/api/v1/tasks/:taskId/approvals', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.read')
    if (!guard) return
    const approvals = await prisma.taskApproval.findMany({
      where: { taskId: request.params.taskId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, taskId: true, processInstanceId: true, processCode: true, source: true, purpose: true, deliveryType: true, status: true, autoCompleteStatus: true, submitterName: true, approvalFileName: true, error: true, createdAt: true, completedAt: true },
    })
    return { data: approvals }
  })

  // 手动同步一次审批状态（本地开发收不到事件回调时的兜底入口）。
  app.post<{ Params: TaskParams & { approvalId: string } }>('/api/v1/tasks/:taskId/approvals/:approvalId/refresh', async (request, reply) => {
    const actor = request.actor
    if (!actor) return reply.code(401).send({ error: 'authentication_required' })
    const guard = await requireTaskPermission(request, reply, request.params.taskId, 'task.execute.own')
    if (!guard) return
    try {
      const approval = await prisma.taskApproval.findFirst({ where: { id: request.params.approvalId, taskId: request.params.taskId }, select: { source: true } })
      if (approval?.source === 'PROJECT_OS') return reply.code(409).send({ error: 'project_os_approval_requires_manager' })
      const result = await refreshTaskApproval({ organizationId: actor.organizationId, approvalId: request.params.approvalId })
      return { data: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_refresh_failed'
      return reply.code(message === 'approval_not_found' ? 404 : ['dingtalk_approval_not_configured', 'project_os_approval_requires_manager'].includes(message) ? 409 : 502).send({ error: message })
    }
  })

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/approval-policy', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.publish')
    if (!guard) return
    if (!await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })) return reply.code(404).send({ error: 'project_not_found' })
    const policy = await prisma.approvalPolicy.findUnique({ where: { projectId: request.params.projectId }, include: { steps: { orderBy: { stepNo: 'asc' } } } })
    const memberOptions = await approvalPolicyMemberOptions(request.params.projectId, guard.actor.organizationId)
    return { data: formatApprovalPolicy(policy as ApprovalPolicyRecord | null, request.params.projectId, memberOptions) }
  })

  app.put<{ Params: { projectId: string }; Body: { enabled?: boolean; steps?: ApprovalPolicyStepInput[] } }>('/api/v1/projects/:projectId/approval-policy', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.publish')
    if (!guard) return
    if (!await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: guard.actor.organizationId, archivedAt: null }, select: { id: true } })) return reply.code(404).send({ error: 'project_not_found' })
    try {
      if (request.body?.enabled !== undefined && typeof request.body.enabled !== 'boolean') throw new Error('approval_policy_enabled_invalid')
      const steps = normalizeApprovalPolicySteps(request.body?.steps)
      if (steps.some((step) => step.mode !== 'ANY' || step.minApprovals !== 1)) throw new Error('approval_policy_use_sequential_steps')
      const memberOptions = await approvalPolicyMemberOptions(request.params.projectId, guard.actor.organizationId)
      validateApprovalPolicyRecipients(steps, memberOptions)
      const policy = await prisma.$transaction(async (tx) => tx.approvalPolicy.upsert({
        where: { projectId: request.params.projectId },
        update: { enabled: request.body?.enabled ?? true, version: { increment: 1 }, steps: { deleteMany: {}, create: steps } },
        create: { projectId: request.params.projectId, enabled: request.body?.enabled ?? true, steps: { create: steps } },
        include: { steps: { orderBy: { stepNo: 'asc' } } },
      }))
      await prisma.auditLog.create({ data: { organizationId: guard.actor.organizationId, actorMemberId: guard.actor.memberId, action: 'PROJECT_APPROVAL_POLICY_UPDATED', resourceType: 'APPROVAL_POLICY', resourceId: policy.id, projectId: request.params.projectId, afterJson: { version: policy.version, enabled: policy.enabled, steps } } })
      return { data: formatApprovalPolicy(policy as ApprovalPolicyRecord, request.params.projectId, memberOptions) }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_policy_update_failed'
      return reply.code(message.startsWith('approval_policy_') ? 400 : 500).send({ error: message })
    }
  })

  // 项目开关：审批通过后后续任务是否自动进入"进行中"（默认仅解锁并通知负责人）。
  app.patch<{ Params: { projectId: string }; Body: { approvalAutoStart?: boolean } }>('/api/v1/projects/:projectId/approval-settings', async (request, reply) => {
    const guard = await requireProjectPermission(request, reply, request.params.projectId, 'workflow.publish')
    if (!guard) return
    if (typeof request.body?.approvalAutoStart !== 'boolean') return reply.code(400).send({ error: 'approval_auto_start_required' })
    const project = await prisma.project.update({ where: { id: request.params.projectId }, data: { approvalAutoStart: request.body.approvalAutoStart }, select: { id: true, approvalAutoStart: true } })
    await prisma.auditLog.create({ data: { organizationId: guard.actor.organizationId, actorMemberId: guard.actor.memberId, action: 'PROJECT_APPROVAL_SETTINGS_UPDATED', resourceType: 'PROJECT', resourceId: project.id, projectId: project.id, afterJson: { approvalAutoStart: project.approvalAutoStart } } })
    return { data: project }
  })

  // 钉钉事件订阅回调（审批状态变更 bpms_instance_change）。免会话鉴权，
  // 依赖 msg_signature 验签 + AES 解密（未配置回调凭据时直接拒绝）。
  app.post('/api/v1/dingtalk/approval/callback', async (request, reply) => {
    if (!(await isDingTalkIntegrationEnabled(config.dingtalk.organizationId))) return reply.code(404).send({ error: 'dingtalk_integration_disabled' })
    if (!config.approval.callbackEnabled || !config.approval.callbackConfigured) {
      return reply.code(404).send({ error: 'dingtalk_callback_not_configured' })
    }
    const query = request.query as { signature?: string; timestamp?: string; nonce?: string }
    const body = request.body as { encrypt?: string } | null
    const encrypt = body?.encrypt
    if (!query.signature || !query.timestamp || !query.nonce || !encrypt) {
      return reply.code(400).send({ error: 'dingtalk_callback_invalid_request' })
    }
    const signatureValid = verifyDingTalkEventSignature({ token: config.approval.callbackToken, timestamp: query.timestamp, nonce: query.nonce, encrypt, signature: query.signature })
    if (!signatureValid) return reply.code(403).send({ error: 'dingtalk_callback_signature_invalid' })

    let event: Record<string, unknown>
    try {
      const decrypted = decryptDingTalkEvent(encrypt)
      event = JSON.parse(decrypted.message) as Record<string, unknown>
    } catch {
      return reply.code(400).send({ error: 'dingtalk_callback_decrypt_failed' })
    }
    const eventType = typeof event.EventType === 'string' ? event.EventType : typeof event.eventType === 'string' ? event.eventType : ''
    if (eventType !== 'bpms_instance_change') {
      // 非审批事件按协议回复 success，避免钉钉反复重试。
      const echo = encryptDingTalkReply(config.dingtalk.corpId)
      return reply.send({ msg_signature: echo.signature, timeStamp: echo.timestamp, nonce: echo.nonce, encrypt: echo.encrypt })
    }
    const processInstanceId = typeof event.processInstanceId === 'string' ? event.processInstanceId : ''
    const changeType = typeof event.type === 'string' ? event.type : ''
    const result = typeof event.result === 'string' ? event.result : ''
    if (processInstanceId) {
      const outcome = changeType === 'terminate' ? 'TERMINATED' : result === 'refuse' ? 'REJECTED' : result === 'agree' ? 'APPROVED' : null
      try {
        await ensureTaskApprovalForDingTalkSubmission({ processInstanceId, processCode: typeof event.processCode === 'string' ? event.processCode : undefined, detail: event as Prisma.InputJsonValue, source: 'callback' })
        if (outcome) await applyApprovalOutcome({ processInstanceId, outcome, detail: event as Prisma.InputJsonValue, source: 'callback' })
      } catch (error) {
        app.log.error(`[Approvals] callback ${processInstanceId} failed: ${error instanceof Error ? error.message : error}`)
      }
    }
    const echo = encryptDingTalkReply(config.dingtalk.corpId)
    return reply.send({ msg_signature: echo.signature, timeStamp: echo.timestamp, nonce: echo.nonce, encrypt: echo.encrypt })
  })
}
