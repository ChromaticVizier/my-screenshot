# my-screenshot

## 基本使用

手动编译安装：

```bash

git clone https://gitlab.com/zjq8947/my-screenshot.git
cd my-screenshot
pnpm i
pnpm build

```

在浏览器扩展中打开开发者模式，加载解压缩的扩展，选择`build\chrome-mv3-prod`这个文件夹。

其余使用按界面提示即可。本项目最大的技术难点在于长截图的实现。下面的部分介绍我的开发历程。

## 技术相关

### 需求

简单来说就是一个给网页长截图的插件：点一下"整页截图"按钮，吐出一张当前页面的"全景"截图，包含从上到下整个视窗的全部内容。

### 技术选型的历程

从需求来看，其实难点很明显：目前互联网上有至少14.9亿个网站，用的前端技术差异极大，要用一个统一的流程对这么大的样本建模是很困难的。我从五月中开始到现在做的所有努力都是在想办法尽可能多的兼容各种奇怪的网站。

#### 1、CDP

CDP(Chrome devtools protocol)，能够让js代码直接与浏览器渲染引擎通信，按引擎现在的状态做个预渲染，"想象"一下后面和前面的页面是什么样的。如果是很古老的网站，甚至是纯html，用CDP都没有任何问题，因为渲染引擎永远都和真实的页面效果保持一致。

但是显然现在的网页基本都是框架做的，一打开全是虚拟dom、动态加载，渲染引擎最多也只能看到当前这一两帧已经固定的东西，两边是啥样还要等scroll事件发过去js才创建，最后截出来会有大片空白或者离谱的错位。

#### 2、最基本的滚动

想靠CDP一劳永逸地获得长截图完全不可能。但可以肯定的是，作为真实的用户使用正常浏览器滚动页面时，引擎必须老老实实渲染（无论底层是捕获scroll事件还是检测页面滚动高度、或者懒加载）。那么截图时就模拟一下滚动事件，让脚本假装用户滚屏。这样能够保证：**整个网页的任何一帧都有一个时刻是绝对完整显示的**。

经过对市面上开源、闭源插件的调研，可以确定这个方向是绝对正确的，无论多么花哨的策略最后还是要一帧一帧滚着截。

在最开始的实现中，循环非常简单：getDisplayMedia抓帧 -> 往下滚一屏。如此往复最后用canvas拼接所有的帧。这个循环今天仍然是整页截图的骨架，体现在 `src/background/handlers/capture.ts` 的 `handleCaptureFullPage` 函数里（以及其他专家路径的同名入口）。每一帧调用的是 Chrome 扩展 API `captureVisibleTab`，为了避免触发 Chrome 的频率限制，这个调用被封装成了 `src/background/handlers/fullPageShared.ts` 里的 `safeCaptureVisibleTab`，内部做了限频和一次退避重试。帧与帧之间的滚动则由注入到页面上下文的 `src/background/injected/fullPage.ts` 的 `scrollToY` 函数完成——它会优先使用内部滚动容器的 `scrollTop`，找不到才退回 `window.scrollTo`。所有帧采集完毕后，用 `src/background/utils/imaging.ts` 的 `stitchToBlob` 在 OffscreenCanvas 上按 scrollY 坐标依次绘制，最终导出为 Blob。

对于比较正常的网页是可以的（约40%左右？），但是对于使用了特殊技术的页面，这会产生两个问题：1、"往下滚一屏"具体滚的是谁？它能够被滚动吗？；2、抓帧时当前页面上是否所有东西都要抓进来？

下面先解决第一个问题。

#### 3、选区功能

先看两个典型的网站：

