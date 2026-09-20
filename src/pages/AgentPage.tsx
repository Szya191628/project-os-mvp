import { ArrowRight, Bot, CheckCircle2, Clock3, FileText, GitBranch, Send, ShieldAlert, Sparkles, UsersRound, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import type { Project, Workflow } from '../types'
import type { NewProjectInput } from '../components/ProjectCreateDialog'
import { useEffect } from 'react'
import { addTaskAssignee, addTaskDeliverable, createTask, deleteTask, fetchPredecessorDeliverable, publishWorkflow, removeTaskAssignee, resolveApiUrl, runAgentQueryApi, updateTask } from '../api'
import { runAgentQuery, type AgentAction, type AgentContext, type AgentEvidence, type AgentIntent, type AgentActorRole, type AgentProjectDraft, type AgentResult } from '../agent/agentEngine'
import { PageHeader, StatusBadge } from '../components/UI'

const prompts = [
  '哪些项目可能延期？',
  '分析未来四周的资源冲突',
  '检查缺少交付物的任务',
  '创建一个流程：需求澄清 3 天、方案设计 5 天、开发 7 天、验收 2 天',
  '帮我生成本周项目组合简报',
]

interface AgentPageProps {
  projects: Project[]
  workflows: Record<string, Workflow>
  currentProjectId?: string
  actorRole?: AgentActorRole
  onOpenProject: (projectId?: string, taskId?: string) => void
  onApplyWorkflowPreview?: (workflow: Workflow) => void
  onCreateProject?: (input: NewProjectInput) => Promise<Project | undefined>
  onRefreshProject?: (projectId: string) => Promise<void>
}

export function AgentPage({ projects, workflows, currentProjectId, actorRole = 'publisher', onOpenProject, onApplyWorkflowPreview, onCreateProject, onRefreshProject }: AgentPageProps) {
  const [input, setInput] = useState('')
  const [question, setQuestion] = useState('哪些项目可能延期？')
  const [history, setHistory] = useState<string[]>([])
  const [conversationId] = useState(() => {
    const storageKey = 'project-os-agent-conversation'
    const existing = window.sessionStorage.getItem(storageKey)
    if (existing) return existing
    const created = window.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
    window.sessionStorage.setItem(storageKey, created)
    return created
  })
  const context: AgentContext = { projects, workflows, currentProjectId, actorRole, today: new Date().toISOString().slice(0, 10) }
  const [result, setResult] = useState<AgentResult>(() => runAgentQuery(question, context))
  const [loading, setLoading] = useState(false)
  const [executingActionId, setExecutingActionId] = useState<string | null>(null)
  const [completedActionIds, setCompletedActionIds] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void runAgentQueryApi({ message: question, projectId: currentProjectId, conversationId })
      .then((next) => { if (!cancelled) setResult(next) })
      .catch(() => { if (!cancelled) setResult(runAgentQuery(question, context)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // The backend owns the authoritative scope; the local engine is only a graceful offline fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, currentProjectId, projects, workflows, actorRole, conversationId])

  const ask = (value?: string) => {
    const next = value ?? input.trim()
    if (!next) return
    setHistory((current) => [next, ...current.filter((item) => item !== next)].slice(0, 4))
    setQuestion(next)
    setInput('')
    setLoading(true)
  }

  const handleAction = async (action: AgentAction) => {
    if (action.kind === 'open-project' && action.projectId) onOpenProject(action.projectId, action.taskId)
    if (action.kind === 'preview-workflow') {
      const preview = action.workflow ?? result.previewWorkflow
      if (preview?.projectId && action.projectId) onApplyWorkflowPreview?.(preview)
    }
    if (action.kind === 'create-project' && action.projectDraft && onCreateProject) {
      setExecutingActionId(action.id)
      setActionError(null)
      try {
        const created = await onCreateProject(toNewProjectInput(action.projectDraft))
        if (!created) return
        setCompletedActionIds((current) => [...new Set([...current, action.id])])
        if (action.projectDraft.taskSpecs.length >= 2 && onApplyWorkflowPreview) {
          const generated = runAgentQuery(`为 ${created.code} 创建流程：${action.projectDraft.taskSpecs.map((task) => `${task.name} ${task.duration} 天`).join('、')}`, { projects: [created], workflows: {}, currentProjectId: created.id, today: created.start, actorRole })
          if (generated.previewWorkflow) onApplyWorkflowPreview(generated.previewWorkflow)
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : '项目创建失败')
      } finally {
        setExecutingActionId(null)
      }
    }
    if (['create-task', 'update-task', 'delete-task', 'assign-task', 'publish-workflow', 'submit-deliverable', 'get-predecessor-deliverable'].includes(action.kind)) {
      setExecutingActionId(action.id)
      setActionError(null)
      try {
        if (action.kind === 'create-task' && action.taskDraft) {
          await createTask(action.taskDraft.projectId, { name: action.taskDraft.name, duration: action.taskDraft.duration, effort: action.taskDraft.effort, ownerMemberId: action.taskDraft.ownerMemberId })
          await onRefreshProject?.(action.taskDraft.projectId)
        } else if (action.kind === 'update-task' && action.taskPatch && action.taskId) {
          await updateTask(action.taskId, action.taskPatch as Record<string, unknown>)
          await onRefreshProject?.(action.projectId ?? '')
        } else if (action.kind === 'delete-task' && action.taskId) {
          await deleteTask(action.taskId)
          await onRefreshProject?.(action.projectId ?? '')
        } else if (action.kind === 'assign-task' && action.taskId && action.memberId) {
          if (action.assignmentMode === 'remove') await removeTaskAssignee(action.taskId, action.memberId)
          else {
            await addTaskAssignee(action.taskId, action.memberId)
            if (action.assignmentMode === 'replace') {
              for (const existingMemberId of action.existingMemberIds ?? []) {
                if (existingMemberId !== action.memberId) await removeTaskAssignee(action.taskId, existingMemberId)
              }
            }
          }
          await onRefreshProject?.(action.projectId ?? '')
        } else if (action.kind === 'publish-workflow' && action.projectId) {
          await publishWorkflow(action.projectId)
          await onRefreshProject?.(action.projectId)
        } else if (action.kind === 'submit-deliverable' && action.taskId && action.deliverable) {
          await addTaskDeliverable(action.taskId, action.deliverable)
          await onRefreshProject?.(action.projectId ?? '')
        } else if (action.kind === 'get-predecessor-deliverable' && action.taskId && action.deliverableId) {
          const result = await fetchPredecessorDeliverable(action.taskId, action.deliverableId)
          if (!result.deliverable.url) throw new Error('前置交付物没有可下载地址')
          window.open(resolveApiUrl(result.deliverable.url), '_blank', 'noopener,noreferrer')
        } else {
          throw new Error('Agent 动作缺少必要参数，请重新提问')
        }
        setCompletedActionIds((current) => [...new Set([...current, action.id])])
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Agent 动作执行失败')
      } finally {
        setExecutingActionId(null)
      }
    }
  }

  const createActions = result.actions.filter((action) => action.kind === 'create-project')
  const executableActions = result.actions.filter((action) => ['create-task', 'update-task', 'delete-task', 'assign-task', 'publish-workflow', 'submit-deliverable', 'get-predecessor-deliverable'].includes(action.kind))
  const navigableActions = result.actions.filter((action) => action.kind !== 'preview-workflow' && action.kind !== 'create-project' && !['create-task', 'update-task', 'delete-task', 'assign-task', 'publish-workflow', 'submit-deliverable', 'get-predecessor-deliverable'].includes(action.kind))

  return (
    <div className="page agent-page page-enter">
      <PageHeader title="Project Agent" description="统一入口：识别你的意图，路由到项目分析、排期模拟、资源负载、流程草稿与发布确认。" eyebrow="AI 功能入口 · V1" actions={<StatusBadge tone={toneForIntent(result.intent)}>{result.modeLabel}</StatusBadge>} />
      <div className="agent-layout">
        <section className="agent-chat">
          <div className="agent-intro"><span className="agent-orb"><Bot size={24} /></span><div><h2>今天想了解什么？</h2><p>Agent 先读取实时项目数据，再给出带依据的分析。涉及流程写入或发布时，会先生成预览并交回页面确认。</p></div></div>
          <div className="prompt-chips">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => ask(prompt)}>{prompt}</button>)}</div>
          <div className="conversation">
            <div className="message message-user"><span className="avatar avatar-dark">CM</span><div><small>你</small><p>{question}</p></div></div>
            <div className="message message-agent"><span className="agent-orb agent-orb-small"><Sparkles size={17} /></span><div className="agent-answer">
              <div className="agent-answer-heading"><small>Project Agent · {result.intentLabel}</small><StatusBadge tone={toneForIntent(result.intent)}>置信度 {Math.round(result.confidence * 100)}%</StatusBadge></div>
              <p>{result.answer}</p>
              {result.evidence.length > 0 && <div className="agent-evidence-list">{result.evidence.map((finding) => <EvidenceCard key={finding.id} finding={finding} onOpenProject={onOpenProject} />)}</div>}
              {result.previewWorkflow && <WorkflowPreview workflow={result.previewWorkflow} onApply={onApplyWorkflowPreview ? () => onApplyWorkflowPreview(result.previewWorkflow!) : undefined} />}
              {createActions.map((action) => <ProjectCreatePreview key={action.id} action={action} completed={completedActionIds.includes(action.id)} executing={executingActionId === action.id} disabled={!onCreateProject} onConfirm={() => void handleAction(action)} />)}
              {executableActions.map((action) => <AgentActionPreview key={action.id} action={action} completed={completedActionIds.includes(action.id)} executing={executingActionId === action.id} disabled={!onRefreshProject && action.kind !== 'get-predecessor-deliverable'} onConfirm={() => void handleAction(action)} />)}
              {actionError && <p className="agent-action-error" role="alert">{actionError}</p>}
              {result.missingFields.length > 0 && <div className="agent-missing"><strong>发布或落地前还需补充</strong><span>{result.missingFields.join('、')}</span></div>}
              {result.suggestions.length > 0 && <><h3>建议动作</h3><ol className="action-list">{result.suggestions.map((suggestion) => <li key={suggestion}><CheckCircle2 size={16} /><button type="button" onClick={() => ask(suggestion)}>{suggestion}</button></li>)}</ol></>}
              {navigableActions.length > 0 && <div className="agent-action-buttons">{navigableActions.map((action) => <button className="link-button" type="button" key={action.id} onClick={() => handleAction(action)} disabled={!action.projectId}>{action.label}<ArrowRight size={14} /></button>)}</div>}
              <div className="answer-sources"><span><FileText size={14} />依据：{result.sourceLabel}</span><time>刚刚</time></div>
            </div></div>
          </div>
          <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); ask() }}><label><WandSparkles size={18} /><span className="sr-only">向 Project Agent 提问</span><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="询问项目进度、资源、风险、交付物或流程…" rows={2} /></label><div><span>{loading ? '正在读取当前用户授权范围…' : '执行动作会复用当前登录用户权限，并在写入前请求确认'}</span><button className="button button-primary" type="submit" disabled={!input.trim() || loading}><Send size={16} />发送</button></div></form>
        </section>
        <aside className="agent-context"><section className="panel"><h3>分析范围</h3><dl><div><dt>项目</dt><dd>{result.scopeLabel}</dd></div><div><dt>任务</dt><dd>{countTasks(workflows)} 个</dd></div><div><dt>数据版本</dt><dd>实时数据库</dd></div><div><dt>当前角色</dt><dd>{actorRoleLabel(actorRole)}</dd></div></dl><button className="button button-secondary button-full" type="button" onClick={() => ask('生成项目组合简报')}>生成组合简报</button></section><section className="panel"><h3>最近提问</h3>{history.length === 0 ? <p className="agent-empty-history">发送一条问题后会显示在这里。</p> : history.map((item) => <button className="recent-item" type="button" key={item} onClick={() => ask(item)}><Clock3 size={16} /><span><strong>{item}</strong><small>重新运行</small></span></button>)}</section><section className="panel agent-router-note"><h3><GitBranch size={16} />意图路由</h3><p>项目分析、排期模拟、资源负载、交付物检查、流程生成和发布确认统一从此入口进入。</p><span><UsersRound size={14} />当前已接入 {projects.length} 个项目</span></section></aside>
      </div>
    </div>
  )
}

