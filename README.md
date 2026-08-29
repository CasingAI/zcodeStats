# ZCode 用量分析

纯前端 Preact SPA，离线分析 ZCode 的 SQLite 用量数据库（`~/.zcode/cli/db/db.sqlite`）。
**零安装、零本地服务**——双击 `dist/index.html` 就能用。

## 用法

1. **通常 ZCode 运行中也能打开**（数据库以 `immutable=1` 只读打开，跳过锁与 WAL 恢复）。如果想读到 WAL 里尚未 checkpoint 的最新数据，建议先 ⌘Q 退出 ZCode 再打开。
   - 部分情况下打开会报错，应用会在横幅里提示原因和处理方式。
2. 启动：开发模式 `npm run dev`，或先 `npm run build` 然后用浏览器打开 `dist/index.html`。
3. 两种入口任选：
   - **直接拖放** — 从 Finder 拖 `db.sqlite` 到页面任意位置即可（**推荐**）。已开着库时再拖会弹确认再替换。
   - **"打开 db.sqlite"** — 系统文件选择器。会先弹窗告诉你 db 文件的确切位置（macOS / Windows）以及"建议直接拖进来"。macOS 系统选择器默认不显示隐藏目录，按 ⌘Shift+. 切到显示隐藏文件。
4. 左侧页面切换：总览 / 按模型 / 按日趋势 / 按会话 / 按小时 / 按工具 / 错误与重试 / SQL 控制台。
5. **时间范围**：总览 / 按日趋势 / 按会话 / 按小时 都支持「近7天 / 近30天 / 全部」。
6. **模型标记**（持久化，全局生效）：按模型页可切「按ID / 按名字聚合」（按名字会去掉 `openrouter/` 这类 provider 前缀），「标记模型」弹窗里给任意 model_id 选一个目标模型（内置 32 个或自建），相同目标会被合并成一组并按目标价计算成本。标记存浏览器 localStorage，**改了任何页面的标记，所有页面的聚合 + 大致成本立即重算**。点击任意分组行进入**模型详情**（KPI + 日趋势 + 小时分布 + 大致成本）。自定义模型在弹窗底部填写单价（¥/1M token）并可删除。
7. **大致成本**：内置 32 个模型 ¥/M token 的价目表（输入 / 输出 / 缓存输入），公式 = `(输入 + 缓存写) × 输入价 + (输出 + reasoning) × 输出价 + 缓存读 × 缓存价`。模型名匹配链：标记 → 精确 → 归一化（去 provider 前缀、小写）→ 内置别名（`stealth/ox-alpha` → `GLM-5.3-Flash`）→ **默认按 deepseek-v4-pro**。表里没列的模型都会按 deepseek-v4-pro 算，**这是估值，不是真实账单**。
8. **按日趋势**有指标切换：Token 模式（总 token / 缓存读 / 输出三条线）或成本模式（单条 ¥ 折线 + 区间/日均/峰值三张 KPI 卡）。
9. 趋势图为 [uPlot](https://github.com/leeoniya/uPlot)：悬浮查值、图例点击隐藏系列、拖拽框选缩放、双击复位。

## 技术原理

- 浏览器通过 [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker) (`showOpenFilePicker`) 或 `<input type=file>` 拿到 `File` 句柄。
- 主线程 `postMessage(file, [file])` 把 `File` 句柄 transferable 到 Web Worker。
- Worker 里跑 [sqlite3 WASM](https://sqlite.org/wasm/doc/trunk/index.html)，注册了一个**自定义只读 VFS**（名为 `zcode-stats`），其 `xRead` 通过 `FileReaderSync` 同步从 `File.slice(offset, len)` 读字节。
- **不会**把整个 932MB 的库加载进内存——SQLite 请求哪个 page，VFS 就从磁盘读哪个 page。
- 整个流程：纯浏览器、零安装、不上传数据。

## 已知限制

- **WAL 模式**：数据库以 `immutable=1` 只读打开——跳过锁、WAL 恢复与 shm，因此 ZCode 正在运行时**通常**也能打开，但只读主库文件，WAL 里未 checkpoint 的最新数据**可能**读不到（取决于版本和当时的 WAL 状态）。要读到最新数据，建议先 `⌘Q` 退出 ZCode 再打开。
- **FileReaderSync 是 Worker 专属**，Firefox / Safari 走主线程就拿不到。Firefox 应该也支持 Worker FileReaderSync（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileReaderSync) 标 baseline widely available），但旧版可能不行。
- **`showOpenFilePicker` 仅 Chromium 系**（Chrome 86+ / Edge 86+）。Safari / Firefox 会自动 fallback 到 `<input type=file>`，UX 一样。
- 自定义 VFS 已在真实数据快照上端到端验证（open + schema + 聚合查询）。若仍遇到报错，**issue 报一下原始错误**。

## 开发

```bash
pnpm install
pnpm dev           # vite dev server (http://localhost:9737)
pnpm build         # 输出到 dist/
pnpm preview       # 预览 dist/
```

## 部署（Cloudflare Pages）

配置即代码：根目录 `wrangler.toml` 声明 `pages_build_output_dir = "dist"`，
任何部署方式都会被 Cloudflare 识别为 Pages 项目（不会被当成 Worker）。

- **本地部署**：`npx wrangler pages deploy`（自动读取 wrangler.toml 里的项目名 `zcodestats` 和产物目录 `dist`）
- **Git 集成**：面板里 Connect to Git 选本仓库，构建命令 `pnpm build`（或 `npm run build`），输出目录 `dist`
- 纯 hash 路由 SPA，无需 `_redirects`；WASM/MIME 由 Pages 自动处理，无需 `_headers`

## 文件结构

```
src/
├── main.tsx              # render(<App />)
├── app.tsx               # 顶部 chrome + 左侧 nav + 路由 + 入口引导
├── global.css            # iOS 6 拟物化 token
├── ui/                   # 拷自 instant-app：ios-button / segmented-control / progress / ios-text-field.css
│   ├── kpi-card.tsx      # 大数字 KPI 卡片
│   ├── data-table.tsx    # 通用表格
│   ├── uplot-chart.tsx   # uPlot 封装（时间序列 + 柱状）
│   ├── heatmap-grid.tsx  # 7×24 热力
│   └── empty-state.tsx
├── pages/                # 8 个分析页面
│   ├── overview.tsx      # 总览（含时间范围 + 成本 KPI）
│   ├── by-model.tsx      # 按模型（含模型标记 + 自定义模型 + 成本列）
│   ├── model-detail.tsx  # 模型详情（#/model/<分组>）
│   ├── by-day.tsx        # 按日趋势（Token / 成本 模式切换）
│   ├── by-session.tsx    # 按会话（+ 成本列）
│   ├── by-hour.tsx       # 按小时热力
│   ├── by-tool.tsx       # 按工具
│   ├── errors.tsx        # 错误与重试
│   └── sql-console.tsx   # 原始 SQL
├── db/
│   ├── worker.ts         # Worker：注册自定义 VFS + sqlite3 WASM + 跑 SQL
│   ├── client.ts         # 主线程：open File → transfer 到 worker → RPC
│   ├── queries.ts        # 所有 SQL + shape 函数
│   └── types.ts          # row 类型
└── lib/
    ├── format.ts         # 数字缩写 / 百分比 / 时长 / 字节 / ¥
    ├── router.ts         # hash 路由（支持 /model/<param>）
    ├── use-query.ts      # 通用数据拉取 hook
    ├── model-groups.ts   # 标记 + 自定义模型存储 + 订阅 hook + resolveGroups + applyBuiltin
    └── pricing.ts        # 32 模型价目表 + 成本估算（按 dbKey 隔离缓存）
```

## 数据口径与限制

- **byModel LIMIT 5000**：覆盖绝大多数用户。超出会显示"已截断"角标 — 切到 7d/30d 通常就能看完。
- **range 控件一致性**：所有"按 X"页 + 总览页 + 工具调用 KPI 都响应 7d/30d/all；只有 SQL 控制台不受影响（用户自写 SQL）。
- **成本是估值，不是真实账单**：内置 32 模型价目表，未列出默认按 deepseek-v4-pro 算；缓存写按"输入价"计、reasoning 并入"输出价"。改标记 / 切 range 会重算。
- **价格缓存按 dbKey 隔离**：close + open 不同 db 不会拿旧价（`pricing.clearPriceCache('*')` 全清）。
- **标记全局生效**：`zcode-stats.model-marks` + `zcode-stats.custom-models` 改一次，所有 useMarks() 订阅的页面 + 价格缓存（pricing 内部 clearPriceCache('*')）同步重算。跨 tab 同步通过 `storage` 事件。
- **内置等价映射**（`pricing.ts` BUILTIN_ALIASES_LC）：如 `openrouter/sonoma/stealth/ox-alpha` → `GLM-5.3-Flash`，大小写不敏感。后续遇到更多直接往表里加。
- **WAL**：只读 + immutable=1 打开；ZCode 运行中通常能开，但只读到主库文件，WAL 未 checkpoint 的最新数据**可能**看不到。要最新数据建议先 `⌘Q` 退出 ZCode。

## License

MIT
