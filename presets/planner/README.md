# dsh-preset-planner — 「规划者」Agent 预设

PTC 基底 + 派工人格。一句话：**先开口、先出理解文档、用户点了确认才开工；开工之后，唯一的产出是「派出去并收回来」。**

默认派出去的是**效率模式智能体**（`agent_preset: 'efficiency'`）——已验证的执行者：零提问、不改范围、逐条回执带证据。所以规划者不需要教工人怎么干活，只需要把活说清楚。

---

## 它跟旧规划者的区别

旧的那套（`@local/dsh-agent-boss`）在调用层把规划者的工具全拒了，只许派工。**本预设取消的是那层「工具面全拒」**：

- 它可以读、探、跑只读命令——因为**选最省路径必须先看清现场**，砍掉读权限的规划者只能靠猜。
- 换上来的是**一道开工闸门**，位置从「工具」挪到了「时间」：不是不让你用工具，是**没跟用户对齐之前不许开工**。

`guard.js` 里的三条硬约束：

1. **开工闸门**：没拿到用户对理解文档的确认，`subagent` / `subagent_preset` / `subagent_fork` / `workflow` 一律拒绝。
2. 不许同步等待（`wait: true` 或超长 `timeout_ms` 直接拒绝）。
3. `write` / `edit` 只许写 `plan.md` 与 `.planner/` 下的文件。

第 1 条是**理解纪律的底线**：一份错的理解，派 10 路工人只会错 10 倍。
第 3 条是**派工纪律的底线**：只要它手里有一支能改任何文件的笔，它迟早替工人把活干了。

---

## 开工闸门怎么工作

钥匙是工具 `confirm_understanding`（`confirm.js`）：

```
写 .planner/understanding.md（九段）
        ↓
confirm_understanding
        ↓  ← 九段不全 / 不足 1200 字 → 直接报错，不打扰用户
推给用户：「确认，开工」/「不对，要改」
        ↓  ← 驳回 → 带意见回来，闸门仍关
确认 → 记下这一版文档的哈希 → 守卫放行
        ↓
文档再改一次 → 哈希对不上 → 闸门自动重新关上
```

- 确认状态按 **agent** 隔离，同一进程里多个规划者会话互不干扰。
- 每个新任务都要重新走一遍；上个任务的确认不算这个任务的。
- 状态存在进程内存里，Harness 重启后要重新确认一次——刻意的：重启之后是不是还在同一个任务上，值得再问一句。

---

## 人格骨架（十二节）

| 节 | 内容 |
|---|---|
| 〇 | 你是调度者：判断自己做，劳动派出去 |
| 一 | **先开口，再开工**：五个必须开口的节点 + 四种必须打断的情形 |
| 二 | **理解文档**：九段模板，一次写完，全文贴进对话 |
| 三 | **确认闸门**：没确认不许开工，驳回要改，改过要重 confirm |
| 四 | 默认值不是选项 + 混合活先切再派 + 小事豁免 |
| 五 | 让「自己动手」变贵（没派工的活必须逐条报备） |
| 六 | 任务书八要素（目标/材料/交付物/**写权限白名单**/验收/禁止/最省路径/报告格式） |
| 七 | 怎么派：一个 `run_code` 并发派 N 个 |
| 八 | 长活儿与阻塞：>5 秒转后台或派工，不许前台等 |
| 九 | 回收：`list-agents` / `job_output(wait:false)` / `send_message` / `job_kill` |
| 十 | 产出与验收：`plan.md` + 收工一次多选勾选 + 长任务每阶段报一句 |
| 十一 | 绝不做（17 条反模式表） |
| 十二 | 诚实边界（7 条） |

---

## 工具面

**调度**：`run_code`(PTC 入口) / `subagent` / `subagent_preset` / `subagent_fork` / `list-agents` / `send_message` / `job_output` / `job_list` / `job_kill` / `ask_user_question`

**闸门**：`confirm_understanding`

**自用**：`glob` / `grep` / `read` / `write`+`edit`(受限) / `pwsh` / `todo_write` / `skill` / `web` / `present`

**没给**：`ops_replace`（最容易滑成自己动手）、`plugin_manager`、`workflow`、`goal`、`schedule`、`plan-mode`

> MCP（`mcp__unity_*`、`browserai` 等）是**宿主级注册**，不挂任何 preset，所以预设在结构上管不住它们——它们会漏进每一个 Agent 的上下文里。要减这部分体积得在宿主层做，不是改预设。

---

## 安装

```bash
# 1. 软链进 profile
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 里加：
#   "dsh-preset-planner": "link:<workspace>/10-程序/governance/dsh-preset-planner"
# dsh.profile.bundles 里加：
#   "dsh-preset-planner"
pnpm install

# 2. 重启 DSH（preset 在启动时读入）
```

> 若同时装了 `@local/dsh-agent-boss`，**把它的 bundle 从 `dsh.profile.bundles` 里移除**：
> 两者都声明 `config.id: planner`，会撞车；而且它的 `planner-tool-gate` 会把本预设的工具全拒掉。
> 另外注意：旧规划者若被内联进 profile 的 `cordis.patch.yml`，也要一并删掉——patch 层在 bundle 之后应用，会盖掉这里的一切。

---

## 已知限制

- **它只能当顶层会话跑。** 委派深度是 1/1，被别的 agent 派出去之后 `subagent*` 全部不可用，
  它就没有派工能力了，只能退化成串行自做。三轮实测里三个子代理都撞到这一条。
- **闸门只拦派工通道**。读文件、写文档、提问不拦——开工前本来就要干这些。只拦得住走工具注册表的路；脚本、子进程重定向这类野路子它看不见。
- **闸门不能替用户看文档**。它只检查「九段齐不齐、够不够长」，内容对不对只有用户能判。所以人格要求**全文贴进对话**，不许只给路径。
- **交付路径只能是 `plan.md` 或 `.planner/`**。守卫按这个白名单拦 `write`/`edit`；
  任务书里指定别的路径，规划者自己写不出来，只能派工写。所以任务书模板第 3 条也这么规定。
- **树还没做完**。理解链路先按 `program-tree-reading` 这个 skill 的阶梯走；`tree_map` 等工具补齐后再接适配，本预设只改一处。
- `subagent_preset` 与 `subagent` 目前是两个工具（一个选预设、一个选模型），同时需要时要调两次。合并成 `dispatch` 是后续项。

## 踩过的坑（环境）

- **Windows PowerShell 的 `Get-Content` 默认按 GBK 解码**，读 UTF-8 文件会显示乱码。
  要么用 `read` 工具 + hex 校验，要么显式 `-Encoding UTF8`。实测子代理在这上面吃过一次。

---

## 校验

```bash
python scripts/validate.py     # 静态检查：YAML / preset / 闸门行 / 人格关键词 / 节序
node  scripts/test-gate.mjs    # 行为检查：闸门开关、驳回、改文档、按 agent 隔离
```

`validate.py` 检查：YAML 可解析、preset 声明完整、PTC 行在位、派工必需插件齐全、闸门行与守卫行都用包内 exports 名、
persona 没用 `complete: true`、人格含六处闸门关键词、且「理解文档」一节必须排在「任务书」之前。
