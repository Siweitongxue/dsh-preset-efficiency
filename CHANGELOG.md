# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
