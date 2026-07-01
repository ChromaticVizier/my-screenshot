# 整页截图 MoE 实现与扩展指南

> 适用分支：`feat/MoE`。
> 本文描述当前代码中「整页（长截图）MoE 路由」的实际实现、如何新增专家、以及各路径的测试站点清单。
> 所有文件路径、方法名均与代码一致；如与代码不符，以代码为准。

---

## 一、整体 MoE 流程

### 1.1 触发链路（从点击到落盘）

```
popup「整页截图」按钮
  └─ src/services/capture.ts  captureFullPage()
       └─ chrome.runtime.sendMessage({ type: CAPTURE_FULL_PAGE })
            └─ src/background/index.ts  onMessage → handleCaptureFullPageRouted(request)   ← MoE 唯一入口
                 ├─ 1) 取设置 + 取可截图标签页
                 ├─ 2) 决策：选出专家（probe → classify）
                 ├─ 3) 写路由日志（网址 + 类型）
                 ├─ 4) 调试浮层（可选，展示后移除）
                 └─ 5) 分派到专家 handler → 滚动截图 → 拼接 → 下载
```

入口编排全部在 **`src/background/handlers/fullPageRouter.ts`** 的 `handleCaptureFullPageRouted()`。

### 1.2 决策逻辑（gating 网络）

| 步骤 | 文件 · 方法 | 作用 |
|---|---|---|
| 探测信号 | `src/background/injected/probePageType.ts` · `probePageType()` | 注入**主 frame**，一次无副作用遍历采集页面特征，返回 `PageTypeProbe`（见下）。唯一副作用：探测 window 可滚性时 `scrollBy(+1)` 后立即还原。 |
| 注入封装 | `fullPageRouter.ts` · `probe(tabId)` | 用 `chrome.scripting.executeScript` 跑 `probePageType`，失败返回 `null`（兜底走 standard）。 |
| 纯函数分类 | `fullPageRouter.ts` · `classifyPageType(p)` | 把 `PageTypeProbe` 映射到专家，返回 `RouteDecision { expert, reason }`。**无 IO、可单测**。 |

`PageTypeProbe`（`probePageType.ts` 导出）关键字段：

| 字段 | 含义 |
|---|---|
| `windowScrollable` | window 自身是否可滚 |
| `docOverflowPx` | 文档可滚溢出量 |
| `scrollerCandidateCount` | 命中「内部滚动容器」判据的元素个数 |
| `bestScrollerScore` / `bestScrollerCoversViewport` / `bestScrollerScrollHeightRatio` | 最高分内部滚动容器的可见面积比 / 是否占视口主体（宽≥60%vw 且高≥60%vh）/ scrollHeight 占文档比 |
| `dominantIframe { src, sameOrigin, areaRatio }` | 最大可见 iframe 及其面积占比 |
| `fixedStickyCount` / `fullscreenOverlay` / `bodyScrollLocked` | fixed/sticky 数量 / 是否有近全屏高层级遮罩 / body 是否锁滚 |

`classifyPageType` 判定顺序（**默认安全**：只在高置信时才升级，否则回退 standard）：

```
1) dominantIframe.areaRatio ≥ 0.6 且 src 为 http(s)            → iframe
2) !windowScrollable 且 bestScrollerCoversViewport 且 候选≥1   → isolate
3) bodyScrollLocked 且 bestScrollerCoversViewport              → isolate
4) 其余                                                        → standard
```

**优先级高于上述自动判定的两条捷径**（在 `handleCaptureFullPageRouted` 内）：
- `settings.fullPageMode` 为 `"standard"` / `"isolate"` → 手动挡，跳过探测，直接用指定专家。
- `settings.siteScrollRegions[hostname]` 存在（用户 picker 选过滚动区）→ 沿用 `standard`（其 `preparePage` 会用该选择器 / frameUrl），不再自动判别。

### 1.3 三个专家（路径）

