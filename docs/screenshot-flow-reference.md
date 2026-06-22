# 长截图流程参考文档

> 基于对 awesome-screenshot 插件的逆向分析，记录其长截图期间对页面的完整操作流程，供开发参考。
>
> 原始数据来源：`rev-observer-1781233163411.json`  
> 目标页面：Cloudflare Dashboard（Workers & Pages）  
> 截图时间：2026-06-12T02:59:23

---

## 概览

| 属性 | 值 |
|------|-----|
| 浏览器视口 | 1536 × 704 px |
| 页面总高度（估算） | ~1632 px |
| 截屏分段数 | 3 屏 |
| 每屏滚动步长 | ~504 px（约 0.7 倍视口高） |
| 总耗时 | ~9.3 秒（t=0 至 t=9274ms） |
| 总记录操作数 | 220 条 |

---

## 完整流程

### 阶段 1：初始化（t=0 ~ 3054ms）

**目标：** 冻结页面滚动行为，注入覆盖样式，强制页面可完整展开。

**操作：**

1. 记录初始状态快照（scrollY、视口尺寸、html/body overflow）
2. 修改 `<html>` style：
   ```css
   scroll-behavior: unset !important;
   ```
   防止后续程序滚动触发平滑动画，导致截图时页面仍在运动。

3. 向 `<head>` 注入 6 个 `<style>` 节点（插件自有的全局覆盖规则）

4. 修改 `<body>` style：
   ```css
   position: relative !important;
   min-width: 100vw !important;
   min-height: 100vh !important;
   ```
   确保 body 不因 overflow 裁剪内容，页面可完整撑开。

---

### 阶段 2：逐屏截图循环（t=3224 ~ 5168ms）

每一屏的截图流程结构相同，分为 **前处理 → 截图 → 后处理 → 滚动** 四步。

#### 每屏前处理（截图前）

**1. 处理侧边栏（sidebar）**

侧边栏使用 `sticky` 或随滚动固定的布局，直接截图会出现在每一屏。解决方案：

```css
/* 将 sidebar 改为绝对定位，top 用负值补偿当前 scrollY，使其仅出现在页面顶部 */
position: absolute !important;
transition: none !important;
left: 0px !important;
top: -[scrollY]px !important;      /* 第一屏: 0, 第二屏: -504px */
bottom: -[remainHeight]px !important;
width: 57px !important;
max-width: 57px !important;
```

**2. 处理底部固定栏**

将 `position: fixed` 的底部工具栏改为 `absolute`，并钉在视口底部等效位置：

```css
position: absolute !important;
transition: none !important;
left: 0px !important;
right: 0px !important;
bottom: 0px !important;
```

**3. 处理右下角浮层（Toast / Notification）**

```css
position: absolute !important;
transition: none !important;
right: 32px !important;
bottom: 32px !important;
width: 340px !important;
max-width: 340px !important;
```

**4. 处理其他 sticky/fixed 元素**

对 header、sidebar-wrapper、aside 内容区等有 sticky 定位的元素：

```css
position: relative !important;
inset: auto !important;
```

**5. 隐藏遮挡弹窗**（如 Cookie 同意横幅，仅第二屏起需要）

```css
visibility: hidden !important;
overflow: hidden !important;
opacity: 0 !important;
```

#### 截图

调用 `chrome.tabs.captureVisibleTab` 或等效 API 截取当前视口。

#### 每屏后处理（截图后）

按相反顺序还原所有 style 修改，包括：
- 还原 sidebar 的 position
- 还原底部栏 style 为 `""`
- 还原浮层 style 为 `""`
- 还原被隐藏弹窗的 visibility/opacity
- 还原 sticky 元素的 position

#### 滚动到下一屏

```js
window.scrollTo({ top: nextScrollY, behavior: 'instant' })
// 或直接设置 window.scrollY（需配合禁用 scroll-behavior）
```

#### 三屏详情

| 屏次 | scrollY | top 补偿 | 前处理时间 | 后处理时间 |
|------|---------|---------|-----------|-----------|
| 第 1 屏 | 0 | top: 0px | t=3224ms | t=3816ms |
| 第 2 屏 | 504 | top: -504px | t=3962ms | t=4514ms |
| 第 3 屏 | 928 | top: 0px（重新从0贴顶） | t=4639ms | t=5167ms |

> 注：第 3 屏侧边栏 top 又回到 0，bottom=-928px，说明插件在最后一屏对 sidebar 的处理策略有所不同（全程覆盖整个文档高度）。

---

### 阶段 3：全局还原（t=5168 ~ 5209ms）

截图循环结束后，执行全局清理：

