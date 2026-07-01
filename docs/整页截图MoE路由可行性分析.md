# 整页截图「MoE 页面类型路由」可行性分析

> 目标：借鉴混合专家系统（Mixture of Experts）思路，把整页（长截图）从"单条流程兜所有页面"改造为"先判别页面类型 → 路由到针对性截图流程（专家）"，从而在不污染已工作页面的前提下，逐站点扩展兼容性。
>
> 本文先盘点现状（已做的针对性处理散落在哪里），再给出页面类型分类（专家清单）、路由器（gating）设计、可行性结论与落地步骤。

---

## 一、现状盘点

### 1.1 当前其实只有「两套整页实现 + 一个全局手动开关」

调度入口在 `src/background/index.ts:41`：

```
CAPTURE_FULL_PAGE
  └─ settings.aggressiveHideMode ? handleCaptureFullPageAggressive : handleCaptureFullPage
```

| 实现 | 文件 | 策略 |
|------|------|------|
| 标准模式（默认） | `src/background/handlers/capture.ts` `handleCaptureFullPage` | 首帧保留顶栏/弹窗 → 之后 `hideFixedElements` 一次性隐藏 + `contentOffsetY` 补偿 → 逐帧滚动拼接 |
| 激进隐藏模式 | `src/background/handlers/captureFullPageAggressive.ts` | 先 `isolateScroller` 把主滚动容器祖先链外元素全 `display:none` → 全帧统一处理 |

> ⚠️ 注意：`docs/整页截图主流程分析.md` 里写的"四套实现（逆向还原 / CDP / 激进 / 标准）"与当前代码**不一致**——`reverseRestoreMode`、`useCdpForFullPage` 在 `settings.ts` 与 handlers 里都不存在，对应的 `captureFullPageReverse.ts` / `captureCdp.ts` 也无此文件。当前实际只有上面两套。该文档需同步更新。

**关键事实：模式选择是一个全局手动开关（`settings.aggressiveHideMode`），不是按页面自动判别。** 用户得自己知道"这个站要开激进模式"，本质是把 MoE 的"路由决策"甩给了用户。

### 1.2 已做的针对性处理（散落在共享注入函数里）

两套 handler 大量复用 `src/background/injected/fullPage.ts` / `fullPageAggressive.ts` 里的"专家级启发函数"。这些就是当前实际承担"兼容各类页面"职责的逻辑，但它们是**在同一条流程里被顺序无差别地全部执行**，靠各自内部的几何阈值自我裁决该不该生效：

| # | 已处理的页面特征 | 代表实现 | 典型站点 |
|---|------------------|----------|----------|
| 1 | SPA 内部主滚动容器（window 不滚，某 div 滚） | `preparePage` 多维评分选 scroller | 知乎、网易邮箱、Confluence |
| 2 | `overflow:hidden` 但 JS 可滚的容器 | `preparePage` 仅排除 `visible` | 网易系 `div.g-body` |
| 3 | fixed/sticky 顶栏逐帧重复 | `hideFixedElements` + 首帧保留 + `contentOffsetY` | 几乎所有门户/SPA |
| 4 | JS 伪 sticky（computed 非 fixed，靠 scroll 回调跟随） | `detectAndHidePseudoSticky`（物理探测漂移） | Confluence |
| 5 | 含 iframe 的超屏弹窗 | `flattenOversizedModals` + `freezeFlattenedModals` | 有道字典"全部产品" |
| 6 | 监听 scroll 即自关的弹窗 | `freezeScrollModals` / `unfreezeScrollModals` | 有道 VIP 购买弹窗 |
| 7 | 动态/懒加载内容 | `waitForDynamicContent` + `measureScrollMetrics` | 知乎信息流、图片站 |
| 8 | 只监听 wheel 的无限滚动 | `kickScrollListeners`（合成 wheel/scroll） | 知乎、网易系 |
| 9 | 无限滚动停不下来 | `maxFullPageHeightPx` 高度封顶 | 信息流/评论流 |
| 10 | `scroll-behavior:smooth` / `scroll-snap` 干扰 | `scrollToY` 临时覆盖 + 全局 freeze style | SPA 通用 |
| 11 | 跨 frame（用户 picker 选了 iframe 内滚动区） | `resolveFrameTarget` + `locateFrameOffsetInPage` + 高度夹紧 | Popo 文档、Confluence 嵌套 |
| 12 | 子 frame 模式主 frame 顶栏重复 | `hideFixedElementsExcludeFrame` / `hideOutsideFrameChain` | 内嵌 SaaS 编辑器 |
| 13 | 用户手动指定滚动区 | `siteScrollRegions`（按 hostname 记忆） | 任意疑难站点 |
| 14 | 内部容器底部 box-shadow/虚拟列表溢出 | `scrollerBottomSafetyPx` / overlap 重叠帧 | IM/聊天类、富文本编辑器 |

