# 模式（mode）契约 — v1

> 一个模式 = 一个目录。丢进 `modes/` 就多一个能派工的预设，不用改 YAML、不用改代码。
> 契约定死在这里，扫描器（`modes-registry.js`）照着吃。

## 目录形状

```
dsh-preset-efficiency/
├── base/                       公共底座：所有模式共用的插件行（读写跑 + 纪律守卫）
├── modes/
│   ├── general/
│   │   ├── mode.yml            本文件契约
│   │   └── skills/             出厂库（随 git 走）
│   └── ppt/
│       ├── mode.yml
│       └── skills/
└── modes-registry.js           扫 modes/*/mode.yml → 注册预设 → 挂 dispatch_mode
```

本地积累库（不进 git，工人提案经你点头后落到这里）：

```
<profile>/mode-skills/<mode-id>/<skill-name>/SKILL.md
```

## `mode.yml` 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 英文小写 + 连字符，全局唯一。也是 `dispatch_mode` 里的那个值 |
| `name` | 是 | 给人看和给模型看的名字，例：`效率模式 · PPT` |
| `description` | 是 | **一句话**，模型靠它决定派谁。写成「什么时候该用它」，不写「它能干什么」 |
| `order` | 否 | 排序，小的在前，默认 100 |
| `persona` | 否 | 只写这个模式特有的规矩，不重复公共纪律。**它和底座人格合成同一行**：`prefix` = 底座那份，`suffix` = 这段 |
| `plugins` | 否 | 追加在公共底座**后面**的插件行。不写 = 只有底座的工具面 |
| `skillDirs` | 否 | 默认 `[shipped]`。`shipped` = 本目录 `skills/`；`local` = `<profile>/mode-skills/<id>/` |
| `denyPrefixes` | 否 | 要**看不见**的宿主工具前缀，例：`mcp__unity_`。走 `tool-mask` 行，把 schema 从提示词里摘掉 |
| `deny` | 否 | 同上，写精确工具名。前缀够用就别写这个 |

## 最小样例

```yaml
# modes/ppt/mode.yml
id: ppt
name: 效率模式 · PPT
description: 做幻灯片、改模板、把材料排版成演示文稿时用它
order: 30
persona: |
  你做 PPT。先问清页数和场合，再动手。模板优先用现成的。
plugins:
  - name: '@deepseek-ai/dsh-tool-pwsh'
  - name: '@deepseek-ai/dsh-tool-read'
skillDirs: [shipped, local]
```

## 扫描器做什么（`modes-registry.js`）

1. 扫 `modes/*/mode.yml`，读上面的字段。
2. 每个模式调 `ctx.agentPresets.register({ id, name, description, order, plugins })`——
   `plugins` = 公共底座行 + 本模式的 `persona` 行 + 本模式的 `plugins` 行 + 自动补一行 skill provider。
3. 自动补的那行 skill provider 必须写死：
   ```yaml
   - name: '@deepseek-ai/dsh-skill-filesystem'
     config:
       includeDefaultRoots: false      # 不继承工作区/用户级库
       customSkillDirs: [<出厂库绝对路径>, <本地库绝对路径>]
       watch: true                     # 改了下一轮可见，不用重启
   ```
4. 挂一个 `@deepseek-ai/dsh-tool-subagent` 实例：
   `toolName: dispatch_mode`、`allowedAgentPresets` = 扫到的全部 id、`agentPreset` = 第一个（或 `general`）。
   枚举**从目录算出来**，不写死——网关那边是静态枚举，这条路绕开它。

## 三条硬规矩

1. **库内文件命名一律 `mode-<id>-` 前缀。** skill provider 注册在全局服务上，别的预设理论上能看见模式库；前缀让重名有迹可循（重名时 rank 低者赢，会打 warn）。
2. **加模式要重启一次。** 注册发生在 bundle `apply` 时，v1 不做热加载。不假装这是零成本。
3. **底座只放「干什么活都得有」的东西。** 模式专属工具一律进 `plugins`，否则「看不见」就退化成「被拒绝了」。
