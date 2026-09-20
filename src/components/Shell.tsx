import { type ReactNode, useEffect, useState } from 'react'
import { Bell, Bot, Boxes, BriefcaseBusiness, CheckSquare2, ChevronDown, ClipboardList, Clock3, Command, ContactRound, ExternalLink, FolderKanban, Hand, Menu, Search, UsersRound, X } from 'lucide-react'
import { CommandPalette, type ViewId } from './CommandPalette'

interface ShellProps {
  activeView: ViewId
  onNavigate: (view: ViewId) => void
  children: ReactNode
  notificationUnreadCount?: number
  onOpenNotifications?: () => void
  canManageMembers?: boolean
  canUseAgent?: boolean
  canViewPortfolioManagement?: boolean
  canManageApprovals?: boolean
  currentUserName?: string
  currentUserRoleLabel?: string
  onLogout?: () => void | Promise<void>
}

const navGroups = [
  {
    label: '工作空间',
    items: [
      { id: 'portfolio' as const, label: '项目组合', icon: BriefcaseBusiness },
      { id: 'projects' as const, label: '项目', icon: FolderKanban },
      { id: 'claimtasks' as const, label: '认领任务', icon: Hand },
      { id: 'mytasks' as const, label: '我的任务', icon: ClipboardList },
      { id: 'notifications' as const, label: '通知中心', icon: Bell },
    ],
  },
  {
    label: '管理',
    items: [
      { id: 'resources' as const, label: '资源负载', icon: UsersRound },
      { id: 'timesheets' as const, label: '工时', icon: Clock3 },
      { id: 'approvals' as const, label: 'OA审批', icon: CheckSquare2 },
      { id: 'members' as const, label: '人员', icon: ContactRound },
    ],
  },
]

// 外部系统入口：新窗口打开独立部署的业务系统（不参与前端路由）。
const externalSystems = [
  { label: '物料管理系统', href: 'https://sensingorigin.cn/', icon: Boxes },
]

export function Shell({ activeView, onNavigate, children, notificationUnreadCount = 0, onOpenNotifications, canManageMembers = false, canUseAgent = false, canViewPortfolioManagement = false, canManageApprovals = false, currentUserName = '当前用户', currentUserRoleLabel = '当前权限', onLogout }: ShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const profileName = currentUserName.trim() || '当前用户'
  const profileInitials = Array.from(profileName).slice(0, 2).join('').toUpperCase()

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const navigate = (view: ViewId) => {
    onNavigate(view)
    setMobileNavOpen(false)
    setAccountMenuOpen(false)
  }

  const switchAccount = () => {
    setAccountMenuOpen(false)
    void onLogout?.()
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'is-open' : ''}`} aria-label="主导航">
        <div className="brand-row">
          <button type="button" className="brand" onClick={() => navigate('portfolio')} aria-label="返回项目组合">
            <span className="brand-mark">P</span>
            <span><strong>Project OS</strong><small>企业项目中枢</small></span>
          </button>
          <button className="icon-button mobile-only" type="button" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航"><X size={19} /></button>
        </div>

        <button className="workspace-switch" type="button">
          <span className="workspace-avatar">感</span>
          <span><strong>感知起源科技</strong><small>企业空间</small></span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>

        <nav className="nav-groups">
          {navGroups.map((group) => {
            const visibleItems = group.items.filter((item) => {
              if (group.label !== '管理') return true
              if (item.id === 'members') return canManageMembers
              if (item.id === 'approvals') return canManageApprovals
              return canViewPortfolioManagement
            })
            if (visibleItems.length === 0) return null
            return <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {visibleItems.map((item) => {
                const Icon = item.icon
                const active = activeView === item.id || (item.id === 'projects' && activeView === 'project')
                return (
                  <button key={item.id} type="button" className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate(item.id)} aria-current={active ? 'page' : undefined}>
                    <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                )
              })}
              {group.label === '工作空间' && externalSystems.map((system) => {
                const Icon = system.icon
                return (
                  <a key={system.href} className="nav-item nav-item-external" href={system.href} target="_blank" rel="noreferrer" onClick={() => { setMobileNavOpen(false); setAccountMenuOpen(false) }} title={`在新窗口打开${system.label}`}>
                    <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                    <span>{system.label}</span>
                    <ExternalLink className="nav-external-mark" size={13} aria-hidden="true" />
                  </a>
                )
              })}
            </div>
          })}
        </nav>

        {canUseAgent && <div className="sidebar-agent">
          <div className="agent-signal"><Bot size={17} aria-hidden="true" /><span>Agent 预览</span></div>
          <p>询问进度、资源与风险，获得可执行建议。</p>
          <button className="button button-secondary button-full" type="button" onClick={() => navigate('agent')}>打开 Agent</button>
        </div>}

        <div className="profile-row">
          <span className="avatar avatar-dark">{profileInitials}</span>
          <span><strong>{profileName}</strong><small>{currentUserRoleLabel}</small></span>
          <button className="icon-button" type="button" onClick={() => setAccountMenuOpen((value) => !value)} aria-label="账户菜单" aria-expanded={accountMenuOpen}><ChevronDown size={16} /></button>
          {accountMenuOpen && <div className="account-menu" role="menu">
            <div className="account-menu-heading"><strong>{profileName}</strong><small>{currentUserRoleLabel}</small></div>
            <button type="button" role="menuitem" onClick={switchAccount}>退出并切换钉钉账号</button>
          </div>}
        </div>
      </aside>

      {mobileNavOpen && <button className="nav-backdrop" type="button" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}

      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-only" type="button" onClick={() => setMobileNavOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
          <button className="search-trigger" type="button" onClick={() => setPaletteOpen(true)}>
            <Search size={17} aria-hidden="true" />
            <span>搜索项目、任务或成员</span>
            <kbd><Command size={12} />K</kbd>
          </button>
          <div className="topbar-actions">
            <span className="sample-badge">数据库模式</span>
            <button className={`icon-button ${notificationUnreadCount > 0 ? 'has-dot' : ''}`} type="button" onClick={onOpenNotifications} aria-label={notificationUnreadCount > 0 ? `通知，${notificationUnreadCount} 条未读` : '通知'}><Bell size={19} /></button>
            <button className="avatar avatar-blue" type="button" aria-label="打开个人资料">{profileInitials}</button>
          </div>
        </header>
        <main className="main-content">{children}</main>
        <footer className="system-footer"><span>Project OS MVP · 前后端联调</span><span>数据来源：PostgreSQL</span></footer>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} canManageMembers={canManageMembers} canUseAgent={canUseAgent} canViewPortfolioManagement={canViewPortfolioManagement} canManageApprovals={canManageApprovals} />
    </div>
  )
}
