import { Check, ChevronLeft, ChevronRight, Download, Plus } from 'lucide-react'
import { timesheets } from '../data'
import { PageHeader, StatusBadge } from '../components/UI'

export function TimesheetsPage() {
  const total = timesheets.reduce((sum, row) => sum + row.monday + row.tuesday + row.wednesday + row.thursday + row.friday, 0)
  return (
    <div className="page page-enter">
      <PageHeader title="工时" description="按周填报、审批并核对项目实际投入。" actions={<><button className="button button-secondary" type="button"><Download size={16} />导出</button><button className="button button-primary" type="button"><Plus size={16} />登记工时</button></>} />
      <div className="week-navigator"><button className="icon-button button-border" type="button" aria-label="上一周"><ChevronLeft size={17} /></button><div><strong>2026 年 8 月 31 日–9 月 4 日</strong><small>第 36 周</small></div><button className="icon-button button-border" type="button" aria-label="下一周"><ChevronRight size={17} /></button><button className="button button-secondary button-compact" type="button">回到本周</button></div>

      <section className="timesheet-summary">
        <div><span>本周已登记</span><strong>{total} h</strong><small>团队样例数据</small></div><div><span>待审批</span><strong>{timesheets.filter((item) => item.status === '待审批').length}</strong><small>共 2 份工时单</small></div><div><span>项目投入</span><strong>4</strong><small>跨 4 个项目</small></div><div><span>填报完整率</span><strong>75%</strong><small>1 份仍为草稿</small></div>
      </section>

      <section className="panel table-panel">
        <div className="data-table timesheet-table" role="table" aria-label="团队工时表">
          <div className="table-row table-head"><span>成员 / 项目</span><span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span><span>合计</span><span>状态</span></div>
          {timesheets.map((entry) => {
            const totalHours = entry.monday + entry.tuesday + entry.wednesday + entry.thursday + entry.friday
            return <div className="table-row" key={entry.id}><span className="timesheet-person"><span className="avatar avatar-soft">{entry.member.slice(0, 1)}</span><span><strong>{entry.member}</strong><small>{entry.project} · {entry.task}</small></span></span>{[entry.monday, entry.tuesday, entry.wednesday, entry.thursday, entry.friday].map((hours, index) => <span className="hour-cell" key={index}>{hours} h</span>)}<strong className="hour-total">{totalHours} h</strong><span><StatusBadge tone={entry.status === '已确认' ? 'success' : entry.status === '待审批' ? 'warning' : 'neutral'}>{entry.status}</StatusBadge></span></div>
          })}
          <div className="table-row timesheet-total"><span>每日合计</span>{[20, 19, 18, 18, 17].map((value, index) => <strong key={`${index}-${value}`}>{value} h</strong>)}<strong>{total} h</strong><span /></div>
        </div>
      </section>
      <div className="approval-bar"><span><Check size={18} /><strong>2 份工时单等待审批</strong><small>共 53 小时</small></span><div><button className="button button-secondary" type="button">退回修改</button><button className="button button-primary" type="button">确认工时</button></div></div>
    </div>
  )
}
