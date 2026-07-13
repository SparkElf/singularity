---
title: "Protyle编辑器注册表产品需求"
description: "定义奇点P1-B3阶段单空间多编辑器协同、活动实例与销毁隔离的可观察结果"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "approved"
tags: ["product", "protyle", "registry", "session", "p1-b3"]
---

# Protyle编辑器注册表产品需求

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-13 | Codex | 固定P1-B3多编辑器协同、活动实例与生命周期验收 |

## 1. 目标与范围

P1-B3为当前空间建立唯一编辑器注册表，使同一浏览器会话内的正文、搜索、反链和浮层Protyle通过显式实例集合协同，不再从旧布局树、活动Tab或全局面板数组反查编辑器。注册表只保存实例引用、注册顺序和当前活动实例，不保存文档正文、事务副本或React页面状态。

本批覆盖编辑器注册/注销、焦点激活、跨编辑器拖拽源定位、事务DOM查找、resize位置保持、全局撤销焦点和旧壳Host关闭。大纲/反链面板刷新、全屏工作台布局、全局浮层收起、`BlockPanel`创建以及React标签页状态属于P1-B4或P3，不进入注册表。

## 2. 同类调研

### 2.1 思源3.7.1本地官方源码

当前官方基线通过`getAllEditor`遍历布局、搜索、反链、自定义编辑器、对话框和`blockPanels`，通过`getAllModels().editor`处理正文页签，并通过DOM活动Tab选择撤销目标。优点是覆盖旧壳全部容器；缺点是编辑器身份依赖布局实现，同一能力在多个全局数组中重复扫描，销毁和切空间没有统一边界。

现有真实调用证明注册表需要支持稳定遍历、按DOM查找、活动实例、幂等注销和整体销毁，不需要保存布局模型、文档内容或派生快照。

### 2.2 现有奇点Session合同

ADR-009与ADR-010已经确定一空间一Session、Registry不进入Zustand、切空间先销毁旧实例。P0的Factory和Controller生命周期证明实例重建由Session边界拥有；B3只补齐Core内部的实例协同，不建立第二套React编辑器列表。

### 2.3 外部核对限制

本轮沿用P1-B2已记录的网络限制：官方GitHub Raw只读访问发生TLS失败。由于本仓包含同版本完整官方布局、编辑器、事务和撤销实现，产品结果以本地官方基线为准，不引用未取得的外部资料。

## 3. 用户故事

- 作为用户，我在两个页签打开同一文档时，拖拽和Kernel推送能在正确实例中找到源块，不产生错误的撤销锚点。
- 作为用户，我在搜索、反链或浮层编辑器中聚焦后执行撤销，系统作用于当前聚焦实例，而不是旧布局中的另一个Tab。
- 作为用户，我关闭页签或浮层后，已销毁编辑器不再参与后续事务、resize或Host关闭扫描。
- 作为用户，我调整分屏或窗口尺寸后，各可见编辑器保持原先的视口锚点。
- 作为平台维护者，我切换空间或销毁Session后，旧空间实例不能进入新空间注册表。

## 4. 交互与状态

### 4.1 注册与注销

每个Protyle在构造出完整内部状态后注册一次。重复注册同一实例不增加重复项，并返回同一个注销语义；注销和整体销毁均幂等。注销活动实例后，活动状态变为空，直到另一个已注册实例获得焦点，不猜测替代实例。

### 4.2 活动实例

编辑器`focusin`把自身设为活动实例。只有已注册实例可以成为活动实例；已销毁实例的迟到焦点不会恢复活动状态。首个注册实例在尚无焦点记录时成为初始活动实例，避免首次打开文档时全局命令无目标。

### 4.3 跨编辑器协同

拖拽按源DOM所属编辑器确定源文档根ID和超级块操作；同文档多实例的Kernel move处理从注册实例中查找可用DOM；resize只遍历当前注册且可见的实例。源DOM不属于当前Session时中止当前操作并暴露稳定诊断，不使用目标文档ID、跨窗口/mobile数组或Kernel查询作为fallback。

### 4.4 Session销毁

销毁注册表时清空全部实例引用和活动实例，并拒绝后续注册。旧实例即使迟到回调也只能命中已销毁的旧注册表，不能进入新Session；新Session创建独立注册表。

## 5. 验收标准

| ID | 可判定结果 | 失败风险与关键路径 | 最低充分证据 |
| --- | --- | --- | --- |
| P-B3-01 | 注册顺序稳定，同一实例重复注册不重复，注销回调幂等 | 重复事务和资源泄漏；构造/销毁 | unit |
| P-B3-02 | `forEach`与`find`只访问当前注册实例，不复制或暴露可变集合 | 旧实例参与操作；所有跨编辑器扫描 | unit + static |
| P-B3-03 | 首个实例成为初始active，focus切换active，注销active后不猜测替代项 | 撤销命中错误编辑器；焦点与关闭 | unit + static |
| P-B3-04 | dispose幂等清空实例与active，并拒绝迟到注册 | 跨空间实例污染；Session切换 | unit |
| P-B3-05 | 跨编辑器拖拽以源DOM所属实例的rootID生成撤销位置，找不到源时中止且不使用目标rootID或fallback | 数据移错文档；拖拽事务 | static + P3 browser integration |
| P-B3-06 | Kernel move可从正文和浮层等全部注册实例查找DOM，不再单独扫描`blockPanels` | 同文档多实例内容不同步；事务推送 | static + P3 browser integration |
| P-B3-07 | resize锚点只遍历注册且可见实例，关闭实例不再参与 | 分屏后滚动跳动；布局调整 | unit + P3 browser integration |
| P-B3-08 | 全局撤销焦点只来自Registry active，不读取活动Tab或布局DOM | 撤销目标错误；焦点切换 | unit + static |
| P-B3-09 | 旧壳Host按Registry查找文档实例，已注销实例不会被重复关闭 | 关闭错误或已销毁页签；Kernel关闭事件 | static + P3 integration |
| P-B3-10 | 大纲/反链、全屏布局和全局浮层UI未进入Registry，剩余旧壳调用有明确B4归属 | Registry膨胀为工作台状态仓库；边界收口 | architecture + AST audit |

## 6. 约束

- **所有权**：当前空间Session拥有Registry；旧App仅作为P1过渡所有者，P2迁入真实Session。
- **数据**：Registry只持实例引用和active指针，不复制DOM、正文、事务、undo镜像或布局模型。
- **性能**：遍历直接访问插入有序集合，不为每次drag、resize或hide创建数组副本。
- **错误**：迟到注册显式失败；源编辑器缺失中止操作并保留`protyle.registry`诊断标签，不添加fallback。
- **安全**：Registry不改变Gateway权限，不向插件或React页面暴露可变内部集合。
- **状态**：Registry不进入Zustand；React标签页状态继续由工作台拥有。
- **测试**：Registry公共状态转移由标准`pnpm test`的真实实现验证；源码边界由AST/typecheck证明，真实DOM协同留给P3 integration。
- **产物**：文档、日志和fixture只记录实例ID、文档ID、阶段和结果，不记录正文、选区或内部提示。

## References

1. [Protyle浏览器宿主方案](../architecture/protyle-browser-host.md)
2. [ADR-010](../adr/0010-protyle-host-actions-and-contract-ownership.md)
3. [P1-B2插件兼容PRD](protyle-plugin-compatibility.md)
4. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
