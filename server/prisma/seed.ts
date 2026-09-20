import 'dotenv/config'

import {
  CalendarMode,
  MemberStatus,
  OrganizationStatus,
  PrismaClient,
  ProjectHealth,
  ProjectStatus,
  WorkflowNodeType,
  WorkflowVersionStatus,
} from '@prisma/client'

const prisma = new PrismaClient()

const ids = {
  organization: '00000000-0000-0000-0000-000000000001',
  department: '00000000-0000-0000-0000-000000000010',
  owner: '00000000-0000-0000-0000-000000000101',
  member: '00000000-0000-0000-0000-000000000102',
  project: '00000000-0000-0000-0000-000000000201',
  calendar: '00000000-0000-0000-0000-000000000210',
  workflow: '00000000-0000-0000-0000-000000000301',
  version: '00000000-0000-0000-0000-000000000302',
  startNode: '00000000-0000-0000-0000-000000000401',
  taskNode: '00000000-0000-0000-0000-000000000402',
  endNode: '00000000-0000-0000-0000-000000000403',
  startSchedule: '00000000-0000-0000-0000-000000000501',
  taskSchedule: '00000000-0000-0000-0000-000000000502',
  endSchedule: '00000000-0000-0000-0000-000000000503',
  startEdge: '00000000-0000-0000-0000-000000000601',
  endEdge: '00000000-0000-0000-0000-000000000602',
} as const

const day = (value: string) => new Date(`${value}T00:00:00.000Z`)

