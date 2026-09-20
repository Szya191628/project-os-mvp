import type { Member, Project, Risk, Task, TimesheetEntry, WorkCalendarConfig, Workflow } from './types'

export const members: Member[] = [
  { id: 'm1', name: '陈默', initials: 'CM', capacity: 40, allocation: 36, skills: ['项目治理', '供应链'] },
  { id: 'm2', name: '林珊', initials: 'LS', capacity: 40, allocation: 43, skills: ['产品设计', '业务分析'] },
  { id: 'm3', name: '周野', initials: 'ZY', capacity: 40, allocation: 38, skills: ['架构', '研发管理'] },
  { id: 'm4', name: '唐瑶', initials: 'TY', capacity: 40, allocation: 28, skills: ['数据建模', '经营分析'] },
  { id: 'm5', name: '赵启', initials: 'ZQ', capacity: 40, allocation: 35, skills: ['实施', '客户成功'] },
  { id: 'm6', name: '顾安', initials: 'GA', capacity: 40, allocation: 18, skills: ['预算', '成本控制'] },
]

export const projects: Project[] = [
  { id: 'p1', code: 'PRJ-042', name: '智能工厂一期', owner: '陈默', ownerInitials: 'CM', department: '制造中心', status: '执行中', progress: 62, start: '2026-07-06', end: '2026-11-20', budget: 3200000, actualCost: 1810000, health: '关注', memberIds: ['m1', 'm2', 'm3', 'm4'], nextMilestone: '现场联调 · 09/18' },
  { id: 'p2', code: 'PRJ-038', name: '供应链可视化', owner: '林珊', ownerInitials: 'LS', department: '供应链中心', status: '有风险', progress: 47, start: '2026-06-15', end: '2026-10-30', budget: 1850000, actualCost: 1090000, health: '预警', memberIds: ['m2', 'm3', 'm4'], nextMilestone: '数据验收 · 09/05' },
  { id: 'p3', code: 'PRJ-051', name: '海外渠道数字化', owner: '赵启', ownerInitials: 'ZQ', department: '国际业务部', status: '规划中', progress: 18, start: '2026-08-17', end: '2027-01-29', budget: 2600000, actualCost: 240000, health: '健康', memberIds: ['m1', 'm5', 'm6'], nextMilestone: '范围评审 · 09/10' },
  { id: 'p4', code: 'PRJ-029', name: '主数据治理', owner: '周野', ownerInitials: 'ZY', department: '信息技术部', status: '执行中', progress: 78, start: '2026-04-20', end: '2026-09-30', budget: 1420000, actualCost: 1180000, health: '健康', memberIds: ['m3', 'm4', 'm5'], nextMilestone: '上线复盘 · 09/25' },
  { id: 'p5', code: 'PRJ-047', name: '研发效能平台', owner: '周野', ownerInitials: 'ZY', department: '研发中心', status: '已暂停', progress: 31, start: '2026-07-20', end: '2026-12-18', budget: 980000, actualCost: 310000, health: '关注', memberIds: ['m2', 'm3'], nextMilestone: '资源决策 · 待定' },
]

