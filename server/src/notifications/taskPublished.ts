export type PublishedTaskMember = { id: string; name: string }

export type PublishedTaskNode = {
  id: string
  taskId: string | null
  nodeType: string
  executionStatus?: string | null
  wbs: string
  name: string
  description: string | null
  closureCriteria: string | null
  ownerMember: PublishedTaskMember | null
  assignees: PublishedTaskMember[]
  managerMembers?: PublishedTaskMember[]
  closureChecks: string[]
  plannedStart: Date | null
  plannedEnd: Date | null
}

export type PublishedTaskEdge = { sourceNodeId: string; targetNodeId: string }

export type PublishedTaskNotice = {
  eventKey: string
  projectId: string
  taskId: string
  title: string
  body: string
  dueDate: Date | null
  recipientMemberIds: string[]
}

type PublishedWorkflowInput = {
  organizationId: string
  projectId: string
  projectCode: string
  projectName: string
  versionId: string
  publisherName: string
  publisherLevel: 'L1' | 'L2'
  nodes: PublishedTaskNode[]
  edges: PublishedTaskEdge[]
  managerTaskIds?: ReadonlySet<string>
}

const completedStatuses = new Set(['COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED'])
const dateOnly = (value: Date | null) => value?.toISOString().slice(0, 10) ?? '待排期'

function uniqueMembers(members: PublishedTaskMember[]) {
  return [...new Map(members.map((member) => [member.id, member])).values()]
}

function responsibleMembers(node: PublishedTaskNode) {
  const source = node.assignees.length > 0 ? node.assignees : node.ownerMember ? [node.ownerMember] : []
  return uniqueMembers(source)
}

export function findMiddleInsertedTaskIds(nodes: PublishedTaskNode[], edges: PublishedTaskEdge[], previousTaskIds: ReadonlySet<string>) {
  const taskNodeIds = new Set(nodes.filter((node) => node.taskId && ['TASK', 'MILESTONE'].includes(node.nodeType)).map((node) => node.id))
  const hasPredecessor = new Set<string>()
  const hasSuccessor = new Set<string>()
  for (const edge of edges) {
    if (taskNodeIds.has(edge.targetNodeId)) hasPredecessor.add(edge.targetNodeId)
    if (taskNodeIds.has(edge.sourceNodeId)) hasSuccessor.add(edge.sourceNodeId)
  }
  return new Set(nodes.filter((node) => node.taskId && !previousTaskIds.has(node.taskId) && hasPredecessor.has(node.id) && hasSuccessor.has(node.id)).map((node) => node.taskId as string))
}

function adjacentLabel(node: PublishedTaskNode | undefined, relation: 'previous' | 'next') {
  if (!node || node.nodeType === 'START' || node.nodeType === 'END') return relation === 'previous' ? '无（项目开始）' : '无（项目结束）'
  const owners = responsibleMembers(node).map((member) => member.name).join('、') || '待分配'
  if (relation === 'previous') return `${node.wbs} ${node.name}｜负责人：${owners}｜交付时间：${dateOnly(node.plannedEnd)}`
  return `${node.wbs} ${node.name}｜负责人：${owners}`
}

export function buildPublishedTaskNotices(input: PublishedWorkflowInput): PublishedTaskNotice[] {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]))
  return input.nodes.flatMap((node) => {
    if (!node.taskId || !['TASK', 'MILESTONE'].includes(node.nodeType)) return []
    if (completedStatuses.has(node.executionStatus ?? '')) return []
    const recipients = uniqueMembers([
      ...responsibleMembers(node),
      ...(input.managerTaskIds?.has(node.taskId) ? node.managerMembers ?? [] : []),
    ])
    if (recipients.length === 0) return []
    const predecessors = input.edges.filter((edge) => edge.targetNodeId === node.id).map((edge) => nodeById.get(edge.sourceNodeId))
    const successors = input.edges.filter((edge) => edge.sourceNodeId === node.id).map((edge) => nodeById.get(edge.targetNodeId))
    const standards = node.closureCriteria?.trim() || node.closureChecks.join('；') || '尚未设置'
    const title = `${input.publisherName} 发布了新任务：${node.wbs} ${node.name}`
    const body = [
      `### ${title}`,
      `**发布人：** ${input.publisherName}（${input.publisherLevel}）`,
      `**项目：** ${input.projectCode} · ${input.projectName}`,
      `**你的任务：** ${node.wbs} ${node.name}`,
      `**具体内容：** ${node.description?.trim() || '尚未填写'}`,
      `**交付标准：** ${standards}`,
      `**计划开始：** ${dateOnly(node.plannedStart)}`,
      `**计划完成：** ${dateOnly(node.plannedEnd)}`,
      '',
      '**上一个任务节点：**',
      ...(predecessors.length > 0 ? predecessors.map((candidate) => `- ${adjacentLabel(candidate, 'previous')}`) : ['- 无（项目开始）']),
      '',
      '**下一个任务节点：**',
      ...(successors.length > 0 ? successors.map((candidate) => `- ${adjacentLabel(candidate, 'next')}`) : ['- 无（项目结束）']),
      '',
      '你可以直接回复 Project OS 机器人查询任务详情；回复“确认收到”确认提醒，回复“进度 80%”直接同步进度。',
    ].join('\n')
    return [{
      eventKey: `task-published:${input.versionId}:${node.taskId}`,
      projectId: input.projectId,
      taskId: node.taskId,
      title,
      body,
      dueDate: node.plannedEnd,
      recipientMemberIds: recipients.map((member) => member.id),
    }]
  })
}