function EvidenceCard({ finding, onOpenProject }: { finding: AgentEvidence; onOpenProject: AgentPageProps['onOpenProject'] }) {
  const Icon = finding.tone === 'danger' ? ShieldAlert : finding.tone === 'warning' ? Clock3 : finding.tone === 'success' ? CheckCircle2 : FileText
  return <div className={`agent-finding finding-${finding.tone}`}><Icon size={18} /><div><strong>{finding.title}</strong><p>{finding.detail}</p>{finding.projectId && <button className="link-button" type="button" onClick={() => onOpenProject(finding.projectId, finding.taskId)}>打开详情<ArrowRight size={14} /></button>}</div></div>
}

function WorkflowPreview({ workflow, onApply }: { workflow: Workflow; onApply?: () => void }) {
  const tasks = workflow.nodes.filter((node) => node.type === 'task' || node.type === 'milestone')
  return <div className="agent-workflow-preview"><div><strong>流程草稿预览</strong><span>{tasks.length} 个任务 · {workflow.edges.length} 条连线</span></div><ol>{tasks.map((task) => <li key={task.id}><span>{task.wbs}</span><strong>{task.name}</strong><small>{task.duration} 天 · {task.owner}</small></li>)}</ol>{onApply && <button className="button button-primary button-compact" type="button" onClick={onApply}>载入流程图确认</button>}</div>
}

