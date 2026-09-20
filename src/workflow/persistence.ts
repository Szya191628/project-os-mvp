import type { Workflow } from '../types.ts'

export class LatestSaveQueue<T> {
  private readonly save: (value: T) => Promise<void>
  private readonly delayMs: number
  private pending: T | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private pendingImmediate = false

  constructor(save: (value: T) => Promise<void>, delayMs = 250) {
    this.save = save
    this.delayMs = delayMs
  }

  enqueue(value: T, options: { immediate?: boolean } = {}) {
    this.pending = value
    this.pendingImmediate = this.pendingImmediate || options.immediate === true
    if (this.running) return
    this.schedule(this.pendingImmediate ? 0 : this.delayMs)
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    this.pendingImmediate = false
  }

  private schedule(delayMs: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delayMs)
  }

  private async flush() {
    if (this.running || this.pending === undefined) return
    const next = this.pending
    this.pending = undefined
    this.pendingImmediate = false
    this.running = true
    try {
      await this.save(next)
    } finally {
      this.running = false
      if (this.pending !== undefined) this.schedule(this.pendingImmediate ? 0 : this.delayMs)
    }
  }
}

export type WorkflowPersistenceActions = {
  saveDraft: (workflow: Workflow) => Promise<void>
  savePublished: (workflow: Workflow) => Promise<void>
  publish: (projectId: string) => Promise<void>
  reload: (projectId: string) => Promise<Workflow>
}

export async function persistWorkflowSnapshot(workflow: Workflow, previousWorkflow: Workflow | undefined, actions: WorkflowPersistenceActions) {
  const isPublishing = workflow.status === 'published' && previousWorkflow?.status !== 'published'
  if (workflow.status === 'published' && previousWorkflow?.status === 'published') {
    await actions.savePublished(workflow)
  } else {
    await actions.saveDraft(workflow)
    if (isPublishing) await actions.publish(workflow.projectId)
  }
  return workflow.status === 'published' ? actions.reload(workflow.projectId) : workflow
}