| 专家标识 | 入口 handler | 路径要点 | 复用的注入逻辑 |
|---|---|---|---|
| `standard` | `src/background/handlers/capture.ts` · `handleCaptureFullPage` | 首帧保留顶栏/弹窗 → 之后 `hideFixedElements` 隐藏 + `contentOffsetY` 让位 → 逐帧滚动拼接。window 滚动 / 内容分散页面最稳，**默认兜底**。 | `preparePage` / `flattenOversizedModals` / `detectAndHidePseudoSticky` / `measureTopHeaderBottom` / `rehideFixedElements` / `scrollToY` / `waitForDynamicContent` … |
| `isolate` | `src/background/handlers/captureFullPageAggressive.ts` · `handleCaptureFullPageAggressive` | `preparePage` 找主滚动容器 → `isolateScroller` 把容器祖先链外元素全 `display:none` → 重测裁切区 → 统一帧滚动拼接。无顶栏/侧栏逐帧重复。 | `isolateScroller` / `measureScrollerRect`（`fullPageAggressive.ts`）+ 共用注入函数 |
| `iframe` | 同 `handleCaptureFullPageAggressive`，但路由传入**合成 siteRule** `{ frameUrl: dominantIframe.src }` | `resolveFrameTarget` 把注入 target 切到该 iframe，主 frame 用 `hideOutsideFrameChain` 只留承载 iframe 的链；`locateFrameOffsetInPage` 求 iframe 在主视口的偏移用于切片。 | 同 isolate + `hideOutsideFrameChain` |

> `standard` / `isolate` 两 handler 都接受可选第二参 `routing?: FullPageRouting`（定义在 `fullPageShared.ts`）。`routing.siteRuleOverride` 让路由器临时注入「合成滚动区规则」——iframe 专家正是借此把 `frameUrl` 喂给隔离流程，**无需用户手动 picker**。

### 1.4 公共设施

| 文件 · 方法 | 作用 |
|---|---|
| `fullPageShared.ts` · `safeCaptureVisibleTab` | `captureVisibleTab` 限频包装（两专家共享时间戳，避免撞 quota） |
| `fullPageShared.ts` · `resolveFrameTarget` / `locateFrameOffsetInPage` | frameUrl → InjectionTarget；iframe 在主 frame 的偏移定位 |
| `src/background/utils/imaging.ts` · `stitchToBlob` / `cropToBlob` / `dataUrlToBitmap` | OffscreenCanvas 切片拼接、裁切 |
| `src/background/utils/download.ts` · `downloadImageBlob` | 触发下载（或转交编辑器裁剪） |
| `src/background/utils/tabHelper.ts` · `getCapturableActiveTab` | 取当前可截图标签页 |

### 1.5 调试 / 数据落地

| 能力 | 文件 · 方法 | 说明 |
|---|---|---|
| 路由日志 | `src/shared/routeLog.ts` · `appendRouteLog` / `getRouteLog` / `clearRouteLog` | 每次整页截图追加一条 `RouteLogEntry { t, url, hostname, expert, mode, reason, signals }`，存 `chrome.storage.local` 的 `moeRouteLog`，封顶 1000 条。 |
| 页面浮层 | `src/background/injected/pageTypeToast.ts` · `showPageTypeToast` / `removePageTypeToast` | 截图前在页面顶部弹出判定类型，`TOAST_DURATION` 后移除（**早于截图**，不进图）。`DEBUG_ROUTE` 期间无条件展示。 |
| console 日志 | `fullPageRouter.ts` · `DEBUG_ROUTE` | 打开后在 service worker 控制台打印 `signals` / `decision`。 |
| 设置 UI | `src/options/index.tsx` | 「长截图模式」下拉（auto/standard/isolate）、「显示页面类型判定」开关、「导出日志 JSON / 清空日志」。 |

### 1.6 端到端时序（auto 模式 · 文字版）