1. 移除 `<head>` 中注入的 6 个 `<style>` 节点
2. 还原 `<body>` style 为 `""`
3. 还原 `<html>` 的 `scroll-behavior`（去掉 `unset !important`）
4. 还原所有在循环中修改过但尚未还原的元素 style
5. **滚动回页面顶部**（`window.scrollTo(0, 0)`），恢复用户浏览位置

---

### 阶段 4：收尾稳定期（t=5232 ~ 9274ms）

截图操作本身已结束，此阶段主要是页面自身的后续响应：

1. **t=5232**：Header 面包屑渐隐动画（`opacity-0`），由滚回顶部触发的正常过渡
2. **t=7792~8209**：侧边栏导航的大量 SVG 图标 remove/add（React 虚拟 DOM reconcile），图标从 `{0x0}` 隐藏态恢复为 `{16×16}` 正常显示
3. **t=7796**：侧边栏 wrapper 临时添加类以禁止子元素动画：
   ```
   [&_*]:!transition-none [&_*]:!duration-0 [&_*]:!animate-none
   ```
4. **t=7797**：window resize 至 `1154×698`（疑为插件内部拼接画布时调整窗口尺寸）
5. **t=8066**：移除上述禁动类，恢复正常
6. **t=9274**：记录 STOP

---

## 关键设计模式

### 1. 对称操作模式（前处理 / 后处理配对）

每次截图前的所有 DOM 修改，在截图完成后**立即全部还原**，且顺序相反。这避免了状态累积导致页面异常。

```
captureScreen(scrollY):
  savedStyles = []
  for each fixedElement:
    savedStyles.push(element.style)
    applyOverrideStyle(element)
  
  takeScreenshot()
  
  for each fixedElement in reverse:
    element.style = savedStyles.pop()
```

### 2. fixed/sticky 元素的定位转换策略

核心思路：将 `fixed`/`sticky` 元素改为 `absolute`，并用负 top 值把它"拉"到页面顶部的等效位置，使其只出现在长图的正确位置，而非每屏重复出现。

```
// fixed 元素 → absolute，位置补偿
top = -(currentScrollY)px
// 视觉效果等价于原来 fixed 在视口顶部
```

### 3. 弹窗/覆盖层的隐藏策略

使用三重属性叠加，确保元素在截图中不可见：

```css
visibility: hidden !important;
overflow: hidden !important;
opacity: 0 !important;
```

单独用 `display: none` 可能触发页面 reflow，影响布局；三重叠加在视觉上隐藏，同时保留元素占位。

### 4. 禁用所有过渡动画

在操作侧边栏时，临时在父容器添加全局禁动类：

```css
* { transition: none !important; duration: 0 !important; animation: none !important; }
```

防止 position 切换触发动画，导致截图捕获到中间态。

### 5. scroll-behavior 强制覆盖

在整个截图过程中，`<html>` 的 scroll-behavior 始终保持 `unset !important`，确保 `scrollTo()` 立即生效，不产生滚动动画帧。

---

## 元素分类处理清单

| 元素类型 | 原始定位 | 截图期间处理方式 | 还原方式 |
|---------|---------|--------------|---------|
| 侧边栏 (sidebar) | sticky / 固定宽度 | absolute + top 补偿 | 还原原 style |
| 页面底部工具栏 | fixed bottom | absolute + bottom:0 | 还原为 `""` |
| 右下角 Toast/通知 | fixed bottom-right | absolute + 固定坐标 | 还原为 `""` |
| 页面 Header | sticky top | relative + inset:auto | 还原为 `""` |
| Cookie 同意弹窗 | fixed overlay | visibility/opacity 隐藏 | 还原为 `""` |
| `<html>` | — | scroll-behavior: unset | 还原原值 |
| `<body>` | — | position:relative, min-size | 还原为 `""` |

---

## 待优化点（观察到的潜在问题）

1. **sidebar top 补偿逻辑不一致**：第 2 屏 top=-504px，第 3 屏却又变回 top=0 + bottom=-928px，说明补偿策略在最后一屏发生了切换，可能导致侧边栏在长图拼接时出现轻微错位。

2. **SVG 图标大量刷新**（t=7792~8209）：截图结束后侧边栏图标被 React 集中 reconcile，说明截图过程中这些图标处于异常状态（0×0），如果在图标刷新完毕前就拼接截图，侧边栏图标区域可能为空。建议截图流程结束后等待一个 rAF 再触发拼接。

3. **window resize 时机**（t=7797，resize 至 1154×698）：出现在截图结束后的收尾期，但时机早于 SVG 图标稳定，可能是插件为了适配拼接画布尺寸而调整了窗口，副作用触发了图标 reconcile。

4. **onetrust 弹窗仅从第 2 屏开始处理**：第 1 屏未隐藏该弹窗，如果用户打开了 Cookie 偏好面板，第 1 屏截图可能被遮挡。
