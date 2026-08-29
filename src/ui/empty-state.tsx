import type { ComponentChildren } from 'preact'
import './empty-state.css'

export type EmptyStateProps = {
  title: string
  description?: string
  action?: ComponentChildren
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div class="empty-state">
      <div class="empty-state__title">{title}</div>
      {description && <div class="empty-state__desc">{description}</div>}
      {action && <div class="empty-state__action">{action}</div>}
    </div>
  )
}
