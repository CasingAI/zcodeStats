## 修复 by-model 页面标题区"按名字聚合"按钮文字溢出

### 问题根因

`src/pages/by-model.tsx:53-87` 的 `.section__header` 是一个 `display: flex; justify-content: space-between; flex-wrap: wrap;`(global.css:207-213) 的容器。左侧是标题 + 两段说明文字(`page__title` + 两行 `page__subtitle`),右侧是内联 flex 容器放着 3 个控件(时间范围 segmented + 聚合方式 segmented + "分组管理" 按钮)。

截图里能看到右边的"分组管理"按钮(只露了"分"字)被截断 —— 这说明:

- 左侧的标题块占据了大量宽度,把右侧控件组挤到了视口右边缘之外
- 右侧控件组的 `min-width` 之和(56×3 + 56×2 + 分组管理 ≈ 240px+ padding)已经接近或超过主区域宽度,所以即使有 `flex-wrap: wrap`,也救不回来 —— 因为整组控件一起被推到屏幕外,而不是逐个换行

### 修复方案:让标题块可收缩,把空间让给控件

最小改动版本,只改 `by-model.tsx` 第 54 行那个标题 `<div>`,**不动 CSS 文件、不改文字、不动布局结构**:

**文件:** `/Users/john/Documents/GitHub/zcodeStats/src/pages/by-model.tsx`

**位置:** 第 54 行 `<div>`(包裹 `page__title` + 两个 `page__subtitle`)

**改动:** 给这个 `<div>` 加上 `minWidth: 0` 和 `flex: 1`,让标题区可以收缩(让出空间给右侧控件);同时给 `<p>` 标签加上 `minWidth: 0`,让说明文字在窄空间下正常换行/省略,而不是把整个 flex 子项撑出去。

具体修改:
1. 第 54 行的 `<div>` 增加 `style={{ minWidth: 0, flex: '1 1 280px' }}`(设个最小基础宽度,低于这个值就让右侧换行)
2. 第 56、59 行两个 `<p class="page__subtitle">` 上加 `style={{ minWidth: 0 }}`,确保长文本在收缩时能换行而不是把父级撑出去

为什么这是最小且最稳的改法:
- 不动任何 CSS 文件
- 不改用户可见的标签文字
- 不影响 `.section__header` 的 `space-between` 语义(标题块 flex 1 后,控件块自然被推到右端,空间够时还是两端对齐;空间不够时,原 `flex-wrap: wrap` 就能让控件组整体换到下一行,而不是溢出右边界)
- 跟 `.page` 的 `max-width: 1200px` 配合,大窗口下视觉无变化
- 截图里看到的"分"字被切,本质就是标题区没让出空间 —— 给标题区 `min-width: 0` 就能让右侧控件组正常显示在视口内

### 验证步骤

修改后,跑 `npm run dev` 打开 by-model 页面,在不同窗口宽度下确认:
1. 宽屏(>1200px):标题靠左,三个控件靠右,布局与现在一致
2. 中等宽度(900-1200px):标题区文字正常换行,控件组整体不被截断
3. 窄屏(<900px):控件组按预期换到标题下方,不再被右边界切掉

### 不做的事

- 不动 `segmented-control.css` 的 `min-width: 56px`(那是 iOS 风格分段的固有视觉)
- 不改 "按名字聚合" / "分组管理" 文字
- 不改 `.section__header` 的全局样式(会影响其他页面)