const permissionDefinitions = [
  ['project.read', '查看项目'], ['project.create', '创建项目'], ['project.member.manage', '管理项目成员'],
  ['project.role.grant', '授予项目级 L2'], ['project.role.revoke', '撤销项目级 L2'],
  ['workflow.read', '查看流程'], ['workflow.edit', '编辑流程'], ['workflow.publish', '发布流程'],
  ['task.read', '查看任务'], ['task.configure', '配置任务'], ['task.assign', '分配任务'],
  ['task.execute.all', '执行项目内全部任务'], ['task.execute.own', '执行负责的任务'],
  ['task.complete.confirm', '确认任务完成'], ['task.delete', '删除任务'], ['task.restore', '恢复任务'],
  ['deliverable.read', '查看交付物'], ['deliverable.manage', '管理全部交付物'], ['deliverable.manage.own', '管理负责任务交付物'],
  ['dependency.read', '查看直接依赖'], ['metrics.project.read', '查看项目指标'], ['metrics.portfolio.read', '查看项目组合指标'],
  ['portfolio.read', '查看项目组合'], ['portfolio.manage', '管理项目组合'], ['agent.use', '使用 Project Agent'],
  ['role.system.manage', '管理系统角色'], ['audit.read', '查看审计日志'],
] as const

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.organization.upsert({
      where: { id: ids.organization },
      update: { name: '感知起源科技', status: OrganizationStatus.ACTIVE },
      create: { id: ids.organization, code: 'SENSE-ORIGIN', name: '感知起源科技' },
    })

    await tx.department.upsert({
      where: { id: ids.department },
      update: { name: '研发中心', status: MemberStatus.ACTIVE },
      create: { id: ids.department, organizationId: ids.organization, name: '研发中心' },
    })

    await tx.member.upsert({
      where: { id: ids.owner },
      update: { name: '陈默', status: MemberStatus.ACTIVE, roleTitle: null },
      create: {
        id: ids.owner,
        organizationId: ids.organization,
        departmentId: ids.department,
        name: '陈默',
      },
    })
    await tx.member.upsert({
      where: { id: ids.member },
      update: { name: '林珊', status: MemberStatus.ACTIVE, roleTitle: null },
      create: {
        id: ids.member,
        organizationId: ids.organization,
        departmentId: ids.department,
        managerId: ids.owner,
        name: '林珊',
      },
    })

    const permissions = new Map<string, { id: string }>()
    for (const [code, name] of permissionDefinitions) {
      const permission = await tx.permission.upsert({ where: { code }, update: { name }, create: { code, name }, select: { id: true } })
      permissions.set(code, permission)
    }
    const allPermissionCodes = permissionDefinitions.map(([code]) => code)
    const l3PermissionCodes = ['project.read', 'workflow.read', 'task.read', 'task.execute.own', 'deliverable.read', 'deliverable.manage.own', 'dependency.read', 'metrics.project.read']
    const l2PermissionCodes = allPermissionCodes.filter((code) => !['project.create', 'portfolio.manage', 'role.system.manage'].includes(code))
    const roleDefinitions = [
      { code: 'L1', name: 'L1 全局管理员', permissionCodes: allPermissionCodes },
      { code: 'L2', name: 'L2 项目经理', permissionCodes: ['project.create'] },
      { code: 'L2_PROJECT', name: '项目级 L2', permissionCodes: l2PermissionCodes },
      { code: 'L3', name: 'L3 执行成员', permissionCodes: l3PermissionCodes },
    ] as const
    for (const roleDefinition of roleDefinitions) {
      const role = await tx.role.upsert({ where: { organizationId_code: { organizationId: ids.organization, code: roleDefinition.code } }, update: { name: roleDefinition.name }, create: { organizationId: ids.organization, code: roleDefinition.code, name: roleDefinition.name }, select: { id: true } })
      await tx.rolePermission.createMany({ data: roleDefinition.permissionCodes.map((code) => ({ roleId: role.id, permissionId: permissions.get(code)!.id })), skipDuplicates: true })
      if (roleDefinition.code === 'L1') await tx.memberRole.upsert({ where: { memberId_roleId: { memberId: ids.owner, roleId: role.id } }, update: { assignedById: ids.owner }, create: { memberId: ids.owner, roleId: role.id, assignedById: ids.owner } })
      if (roleDefinition.code === 'L3') await tx.memberRole.upsert({ where: { memberId_roleId: { memberId: ids.member, roleId: role.id } }, update: { assignedById: ids.owner }, create: { memberId: ids.member, roleId: role.id, assignedById: ids.owner } })
    }

    await tx.project.upsert({
      where: { id: ids.project },
      update: {
        name: '研发流程平台示例项目',
        status: ProjectStatus.IN_PROGRESS,
        health: ProjectHealth.HEALTHY,
      },
      create: {
        id: ids.project,
        organizationId: ids.organization,
        code: 'PRJ-001',
        name: '研发流程平台示例项目',
        departmentId: ids.department,
        ownerMemberId: ids.owner,
        createdById: ids.owner,
        status: ProjectStatus.IN_PROGRESS,
        health: ProjectHealth.HEALTHY,
        plannedStart: day('2026-08-31'),
        plannedEnd: day('2026-09-04'),
      },
    })

    await tx.projectMember.upsert({
      where: { projectId_memberId: { projectId: ids.project, memberId: ids.owner } },
      update: { membershipRole: 'owner' },
      create: { projectId: ids.project, memberId: ids.owner, organizationId: ids.organization, membershipRole: 'owner' },
    })
    await tx.projectMember.upsert({
      where: { projectId_memberId: { projectId: ids.project, memberId: ids.member } },
      update: { membershipRole: 'member' },
      create: { projectId: ids.project, memberId: ids.member, organizationId: ids.organization },
    })

    await tx.workCalendar.upsert({
      where: { id: ids.calendar },
      update: { name: '项目工作日历', mode: CalendarMode.WORKING },
      create: {
        id: ids.calendar,
        organizationId: ids.organization,
        projectId: ids.project,
        name: '项目工作日历',
        mode: CalendarMode.WORKING,
        weekdays: { create: [1, 2, 3, 4, 5].map((weekday) => ({ weekday })) },
      },
    })

    await tx.workflow.upsert({
      where: { id: ids.workflow },
      update: {},
      create: { id: ids.workflow, projectId: ids.project },
    })
    await tx.workflowVersion.upsert({
      where: { id: ids.version },
      update: { status: WorkflowVersionStatus.DRAFT, baselineStart: day('2026-08-31') },
      create: {
        id: ids.version,
        workflowId: ids.workflow,
        versionNo: 1,
        status: WorkflowVersionStatus.DRAFT,
        baselineStart: day('2026-08-31'),
        calendarId: ids.calendar,
        createdById: ids.owner,
      },
    })
    await tx.workflow.update({ where: { id: ids.workflow }, data: { draftVersionId: ids.version } })

    await tx.workflowNode.upsert({
      where: { id: ids.startNode },
      update: { name: '项目开始', positionX: 80, positionY: 120 },
      create: {
        id: ids.startNode,
        workflowVersionId: ids.version,
        nodeType: WorkflowNodeType.START,
        wbs: 'START',
        name: '项目开始',
        positionX: 80,
        positionY: 120,
      },
    })
    await tx.workflowNode.upsert({
      where: { id: ids.taskNode },
      update: { name: '需求确认', ownerMemberId: ids.member, durationDays: 3, positionX: 320, positionY: 120 },
      create: {
        id: ids.taskNode,
        workflowVersionId: ids.version,
        nodeType: WorkflowNodeType.TASK,
        wbs: '1.1',
        name: '需求确认',
        ownerMemberId: ids.member,
        durationDays: 3,
        effortHours: 24,
        description: '确认项目范围、输入和协作事项',
        closureCriteria: '提交确认记录',
        positionX: 320,
        positionY: 120,
      },
    })
    await tx.workflowNode.upsert({
      where: { id: ids.endNode },
      update: { name: '项目结束', positionX: 620, positionY: 120 },
      create: {
        id: ids.endNode,
        workflowVersionId: ids.version,
        nodeType: WorkflowNodeType.END,
        wbs: 'END',
        name: '项目结束',
        positionX: 620,
        positionY: 120,
      },
    })

    await tx.workflowEdge.upsert({
      where: { id: ids.startEdge },
      update: { sourceNodeId: ids.startNode, targetNodeId: ids.taskNode },
      create: { id: ids.startEdge, workflowVersionId: ids.version, sourceNodeId: ids.startNode, targetNodeId: ids.taskNode },
    })
    await tx.workflowEdge.upsert({
      where: { id: ids.endEdge },
      update: { sourceNodeId: ids.taskNode, targetNodeId: ids.endNode },
      create: { id: ids.endEdge, workflowVersionId: ids.version, sourceNodeId: ids.taskNode, targetNodeId: ids.endNode },
    })

    await tx.workflowNodeSchedule.upsert({
      where: { workflowVersionId_nodeId: { workflowVersionId: ids.version, nodeId: ids.startNode } },
      update: { plannedStart: day('2026-08-31'), plannedEnd: day('2026-08-31'), startOffset: 0, endOffset: 0, calendarSpan: 1 },
      create: { workflowVersionId: ids.version, nodeId: ids.startNode, plannedStart: day('2026-08-31'), plannedEnd: day('2026-08-31'), startOffset: 0, endOffset: 0, calendarSpan: 1 },
    })
    await tx.workflowNodeSchedule.upsert({
      where: { workflowVersionId_nodeId: { workflowVersionId: ids.version, nodeId: ids.taskNode } },
      update: { plannedStart: day('2026-08-31'), plannedEnd: day('2026-09-02'), startOffset: 0, endOffset: 2, calendarSpan: 3 },
      create: { workflowVersionId: ids.version, nodeId: ids.taskNode, plannedStart: day('2026-08-31'), plannedEnd: day('2026-09-02'), startOffset: 0, endOffset: 2, calendarSpan: 3 },
    })
    await tx.workflowNodeSchedule.upsert({
      where: { workflowVersionId_nodeId: { workflowVersionId: ids.version, nodeId: ids.endNode } },
      update: { plannedStart: day('2026-09-02'), plannedEnd: day('2026-09-02'), startOffset: 2, endOffset: 2, calendarSpan: 1 },
      create: { workflowVersionId: ids.version, nodeId: ids.endNode, plannedStart: day('2026-09-02'), plannedEnd: day('2026-09-02'), startOffset: 2, endOffset: 2, calendarSpan: 1 },
    })
  })

  console.log(`Seeded organization ${ids.organization} and project ${ids.project}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
