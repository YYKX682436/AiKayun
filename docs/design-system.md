# AiKayun 设计系统

本规范定义商城前台与管理后台共享的基础视觉语言，供新页面和后续页面迁移使用。当前代码基础见 `apps/web/assets/css/main.css`、`apps/web/app.config.ts` 与 `apps/web/app.vue`；`main.css` 和 `app.config.ts` 是唯一的设计变量来源，不生成或同步第二份 Token 文件。

## 定位与原则

- 现代、清晰、轻盈，以数字商品的可信赖感和易读性为先。
- 借鉴小米 HiUI 的秩序感、简洁层级与自然轻量感，不引入其 React 组件或照搬其颜色参数。
- 用层级、留白和边界组织信息；避免大面积玻璃、复杂渐变、强阴影和装饰动效。
- 中文优先，桌面和移动端遵循同一套颜色与组件语义。
- 商城前台突出品牌和购买体验；管理后台减少装饰、提高信息密度，保持长期使用的舒适度。
- 颜色始终传达清晰的业务含义；状态不能只靠颜色区分。

## 色彩

### 品牌主色

默认品牌使用清爽、偏冷的蓝色。完整色阶定义在 `main.css` 的 Tailwind `@theme static` 中，供语义色和需要色阶的轻量点缀复用。

| 色阶 | 值 | 主要用途 |
| --- | --- | --- |
| 50 | `#EFF6FF` | 极浅品牌底色 |
| 100 | `#DBEAFE` | 选区、标签或选中色 |
| 200 | `#BFDBFE` | 柔和强调 |
| 300 | `#93C5FD` | 深色模式的柔和强调 |
| 400 | `#60A5FA` | 深色模式主色 |
| 500 | `#3B82F6` | 中间色阶 |
| 600 | `#2563EB` | 浅色模式主色、主要操作 |
| 700 | `#1D4ED8` | 深色主色、焦点及强调 |
| 800 | `#1E40AF` | 深色文字或高强调 |
| 900 | `#1E3A8A` | 浅色模式深色品牌文字 |
| 950 | `#172554` | 最深品牌色 |

该表为 AiKayun 固定色阶，管理后台继续使用。商城前台以部署配置中的品牌色为种子，在运行时生成经过对比度检查的对应色阶，因此前台主色可与上表的默认蓝色略有不同。

Nuxt UI 语义色映射在 `app.config.ts`：`primary → brand`、`secondary → sky`、`success → green`、`info → blue`、`warning → amber`、`error → red`、`neutral → slate`。浅色模式使用较深语义色阶改善白底上的文字与按钮对比；深色模式使用较浅色阶。状态色具有固定业务含义，客户品牌色只对应品牌主色。

### 页面语义色

页面和组件应使用 Nuxt UI 的语义类，不在业务组件中另建一套颜色变量：

| 意图 | Nuxt UI 用法 | 说明 |
| --- | --- | --- |
| 页面背景 | `bg-default` | 浅色使用 slate-50（`#F8FAFC`），深色使用 slate-950 |
| 内容表面 | `bg-elevated` | 浅色为白色，深色为 slate-900；用于卡片、导航及浮层 |
| 弱化/悬停底色 | `bg-muted` | 次级区域、轻量悬停 |
| 选中强调 | `bg-accented` 或 `bg-primary/10` | 选中项和品牌提示 |
| 主要文字 | `text-default`、`text-highlighted` | 正文、标题 |
| 次要文字 | `text-muted`、`text-toned`、`text-dimmed` | 说明、辅助信息、禁用内容 |
| 分隔线 | `border-default`、`border-muted` | 容器边界和分隔 |
| 状态 | `text-success`、`text-warning`、`text-error`、`text-info` | 与文字/图标配合表达状态 |

不要在新组件中直接使用 `indigo-*`、`slate-*`、`white` 等调色板类表达主题语义。品牌浅色可使用 `primary/10` 等 Nuxt UI 语义透明度类。`neutral` 是页面基础中性色，状态色不随商家品牌色改变。

