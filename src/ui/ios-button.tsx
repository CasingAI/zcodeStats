import type { ComponentChildren, JSX } from 'preact'
import './ios-button.css'

export type IosButtonTone = 'secondary' | 'primary' | 'danger'
export type IosButtonSize = 'default' | 'compact'

export type IosButtonProps = {
  children?: ComponentChildren
  tone?: IosButtonTone
  size?: IosButtonSize
  /** 方形图标按钮（导航箭头等） */
  icon?: boolean
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  title?: string
  class?: string
  'aria-label'?: string
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>
}

/** iOS 6 拟物按钮：灰底 / 蓝主按钮 / 危险红；可通过 --ios-button-* CSS 变量换皮 */
export function IosButton({
  children,
  tone = 'secondary',
  size = 'default',
  icon = false,
  type = 'button',
  disabled = false,
  title,
  class: className,
  'aria-label': ariaLabel,
  onClick,
}: IosButtonProps) {
  const classes = [
    'ios-button',
    `ios-button--${tone}`,
    size === 'compact' ? 'ios-button--compact' : undefined,
    icon ? 'ios-button--icon' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      class={classes}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