```
handleCaptureFullPageRouted
  getSettings() ─ mode=auto
  getCapturableActiveTab() ─ tab, tabId, hostname
  ┌ siteScrollRegions[hostname]? ── 有 ─→ decision=standard(站点手动滚动区)
  └ 无 ─→ probe(tabId)=probePageType()  ─→ classifyPageType(signals) ─→ decision
  appendRouteLog({ url, hostname, expert, reason, signals })          ← 持久化
  if (DEBUG_ROUTE || showPageTypeToast) maybeShowDebugToast()         ← 浮层(展示后移除)
  switch(decision.expert):
     standard → handleCaptureFullPage(request)
     isolate  → handleCaptureFullPageAggressive(request)
     iframe   → handleCaptureFullPageAggressive(request, { siteRuleOverride:{frameUrl} })
```

---

## 二、路径扩展指南（如何新增一个「专家」）

新增专家本质是给 MoE 加一类页面的针对性流程。得益于路由器与专家解耦，**改动集中在少数几个「接缝」，互不影响已有路径**。

### 2.1 改动清单（按顺序）

假设要新增专家 `restaticize`（逆向法：把 fixed/sticky 就地改 relative，适配「强 JS 吸顶 / 多并列容器」页面）：

1. **扩展专家联合类型** — `src/shared/settings.ts`
   ```ts
   export type FullPageExpert = "standard" | "isolate" | "iframe" | "restaticize"
   ```
   （`RouteDecision.expert`、`RouteLogEntry.expert`、`EXPERT_LABELS` 都基于它，会自动要求补齐。）

2. **加判别信号（如需要）** — `src/background/injected/probePageType.ts`
   在 `PageTypeProbe` 增字段并在 `probePageType()` 里采集（如 `pseudoStickyCount`、`parallelScrollerCount`）。保持**无副作用**、`try/catch` 包裹每个元素访问。

3. **加分类分支** — `fullPageRouter.ts` · `classifyPageType()`
   在合适优先级插入判据，返回 `{ expert: "restaticize", reason: "..." }`。
   **务必遵循「默认安全」**：新判据要足够特异，命中不确定时让它落回 `standard`，避免改坏既有页面。

4. **加中文标签** — `fullPageRouter.ts` · `EXPERT_LABELS`
   ```ts
   restaticize: "就地静态化（强吸顶 / 多并列容器）"
   ```

5. **实现专家 handler** — 新建 `src/background/handlers/captureFullPageRestaticize.ts`
   - 签名对齐：`(request: CaptureFullPageRequest, routing?: FullPageRouting) => Promise<CaptureResponse>`。
   - **复用** `fullPageShared.ts` 的限频截图 / frame 定位、`imaging.ts` 的拼接、`fullPage.ts` 的 `preparePage` / `scrollToY` / `waitForDynamicContent` 等；只写本专家特有的 DOM 处理（注入函数放 `src/background/injected/`，自包含、不引外部模块）。

6. **接线分派** — `fullPageRouter.ts` · `handleCaptureFullPageRouted()` 的 `switch (decision.expert)`
   ```ts
   case "restaticize":
     return await handleCaptureFullPageRestaticize(request, routing)
   ```

7. **（可选）暴露手动挡** — `src/shared/settings.ts` `FullPageMode` + `src/options/index.tsx` 下拉项，方便强制走新专家做对照测试。

### 2.2 基础专家 vs 叠加修饰符

不是所有差异都要新开「基础专家」。区分两类：