### 1.3 已积累的"逆向研究样本"

`reverse/` 目录下有 5 份按站点命名的 MutationObserver 录制（闭源 awesome-screenshot 在该页面的全部 DOM 操作时间线），等于现成的**页面类型研究集**：

- `confluence文档.json`、`gitlab个人页面.json`、`慕课首页.json`、`知乎帖子页面.json`、`网易邮箱收件箱列表.json`

`docs/screenshot-flow-reference.md` 还把 Cloudflare Dashboard 的逆向流程总结成了"元素分类处理清单"。这些样本可直接作为**分类器与各专家的回归验证集**。

### 1.4 现状的真实痛点（为什么要 MoE）

1. **无隔离**：所有启发逻辑跑在同一条流程，靠内部阈值自裁。改一个阈值（如 `isContentLikeFixed` 的面积比、`detectAndHidePseudoSticky` 的 `FOLLOW_RATIO`）会同时影响所有页面 → "修好 A 站点，拍坏 B 站点"。
2. **路由靠人**：唯一的"模式切换"是全局手动开关，用户无从判断该不该开。
3. **流程臃肿**：每加一类页面就往主流程塞一段补丁（flatten、freezeScroll、pseudo-sticky 探测……），`capture.ts` 的 `handleCaptureFullPage` 已超长、分支复杂。
4. **探测副作用**：`detectAndHidePseudoSticky` 的 200px 探测滚动可能误触无限滚动加载——本不该对该类页面执行的逻辑被无条件执行。

> 一句话：现在是"一个全能专家被迫处理所有页面"，MoE 要把它拆成"一个路由器 + 若干窄而精的专家"。

---

## 二、页面类型分类（专家清单）

把 1.2 的 14 项特征**收敛成可在截图前一次性判别、且彼此互斥的粗粒度类型**。粒度太细（如把"有道弹窗"单列）会退化回打补丁；粒度太粗（如只分 SPA/非 SPA）又起不到隔离作用。建议按"主滚动驱动方式 + 内容加载方式"两个主轴切：

| 专家 | 页面类型 | 判别要点 | 截图路径要点 | 对应现有能力 |
|------|----------|----------|--------------|--------------|
| **E0 静态文档型** | window 可滚的传统页面（博客/门户/文档） | `window.scrollTo` 探测可滚 + 无主导 SPA 壳 + fixed 少 | window 滚动 + 首帧保留顶栏 + 之后隐藏 fixed | 标准模式主路径 |
| **E1 SPA 单主容器型** | 单一内部滚动 div 撑起主体 | `preparePage` 评分出唯一高分 scroller + window 不滚 | scroller 隔离（激进）+ 统一帧 | 激进模式 + `isolateScroller` |
| **E2 内嵌 iframe 型** | 主体内容在某个大 iframe 内（在线文档/编辑器） | 最大可见 iframe 面积占比高 / 用户 picker 选在 iframe | frame 定位 + 偏移夹紧 + 子 frame 链隔离 | `resolveFrameTarget` / `locateFrameOffsetInPage` / `hideOutsideFrameChain` |
| **E3 无限流/虚拟列表型** | 信息流、评论流、虚拟滚动列表 | 滚动中 `scrollHeight` 持续增长 / DOM 回收（节点数稳定但内容变） | 高度封顶 + kick 唤醒 + 放宽稳定判据 + 不做探测性滚动 | `maxFullPageHeightPx` / `kickScrollListeners` / `waitForDynamicContent` |
| **E4 强弹窗遮罩型** | 进入即全屏遮罩/超屏弹窗/Cookie 横幅 | 高 z-index 全屏 fixed + `body` scroll lock | 先决策（关闭/摊平/保留）再走对应基础专家 | `flattenOversizedModals` / `freezeScrollModals` |
| **E5 复杂吸顶/多并列型**（可选） | 多个并列可滚区、强 JS 吸顶、内容分散 | 多个相近高分候选 / 伪 sticky 命中多 | 就地静态化（fixed→relative，逆向法）而非隔离 | 逆向参考 `screenshot-flow-reference.md`（尚未落地为代码） |

