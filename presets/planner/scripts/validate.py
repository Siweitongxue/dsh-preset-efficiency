"""校验 dsh-preset-planner 的 bundle patch 与守卫模块。

只做静态检查：YAML 能解析、preset 声明完整、PTC 与守卫行在位、guard.js 导出契约齐全。
不启动 Harness。
"""

import io
import re
import sys

import yaml

PATCH = "cordis.patch.yml"
GUARD = "guard.js"
CONFIRM = "confirm.js"
GATE = "gate-state.js"
STEER = "steer.js"
REPORT = "report.js"
SKILLGATE = "skill-gate.js"

errors = []
notes = []


class Loader(yaml.SafeLoader):
    """忽略 Loader 的 !!js / !js 等自定义标签。"""


for _tag in ("tag:yaml.org,2002:js", "!js"):
    Loader.add_constructor(_tag, lambda loader, node: None)
Loader.add_multi_constructor("!", lambda loader, suffix, node: None)


def check(cond, message):
    if not cond:
        errors.append(message)


with io.open(PATCH, encoding="utf-8") as fh:
    doc = yaml.load(fh, Loader=Loader)
check(isinstance(doc, list) and doc, "patch 顶层必须是非空列表")

presets = []
rows = []
for entry in doc:
    if isinstance(entry, dict) and "insert" in entry:
        for item in entry["insert"] or []:
            rows.append(item)
            if item.get("name") == "@deepseek-ai/dsh-agent-preset":
                presets.append(item)
    elif isinstance(entry, dict) and "id" in entry:
        rows.append(entry)

check(len(presets) == 1, "应当恰好声明 1 个 agent preset，实际 %d" % len(presets))

if presets:
    config = presets[0].get("config") or {}
    check(config.get("id") == "planner", "preset id 必须是 planner")
    check(bool(config.get("name")), "preset 缺少显示名")
    check(isinstance(config.get("order"), int), "preset 缺少 order")
    check(bool(config.get("description")), "preset 缺少 description")

    plugins = config.get("plugins") or []
    check(len(plugins) >= 12, "插件行过少（%d），像是漏了几组" % len(plugins))

    ids = [p.get("id") for p in plugins if isinstance(p, dict)]
    dupes = {i for i in ids if ids.count(i) > 1}
    check(not dupes, "插件 id 重复：%s" % ", ".join(sorted(dupes)))

    for row in plugins:
        check(isinstance(row, dict) and row.get("id"), "有插件行缺少 id")
        check(isinstance(row, dict) and row.get("name"), "插件行 %r 缺少 name" % (row or {}).get("id"))

    # PTC 起手形态
    ptc = [p for p in plugins if p.get("name") == "@deepseek-ai/dsh-agent-tool-presentation"]
    check(len(ptc) == 1, "缺少 tool-presentation 行")
    if ptc:
        check((ptc[0].get("config") or {}).get("mode") == "ptc", "tool-presentation 必须是 mode: ptc")

    # 派工核心工具必须齐（组内嵌套也算）
    def collect_names(rows_in):
        found = set()
        for row in rows_in or []:
            if not isinstance(row, dict):
                continue
            if row.get("name"):
                found.add(row["name"])
            nested = row.get("config")
            if isinstance(nested, list):
                found |= collect_names(nested)
        return found

    names = collect_names(plugins)
    for required in (
        "@deepseek-ai/dsh-tool-subagent",
        "@deepseek-ai/dsh-tool-subagent-control",
        "@deepseek-ai/dsh-tool-jobs",
        "@deepseek-ai/dsh-tool-ask-user",
    ):
        check(required in names, "缺少派工必需插件：%s" % required)

    # 守卫
    guard_rows = [p for p in plugins if str(p.get("name", "")).endswith("/guard")]
    check(len(guard_rows) == 1, "应当恰好挂 1 个守卫行")
    if guard_rows:
        check(
            guard_rows[0]["name"] == "dsh-preset-planner/guard",
            "守卫必须用包内 exports 名 dsh-preset-planner/guard（相对路径会 never started）",
        )

    # 人格不得使用 complete: true（会让 dsh-ops/ptc 失活）
    persona = [p for p in plugins if p.get("name") == "@deepseek-ai/dsh-persona"]
    check(len(persona) == 1, "缺少 persona 行")
    if persona:
        check(not (persona[0].get("config") or {}).get("complete"), "persona 不许用 complete: true")