## 排版

- 使用系统字体，不加载远程字体：`system-ui`、平台系统字体，以及 PingFang SC、Microsoft YaHei、Noto Sans CJK SC 等中文回退字体。
- 正文基准 16px，行高 1.6；说明文字通常 14px，12px 仅用于次要注记。
- 页面标题一般 32–48px，二级标题 24–32px，三级标题 18–20px；通过字重（正文 400、标签 500、标题 600）建立层级，不靠紧缩字距。
- 中文正文默认自然换行；长标识和订单号允许断行，不对普通句子使用逐字断行。
- 价格、数量、时间及表格数字使用 `tabular-nums`，避免数字宽度变化造成跳动。价格符号和小数位遵循货币格式化结果，不用空格模拟对齐。

## 间距与布局

- 复用 Tailwind CSS 4 的间距与断点，不另外定义相近的间距变量。按 4px 基准组织内容，优先使用其现有 4/8/12/16/24/32px 等级。
- Nuxt UI `--ui-container` 默认 80rem（1280px）；内容容器用 `UContainer` 或 Tailwind 宽度工具，避免固定像素宽度。
- 常规页面左右留白：移动端至少 16px、平板约 24px、桌面约 32px；相关内容用 16–24px 组内间距，区块之间约 24–48px。
- 主导航高度 64px（`--ui-header-height`）。商城页面优先内容与商品；后台采用侧栏/主内容区，在窄屏下导航转为顶部内容，不制造横向滚动。
- 移动优先布局。沿用 Tailwind 的 `sm`、`md`、`lg`、`xl` 断点；商品/卡片栅格按可读宽度逐步从一列扩展，并在 320px 视口保留可用性。
- 重要触控操作目标尽量达到 44×44px，目标间保持至少 8px 间隔；不依赖 hover 才能操作。

## 圆角与阴影

- Nuxt UI `--ui-radius` 基准为 4px；全局组件层级为按钮/输入框 8px、卡片 12px、非全屏弹窗 16px，胶囊标签使用全圆角。
- 新建卡片默认以边框和留白分层，不叠加强阴影；只在浮层确有层级需要时使用 Nuxt UI 默认轻量阴影。
- 现有局部类名仍可能覆盖组件默认值。②-1 只调整了少量验证点，完整统一仍属于②-4。

## 交互与动效

- Hover 提供轻量底色或强调变化；Active 状态即时反馈；Disabled 状态降低强调度并禁止误操作；异步操作保留加载和结果提示。
- Nuxt UI 保持其键盘焦点样式，全局焦点轮廓至少 2px、颜色跟随主色。不得隐藏键盘焦点。
- 微交互通常在 120–200ms 完成，使用共享的 `ease-out` 曲线；只为状态变化服务，不添加装饰性入场动画。
- `prefers-reduced-motion: reduce` 下缩短动画和过渡，并关闭平滑滚动；加载状态仍需有静态图标、文案或禁用状态反馈。
- 错误和成功状态提供可读文字或图标，不只改变颜色。

## 前台与后台

- **商城前台：**品牌主色用于购买、关键链接和选择状态；商品图片、价格、库存/交付说明优先，分区清楚，留白服务于浏览节奏。
- **管理后台：**保持稳定中性色和状态色，减少大面积品牌色及装饰；使用紧凑但可读的表单、列表和卡片布局，危险操作始终使用 error 语义并给出明确反馈。
- 两端共享语义颜色、字体、焦点和圆角规则；页面可根据使用场景调整信息密度，不复制两套基础 Token。

## 浅色、深色及商家主题边界

