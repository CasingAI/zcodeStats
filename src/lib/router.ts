import { useEffect, useState } from 'preact/hooks'

export type Route = {
  path: string
  title: string
  /** 是否在导航中默认显示 */
  showInNav?: boolean
}

export const ROUTES: readonly Route[] = [
  { path: 'overview', title: '总览', showInNav: true },
  { path: 'by-model', title: '按模型', showInNav: true },
  { path: 'by-day', title: '按日趋势', showInNav: true },
  { path: 'by-session', title: '按会话', showInNav: true },
  { path: 'by-hour', title: '按小时', showInNav: true },
  { path: 'by-tool', title: '按工具', showInNav: true },
  { path: 'errors', title: '错误与重试', showInNav: true },
  { path: 'sql', title: 'SQL 控制台', showInNav: true },
  // 参数路由：#/model/<encoded 分组名>，不在侧边栏出现
  { path: 'model', title: '模型详情' },
] as const

export type RouteName = (typeof ROUTES)[number]['path']

const DEFAULT: RouteName = 'overview'

export type RouteInfo = {
  route: RouteName
  /** hash 中第一个 '/' 之后的部分（decodeURIComponent 过），仅参数路由使用 */
  param: string
}

function parseHash(): RouteInfo {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [pathSeg = '', ...rest] = raw.split('/')
  const route = (ROUTES as readonly { path: string }[]).some((r) => r.path === pathSeg)
    ? (pathSeg as RouteName)
    : DEFAULT
  let param = rest.join('/')
  try {
    param = decodeURIComponent(param)
  } catch {
    /* 保留原样 */
  }
  return { route, param }
}

/** 跳转。path 可以带参数段，如 navigate('model/openrouter%2Fglm-5.3') */
export function navigate(path: string): void {
  const target = `#/${path}`
  if (window.location.hash !== target) {
    window.location.hash = target
  }
}

/** 订阅当前路由（含参数段） */
export function useRoute(): RouteInfo {
  const [info, setInfo] = useState<RouteInfo>(() => parseHash())
  useEffect(() => {
    const onChange = () => setInfo(parseHash())
    window.addEventListener('hashchange', onChange)
    // 首次挂载时如果 hash 空，补一个默认
    if (!window.location.hash) {
      window.location.hash = `/${DEFAULT}`
    }
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return info
}