function ProjectCreatePreview({ action, completed, executing, disabled, onConfirm }: { action: AgentAction; completed: boolean; executing: boolean; disabled: boolean; onConfirm: () => void }) {
  const draft = action.projectDraft
  if (!draft) return null
  return <div className="agent-project-create-preview"><div className="agent-project-create-heading"><div><strong>项目创建预览</strong><span>{draft.start} → {draft.end}</span></div><StatusBadge tone={completed ? 'success' : 'warning'}>{completed ? '已创建' : '需确认'}</StatusBadge></div><p><strong>{draft.name}</strong>{draft.taskSpecs.length > 0 ? ` · ${draft.taskSpecs.length} 个流程任务` : ''}</p>{draft.taskSpecs.length > 0 && <ol>{draft.taskSpecs.map((task, index) => <li key={`${task.name}-${index}`}><span>{index + 1}</span><strong>{task.name}</strong><small>{task.duration} 天</small></li>)}</ol>}{!completed && <button className="button button-primary button-compact" type="button" onClick={onConfirm} disabled={disabled || executing}>{executing ? '正在创建…' : disabled ? '当前页面未接入创建权限' : '确认创建项目'}</button>}</div>
}

function AgentActionPreview({ action, completed, executing, disabled, onConfirm }: { action: AgentAction; completed: boolean; executing: boolean; disabled: boolean; onConfirm: () => void }) {
  const task = action.taskDraft
  const patch = action.taskPatch
  const description = action.kind === 'create-task'
    ? `新增任务“${task?.name ?? '未命名'}”${task?.duration === undefined ? '' : ` · ${task.duration} 天`}`
    : action.kind === 'update-task'
      ? `修改任务${patch?.name ? `名称为“${patch.name}”` : ''}${patch?.duration === undefined ? '' : ` · 工期 ${patch.duration} 天`}${patch?.progress === undefined ? '' : ` · 进度 ${patch.progress}%`}${patch?.status ? ` · 状态 ${patch.status}` : ''}`
      : action.kind === 'delete-task'
        ? '删除该任务及其关联连线（可通过任务恢复入口恢复）'
        : action.kind === 'assign-task'
          ? `${action.assignmentMode === 'remove' ? '移除' : '添加'}负责人：${action.memberName ?? '未指定'}`
          : action.kind === 'submit-deliverable'
            ? `提交交付物“${action.deliverable?.name ?? '未命名附件'}”`
            : action.kind === 'get-predecessor-deliverable'
              ? `获取前置交付物“${action.deliverable?.name ?? '指定文件'}”`
              : '发布当前流程草稿'
  return <div className="agent-project-create-preview agent-task-action-preview"><div className="agent-project-create-heading"><div><strong>{action.kind === 'create-task' ? '新增任务预览' : action.kind === 'update-task' ? '修改任务预览' : action.kind === 'delete-task' ? '删除任务预览' : action.kind === 'assign-task' ? '负责人调整预览' : action.kind === 'submit-deliverable' ? '交付物提交预览' : action.kind === 'get-predecessor-deliverable' ? '前置交付物获取预览' : '流程发布预览'}</strong><span>{action.kind === 'publish-workflow' ? '将发布当前流程草稿' : action.kind === 'get-predecessor-deliverable' ? '权限校验后打开文件' : action.projectId ? '已定位到授权项目' : '未定位项目'}</span></div><StatusBadge tone={completed ? 'success' : 'warning'}>{completed ? '已执行' : '需确认'}</StatusBadge></div><p>{description}</p>{!completed && <button className="button button-primary button-compact" type="button" onClick={onConfirm} disabled={disabled || executing}>{executing ? '正在执行…' : disabled ? '当前页面未接入执行权限' : action.kind === 'delete-task' ? '确认删除任务' : action.kind === 'publish-workflow' ? '确认发布流程' : action.kind === 'submit-deliverable' ? '确认提交交付物' : action.kind === 'get-predecessor-deliverable' ? '确认获取交付物' : '确认执行'}</button>}</div>
}

function toNewProjectInput(draft: AgentProjectDraft): NewProjectInput {
  return { name: draft.name, code: draft.code ?? '', owner: draft.owner ?? '', department: draft.department ?? '研发中心', start: draft.start, end: draft.end }
}

function toneForIntent(intent: AgentIntent): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  if (intent === 'workflow-publish') return 'warning'
  if (intent === 'workflow-generate') return 'accent'
  if (intent === 'portfolio-analysis' || intent === 'schedule-analysis') return 'danger'
  if (intent === 'resource-analysis' || intent === 'deliverable-analysis') return 'warning'
  return 'accent'
}

function countTasks(workflows: Record<string, Workflow>) {
  return Object.values(workflows).reduce((count, workflow) => count + workflow.nodes.filter((node) => node.type === 'task' || node.type === 'milestone').length, 0)
}

function actorRoleLabel(role: AgentActorRole) {
  return role === 'publisher' ? '流程发布者' : role === 'editor' ? '流程编辑者' : role === 'executor' ? '执行成员' : '只读成员'
}
