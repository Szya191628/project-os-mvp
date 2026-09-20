import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export function PageHeader({ title, description, eyebrow, actions }: { title: string; description: string; eyebrow?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="page-context">{eyebrow}</p>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function ProgressBar({ value, tone = 'accent', label }: { value: number; tone?: 'accent' | 'success' | 'warning' | 'danger'; label?: string }) {
  return (
    <div className="progress-wrap">
      <div className="progress-track" aria-label={label ?? `完成度 ${value}%`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <span className={`progress-fill tone-${tone}`} style={{ '--progress': `${value}%` } as React.CSSProperties} />
      </div>
      {label && <span className="progress-label">{label}</span>}
    </div>
  )
}

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }) {
  return <span className={`status-badge status-${tone}`}>{children}</span>
}

export function SectionHeader({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="section-header">
      <div><h2>{title}</h2>{meta && <p>{meta}</p>}</div>
      {action}
    </div>
  )
}

export function LinkButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <button className="link-button" type="button" onClick={onClick}>{children}<ChevronRight size={15} /></button>
}
