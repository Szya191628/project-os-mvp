import { ArrowDown, ArrowUp, Download, Plus, WalletCards } from 'lucide-react'
import { formatCurrency, projects } from '../data'
import { PageHeader, ProgressBar, SectionHeader, StatusBadge } from '../components/UI'

export function CostsPage() {
  const totalBudget = projects.reduce((sum, project) => sum + project.budget, 0)
  const totalActual = projects.reduce((sum, project) => sum + project.actualCost, 0)
  const committed = totalActual + 860000
  return (
    <div className="page page-enter">
      <PageHeader title="成本" description="跟踪项目预算、已发生成本、承诺成本与完工预测。" actions={<><button className="button button-secondary" type="button"><Download size={16} />导出报表</button><button className="button button-primary" type="button"><Plus size={16} />登记成本</button></>} />
      <section className="cost-summary">
        <div className="cost-primary"><span className="metric-icon"><WalletCards size={20} /></span><span>项目组合总预算</span><strong>{formatCurrency(totalBudget)}</strong><ProgressBar value={Math.round(totalActual / totalBudget * 100)} label={`已发生 ${Math.round(totalActual / totalBudget * 100)}%`} /></div>
        <div><span>已发生成本</span><strong>{formatCurrency(totalActual)}</strong><small className="trend-neutral"><ArrowUp size={13} /> 本月新增 ¥42 万</small></div>
        <div><span>承诺成本</span><strong>{formatCurrency(committed)}</strong><small>含已签采购与合同</small></div>
        <div><span>完工预测 EAC</span><strong>{formatCurrency(10140000)}</strong><small className="text-success"><ArrowDown size={13} /> 低于预算 0.9%</small></div>
      </section>

      <div className="cost-layout">
        <section className="panel cost-chart-panel"><SectionHeader title="预算消耗趋势" meta="组合层面 · 月度累计" /><div className="cost-chart" aria-label="预算和实际成本趋势图"><div className="chart-y"><span>¥10m</span><span>¥7.5m</span><span>¥5m</span><span>¥2.5m</span><span>¥0</span></div><div className="chart-area"><i /><i /><i /><i /><i /><svg viewBox="0 0 600 210" preserveAspectRatio="none" aria-hidden="true"><polyline className="budget-line" points="0,190 100,168 200,142 300,105 400,70 500,42 600,24" /><polyline className="actual-line" points="0,198 100,186 200,171 300,148 400,125 500,96 600,75" /></svg><div className="chart-x"><span>4 月</span><span>5 月</span><span>6 月</span><span>7 月</span><span>8 月</span><span>9 月</span><span>10 月</span></div></div></div><footer className="chart-legend"><span><i className="line-budget" />预算基线</span><span><i className="line-actual" />实际 + 承诺</span></footer></section>
        <section className="panel cost-structure"><SectionHeader title="成本构成" meta="已发生 + 承诺" /><div className="cost-donut" aria-label="成本构成：外部采购、人员、软件及其他"><div><strong>¥742 万</strong><small>已发生 + 承诺</small></div></div><div className="donut-legend"><span><i className="donut-a" />外部采购 <strong>42%</strong></span><span><i className="donut-b" />内部人员 <strong>33%</strong></span><span><i className="donut-c" />软件与云 <strong>18%</strong></span><span><i className="donut-d" />其他 <strong>7%</strong></span></div></section>
      </div>

      <section className="panel table-panel"><SectionHeader title="项目成本明细" meta="按预算使用率排序" /><div className="data-table cost-table"><div className="table-row table-head"><span>项目</span><span>总预算</span><span>已发生</span><span>承诺</span><span>使用率</span><span>预测偏差</span><span>状态</span></div>{projects.map((project, index) => { const usage = Math.round(project.actualCost / project.budget * 100); return <button type="button" className="table-row" key={project.id}><span><strong>{project.name}</strong><small>{project.code}</small></span><span>{formatCurrency(project.budget)}</span><span>{formatCurrency(project.actualCost)}</span><span>{formatCurrency([380000, 270000, 90000, 110000, 10000][index])}</span><span className="table-progress"><ProgressBar value={usage} tone={usage > 75 ? 'warning' : 'accent'} /><small>{usage}%</small></span><span className={index === 1 ? 'text-danger' : 'text-success'}>{index === 1 ? '+6.4%' : `−${[2.1, 0, 4.8, 1.7, 0.9][index]}%`}</span><span><StatusBadge tone={index === 1 ? 'danger' : 'success'}>{index === 1 ? '需关注' : '可控'}</StatusBadge></span></button> })}</div></section>
    </div>
  )
}
