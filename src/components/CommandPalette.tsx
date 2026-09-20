import { useEffect, useRef, useState } from 'react'
import { Bell, Bot, BriefcaseBusiness, CheckSquare2, ClipboardList, Clock3, ContactRound, FolderKanban, Hand, Search, UsersRound, X } from 'lucide-react'

export type ViewId = 'portfolio' | 'projects' | 'project' | 'mytasks' | 'claimtasks' | 'notifications' | 'resources' | 'timesheets' | 'risks' | 'costs' | 'approvals' | 'members' | 'agent'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onNavigate: (view: ViewId) => void
  canManageMembers?: boolean
  canUseAgent?: boolean
  canViewPortfolioManagement?: boolean
  canManageApprovals?: boolean
}

const commands: Array<{ id: ViewId; label: string; hint: string; icon: typeof Search }> = [
  { id: 'portfolio', label: '打开项目组合概览', hint: '查看整体健康度', icon: BriefcaseBusiness },
  { id: 'projects', label: '打开项目列表', hint: '筛选与查看项目', icon: FolderKanban },
  { id: 'project', label: '打开智能工厂一期', hint: 'WBS 与甘特图', icon: FolderKanban },
  { id: 'mytasks', label: '打开我的任务', hint: '查看跨项目待办', icon: ClipboardList },
  { id: 'claimtasks', label: '打开认领任务', hint: '从全局任务池认领任务', icon: Hand },
  { id: 'notifications', label: '打开通知中心', hint: '查看任务提醒与模板', icon: Bell },
  { id: 'resources', label: '打开资源负载', hint: '检查人员容量', icon: UsersRound },
  { id: 'timesheets', label: '打开工时', hint: '填报与审批', icon: Clock3 },
  { id: 'approvals', label: '打开 OA 审批', hint: '查看待处理与历史审批', icon: CheckSquare2 },
  { id: 'members', label: '打开人员管理', hint: '查看成员与全局权限', icon: ContactRound },
  { id: 'agent', label: '询问 Project Agent', hint: '分析项目与生成行动项', icon: Bot },
]

export function CommandPalette({ open, onClose, onNavigate, canManageMembers = false, canUseAgent = false, canViewPortfolioManagement = false, canManageApprovals = false }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const availableCommands = commands.filter((command) => (command.id !== 'members' || canManageMembers) && (command.id !== 'agent' || canUseAgent) && (command.id !== 'approvals' || canManageApprovals) && (!['resources', 'timesheets', 'risks', 'costs'].includes(command.id) || canViewPortfolioManagement))
  const filtered = availableCommands.filter((command) => `${command.label}${command.hint}`.toLowerCase().includes(query.toLowerCase()))

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((current) => Math.min(current + 1, filtered.length - 1))
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((current) => Math.max(current - 1, 0))
      }
      if (event.key === 'Enter' && filtered[activeIndex]) {
        onNavigate(filtered[activeIndex].id)
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [activeIndex, filtered, onClose, onNavigate, open])

  if (!open) return null

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="快速前往">
        <div className="palette-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            placeholder="搜索页面或项目"
            aria-label="搜索命令"
          />
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭快速前往"><X size={18} /></button>
        </div>
        <div className="palette-results" role="listbox" aria-label="可用命令">
          {filtered.map((command, index) => {
            const Icon = command.icon
            return (
              <button
                key={command.id}
                className={`palette-command ${index === activeIndex ? 'is-active' : ''}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => { onNavigate(command.id); onClose() }}
              >
                <span className="command-icon"><Icon size={18} aria-hidden="true" /></span>
                <span><strong>{command.label}</strong><small>{command.hint}</small></span>
                <kbd>↵</kbd>
              </button>
            )
          })}
          {filtered.length === 0 && <div className="empty-compact">没有匹配的页面或项目。</div>}
        </div>
        <footer className="palette-footer"><span>↑↓ 选择</span><span>↵ 打开</span><span>Esc 关闭</span></footer>
      </section>
    </div>
  )
}
