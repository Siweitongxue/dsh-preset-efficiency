# dsh-preset-efficiency

用最少的往返、最短的等待交付结果 —— 一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的「效率模式」Agent 预设。

它不是提示词玩具：**基于内置 PTC 模式克隆**，保留「模型只看到 `run_code` + 生成 SDK」的工具呈现方式（少往返是提速的大头），换掉人格，砍掉会让人犹豫的工具，再顺手打开 `dsh-ops` 的 PTC 组件省钱。

```
标准模式  PTC 模式  极简模式  创造模式   ← 内置
规划者  程序树模式  效率模式              ← 自定义（本包安装后出现）
```

## 它到底改了什么

| 层 | 内容 |
|---|---|
| **工具呈现** | `tool-presentation: mode ptc` —— 模型只看到 `run_code` + SDK，批量调用写在一段代码里 |
| **人格** | 停/动分明、长活儿全后台、一次写成、结论先行（见下） |
| **工具面** | 从 PTC 基底做减法：保留 pwsh + jobs（后台通道）、fs / fs-search、skills、compaction、delegation、todo、ask-user、原生 web、present；**去掉** plan-mode（计划模式天然犹豫）、goal、schedule、plugin-manager、workflow |
| **省钱** | override `dsh-ops-ptc` → 启用 `ops_batch`（原生 Rust 批量操作）+ `ops_result`（有界结果引用），结果不整段灌回上下文 |
| **运行时守卫** | 自带 `guard.js`：任何工具带 `wait: true`，或等待类参数 `timeout_ms > 5000`，**直接拒绝**并返回改道提示——「不许同步等」是硬约束，不是建议（只在本预设内生效，不影响其它预设） |

### 效率人格的五条铁律

0. **指令遵循拉满（最高优先级）** —— 纯执行者：不制定计划、不做设计、不改范围。任务书与计划表的每一句都是硬约束；开工先把要求拆成带编号的条目，交付时逐条回执（已做／未做＋原因＋证据），缺一条都不许说「完成」。**为了快而少做一条，比慢三倍更失败。** 服从再往下拆三层：
   - **事实层以实测为准**：任务书写的数字/路径/状态与实测不符，就地采用实测口径并标出「任务书写 X，实测 Y」，不许硬凑数据——事实没有第二个选项，更正它不损害服从。
   - **决定层只能由用户改**：做什么、做多少、做到什么程度，只提不换。
   - **任务书之外的动作必须原样上报**：为了做完任务而必须做任务书没写的事，非破坏性且不花钱的直接做，破坏性/花钱的停手问；无论哪种都要写清做了什么、改在哪、为什么、影响、回滚方案，一件不许静默。
1. **停和动分明** —— 动之前用一条 `ask_user_question` 把所有歧义一次问完（含破坏性操作与花钱授权）；动之后零提问、零确认、零请示；只有「新歧义 / 破坏性操作 / 花钱」能打断执行。
2. **长活儿一律后台** —— 预计超过 5 秒的活必须 `run_in_background`，能并行的在同一个 `run_code` 里一起发；起完后台立刻做别的步骤，不轮询。
3. **输出边界收割** —— 每次要输出正文之前 `job_output(wait:false)` 收一次增量，有结果就并进这次输出；交付前 `job_list` 收尾。
4. **不许反复调** —— 只允许最基础的编译/类型检查/单次测试；失败后修复一次，第二次还失败就停手交回卡点，禁止「改了→再验→再改」的循环。**省次数，不省范围**：这一次验证必须覆盖改动过的全部影响面。
5. **绝不做的事**（§六 反模式黑名单）—— 静默跳过、硬凑数字、中途请示、`job_output(wait:true)`、调试循环、无证据声称完成、擅自缩范围、编造路径、把瞬时状态写成结论、报喜不报忧。十条集中成表，不散落在各节。
6. **诚实边界**（§七）—— 明写这个模式做不到什么：不判断该不该做、不追真问题、不保证事实准确、没有中间信号、不做设计、不保证零错误。**要它判断范围，说明用错了模式。**

## 模式（modes）

一个预设现在带多个模式：**一个模式 = 一个目录**。丢一个目录进 `modes/`，就多一个能派工的模式，不用改 YAML 模板、不用改代码。完整字段契约在 [MODES.md](MODES.md)。

### ① 目录形状与 `mode.yml`

```
modes/
├── general/               拿不准派谁时用它（默认，order 100）
│   ├── mode.yml           这个模式的全部声明
│   └── skills/            出厂库（随仓库走）
└── ppt/
    ├── mode.yml
    └── skills/
```

`mode.yml` 的字段（逐条说明见 `MODES.md`）：