- 浅色、深色和跟随系统由 Nuxt Color Mode 管理，默认 `preference` 是 `system`。明确选择的浅色或深色优先于系统设置；跟随系统时，系统偏好变化会立即更新 `value`。
- 模式偏好由 Nuxt Color Mode 写入 `localStorage` 的 `aikayun-color-mode`。这是长期应用存储键；历史 `nuxt-color-mode` 与阶段②-1临时键 `aikayun-color-mode-r1` 不参与初始化，避免旧值覆盖新的系统默认。没有额外的主题状态或同步存储。
- 模式切换使用 Nuxt UI `USelectMenu` 和 Nuxt Color Mode 的 `preference`；实际显示主题读取只读 `value`。选择器在客户端初始化后启用，SSR 提供稳定回退项。
- 店铺品牌配置位于 `runtimeConfig.public`：`storeName`、`storeLogoUrl`、`storeBrandColor`。独立部署通过 `NUXT_PUBLIC_STORE_NAME`、`NUXT_PUBLIC_STORE_LOGO_URL`、`NUXT_PUBLIC_STORE_BRAND_COLOR` 设置，无需修改源码或重新构建应用镜像。
- Logo 仅接受站内根路径或 HTTPS URL；无 Logo 时统一显示店铺名称首字。品牌色仅接受 `#RGB` 或 `#RRGGBB`；非法颜色回退为 AiKayun 默认蓝 `#2563EB`。Culori 将主色转换为 OKLCH 并裁切到 sRGB，在统一色阶生成逻辑中检查实际浅色和深色页面表面、`primary/10` 半透明底色、主按钮反白文字，以及聚焦轮廓。色阶以高于 WCAG AA 的余量生成；浏览器测试对普通品牌文字和按钮验证至少 4.5:1，对焦点轮廓验证至少 3:1。成功、信息、警告、错误色保持独立。
- 商城前台的浏览器标题由 `app.vue` 的响应式 `titleTemplate` 使用当前 `storeName`；管理后台和登录页使用固定 AiKayun 产品名称。SSR 按当前请求路由和 `runtimeConfig.public` 输出首屏标题，客户端路由时同步更新。
- 浏览器 `theme-color` 由 `app.vue` 通过 Nuxt `useHead` 与 `useColorMode().value` 同步：浅色用 `#F8FAFC`，深色用 `#020617`；SSR 模式尚未解析时先输出浅色默认值，客户端解析后随实际显示模式更新，不另存模式状态。
- 商城前台将生成的 `--ui-color-primary-*` 变量放在 `<html>` 根节点，页面导航切换时由 SSR/应用路由设置 `data-aikayun-area` 并更新根变量。管理后台及登录页不写入客户主色，沿用 AiKayun 蓝和中性色。
- 根节点作用域使 UApp 中 Teleport 到 `body` 的菜单、弹窗和抽屉继承当前区域主题；不依赖可能被 Teleport 脱离的局部容器，也不在服务端模块间共享可变主题状态。
- Color Mode 的早期 head 脚本在绘制前读取用户偏好并设置 `.light` / `.dark`；应用 SSR 不按未知系统状态分支渲染主题文案。品牌根变量由本次请求的 public runtimeConfig 计算并随首屏 HTML 输出。
- Compose 默认值可直接运行 AiKayun 蓝色配置；`docs/deployment.md` 也提供紫色配置示例。新增品牌只需在目标部署设置三项环境变量并重启 web 容器；生产构建验证会在不重建应用镜像的条件下，以另一组启动环境变量启动同一份构建产物。
- 当前没有后台可视化主题编辑器、主题数据库、配置 API、拖拽装修、主题市场或多租户/按域名主题解析。品牌配置仅在部署层维护。

## 新页面使用规范

1. 使用 Tailwind/Nuxt UI 语义类（如 `bg-default`、`text-highlighted`、`border-default`、`text-primary`）和 Nuxt UI 组件，不把品牌颜色写成具体调色板类。
2. 主要操作使用 `UButton` 的 primary 语义，次要操作用 neutral outline/ghost，危险操作用 error；不要仅通过颜色表达状态。
3. 输入项提供可见标签；表单错误贴近对应字段，加载与提交结果可感知。
4. 先保证 320px 宽度、键盘可达和 200% 缩放下可读，再扩展桌面栅格；不依赖 hover，避免横向滚动。
5. 后台列表/金额数字用 `tabular-nums`；有意覆盖默认圆角或阴影时，只在具体组件类名中说明需要。