- **基础专家（互斥）**：决定**滚动驱动 + 隔离方式**——standard / isolate / iframe / restaticize。新增需走 §2.1。
- **修饰符（可叠加）**：决定**加载/弹窗策略**，与基础专家正交。当前已内嵌在各 handler 里：
  - 动态/懒加载/无限流 → `waitForDynamicContent` + `kickScrollListeners` + `maxFullPageHeightPx`
  - 超屏 iframe 弹窗 / scroll-自关弹窗 → `flattenOversizedModals` / `freezeScrollModals`

  这类无需新专家；若要强化，改对应注入函数即可（影响面仅限调用它的专家）。判别提示可由 `probePageType` 增信号（如 `growsOnScroll`），但**不应**为每个修饰符组合新建专家（会专家数爆炸）。

### 2.3 验证新专家（防回归）

1. 打开 `DEBUG_ROUTE`，访问目标站点，看 service worker 控制台 `decision` 是否如期。
2. 在选项页**导出日志 JSON**，对照 §三 的站点清单核对分类是否漂移。
3. 重点回测「原本走 standard 的页面有没有被新判据误抢」——这是新专家最大的风险点。
4. 用 `reverse/*.json`（confluence / gitlab / 慕课 / 知乎 / 网易邮箱）作为固定回归样本。

---

## 三、各路径测试网站列表

> ⚠️ 说明：分类基于页面**运行时结构**（window 是否可滚 / 主滚动容器 / 主体 iframe），同一站点不同页面、改版后都可能变化。下表是**预期路由**，**实际以「导出日志 JSON」里的 `expert` 字段为准**。每条路径给出 ≥10 个代表站点。

### 3.1 `standard`（纯内容 / window 滚动 / 内容分散）

判据：`windowScrollable=true` 或无单一主导内部滚动容器。典型：传统文章/门户/代码仓库页。

| # | 站点 | 代表页面 | 备注 |
|---|---|---|---|
| 1 | 维基百科 | `zh.wikipedia.org` 任一词条 | 长正文 window 滚动 |
| 2 | MDN | `developer.mozilla.org` 文档页 | |
| 3 | CSDN | `blog.csdn.net` 博文 | 顶栏 sticky，首帧保留 |
| 4 | 博客园 | `cnblogs.com` 博文 | |
| 5 | 掘金 | `juejin.cn` 文章详情 | |
| 6 | 简书 | `jianshu.com` 文章 | |
| 7 | 知乎专栏 | `zhuanlan.zhihu.com/p/...` | 见 `reverse/知乎帖子页面.json` |
| 8 | GitHub | `github.com/owner/repo` 仓库/README | window 滚动 |
| 9 | Stack Overflow | 任一问题页 | |
| 10 | Medium | 任一 story | |
| 11 | npm | `npmjs.com/package/...` | |
| 12 | 豆瓣 | `douban.com` 电影/书籍详情 | |
| 13 | 新浪/网易/人民网 | 新闻正文页 | 含底部推荐流 |
| 14 | GitLab 个人页 | 见 `reverse/gitlab个人页面.json` | |
| 15 | 各类 WordPress/Hexo 博客 | 文章页 | |

### 3.2 `isolate`（SPA 单主滚动容器 · window 锁滚）

判据：`!windowScrollable && bestScrollerCoversViewport`（或 `bodyScrollLocked && …`）。典型：应用型 SPA「外壳固定、中栏滚动」。

| # | 站点 | 代表页面 | 备注 |
|---|---|---|---|
| 1 | 网易邮箱 | `mail.163.com` 收件箱列表 | 见 `reverse/网易邮箱收件箱列表.json`，虚拟列表 |
| 2 | ChatGPT | `chatgpt.com` 会话页 | 中间会话区内部滚动 |
| 3 | Notion | `notion.so` 页面 | |
| 4 | 语雀 | `yuque.com` 文档 | 左右栏固定、正文滚 |
| 5 | Confluence | 文档/空间页 | 见 `reverse/confluence文档.json`，JS 伪 sticky |
| 6 | Slack Web | `app.slack.com` 频道 | 消息区内部滚 |
| 7 | Discord Web | `discord.com/channels/...` | |
| 8 | 飞书 / Lark | 云文档 / 消息 | |
| 9 | 钉钉 Web | 工作台 / 文档 | |
| 10 | Jira | issue / backlog 看板 | |
| 11 | Linear | `linear.app` issue 列表 | |
| 12 | 微信读书 Web | `weread.qq.com` 阅读页 | |
| 13 | Microsoft Teams Web | 聊天 / 频道 | |
| 14 | Ant Design Pro 类后台 | 各类企业管理后台 | 左侧导航固定、内容区滚 |
| 15 | 慕课首页 | 见 `reverse/慕课首页.json` | 复核：可能是 standard |