| 字段 | 作用 |
|---|---|
| `id` | 派工时用的那个值，英文小写 + 连字符 |
| `name` | 给人看也给模型看的名字，例：`效率模式 · PPT` |
| `description` | **一句话写「什么时候该派它」，不写「它能干什么」** —— 模型就是靠这一句决定派谁 |
| `order` | 排序，默认 100 |
| `persona` | 只写本模式特有的规矩；公共纪律由底座给，这里不重复 |
| `plugins` | 追加在公共底座后面的插件行；不写 = 只有底座的工具面 |
| `skillDirs` | 默认 `[shipped]`；`local` 指本地积累库 |
| `denyPrefixes` / `deny` | 要看不见的宿主工具（按前缀或精确名），从提示词里摘掉 |

### ② 加一个模式

1. 在 `modes/` 下新建目录，比如 `modes/doc/`；
2. 写 `mode.yml`，最少三个字段：`id` / `name` / `description`；
3. 要出厂技能就放 `modes/doc/skills/<skill>/SKILL.md`；
4. **重启一次 DSH。**

**加模式要重启 —— 注册发生在 bundle 加载时，v1 不做热加载。** 不假装这是零成本：丢目录这一步省的是配置，不是重启。

### ③ skill 库两段在哪

| 段 | 位置 | 谁往里写 |
|---|---|---|
| 出厂库 | `modes/<id>/skills/`（随仓库走） | 维护者 |
| 本地积累库 | `<DSH_HOME>/mode-skills/<mode>/` | 工人提案，**用户点头后才落** |

两段都写进这个模式自己的 skill provider（`includeDefaultRoots: false`）：**不继承工作区/用户级 skill**，模式之间也不会捡到彼此的东西。

### ④ 模式工人收工要交提案，进不进库由用户点头

模式工人收工前，把这次摸出来的可复用套路写成一份提案交回来（规划者侧走 `skill_proposal`：`propose` 只校验记账、`promote` 把正文推给用户点「确认入库」）。**工人没资格自己往 `mode-skills/` 里写文件** —— 进不进库是用户点头的事，不是工人说了算。

---

## 安装

### 方式一：让 Agent 装（推荐）

把仓库克隆到本地，然后对 DSH 说：

> 用 plugin_manager 安装绝对路径 `<bundle 目录>` 这个 bundle。

对应工具调用：

```jsonc
{ "action": "install_bundle", "target": "<到本仓库的绝对路径>" }
```

`install_bundle` 会自己完成依赖安装和 bundle 选择，**不要**用 shell 手动复现这些步骤。安装后可能出现需要重启宿主的提示，按提示重启。

### 方式二：手动

1. 在本机 profile 目录（如 `~/.dsh/profiles/desktop/`）执行 `pnpm add link:<到本仓库的绝对路径>`。
2. 在该 profile 的 `package.json` 里，把 `dsh-preset-efficiency` 加进 `dsh.profile.bundles`（放在 `dsh-ops` 之后，才能覆盖它的 PTC 组件行）。
3. 重启 DeepSeek Harness。

### 验证

- `plugin_manager` → `list_bundles` 能看到 `dsh-preset-efficiency`；
- `plugin_manager` → `list_plugins` 能看到 `preset-efficiency` 行处于启用状态；
- 新建一个任务，在「新建任务」的预设选择器里能看到 **效率模式**（在「自定义」分组里，`order: 5` 排在自定义组最前）。

> 预设的改动只影响**新建**的任务；已经开始的会话保持它启动时的组合。

## 设计说明

- **为什么不用 `complete: true` 重写整个系统提示**：`dsh-ops/ptc` 是靠识别宿主装配出的 `tools:ptc-only` 段落来激活的，砍掉系统段落会让它失活，省 token 的组件就白装了。效率靠「删工具 + 短人格」实现。
- **为什么是 PTC 而不是 native**：native 每次工具调用都是一轮模型往返；PTC 把 N 次调用压进一段代码，少 N-1 轮往返。小任务持平或更快，批量任务明显更快——前提是不进入调试循环，所以人格里把验证上限钉死。
- **为什么不改内置预设**：本 bundle 只 `insert` 自己的行，另外 `override` 一行 `dsh-ops-ptc`。内置的 standard / ptc / minimal / cordis 一个字没动，升级 DSH 不会被覆盖掉。
- **`dsh-ops-ptc` 是可选增强**：删掉 `cordis.patch.yml` 末尾那几行即可关掉，效率模式本身不依赖它。没装 `dsh-ops` 的 profile 里这行匹配不到目标，Loader 只会警告并跳过。

## 卸载

```jsonc
{ "action": "remove_bundle", "target": "dsh-preset-efficiency" }
```

## 已知限制

- 「效率模式」只能出现在**自定义**分组。内置分组由客户端的 `BUILT_IN_PRESET_KEYS` 与 i18n 写死，进不去，也不该进（升级即丢）。
- 预设 id 必须全局唯一：如果你已经有一个 `efficiency` 预设，装之前先删掉或改 id。
- `ops_batch` / `ops_result` 只对 PTC-only 会话生效；标准 / 极简等原生模式看不到这两个工具，也不会有额外提示词。

## License

MIT
