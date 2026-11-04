# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.2] - 2026-11-04

### Changed

- 新增人格第〇条「指令遵循（最高优先级）」：效率模式定位为**纯执行者**——不制定计划、
  不做设计、不改范围；任务书与计划表逐条执行，交付逐条回执（已做／未做＋原因＋证据），
  缺一条不许说「完成」。为了快而少做一条，比慢三倍更失败。
- 交付格式改为「结论一句／逐条回执／遗留与风险」：条目 ≥3 用表格，只有一条就一句话。
- 中英文 README 同步：人格从四条铁律扩为五条，指令遵循排第 0。

## [0.1.1] - 2026-11-04

### Fixed

- 人格补上「交付前零成本自检」：把任务书的每条要求逐项点过，只核对、不重做。
  A/B 实测（高中化学难度重排）中，效率模式因追求紧凑漏掉整块「化学反应与能量」，
  而标准模式靠更长的分层输出覆盖了 16 章。核对与「不重复验证」不冲突：
  验证是重做（仍禁止），核对是点数（成本几乎为零）。
- 人格补上列举类任务的清单纪律：任务书出现「全部 / 所有 / 完整 / 逐一 / 列出 / 排序」时，
  动笔前先把清单在心里列全；这类任务的失败几乎都是漏项而不是写错。

## [0.1.0] - 2026-11-04

### Added

- 新增 `efficiency` 预设（「效率模式」），工具清单克隆自内置 PTC 模式，以
  `tool-presentation: mode ptc` 呈现，模型只看到 `run_code` + 生成 SDK。
- 效率人格：停/动分明（一次问清 → 零提问执行 → 仅新歧义/破坏性/花钱可打断）、
  长活儿一律后台并在输出边界收割、只允许一次编译级验证、禁止调试循环。
- 工具面做减法：去掉 plan-mode、goal、command-goal、schedule、plugin-manager、
  plugin-market、workflow；保留 pwsh + jobs、fs、skills、compaction、delegation、
  todo、ask-user、原生 web、present。
- `override dsh-ops-ptc` 启用 `dsh-ops` 的 PTC 组件（`ops_batch` / `ops_result`），
  结果经有界引用返回，不整段进入上下文。
- `scripts/validate.py`：离线校验 YAML 结构、预设字段、entry id 唯一性、
  插件名白名单、PTC 展示行与内置预设 id 冲突。
- GitHub Actions：推送与 PR 时运行上述校验。