1. [popo文档内页](https://docs.popo.netease.com/team/pc/rd_space/pageDetail/14548fc84a914eb4937603d74d0382da?popo_locale=zh&xyz=1780472073426&xyz=1780477645786#jtnw-1773996817808)
2. [宝库内页](https://baoku-test.youdao.com/home/#/notebook?projectId=585e8384-1676-466b-97d9-e32bd90d45d0&name=%E3%80%8A%E7%AF%AE%E7%90%83%E4%B8%8E%E9%B8%A1%E3%80%8B%E6%B8%B8%E6%88%8F%E8%B5%84%E6%96%99%E9%9B%86)

这两个网站很有代表性，如果你用简单的window滚动来滚popo文档，就会发现根本滚不动（或者只能滚动左边的侧边栏），这是因为右边的主体其实整个是一个iframe；而对于宝库内页，虽然没有iframe，但是它是三栏布局（知识库列表、AI聊天栏、生成产物），我不知道用户真正想要截取的是哪部分。

所以在这个版本中，我做了两个功能，一是拓宽滚动区的识别范围，找到页面上任何接受scroll（鼠标放上去能滚的）地方；二是加入手动选择滚动区，让用户可以自己选要截哪部分的长图。

手动选区的交互逻辑在 `src/background/injected/scrollRegionPicker.ts` 的 `pickScrollRegion` 函数里：它向页面注入一个半透明遮罩，用户点击后返回 `PickedScrollRegion`（含 CSS selector、所在 frame 的 URL、以及元素的滚动尺寸）。这个结果以 hostname 为 key 存入 `src/shared/settings.ts` 的 `SiteScrollRegionRule` 结构中，持久化到 `chrome.storage.local`。后续截图时，`src/background/injected/fullPage.ts` 的 `preparePage` 函数会优先读取这条规则，直接用保存的 selector 定位滚动容器，跳过自动评分流程。对于 iframe 场景，`src/background/handlers/fullPageShared.ts` 的 `resolveFrameTarget` 会把 `frameUrl` 解析成具体的 `frameId`，让后续所有注入脚本都打到正确的 frame 里。

到这一步，我的插件就已经比闭源的awesome-screenshot要高明一些了，因为它根本没考虑这两种情况。当用户选定一个滚动区后，插件后续的处理都只会围绕这个滚动区，把其它部分当成普通的页面元素，即使它们也能滚。

#### 4、基于阈值的元素隐藏

现在处理3中的第二个问题。大部分网站都是有一个顶栏的，而且大部分是fixed定位或者靠js算偏移来追着视窗走。如果无脑截取拼接，最后的图片上就全是顶栏和fixed元素。

那么怎么判断一个元素需要在某一帧中被隐藏呢？我使用的是基于阈值的判断，比如：带有fixed属性的一律隐藏、位于顶部且宽度为100vw的隐藏（顶栏常见特征）……

核心判断逻辑在 `src/background/injected/fullPage.ts` 的 `hideFixedElements` 函数里。它遍历页面上所有 fixed/sticky 元素，内部有一个 `isContentLikeFixed` 闭包函数，通过面积比（`areaRatio`）、高度比（`heightRatio`）、子树高度与文档高度之比（`subtreeRatio`）等几何阈值判断一个元素是"需要保留的主体容器"还是"应当隐藏的导航 chrome"。为了防止 SPA 在滚动过程中重新挂载顶栏节点（导致隐藏失效），每一帧截图前还会调一次同文件的 `rehideFixedElements` 做增量补扫。对于靠 JS 模拟偏移追视窗的伪 sticky 元素（computed position 仍是 static），`detectAndHidePseudoSticky` 通过探测滚动前后元素的绝对坐标漂移来识别。这些阈值通过 `src/shared/settings.ts` 的 `FullPageRuleSet` 接口暴露给用户调节，包括 `fullPageOverlapRatio`（帧间重叠比例）和 `maxFullPageHeightPx`（长图高度上限）等。

我很快发现了这种做法的限制，在大部分网站上work的阈值设定可能在另一部分网站上就完全没法用。类比一下就是，如果你想用一条曲线去拟合很多的数据点，参数少了就必然产生大方差；参数多了又会让曲线方程变得特别臃肿，这是一个构造性两难。

如果真的是常规的数据点，我会想到画个bb图得到最佳参数量，然后开始训练随机森林，弄出一个最优的曲线，但是截图的效果是不能像数据一样被量化的，必须人眼一点点看。

既然上面提到了，我做的很多努力都是在解决"某些特殊页面的元素取舍"，那是否可以借鉴机器学习中的MoE，为每种类型的页面单独做一条路径，相当于找出特征相似的数据点用多条曲线拟合，完美解决这个两难问题。

#### 5、模仿MoE

实现其实很简单，当截图流程开始时，一个判断器会开始对当前页面进行分析（它其实依然是基于阈值的，而且至今也做不到完全准确，我正在想办法解决）。定好类型之后，交给对应的专家路由去处理，比如SPA页面就找关键标签隐藏、类SPA就走阈值判断、AI聊天类的就找到底部发送框隐藏。对于iframe类的页，用户手动选区后回落到普通页面处理。

具体来说，入口是 `src/background/handlers/fullPageRouter.ts` 的 `handleCaptureFullPageRouted`，它在每次整页截图时被调用。第一步是把 `src/background/injected/probePageType.ts` 的 `probePageType` 注入到页面执行——这是 gating 网络，它对页面做一次无副作用的单遍历，采集 `windowScrollable`（window 是否可滚）、`bestScrollerCoversViewport`（是否存在占视口主体的内部滚动容器）、`hasSidebar`（是否有贯穿全高的大侧边栏）、`dominantIframe`（是否有主体 iframe）等信号，结果以 `PageTypeProbe` 结构体的形式返回给 background。第二步是把这个结构体传给同文件的纯函数 `classifyPageType`，它按优先级检查各个信号，返回一个专家标识（`FullPageExpert`）和判决理由字符串，整个判别过程没有任何副作用，便于测试。

目前的专家有六条路径：`standard` 走 `src/background/handlers/capture.ts` 的 `handleCaptureFullPage`（首帧保留顶栏，逐帧补偿隐藏，window 滚动场景最稳，兜底路径）；`isolate` 走 `src/background/handlers/captureFullPageAggressive.ts` 的 `handleCaptureFullPageAggressive`（隔离主滚动容器，把容器外的所有元素 display:none，SPA 单主滚动容器场景）；`iframe` 也走同一个 aggressive handler，但路由器会把自动探测到的主体 iframe 地址合成为 `SiteScrollRegionRule` 传入，效果与用户手动选区等价；`spa-like` 同样走 aggressive handler，区别是额外传入 `hideStructuralChrome: true`，让后续帧在裁切区之外再主动隐藏顶栏和侧边栏；`chat` 走 `src/background/handlers/captureFullPageChat.ts` 的 `handleCaptureFullPageChat`，它会在最后一帧才保留底部输入框；`embedded-doc` 走 `src/background/handlers/captureFullPageEmbeddedDoc.ts` 的 `handleCaptureFullPageEmbeddedDoc`，处理网易灵犀 SpreadJS 等用 canvas 自定义滚动的内嵌文档，改用模拟键盘 PageDown 逐页推进。每次判决结果会通过 `src/shared/routeLog.ts` 的 `appendRouteLog` 写入本地存储，可在设置页导出 JSON，用于事后核对和样本积累。

经过测试这个方法带来了极大的提升，不只是在截图效果上，工程难度上也是：之前如果发现一个截图效果不佳的页面，修改后就必须把所有测试点全部过一遍以确保本次修改不会把之前好的地方改坏；现在这样只需要测自己路径上的页面就可以了。

#### 6、URL 白名单特殊补丁

MoE 把页面分给不同专家后，仍然会遇到一些“分类大体正确，但通用专家路径里的某一步会破坏该站点”的页面。比如有道 OA 门户页会被正确判定为 `isolate`，主滚动容器也是 `.homepage`，但通用逐帧隐藏逻辑会误伤门户主体组件，导致首帧后内容全部消失；163 邮箱邮件阅读页则会被判定为 `iframe`，页面也确实存在大 iframe，但真正应该滚动的是主页面里的邮件正文外层容器，而不是 iframe 内部文档。

为了解决这类“不能为了一个网址破坏整条专家路径”的问题，现在在 MoE 分发后、正式进入专家 handler 前，加了一层 URL 白名单特殊补丁。入口仍然在 `src/background/handlers/fullPageRouter.ts` 的 `handleCaptureFullPageRouted`：页面类型判定完成后，先调用 `src/background/handlers/fullPageSpecialCases.ts` 的 `matchFullPageSpecialCase`，用当前专家类型和 URL 去查特殊名单；如果命中，就直接执行对应的专用 handler；如果没有命中，则保持原来的专家分发逻辑。

特殊名单本身不写死在 TS 里，而是单独放在 `src/background/handlers/fullPageSpecialCases.json`。它按专家路径分组，结构是一个二维数组：第一维是专家类型（`standard`、`isolate`、`iframe`、`spa-like`、`embedded-doc`、`chat`），第二维是该专家下的特殊 URL 规则。每条规则的第一个字符串是 `case-id`，后面的字符串是匹配模式。例如：

```json
{
  "isolate": [
    [
      "youdao-oa-portal",
      "https://oa.corp.youdao.com/",
      "https://oa.corp.youdao.com/wui/index.html*#/main/portal/*"
    ]
  ],
  "iframe": [
    [
      "mail-163-read",
      "https://mail.163.com/js6/main.jsp*#module=read.ReadModule*"
    ]
  ]
}
```

`fullPageSpecialCases.ts` 负责加载这个 JSON，并把 `case-id` 映射到实际 handler。JSON 只描述“哪些 URL 要特殊处理”，真正的破坏性/定制逻辑放到独立文件里，避免污染通用路径。目前已有两个补丁文件：`src/background/handlers/captureFullPageMail163Read.ts` 用于 163 邮箱阅读页，它通过合成 `SiteScrollRegionRule` 强制使用 `div.frame-main-cont-body.nui-scroll[id$="_ScrollDiv"]` 作为主滚动容器；`src/background/handlers/captureFullPageYoudaoOaPortal.ts` 用于有道 OA 门户页，它强制使用 `.homepage`，并通过 `FullPageRouting.skipFrameChromeHiding` 跳过会误伤主体的逐帧隐藏逻辑，只依赖 scroller 裁切避免顶栏/侧栏重复。

为了支持 JSON import，`tsconfig.json` 中开启了 `resolveJsonModule`。新增一个特殊站点时，推荐流程是：先在 `fullPageSpecialCases.json` 的对应专家类型下增加 `[case-id, url-pattern...]`，再新建一个独立 handler 文件保存专用截图逻辑，最后在 `fullPageSpecialCases.ts` 的 `SPECIAL_CASE_HANDLERS` 中把 `case-id` 绑定到 handler。这样每个特例的影响范围都被限制在它自己的 URL 白名单内，不会再因为修一个特殊页面而破坏同一专家路径下的其它页面。

### 最近的工作

既然有了MoE，后续其实只需要干两件事：1、优化判断器，不要出现漏判（目前没找到很好的方法，实在不行就集成一个随机森林走端侧推理）；2、优化细分路径。第二条其实很简单，直接让AI做非破坏性修改，如果认为这个页面值得独占一个expert，就给它单开一个。

我的插件包目前只有不到1MB大，而awesome-screenshot的包有24MB，我猜可能就是路径比较多。


2026-07-09

---

正在测试海量网站，把无法正常截图的放进特殊处理名单。后续维护基本也就是干这个。
