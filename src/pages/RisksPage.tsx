import { Bot, Filter, Plus, ShieldAlert } from 'lucide-react'
import { projects, risks } from '../data'
import { PageHeader, SectionHeader, StatusBadge } from '../components/UI'

export function RisksPage() {
  return (
    <div className="page page-enter">
      <PageHeader title="风险" description="识别、评估并跟进跨项目风险，确保响应动作有负责人和期限。" actions={<button className="button button-primary" type="button"><Plus size={16} />登记风险</button>} />
      <div className="risk-layout">
        <section className="panel risk-matrix-panel">
          <SectionHeader title="风险矩阵" meta="概率 × 影响" />
          <div className="risk-matrix-wrap">
            <div className="matrix-y-label">概率</div>
            <div className="risk-matrix" aria-label="风险概率影响矩阵">
              {[5, 4, 3, 2, 1].map((probability) => [1, 2, 3, 4, 5].map((impact) => {
                const items = risks.filter((risk) => risk.probability === probability && risk.impact === impact)
                const score = probability * impact
                return <div className={`matrix-cell ${score >= 16 ? 'matrix-danger' : score >= 9 ? 'matrix-warning' : 'matrix-low'}`} key={`${probability}-${impact}`}>{items.map((risk) => <button type="button" key={risk.id} title={risk.title}>{risk.id.toUpperCase().replace('R', '')}</button>)}</div>
              }))}
            </div>
            <div className="matrix-x-label">影响</div>
          </div>
          <div className="matrix-legend"><span><i className="matrix-low" />低</span><span><i className="matrix-warning" />中</span><span><i className="matrix-danger" />高</span></div>
        </section>

        <section className="panel risk-summary-panel">
          <SectionHeader title="需要处理" meta="按响应期限排序" />
          <div className="risk-summary-number"><ShieldAlert size={24} /><div><strong>1 项</strong><span>高风险等待决策</span></div></div>
          <div className="risk-decision"><StatusBadge tone="danger">高风险</StatusBadge><h3>海外仓数据接口延迟</h3><p>建议确认批量导入回退方案，并冻结本轮新增数据范围。</p><div><span>负责人：周野</span><time>截止 09/03</time></div></div>
          <button className="button button-secondary button-full" type="button"><Bot size={16} />让 Agent 生成响应计划</button>
        </section>
      </div>

      <section className="panel table-panel risk-register">
        <SectionHeader title="风险台账" meta={`${risks.length} 项开放风险`} action={<button className="button button-secondary button-compact" type="button"><Filter size={15} />全部项目</button>} />
        <div className="data-table risk-table" role="table">
          <div className="table-row table-head"><span>风险</span><span>项目</span><span>等级</span><span>负责人</span><span>概率 / 影响</span><span>响应措施</span><span>期限</span></div>
          {risks.map((risk) => <button type="button" className="table-row" key={risk.id}><span><strong>{risk.title}</strong><small>{risk.id.toUpperCase()}</small></span><span>{projects.find((project) => project.id === risk.projectId)?.name}</span><span><StatusBadge tone={risk.level === '高' ? 'danger' : risk.level === '中' ? 'warning' : 'success'}>{risk.level}</StatusBadge></span><span>{risk.owner}</span><span className="mono-cell">P{risk.probability} / I{risk.impact}</span><span className="response-cell">{risk.response}</span><time>{risk.due.slice(5).replace('-', '/')}</time></button>)}
        </div>
      </section>
    </div>
  )
}
