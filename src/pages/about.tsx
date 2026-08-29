const REPO_URL = 'https://github.com/CasingAI/zcodeStats'

export function AboutPage() {
  return (
    <div class="page">
      <h1 class="page__title">关于</h1>
      <p class="page__subtitle">ZCode 用量分析 — 本地化、可拖拽的 SQLite 浏览器分析工具</p>

      <div class="section">
        <h2 class="section__title">项目仓库</h2>
        <p style={{ fontSize: 14, lineHeight: 1.7, margin: '8px 0 0' }}>
          源码、Issue 与贡献:
          {' '}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--link, #0a66c2)', wordBreak: 'break-all' }}
          >
            {REPO_URL}
          </a>
        </p>
      </div>

      <div class="section">
        <h2 class="section__title">使用说明</h2>
        <ol style={{ margin: '8px 0 0 20px', padding: 0, fontSize: 13, lineHeight: 1.7 }}>
          <li>在 ZCode 中正常使用一段时间,让 <code>~/.zcode/cli/db/db.sqlite</code> 里积累数据。</li>
          <li>点右上角「打开 db.sqlite」,或直接把文件拖进浏览器窗口。</li>
          <li>在左侧导航切换「总览 / 按模型 / 按日趋势 / 按会话 / 按小时 / 按工具 / 错误与重试 / SQL 控制台」查看不同维度的统计。</li>
          <li>需要原始数据时,可在 SQL 控制台里直接写查询。</li>
        </ol>
      </div>

      <div class="section">
        <h2 class="section__title">隐私</h2>
        <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.7 }}>
          本工具完全在浏览器中运行:数据库通过
          <code> OPFS </code>
          或
          <code> File </code>
          句柄读取,所有 SQL 在本地
          <code> sql.js </code>
          引擎里执行,网络请求只发生在首次加载页面资源时。
        </p>
      </div>
    </div>
  )
}
