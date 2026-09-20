import { X } from 'lucide-react'
import { useState } from 'react'
import type { ProjectPortfolio } from '../types'

export interface NewProjectInput {
  name: string
  code: string
  owner: string
  department: string
  start: string
  end: string
  portfolioId?: string
}

interface ProjectCreateDialogProps {
  onClose: () => void
  onCreate: (input: NewProjectInput) => void
  portfolios?: ProjectPortfolio[]
  allowPortfolioSelection?: boolean
  initialPortfolioId?: string
}

export function ProjectCreateDialog({ onClose, onCreate, portfolios = [], allowPortfolioSelection = true, initialPortfolioId = '' }: ProjectCreateDialogProps) {
  const [form, setForm] = useState<NewProjectInput>(() => {
    const defaultStart = new Date()
    const defaultEnd = new Date(defaultStart.getTime() + 90 * 24 * 60 * 60 * 1000)
    return { name: '', code: '', owner: '陈默', department: '研发中心', start: defaultStart.toISOString().slice(0, 10), end: defaultEnd.toISOString().slice(0, 10), portfolioId: initialPortfolioId }
  })

  const update = (field: keyof NewProjectInput, value: string) => setForm((current) => ({ ...current, [field]: value }))

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.name.trim()) return
    onCreate({ ...form, name: form.name.trim(), code: form.code.trim() })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
        <header className="modal-header"><div><p className="page-context">项目立项</p><h2 id="create-project-title">新建项目</h2><p>先建立项目，再在流程图中配置研发任务。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭新建项目"><X size={19} /></button></header>
        <form onSubmit={submit}>
          <div className="modal-body">
            <label className="form-field"><span>项目名称 <em>*</em></span><input autoFocus required value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：智谷二期研发" /></label>
            <div className="form-grid"><label className="form-field"><span>项目编号</span><input value={form.code} onChange={(event) => update('code', event.target.value)} placeholder="留空自动生成" /></label><label className="form-field"><span>负责人</span><input value={form.owner} onChange={(event) => update('owner', event.target.value)} /></label></div>
            <label className="form-field"><span>所属部门</span><input value={form.department} onChange={(event) => update('department', event.target.value)} /></label>
            {allowPortfolioSelection ? <label className="form-field"><span>所属项目组合</span><select value={form.portfolioId} onChange={(event) => update('portfolioId', event.target.value)}><option value="">暂不归入组合</option>{portfolios.map((portfolio) => <option value={portfolio.id} key={portfolio.id}>{portfolio.name}（{portfolio.code}）</option>)}</select></label> : <p className="form-note">L2 新建项目默认暂不归入项目组合，后续由 L1 统一调整组合归属。</p>}
            <div className="form-grid"><label className="form-field"><span>开始日期</span><input type="date" value={form.start} onChange={(event) => update('start', event.target.value)} /></label><label className="form-field"><span>目标结束日期</span><input type="date" value={form.end} onChange={(event) => update('end', event.target.value)} /></label></div>
            <p className="form-note">创建后会自动生成“项目开始”和“项目结束”节点，后续任务通过流程图添加。</p>
          </div>
          <footer className="modal-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="submit">创建并打开流程图</button></footer>
        </form>
      </section>
    </div>
  )
}