## 当前迁移范围

②-1 建立默认变量、Nuxt UI 组件基础主题和少量布局/组件验证点；②-2 为当前正式页面接通色彩模式与前后台品牌边界；②-3 整理重复的品牌图形、统一直接使用 Nuxt UI 基础交互组件，并补齐异步错误反馈与回归验证。其他页面的全面视觉迁移仍留到②-4。

## 公共组件使用规范

优先组合 Nuxt UI 4 的原生组件，不为单页样式建立新的包装层。当前可直接使用的基础组件包括：

- 操作与输入：`UButton`、`UInput`、`UTextarea`、`UFormField`、`UForm`、`USelect`、`USelectMenu`。
- 内容与状态：`UCard`、`UAlert`、`UBadge`、`USkeleton`、`UProgress`、`UEmpty`。
- 弹层与导航：`UModal`、`USlideover`、`UDrawer`、`UDropdownMenu`、`UNavigationMenu`、`UTabs`。
- 外观：`UApp`、`UContainer`、`UTheme` 及已有的 `ThemeModeSelect`。

使用组件自己的语义色、尺寸、变体和禁用/加载能力；按钮、输入框、卡片和弹窗的圆角由 `app.config.ts` 及 `--ui-radius` 统一。异步操作必须在执行期间防止重复提交，并在失败时显示可读原因。表单标签、字段错误和全局消息分别使用 `UFormField`、字段 `error` 及 `UAlert`；只在确有持续业务状态时显示加载占位，不用颜色单独表达成功或失败。

项目自定义组件仅用于稳定且重复的项目语义：

- `BrandMark` 统一商城和后台的品牌图形显示。商城调用方从运行时店铺配置传入名称与 Logo，管理后台固定使用 AiKayun；品牌图形本身是装饰，链接仍提供可读的品牌名称。
- `ThemeModeSelect` 是浅色、深色和跟随系统的唯一入口。不要在页面或组件中另建颜色模式状态或选择器。

页面标题、说明和操作区没有跨页面重复结构时，直接使用语义化 HTML 与 Nuxt UI 组件；真实列表为空时优先使用 Nuxt UI `UEmpty`，不为尚不存在的数据创建占位流程。新业务组件以已确认的数据契约为边界。

D7 使用 `StorefrontProductCard`、`StorefrontProductGrid`、`StorefrontPagination` 与分类导航组合真实公开数据。商品卡片保持轻量信息密度、固定图片比例、品牌语义售价和明显焦点状态，整张卡片只导航至详情；缺图使用统一弱化占位，缺货与暂无可选规格使用文本/徽标区分。前台仅使用 Nuxt UI 语义 Token，不固定 AiKayun 蓝色；卡片不承载购买按钮、假库存、销量或营销倒计时。分类层级在桌面导航与触屏抽屉中共享同一树数据和链接身份。

前后台共享组件语义和交互，但品牌边界由根节点主题范围决定：商城主题来自当前请求的商家运行时配置，后台始终使用 AiKayun 蓝色。弹窗、菜单通过 Nuxt UI 的 portal/teleport 继承当前根主题；组件内不得固定 HEX、`indigo-*` 或 `slate-*` 来表达主题含义。通过 `UApp` 保持主题上下文和全局组件行为，并让 SSR 首屏与客户端导航采用同一品牌配置。

新页面选型顺序：先找 Nuxt UI 是否有匹配的基础组件；若有，直接组合并使用语义 token；仅当相同结构或稳定业务含义在多处重复时，新增边界清楚的项目组件。开始商品、订单、支付、卡密或数字交付开发时，先基于已确认的数据契约选型，不在基础组件内加入业务逻辑。

开发环境提供 `/dev-preview` 设计预览页，直接组合当前 Nuxt UI 组件和语义 Token；该路由在非开发构建的页面清单中移除。