### 3.3 `iframe`（内容主体在大 iframe 内）

判据：`dominantIframe.areaRatio ≥ 0.6 && src 为 http(s)`。典型：内嵌编辑器 / 在线文档 / 预览器。

| # | 站点 | 代表页面 | 备注 |
|---|---|---|---|
| 1 | CodePen | `codepen.io/.../full/...` 全屏预览 | 结果在 iframe |
| 2 | JSFiddle | `jsfiddle.net` Result 视图 | |
| 3 | StackBlitz | `stackblitz.com` 预览面板 | |
| 4 | CodeSandbox | 预览 iframe | |
| 5 | 在线 PDF 阅读器 | PDF.js / 各类文库内嵌阅读器 | 主体在 iframe |
| 6 | Office Online 内嵌 | 第三方页内嵌的 Word/Excel Online | |
| 7 | popo 文档 / 内嵌富文本 | 见 `fullPageShared.ts` 注释（最大 iframe 兜底） | iframe src 带时间戳 |
| 8 | GitBook 内嵌 | 帮助中心嵌 GitBook | |
| 9 | Grafana 内嵌仪表盘 | 业务页 iframe 嵌 Grafana | |
| 10 | Tableau / Power BI 内嵌 | 报表嵌入页 | |
| 11 | Zendesk / Intercom 帮助中心 | 内嵌客服/文档 iframe | |
| 12 | 在线研报 / 财报阅读器 | 券商研报内嵌阅读器 | |
| 13 | 第三方表单 | 页内嵌 Typeform / 腾讯问卷 iframe | |
| 14 | 内嵌 CMS 编辑器 | 后台用 iframe 承载富文本编辑器 | |
| 15 | 嵌入式地图/可视化大屏 | 主体为单个大 iframe 时 | |

### 3.4 其它（捷径路径，非自动判定）

| 路径 | 触发 | 代表测试方式 |
|---|---|---|
| 手动挡 `standard` / `isolate` | 选项页「长截图模式」改成对应值 | 任一站点：强制走该专家，与 auto 结果对照 |
| 站点手动滚动区 | popup「选择滚动区域」picker 选过的站点 | 任一疑难站点：选区后再截图，应走 standard 并用该选择器 |

---

## 附：关键文件速查

| 角色 | 文件 |
|---|---|
| MoE 入口 / 路由 | `src/background/handlers/fullPageRouter.ts` |
| 分类探测（注入） | `src/background/injected/probePageType.ts` |
| 调试浮层（注入） | `src/background/injected/pageTypeToast.ts` |
| 专家：standard | `src/background/handlers/capture.ts` (`handleCaptureFullPage`) |
| 专家：isolate / iframe | `src/background/handlers/captureFullPageAggressive.ts` |
| 共享注入逻辑 | `src/background/injected/fullPage.ts` / `fullPageAggressive.ts` |
| 共享编排工具 | `src/background/handlers/fullPageShared.ts` |
| 拼接 / 下载 | `src/background/utils/imaging.ts` / `download.ts` |
| 路由日志存储 | `src/shared/routeLog.ts` |
| 类型 / 设置 | `src/shared/settings.ts`（`FullPageMode` / `FullPageExpert` / `FullPageRuleSet`） |
| 设置 UI | `src/options/index.tsx` |
| 消息调度 | `src/background/index.ts` |