# dsh-ops 的 PTC 组件覆盖行
optc = [r for r in rows if r.get("id") == "dsh-ops-ptc"]
check(len(optc) == 1, "缺少 dsh-ops-ptc 覆盖行")
if optc:
    check(optc[0].get("disabled") is False, "dsh-ops-ptc 必须显式 disabled: false")

with io.open(GUARD, encoding="utf-8") as fh:
    src = fh.read()
check(re.search(r"export\s+const\s+inject\s*=\s*\[", src), "guard.js 缺少 inject 导出")
check(re.search(r"export\s+function\s+apply\s*\(", src), "guard.js 缺少 apply 导出")
check("ctx.tools.guard(" in src, "guard.js 没有挂 ctx.tools.guard")
check("write" in src and "edit" in src, "guard.js 没覆盖 write/edit 写权限检查")

# ── 开工闸门 ────────────────────────────────────────────────────────────────
with io.open(CONFIRM, encoding="utf-8") as fh:
    confirm_src = fh.read()
check(re.search(r"export\s+const\s+inject\s*=\s*\[", confirm_src), "confirm.js 缺少 inject 导出")
check(re.search(r"export\s+function\s+apply\s*\(", confirm_src), "confirm.js 缺少 apply 导出")
check("ctx.tools.register(" in confirm_src, "confirm.js 没有注册工具")
check("ctx.userQuestions.ask(" in confirm_src, "confirm.js 没有真的问用户")
check("name: 'confirm_understanding'" in confirm_src, "confirm.js 的工具名必须是 confirm_understanding")
check("markConfirmed(" in confirm_src, "confirm.js 确认后没有写闸门状态")

with io.open(GATE, encoding="utf-8") as fh:
    gate_src = fh.read()
check("export function checkGate(" in gate_src, "gate-state.js 缺少 checkGate 导出")
check("hashText(" in gate_src, "gate-state.js 缺少哈希校验")

with io.open(STEER, encoding="utf-8") as fh:
    steer_src = fh.read()
for _n in ("steer_worker", "stop_worker", "list_workers"):
    check(_n in steer_src, "steer.js 缺工具 " + _n)
check("ctx.subagents.sendMessage(" in steer_src, "steer.js 没接 sendMessage")
check("ctx.subagents.interrupt(" in steer_src, "steer.js 没接 interrupt")
check("ctx.subagents.listChildren(" in steer_src, "steer.js 没接 listChildren")
check("confirm_plan" in confirm_src, "confirm.js 缺计划表闸门 confirm_plan")
check("bumpStep(" in src and "stepCount(" in src, "guard.js 没接反馈闸门")
check("反馈闸门" not in src, "guard.js 不该再用「拒绝」实现进度提醒（已改成 post-execute 提醒）")

with io.open(REPORT, encoding="utf-8") as fh:
    report_src = fh.read()
check(re.search(r"export\s+const\s+inject\s*=\s*\[", report_src), "report.js 缺少 inject 导出")
check(re.search(r"export\s+function\s+apply\s*\(", report_src), "report.js 缺少 apply 导出")
check("ctx.tools.register(" in report_src, "report.js 没有注册工具")
check("name: 'report_progress'" in report_src, "report.js 的工具名必须是 report_progress")
check("resetSteps(" in report_src, "report.js 汇报后没有清零步数")
check("tools/post-execute" in report_src, "report.js 没有接 post-execute 提醒")

report_rows = [p for p in plugins if str(p.get("name", "")).endswith("/report")]
check(len(report_rows) == 1, "应当恰好挂 1 个进度汇报行（dsh-preset-planner/report）")

# ── 技能提案闸门 ────────────────────────────────────────────────────────────
with io.open(SKILLGATE, encoding="utf-8") as fh:
    skillgate_src = fh.read()