设计要点：

- **E4 是"前置修饰器"而非独立终点**：弹窗处理完后仍要落到 E0/E1/E2 之一。可实现为"路由前的预处理 hook"，避免与主路径正交爆炸。
- **E5 是新增能力**：目前代码没有"就地静态化"路径（逆向文档里有方案、无实现）。可作为 MoE 落地后的第一个"新专家"试点，验证"加专家不动老专家"的隔离价值。
- **用户站点规则 = 强制路由**：`siteScrollRegions` 已是按 hostname 的覆盖，天然适合升级成"强制指定专家 + 强制 scroller"。

---

## 三、路由器（Gating Network）设计

MoE 的核心是"便宜、可靠的分类"。好消息：**分类所需信号几乎都已在 `preparePage` 里采集，只是没拿来做路由**。

### 3.1 一次注入即可采集的分类特征

```
probePageType() 注入主 frame，返回结构化特征：
  - windowScrollable        : scrollTo 探测（preparePage 已有）
  - docOverflowHeight       : 文档可滚总高
  - scrollerCandidates      : 评分 ≥ 阈值的内部滚动容器数量 + 最高分/次高分
  - maxIframeAreaRatio      : 最大可见 iframe 面积 / 视口面积
  - fixedStickyCount        : fixed/sticky 元素数与总覆盖面积
  - fullscreenModal         : 是否存在高 z-index 全屏遮罩 + body 是否 scroll-lock
  - growsOnScroll           : 小步探测后 scrollHeight 是否增长（无限流信号，可选/惰性）
  - domRecycles             : 小步探测后视口内节点签名是否突变（虚拟列表信号，可选）
```

### 3.2 路由决策（规则优先，可演进为打分）

```
1. 命中 siteScrollRegions[hostname]  → 强制路由（用户/内置规则最高优先级）
2. fullscreenModal                   → 挂 E4 预处理，再继续 3~5
3. maxIframeAreaRatio ≥ 0.5          → E2 内嵌 iframe 型
4. scrollerCandidates==1 且 !windowScrollable → E1 SPA 单主容器型
5. scrollerCandidates≥2（多并列）或 强 JS 吸顶 → E5 复杂型（未实现则回退 E1/E0）
6. growsOnScroll / domRecycles       → E3 无限流/虚拟列表型（叠加到 E0/E1 之上作为"加载策略"）
7. 其余                              → E0 静态文档型（默认兜底）
```

> 建议路由器**输出"主类型 + 置信度 + 命中信号"**，低置信度时回退到当前默认流程，并把分类结果落盘（复用现有 `DEBUG_DUMP_FRAMES` 调试通道），便于用 `reverse/*.json` 样本集校准。

### 3.3 E3 与 E2 是"维度"不是"互斥类"

无限流/虚拟列表（E3）和内嵌 iframe（E2）其实是**正交维度**：知乎信息流（E0+E3）、网易邮箱列表（E1+E3 虚拟列表）、Confluence 嵌套（E2+静态）。所以更准确的模型是：

- **基础专家（互斥，决定滚动驱动 + 隔离方式）**：E0 / E1 / E2 / E5
- **加载策略修饰符（可叠加）**：E3（动态/无限/虚拟）、E4（弹窗）

这避免了"专家数量 = 特征组合数"的爆炸，与 MoE 的"少量专家 + 组合"精神一致。

---

## 四、可行性结论

| 维度 | 评估 | 说明 |
|------|------|------|
| 技术可行性 | ✅ 高 | 分类信号已在 `preparePage` 采集；两套 handler 已是 E0/E1 雏形；只是缺"路由层"与"流程参数化"。 |
| 改造成本 | 🟡 中 | 主要工作量在：抽出 pipeline 接口 + classifier + 把现有逻辑包装成专家。不是从零重写。 |
| 隔离收益 | ✅ 高 | 每个专家独立文件 + 独立参数，改 E1 不碰 E0；新增 E5 不动老路径——直击核心痛点。 |
| 误判风险 | 🟡 中 | 分类错 → 走错专家。缓解：置信度回退 + 站点规则强制覆盖 + 样本回归集。 |
| 性能开销 | ✅ 低 | 分类是一次注入探测（百毫秒级），相对整页截图秒级耗时可忽略。`growsOnScroll`/`domRecycles` 做成惰性，仅在需要时探测。 |
| 维护性 | ✅ 改善 | 主流程从"巨型分支"变成"路由表 + 窄专家"；新页面问题先归类，再决定"调专家参数 / 加新专家"。 |

