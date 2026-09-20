import { X } from 'lucide-react'
import { useState } from 'react'
import type { Project } from '../types'

export interface NewProjectPortfolioInput {
  name: string
  code: string
  description: string
  projectIds: string[]
}

interface ProjectPortfolioCreateDialogProps {
  projects: Project[]
  onClose: () => void
  onCreate: (input: NewProjectPortfolioInput) => void
}

export function ProjectPortfolioCreateDialog({ projects, onClose, onCreate }: ProjectPortfolioCreateDialogProps) {
  const [form, setForm] = useState<NewProjectPortfolioInput>({ name: '', code: '', description: '', projectIds: [] })

  const toggleProject = (projectId: string) => setForm((current) => ({ ...current, projectIds: current.projectIds.includes(projectId) ? current.projectIds.filter((id) => id !== projectId) : [...current.projectIds, projectId] }))
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.name.trim()) return
    onCreate({ ...form, name: form.name.trim(), code: form.code.trim(), description: form.description.trim() })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal-card portfolio-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-portfolio-title">
        <header className="modal-header"><div><p className="page-context">项目群管理</p><h2 id="create-portfolio-title">新建项目组合</h2><p>把多个独立项目归入一个项目群，统一查看整体进度、风险和资源。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭新建项目组合"><X size={19} /></button></header>
        <form onSubmit={submit}>
          <div className="modal-body">
            <label className="form-field"><span>组合名称 <em>*</em></span><input autoFocus required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：卫星 SAR 产品线" /></label>
            <label className="form-field"><span>组合编号</span><input value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} placeholder="留空自动生成" /></label>
            <label className="form-field"><span>组合说明</span><textarea rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="描述该项目群的共同目标和范围" /></label>
            <fieldset className="portfolio-project-picker"><legend>选择包含的项目</legend>{projects.length === 0 ? <p className="drawer-empty-note">暂时没有可加入的项目。</p> : projects.map((project) => <label className="portfolio-project-option" key={project.id}><input type="checkbox" checked={form.projectIds.includes(project.id)} onChange={() => toggleProject(project.id)} /><span><strong>{project.name}</strong><small>{project.code} · {project.portfolio?.name ?? '当前未分组'}</small></span></label>)}</fieldset>
            <p className="form-note">一个项目只能归属一个项目组合；已归属其他组合的项目加入后会自动调整归属。</p>
          </div>
          <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="submit">创建并归入项目</button></footer>
        </form>
      </section>
    </div>
  )
}