export const initialTasks: Task[] = [
  { id: 't1', projectId: 'p1', wbs: '1', name: '智能工厂一期', owner: '陈默', startOffset: 0, duration: 20, progress: 62, status: '进行中', level: 0, effort: 0 },
  { id: 't2', projectId: 'p1', parentId: 't1', wbs: '1.1', name: '项目启动与范围确认', owner: '陈默', startOffset: 0, duration: 3, progress: 100, status: '已完成', level: 1, effort: 64 },
  { id: 't3', projectId: 'p1', parentId: 't1', wbs: '1.2', name: '生产现场调研', owner: '林珊', startOffset: 2, duration: 4, progress: 100, status: '已完成', dependency: '1.1 FS', level: 1, effort: 112 },
  { id: 't4', projectId: 'p1', parentId: 't1', wbs: '1.3', name: '解决方案设计', owner: '周野', startOffset: 5, duration: 5, progress: 80, status: '进行中', dependency: '1.2 FS', level: 1, effort: 160 },
  { id: 't5', projectId: 'p1', parentId: 't1', wbs: '1.4', name: '设备数据接入', owner: '周野', startOffset: 8, duration: 6, progress: 48, status: '进行中', dependency: '1.3 SS+2', level: 1, effort: 224 },
  { id: 't5b', projectId: 'p1', parentId: 't1', wbs: '1.4b', name: '现场安全校验', owner: '赵启', startOffset: 8, duration: 3, progress: 0, status: '未开始', dependency: '1.3 FS', level: 1, effort: 72 },
  { id: 't6', projectId: 'p1', parentId: 't1', wbs: '1.5', name: '现场联调', owner: '赵启', startOffset: 14, duration: 0, progress: 0, status: '未开始', dependency: '1.4 FS', milestone: true, level: 1, effort: 0 },
  { id: 't7', projectId: 'p1', parentId: 't1', wbs: '1.6', name: '试运行与培训', owner: '赵启', startOffset: 15, duration: 4, progress: 0, status: '未开始', dependency: '1.5 FS', level: 1, effort: 144 },
  { id: 't8', projectId: 'p1', parentId: 't1', wbs: '1.7', name: '一期验收', owner: '陈默', startOffset: 20, duration: 0, progress: 0, status: '未开始', dependency: '1.6 FS', milestone: true, level: 1, effort: 0 },
]

export function createNaturalWorkCalendar(): WorkCalendarConfig {
  return { mode: 'natural', name: '项目自然日', weeklyWorkdays: [1, 2, 3, 4, 5], holidays: [], customRestDays: [], makeupWorkdays: [] }
}

export function createEmptyWorkflow(projectId: string, baselineStart: string): Workflow {
  return {
    projectId,
    baselineStart,
    status: 'draft',
    version: 0,
    nodes: [
      { id: 'start', projectId, type: 'start', wbs: '0', name: '项目开始', owner: '项目组', duration: 0, effort: 0, progress: 100, status: '已完成', position: { x: 32, y: 230 } },
    { id: 'end', projectId, type: 'end', wbs: '2', name: '项目结束', owner: '项目组', duration: 0, effort: 0, progress: 0, status: '未开始', position: { x: 860, y: 230 } },
    ],
    edges: [],
    calendar: createNaturalWorkCalendar(),
  }
}

export const risks: Risk[] = [
  { id: 'r1', projectId: 'p2', title: '海外仓数据接口延迟', owner: '周野', probability: 4, impact: 5, level: '高', response: '启用每日数据质量检查，并准备批量导入回退方案', due: '2026-09-03' },
  { id: 'r2', projectId: 'p1', title: '老旧设备协议文档不完整', owner: '赵启', probability: 3, impact: 4, level: '中', response: '联合设备商完成现场抓包验证', due: '2026-09-08' },
  { id: 'r3', projectId: 'p3', title: '多地区流程口径尚未统一', owner: '林珊', probability: 3, impact: 3, level: '中', response: '按区域建立差异清单，提交范围委员会决策', due: '2026-09-12' },
  { id: 'r4', projectId: 'p4', title: '历史主数据去重误判', owner: '唐瑶', probability: 2, impact: 4, level: '低', response: '关键主数据采用双人抽检', due: '2026-09-16' },
]

export const timesheets: TimesheetEntry[] = [
  { id: 'ts1', member: '陈默', project: '智能工厂一期', task: '项目管理', monday: 4, tuesday: 4, wednesday: 3, thursday: 4, friday: 3, status: '已确认' },
  { id: 'ts2', member: '林珊', project: '智能工厂一期', task: '解决方案设计', monday: 6, tuesday: 5, wednesday: 6, thursday: 4, friday: 5, status: '待审批' },
  { id: 'ts3', member: '周野', project: '主数据治理', task: '上线准备', monday: 4, tuesday: 4, wednesday: 5, thursday: 4, friday: 4, status: '草稿' },
  { id: 'ts4', member: '唐瑶', project: '供应链可视化', task: '数据模型', monday: 6, tuesday: 6, wednesday: 4, thursday: 6, friday: 5, status: '待审批' },
]

export const formatCurrency = (value: number) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', maximumFractionDigits: 0,
}).format(value)