**核心判断：可行，且方向正确。** 本质上是把已经存在的"隐式专家集合"显式化、并加一个自动路由器，替代当前的全局手动开关。最大价值不是立刻提升某个站点的成功率，而是**建立隔离边界**，让后续逐站点优化不再有"按下葫芦浮起瓢"的风险。

### 风险与缓解

1. **分类误判** → 置信度阈值 + 低置信回退默认流程 + `siteScrollRegions` 强制路由兜底。
2. **正交维度建模错误**（把 E3/E4 当互斥类）→ 采用 §3.3 的"基础专家 + 修饰符"模型。
3. **回归不可见** → 用 `reverse/*.json` + 实测站点建一个分类断言集，每次改路由跑一遍。
4. **一次性大改引入新 bug** → 灰度落地（见 §5），classifier 先"只观察不接管"。

---

## 五、落地步骤（增量、可灰度）

> 原则：先加路由器但不改变默认行为，验证分类准确率后再逐步接管。全程保证"随时能退回当前两套实现"。

1. **抽象 pipeline 接口**：定义 `CapturePipeline { prepare, classifyHint?, run }`，把 `capture.ts` / `captureFullPageAggressive.ts` 的公共编排（限频截图、拼接、恢复、frame 偏移）下沉到 `fullPageShared.ts`（部分已在）。
2. **落地 classifier**：新增 `probePageType` 注入函数（复用 `preparePage` 的探测）+ background 侧 `routePageType()` 返回 `{ type, modifiers, confidence, signals }`。**此阶段只把结果 `console.log` / 落盘，不改流程。**
3. **包装现有专家**：`E0 = handleCaptureFullPage`、`E1 = handleCaptureFullPageAggressive`，外加 E2 子 frame 路径（已有逻辑）抽成显式专家。
4. **接通路由（灰度）**：`index.ts` 调度改为 `route → expert`；初期仅对**高置信度**类型启用自动路由，其余仍走默认；`aggressiveHideMode` 降级为"手动覆盖路由"。
5. **建回归集**：用 `reverse/*.json` 命名的 5 个站点 + 已知疑难站点，断言"分类结果符合预期"，纳入改动前置检查。
6. **新增专家试点**：把逆向文档里的"就地静态化"实现为 **E5**，作为"新增专家不影响老专家"的第一例验证。
7. **清理**：路由稳定后，收敛 `docs/整页截图主流程分析.md`（修正其"四模式"过时描述），把散落的阈值按专家归档到各自模块。

### 建议的目标文件结构（示意）

```
src/background/
├─ handlers/
│  ├─ fullPageRouter.ts         # 路由器：probe → 选专家（新增）
│  ├─ fullPageShared.ts         # 公共编排下沉（已存在，扩充）
│  └─ experts/
│     ├─ staticDoc.ts           # E0
│     ├─ spaScroller.ts         # E1（原 aggressive）
│     ├─ embeddedIframe.ts      # E2
│     ├─ restaticize.ts         # E5（新增，逆向法）
│     └─ modifiers/
│        ├─ dynamicLoad.ts      # E3 修饰符
│        └─ modalGuard.ts       # E4 修饰符
└─ injected/
   ├─ probePageType.ts          # 分类探测注入函数（新增）
   └─ fullPage.ts               # 现有启发函数（按专家逐步归档）
```

---

## 六、待用户确认的开放问题

1. **分类粒度**：采用 §3.3 的"4 基础专家 + 2 修饰符"模型，还是先只做 E0/E1/E2 三类最小集？
2. **灰度策略**：是否接受"classifier 先只观察、人工核对若干站点后再接管路由"的稳健路线（更慢但零回归风险）？
3. **E5 优先级**：逆向法"就地静态化"是否值得作为首个新专家试点（它能验证隔离价值，但本身有 inline-style 冲突等已知坑）？
4. **手动开关去留**：`aggressiveHideMode` 是直接降级为"手动覆盖"，还是保留一段过渡期与自动路由并存？