check(re.search(r"export\s+const\s+inject\s*=\s*\[", skillgate_src), "skill-gate.js 缺少 inject 导出")
check(re.search(r"export\s+function\s+apply\s*\(", skillgate_src), "skill-gate.js 缺少 apply 导出")
check("ctx.tools.register(" in skillgate_src, "skill-gate.js 没有注册工具")
check("'skill_proposal'" in skillgate_src, "skill-gate.js 的工具名必须是 skill_proposal")
check("'propose'" in skillgate_src and "'promote'" in skillgate_src, "skill-gate.js 缺 propose / promote 两个动作")
check("ctx.userQuestions.ask(" in skillgate_src, "skill-gate.js 的入库确认没有真的问用户")
check("mode-skills" in skillgate_src, "skill-gate.js 没写库的位置 <DSH_HOME>/mode-skills")
check("copyFileSync(" in skillgate_src, "skill-gate.js 没有复制文件")
check("schema:" in skillgate_src and "render:" in skillgate_src, "skill-gate.js 的 output 缺 schema 或 render")
check("additionalProperties: false" in skillgate_src, "skill-gate.js 参数表没关掉额外字段")
check(
    re.search(r"confirmed\s*:\s*\{\s*type", skillgate_src) is None,
    "skill-gate.js 不许把 confirmed 做成参数（确认只能来自用户点的按钮）",
)
check("claimScopes(" in src, "guard.js 没接撞车拦截")
check("export function claimScopes(" in gate_src, "gate-state.js 缺 claimScopes")
check("checkGate(" in src, "guard.js 没有调用 checkGate —— 闸门没接上")
check("subagent_preset" in src, "guard.js 的派工名单里缺 subagent_preset")

if presets:
    plugins = presets[0].get("config", {}).get("plugins") or []
    steer_rows = [p for p in plugins if str(p.get("name", "")).endswith("/steer")]
    check(len(steer_rows) == 1, "应当恰好挂 1 个方向盘行（dsh-preset-planner/steer）")

    skill_gate_rows = [p for p in plugins if str(p.get("name", "")).endswith("/skill-gate")]
    check(len(skill_gate_rows) == 1, "应当恰好挂 1 个技能提案闸门行（dsh-preset-planner/skill-gate）")
    if skill_gate_rows:
        check(
            skill_gate_rows[0]["name"] == "dsh-preset-planner/skill-gate",
            "技能提案闸门必须用包内 exports 名 dsh-preset-planner/skill-gate（相对路径会 never started）",
        )

    gate_rows = [p for p in plugins if str(p.get("name", "")).endswith("/confirm")]
    check(len(gate_rows) == 1, "应当恰好挂 1 个开工闸门行（dsh-preset-planner/confirm）")
    if gate_rows:
        check(
            gate_rows[0]["name"] == "dsh-preset-planner/confirm",
            "闸门必须用包内 exports 名 dsh-preset-planner/confirm（相对路径会 never started）",
        )

    text = ""
    persona = [p for p in plugins if p.get("name") == "@deepseek-ai/dsh-persona"]
    if persona:
        cfg = persona[0].get("config") or {}
        text = (cfg.get("prefix") or "") + (cfg.get("suffix") or "")
    for marker, why in (
        ("先开口", "人格缺「先开口再开工」一节"),
        ("理解文档", "人格缺理解文档"),
        ("confirm_understanding", "人格没点名开工闸门工具"),
        ("九段", "人格没给理解文档的九段结构"),
        ("确认闸门", "人格没写确认闸门这一节"),
        ("每接一个新任务", "人格没要求每个新任务重新确认"),
        ("环境坐标", "人格没把环境坐标写进九要素"),
        ("confirm_plan", "人格没写计划表闸门"),
        ("steer_worker", "人格没告诉它用 steer_worker 操控工人"),
        ("一次只派一个", "人格没写派工纪律"),
        ("最慢的那条链", "人格没写派工经济学"),
    ):
        check(marker in text, why)
    # 顺序不可倒：理解文档一节必须排在派工/任务书之前
    i_doc = text.find("二、理解文档")
    i_eight = text.find("六、任务书九要素")
    check(0 <= i_doc < i_eight, "理解文档必须排在任务书之前（当前顺序不对）")

if errors:
    print("FAIL")
    for item in errors:
        print("  - " + item)
    sys.exit(1)

print("OK — bundle patch valid: preset 'planner', %d 插件行" % len(config.get("plugins") or []))
