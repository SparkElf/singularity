---
title: "奇点设计系统"
description: "将思源现有视觉语言升级为奇点的shadcn语义令牌、组件与交互规范"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "approved"
tags: ["singularity", "design-system", "shadcn", "siyuan"]
---

# 奇点设计系统

> 奇点不重做思源视觉风格；本系统将思源现有主题、密度与交互规则转化为可维护的shadcn设计合同。

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-13 | Codex | 建立思源到shadcn的令牌、密度、组件和交互规范 |

## Table of Contents

- [1. 设计原则](#1-设计原则)
- [2. 技术基线](#2-技术基线)
- [3. 颜色系统](#3-颜色系统)
- [4. 排版系统](#4-排版系统)
- [5. 尺寸与密度](#5-尺寸与密度)
- [6. 圆角、边框与阴影](#6-圆角边框与阴影)
- [7. 组件体系](#7-组件体系)
- [8. 布局体系](#8-布局体系)
- [9. 交互与动效](#9-交互与动效)
- [10. 可访问性](#10-可访问性)
- [11. Protyle兼容边界](#11-protyle兼容边界)
- [12. 执行约束](#12-执行约束)
- [References](#references)

## 1. 设计原则

1. **编辑器优先**：应用壳安静、紧凑，不与正文争夺注意力。
2. **继承思源**：颜色、字号、圆角、密度和状态直接来源于现有思源主题。
3. **企业清晰**：组织、权限和审计页面使用表格、列表和分栏，不改成营销卡片墙。
4. **语义用色**：组件只使用设计令牌，不直接写业务颜色。
5. **稳定布局**：工具栏、侧栏、列表行和图标按钮具有固定尺寸，不因内容变化跳动。
6. **少装饰**：不用渐变、光晕、装饰球、超大标题和多层嵌套卡片。
7. **全交互**：可见控件必须具备真实状态和行为，不展示无效按钮。

## 2. 技术基线

| 项目 | 选择 |
|------|------|
| 组件来源 | shadcn官方registry |
| Primitive | Radix UI |
| shadcn风格 | `nova`，由奇点令牌覆盖 |
| CSS系统 | Tailwind CSS 4 |
| 图标 | Lucide React |
| 字体 | 思源现有系统字体栈 |
| 主题 | Light与Dark，分别映射Daylight与Midnight |
| 组件源码 | `enterprise/apps/web/src/components/ui` |
| 主题文件 | `enterprise/apps/web/src/styles.css` |

shadcn提供可访问结构和组件源码，奇点令牌决定最终视觉。禁止保留shadcn默认蓝灰主题与默认宽松密度。

## 3. 颜色系统

### 3.1 Light主题

| 语义令牌 | 值 | 思源来源 |
|----------|----|----------|
| `background` | `#ffffff` | `--b3-theme-background` |
| `foreground` | `#222222` | `--b3-theme-on-background` |
| `card` | `#ffffff` | `--b3-theme-background` |
| `card-foreground` | `#222222` | `--b3-theme-on-background` |
| `popover` | `#ffffff` | `--b3-menu-background` |
| `popover-foreground` | `#222222` | `--b3-theme-on-background` |
| `primary` | `#3575f0` | `--b3-theme-primary` |
| `primary-foreground` | `#ffffff` | `--b3-theme-on-primary` |
| `secondary` | `#f6f6f6` | `--b3-theme-surface` |
| `secondary-foreground` | `#222222` | `--b3-theme-on-background` |
| `muted` | `#f6f6f6` | `--b3-theme-surface` |
| `muted-foreground` | `#5f6368` | `--b3-theme-on-surface` |
| `accent` | `rgba(53,117,240,.12)` | `--b3-theme-primary-lightest` |
| `accent-foreground` | `#3575f0` | `--b3-theme-primary` |
| `destructive` | `#d23f31` | `--b3-theme-error` |
| `border` | `#e0e0e0` | `--b3-border-color` |
| `input` | `#e0e0e0` | `--b3-border-color` |
| `ring` | `rgba(53,117,240,.54)` | `--b3-theme-primary-light` |
| `sidebar` | `#f6f6f6` | `--b3-theme-surface` |
| `sidebar-foreground` | `#222222` | `--b3-theme-on-background` |
| `sidebar-accent` | `rgba(0,0,0,.075)` | `--b3-list-hover` |
| `sidebar-border` | `#e0e0e0` | `--b3-border-color` |

辅助状态沿用思源：成功`#65b84d`、警告`#ff9200`、错误`#d23f31`、信息`#3575f0`。

### 3.2 Dark主题

| 语义令牌 | 值 | 思源来源 |
|----------|----|----------|
| `background` | `#1e1e1e` | Midnight background |
| `foreground` | `#dadada` | Midnight on-background |
| `card` | `#2c2c2c` | Midnight surface |
| `card-foreground` | `#dadada` | Midnight on-background |
| `popover` | `#1e1e1e` | Midnight menu |
| `popover-foreground` | `#dadada` | Midnight on-background |
| `primary` | `#3575f0` | Midnight primary |
| `primary-foreground` | `#ffffff` | Midnight on-primary |
| `secondary` | `#2c2c2c` | Midnight surface |
| `secondary-foreground` | `#dadada` | Midnight on-background |
| `muted` | `#2c2c2c` | Midnight surface |
| `muted-foreground` | `#9aa0a6` | Midnight on-surface |
| `accent` | `rgba(53,117,240,.24)` | Midnight primary-lightest |
| `accent-foreground` | `#dadada` | Midnight on-background |
| `destructive` | `#d23f31` | Midnight error |
| `border` | `#484848` | Midnight border |
| `input` | `#484848` | Midnight border |
| `ring` | `rgba(53,117,240,.72)` | Midnight primary-light |
| `sidebar` | `#2c2c2c` | Midnight surface |
| `sidebar-foreground` | `#dadada` | Midnight on-background |
| `sidebar-accent` | `rgba(255,255,255,.10)` | Midnight list-hover |
| `sidebar-border` | `#484848` | Midnight border |

### 3.3 使用规则

- 正文使用`foreground`，辅助文字使用`muted-foreground`。
- 选中项使用`accent`与`accent-foreground`，不用实色大面积主色背景。
- 主色仅用于主操作、焦点、选中与链接。
- 状态必须同时使用文字或图标，不只依赖颜色。
- 图表使用独立图表令牌，不复用权限角色颜色。

## 4. 排版系统

字体栈继承思源：

```css
font-family: "Emojis Additional", "Emojis Reset", BlinkMacSystemFont,
  Helvetica, "Luxi Sans", "DejaVu Sans", Arial, sans-serif, emojis;
```

| 角色 | 字号 | 行高 | 字重 | 用途 |
|------|------|------|------|------|
| `page-title` | 20px | 28px | 600 | 页面标题 |
| `section-title` | 16px | 24px | 600 | 区域标题 |
| `body` | 14px | 20px | 400 | 正文与表格 |
| `body-strong` | 14px | 20px | 600 | 重点正文 |
| `compact` | 13px | 18px | 400 | 侧栏与工具面 |
| `caption` | 12px | 16px | 400 | 辅助信息 |
| `control` | 14px | 20px | 500 | 表单与按钮 |

界面控件字距固定为`0`。不使用随视口缩放的字体，也不在管理页面使用英雄级标题。

## 5. 尺寸与密度

以4px为基础网格。组件内间距优先使用4、8、12、16、24、32px。

| 元素 | 标准尺寸 |
|------|----------|
| 紧凑按钮 | 28px高 |
| 标准按钮 | 32px高 |
| 重要表单控件 | 36px高 |
| 图标按钮 | 28px或32px正方形 |
| 导航/列表行 | 28px或32px高 |
| 顶部工具栏 | 40px高 |
| 企业页面标题栏 | 48px高 |
| 主侧栏 | 240px，可折叠至40px |
| 图标 | 控件内16px，导航18px |

管理表格保持紧凑行高，重复操作不使用大卡片。移动端工具触控目标不得小于40px；视觉图标仍保持16–18px。

## 6. 圆角、边框与阴影

| 语义 | 值 | 用途 |
|------|----|------|
| `radius-sm` | 3px | 标签、紧凑内嵌控件 |
| `radius-md` | 6px | 输入、按钮、列表选中项 |
| `radius-lg` | 12px | 对话框、菜单、浮层 |
| `border` | 1px | 分隔、输入和容器边界 |
| `shadow-point` | 思源point shadow | 小浮层 |
| `shadow-dialog` | `0 8px 24px rgba(0,0,0,.2)` | 对话框 |

页面区域不做漂浮卡片。阴影只用于浮层、菜单和对话框；固定侧栏、工具栏和表格使用边框分隔。

## 7. 组件体系

### 7.1 shadcn组件映射

| 产品需求 | shadcn组件 | 奇点约束 |
|----------|------------|----------|
| 命令 | `Button` | 28/32px高；图标使用`data-icon` |
| 搜索 | `InputGroup` | 搜索图标置于addon |
| 表单 | `FieldGroup`、`Field` | 错误状态使用`data-invalid` |
| 导航 | `Sidebar` | 240/40px；选中使用accent |
| 空状态 | `Empty` | 无装饰插画，使用Lucide图标 |
| 数据列表 | `Table` | 紧凑行、固定操作列 |
| 状态 | `Badge` | 语义变体，不写原始颜色 |
| 视图切换 | `Tabs` | 紧凑高度，避免胶囊堆叠 |
| 菜单 | `DropdownMenu` | 完整Group结构 |
| 模态 | `Dialog` | 必须包含Title和Description |
| 侧面板 | `Sheet` | 用于成员、分享和权限详情 |
| 反馈 | `Sonner`、`Alert` | 错误可诊断，不吞错 |
| 加载 | `Skeleton`、`Spinner` | 稳定占位尺寸 |
| 危险操作 | `AlertDialog` | 明确对象和后果 |

### 7.2 变体规则

- 主操作：`default`，每个命令区最多一个。
- 次操作：`outline`或`secondary`。
- 工具操作：`ghost`与图标按钮。
- 危险操作：`destructive`，不可仅以红色文字代替确认。
- 加载按钮：`disabled`并组合`Spinner`，不创建自定义`isLoading`属性。

## 8. 布局体系

### 8.1 知识工作台

```text
顶部工具栏 40px
├── 主侧栏 240/40px
├── 文档树或搜索结果面板
└── Protyle编辑区
```

编辑区保持最大可用面积。侧栏和面板通过边框分隔，不放进装饰卡片。

### 8.2 企业管理

```text
页面标题栏 48px
筛选与命令栏 40px
数据表格或分栏详情
分页/状态栏
```

成员、用户组、空间、分享和审计默认使用表格。详情使用Sheet或独立页面，不在表格外再套卡片。

### 8.3 响应式

- `>= 1024px`：完整侧栏与多列工作区。
- `720–1023px`：侧栏折叠，详情面板覆盖显示。
- `< 720px`：40px工具栏、40px侧轨、单主内容列。
- 固定格式控件使用明确宽高，不因图标、标签或加载状态改变布局。

## 9. 交互与动效

- Hover背景沿用思源列表hover，20ms进入。
- 颜色与宽度变化使用200ms、`cubic-bezier(0,0,.2,1)`。
- 焦点使用主色ring，不以浏览器默认黑框代替。
- 支持`prefers-reduced-motion`，禁用非必要过渡。
- 删除、撤销权限和永久分享等高风险操作必须二次确认。
- 键盘导航、快捷键和右键菜单不得因React壳迁移失效。

## 10. 可访问性

- 文本与背景达到WCAG AA对比度。
- 图标按钮必须有可访问名称和Tooltip。
- Dialog、Sheet、Drawer必须有Title。
- 输入必须有Label；搜索可用视觉隐藏Label或`aria-label`。
- 表格操作支持键盘到达，焦点顺序与视觉顺序一致。
- 移动触控目标至少40px，桌面紧凑控件可为28–32px。

## 11. Protyle兼容边界

- 不对Protyle DOM注入Tailwind Preflight。
- 不把Protyle文档状态复制到Zustand或React state。
- 思源`--b3-*`令牌继续存在，并由奇点令牌建立一对一别名。
- Protyle既有主题、插件、快捷键、菜单和块状态必须继续工作。
- shadcn组件只管理React壳及企业功能，不替代编辑器内部控件。

## 12. 执行约束

1. 先初始化shadcn与语义令牌，再实现产品页面。
2. 先搜索官方registry，不手写已有基础组件。
3. 页面只使用语义类，如`bg-background`、`text-muted-foreground`。
4. 组件颜色和排版通过变体与令牌控制，`className`只负责布局。
5. 不使用`space-x-*`、`space-y-*`；使用`gap-*`。
6. 不新增不可操作按钮、虚假数据卡片和营销式内容。
7. 每个新页面必须验证桌面、移动、键盘、控制台和网络健康。
8. 设计评审以思源当前主题和本文件为双重依据。

## References

1. [SiYuan Daylight theme](../../app/appearance/themes/daylight/theme.css)
2. [SiYuan Midnight theme](../../app/appearance/themes/midnight/theme.css)
3. [shadcn/ui documentation](https://ui.shadcn.com/docs)
4. [Tailwind CSS documentation](https://tailwindcss.com/docs)
5. [奇点完整方案](./Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

