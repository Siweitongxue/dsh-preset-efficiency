# -*- coding: utf-8 -*-
import io
import json
import os

D = os.path.join("D:\\AI Company", "10-\u7a0b\u5e8f", "governance", "dsh-preset-planner")


def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()


def write(p, t):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(t)


def sub(t, old, new, label):
    if old not in t:
        raise SystemExit("MISSING: " + label)
    return t.replace(old, new, 1)


# ── 1) 人格 §七 ────────────────────────────────────────────────────────────
p = os.path.join(D, "cordis.patch.yml")
t = read(p)

OLD_SEC7 = """                \u2501\u2501\u2501 \u4e03\u3001\u600e\u4e48\u6d3e\uff08PTC\uff09\u2501\u2501\u2501

                \u4e00\u4e2a run_code \u91cc\u5e76\u53d1\u6d3e N \u4e2a\uff0c\u4e0d\u662f N \u6b21\u5f80\u8fd4\uff1a

                ```js
                const ids = []
                for (const t of tasks) {
                  ids.push(await subagent_preset({ description: t.tag, prompt: t.prompt, agent_preset: 'efficiency' }))
                }
                report({ dispatched: ids.length, ids })
                ```

                - \u9ed8\u8ba4\u7528 subagent_preset\uff1a\u5b83\u80fd\u6307\u5b9a\u9884\u8bbe\uff0c\u5de5\u4eba\u81ea\u5e26\u5b8c\u6574\u5de5\u5177\u4e0e\u4eba\u54c1\u3002
                - \u666e\u901a subagent \u53ea\u5728\u4e0d\u9700\u8981\u5916\u90e8\u4fe1\u606f\u65f6\u7528\uff1b\u5b83\u80fd\u6309 provider/model \u9009\u6a21\u578b\u3002
                - \u540e\u7eed\u6b65\u9aa4\u4f9d\u8d56\u672c\u6b21\u5bf9\u8bdd\u7ec6\u8282\u7684\uff0c\u7528 subagent_fork\uff0c\u522b\u91cd\u8ff0\u4e00\u904d\u80cc\u666f\u3002
                - **\u7981\u6b62\u5728\u6d3e\u5de5\u7684\u90a3\u4e2a run_code \u91cc\u7b49\u7ed3\u679c\u3002** \u6d3e\u5b8c\u7acb\u523b\u53bb\u505a\u522b\u7684\u3002"""

NEW_SEC7 = """                \u2501\u2501\u2501 \u4e03\u3001\u600e\u4e48\u6d3e\uff0c\u600e\u4e48\u6536\u7f25\u7ef3 \u2501\u2501\u2501

                \u6d3e\u5de5\u53ea\u7528 `subagent_preset`\uff08\u9ed8\u8ba4 agent_preset: 'efficiency'\uff09\uff1a

                ```js
                const ids = []
                for (const t of tasks) {
                  ids.push(await subagent_preset({ description: t.tag, prompt: t.prompt, agent_preset: 'efficiency' }))
                }
                report({ dispatched: ids.length, ids })
                ```

                **\u6d3e\u51fa\u53bb\u4e4b\u540e\u4f60\u5fc5\u987b\u80fd\u64cd\u63a7\u5b83\u3002** \u8fd9\u4e2a profile \u88c5\u4e86 Agent Teams\uff0c\u56e2\u961f\u7248\u7684
                `send_message` / `interrupt_agent` / `list_agents` \u4e0e\u5b50\u4ee3\u7406\u63a7\u5236\u5de5\u5177**\u540c\u540d**\uff0c\u628a\u540e\u8005\u5f71\u5b50\u6389\u4e86\uff1b
                \u56e2\u961f\u7248\u6309**\u961f\u53cb\u540d\u5b57**\u627e\u4eba\uff0c\u627e\u4e0d\u5230\u4f60\u7684\u5de5\u4eba\uff08\u5b9e\u6d4b\u62a5\u9519 `active teammate "xxx" not found`\uff09\u3002
                \u6240\u4ee5\u4f60\u53ea\u80fd\u7528\u4e0b\u9762\u8fd9\u4e09\u4e2a\uff1a

                | \u8981\u5e72\u4ec0\u4e48 | \u7528\u54ea\u4e2a | \u4e0d\u8981\u7528 |
                |---|---|---|
                | \u7ed9\u5728\u8dd1\u7684\u5de5\u4eba\u52a0\u7ea6\u675f / \u53eb\u9192\u505c\u4e0b\u7684 | `steer_worker(agent_id, message)` | `send_message` |
                | \u505c\u6389\u8dd1\u5e9f\u7684 | `stop_worker(agent_id)` | `interrupt_agent` |
                | \u6d3e\u65b0\u6d3b\u524d\u5148\u770b\u770b\u8c01\u4ea4\u6d3b\u4e86 | `list_workers()` | `list_agents` |

                - `agent_id` \u5c31\u662f `subagent_preset` \u8fd4\u56de\u7684\u90a3\u4e2a id\u3002
                - **\u4e0d\u7528 `spawn_teammate` \u6d3e\u6d3b**\uff1a\u961f\u53cb\u7ee7\u627f\u4f60\u7684\u9884\u8bbe\uff0c\u4f1a\u9020\u51fa\u4e00\u7fa4\u5c0f\u89c4\u5212\u8005\uff0c\u8fd8\u5404\u81ea\u5e26\u7740\u5f00\u5de5\u95f8\u95e8\u3002
                - **\u7981\u6b62\u5728\u6d3e\u5de5\u7684\u90a3\u4e2a run_code \u91cc\u7b49\u7ed3\u679c\u3002** \u6d3e\u5b8c\u7acb\u523b\u53bb\u505a\u522b\u7684\u3002

                \u6d3e\u5de5\u7eaa\u5f8b\uff08\u4e00\u6b21\u771f\u5b9e\u4e8b\u6545\u6362\u6765\u7684\u516d\u6761\uff0c\u4e0d\u662f\u5efa\u8bae\uff09\uff1a

                1 **\u4e00\u6b21\u53ea\u6d3e\u4e00\u4e2a**\uff0c\u9664\u975e\u4e24\u4ef6\u4e8b\u7684**\u6587\u4ef6\u3001\u8fdb\u7a0b\u3001\u9a8c\u8bc1\u624b\u6bb5**\u4e09\u8005\u90fd\u4e0d\u91cd\u53e0\u3002
                2 **\u6d3e\u524d\u5148\u786e\u8ba4\u4e0a\u4e00\u4e2a\u771f\u6b7b\u4e86**\uff1a\u56de\u6267\u6216\u6587\u4ef6\u9759\u6b62**\u8fde\u7eed 3 \u5206\u949f**\uff0c\u4e0d\u9760\u201c\u770b\u8d77\u6765\u6ca1\u52a8\u9759\u201d\u3002\u4e0d\u786e\u5b9a\u5c31 `list_workers()` \u770b\u4e00\u773c\u3002
                3 **\u72ec\u5360\u8d44\u6e90\u5fc5\u987b\u58f0\u660e**\uff1a\u8c01\u5360\u7740 Unity \u7f16\u8f91\u5668 / \u6570\u636e\u5e93 / \u7aef\u53e3\uff0c\u5199\u6b7b\u201c\u672c\u8f6e\u53ea\u6709\u4f60\u80fd\u78b0\u201d\uff0c\u5176\u4ed6\u5de5\u4eba\u4e00\u5f8b\u7981\u6b62\u3002
                4 **\u9a8c\u6536\u5224\u636e\u5fc5\u987b\u4e0e\u88ab\u6d4b\u5bf9\u8c61\u65e0\u5173**\uff1a\u4e0d\u62ff\u6574\u5f20\u622a\u56fe\u7684\u7070\u5360\u6bd4\u5224\u65ad\u6297\u952f\u9f7f\uff08\u59ff\u6001\u4e00\u53d8\u5c31\u5931\u771f\uff09\uff0c\u8981\u7528\u4e0d\u53d7\u5e72\u6270\u7684\u5c40\u90e8\u7279\u5f81\u3002
                5 **\u65b9\u5411\u88ab\u5426 = \u7acb\u5373\u505c\u6d3e**\u3002\u4e0d\u518d\u7528\u201c\u518d\u6539\u4e00\u7248\u201d\u6d88\u8017\u7528\u6237\uff0c\u5148\u628a\u65b9\u6848\u6446\u51fa\u6765\u7ed9\u7528\u6237\u5ba1\u3002
                6 **\u6bcf\u6b21\u6539\u52a8\u5148\u7ed9 diff**\uff1a\u5de5\u4eba\u4ea4\u56de\u540e\u5148 `git diff --stat` \u62a5\u4e00\u773c\uff0c\u7528\u6237\u70b9\u5934\u624d\u7559\u3002"""

t = sub(t, OLD_SEC7, NEW_SEC7, "sec7")

# 插件的行：放在 understanding-gate 之后
t = sub(t,
        "          # \u2500\u2500 \u8fd0\u884c\u65f6\u786c\u7ea6\u675f \u2500\u2500",
        "          # \u2500\u2500 \u65b9\u5411\u76d8\uff1a\u63a7\u5236\u81ea\u5df1\u6d3e\u51fa\u53bb\u7684\u5de5\u4eba \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n"
        "          # \u56e2\u961f\u7248 send_message / interrupt_agent / list_agents \u540c\u540d\u5f71\u5b50\u4e86\u5b50\u4ee3\u7406\u63a7\u5236\u5de5\u5177\uff0c\n"
        "          # \u8fd9\u4e09\u4e2a\u5de5\u5177\u76f4\u63a5\u8c03 ctx.subagents \u7684\u516c\u5f00\u670d\u52a1\uff0c\u6362\u4e2a\u540d\u5b57\u907f\u5f00\u51b2\u7a81\u3002\n"
        "          - id: worker-steering\n"
        "            name: 'dsh-preset-planner/steer'\n\n"
        "          # \u2500\u2500 \u8fd0\u884c\u65f6\u786c\u7ea6\u675f \u2500\u2500",
        "steer row")

# 黑名单追加
t = sub(t,
        "                | \u628a\u673a\u68b0\u6d3b\u6d3e\u6210\u5f00\u653e\u9898\uff08\"\u4f60\u53bb\u770b\u770b\u600e\u4e48\u5408\u5e76\"\uff09 | \u5f00\u653e\u9898 = \u4e8c\u5341\u8d9f\u5f80\u8fd4\uff1b\u5199\u6210\u6e05\u5355 = \u4e09\u8d9f |",
        "                | \u628a\u673a\u68b0\u6d3b\u6d3e\u6210\u5f00\u653e\u9898\uff08\"\u4f60\u53bb\u770b\u770b\u600e\u4e48\u5408\u5e76\"\uff09 | \u5f00\u653e\u9898 = \u4e8c\u5341\u8d9f\u5f80\u8fd4\uff1b\u5199\u6210\u6e05\u5355 = \u4e09\u8d9f |\n"
        "                | \u7528 spawn_teammate \u6d3e\u6d3b | \u961f\u53cb\u7ee7\u627f\u4f60\u7684\u9884\u8bbe\uff0c\u9020\u51fa\u4e00\u7fa4\u5c0f\u89c4\u5212\u8005 |\n"
        "                | \u7528 send_message / interrupt_agent / list_agents \u64cd\u63a7\u5de5\u4eba | \u90a3\u662f\u56e2\u961f\u7248\uff0c\u627e\u4e0d\u5230\u4f60\u7684\u5de5\u4eba |\n"
        "                | \u540c\u4e00\u4e2a\u72ec\u5360\u8d44\u6e90\u6d3e\u4e24\u8def\u5de5\u4eba | \u5fc5\u62a2\uff0c\u5fc5\u4e92\u76f8\u8986\u76d6 |\n"
        "                | \u62ff\u6574\u56fe\u7edf\u8ba1\u5f53\u9a8c\u6536\u5224\u636e | \u5224\u636e\u5fc5\u987b\u4e0e\u88ab\u6d4b\u5bf9\u8c61\u65e0\u5173 |\n"
        "                | \u65b9\u5411\u88ab\u5426\u4e86\u8fd8\u63a5\u7740\u6d3e\u540c\u4e00\u6761\u8def | \u7acb\u5373\u505c\u6d3e\uff0c\u5148\u51fa\u65b9\u6848 |",
        "blacklist")

write(p, t)
print("patch: sec7 + steer row + blacklist")

# ── 2) package.json ────────────────────────────────────────────────────────
p = os.path.join(D, "package.json")
pk = json.loads(read(p))
pk["version"] = "0.4.0"
pk["exports"]["./steer"] = "./steer.js"
if "steer.js" not in pk["files"]:
    pk["files"].insert(2, "steer.js")
write(p, json.dumps(pk, ensure_ascii=False, indent=2) + "\n")
print("package.json: 0.4.0")

# ── 3) validate.py ─────────────────────────────────────────────────────────
p = os.path.join(D, "scripts", "validate.py")
t = read(p)
t = sub(t, 'GATE = "gate-state.js"', 'GATE = "gate-state.js"\nSTEER = "steer.js"', "const steer")

t = sub(t, 'check("checkGate(" in src, "guard.js \u6ca1\u6709\u8c03\u7528 checkGate \u2014\u2014 \u95f8\u95e8\u6ca1\u63a5\u4e0a")',
        'with io.open(STEER, encoding="utf-8") as fh:\n'
        '    steer_src = fh.read()\n'
        'check("ctx.subagents.sendMessage(" in steer_src, "steer.js \u6ca1\u6709\u63a5 sendMessage")\n'
        'check("ctx.subagents.interrupt(" in steer_src, "steer.js \u6ca1\u6709\u63a5 interrupt")\n'
        'check("ctx.subagents.listChildren(" in steer_src, "steer.js \u6ca1\u6709\u63a5 listChildren")\n'
        'for _n in ("steer_worker", "stop_worker", "list_workers"):\n'
        '    check(_n in steer_src, "steer.js \u7f3a\u5de5\u5177 " + _n)\n\n'
        'check("checkGate(" in src, "guard.js \u6ca1\u6709\u8c03\u7528 checkGate \u2014\u2014 \u95f8\u95e8\u6ca1\u63a5\u4e0a")',
        "steer checks")

t = sub(t, '    gate_rows = [p for p in plugins if str(p.get("name", "")).endswith("/confirm")]',
        '    steer_rows = [p for p in plugins if str(p.get("name", "")).endswith("/steer")]\n'
        '    check(len(steer_rows) == 1, "\u5e94\u5f53\u6070\u597d\u6302 1 \u4e2a\u65b9\u5411\u76d8\u884c\uff08dsh-preset-planner/steer\uff09")\n\n'
        '    gate_rows = [p for p in plugins if str(p.get("name", "")).endswith("/confirm")]',
        "steer row check")

t = sub(t, '        ("\u73af\u5883\u5750\u6807", "\u4eba\u683c\u6ca1\u628a\u73af\u5883\u5750\u6807\u5199\u8fdb\u4e5d\u8981\u7d20"),',
        '        ("\u73af\u5883\u5750\u6807", "\u4eba\u683c\u6ca1\u628a\u73af\u5883\u5750\u6807\u5199\u8fdb\u4e5d\u8981\u7d20"),\n'
        '        ("steer_worker", "\u4eba\u683c\u6ca1\u544a\u8bc9\u5b83\u7528 steer_worker \u64cd\u63a7\u5de5\u4eba"),\n'
        '        ("\u4e00\u6b21\u53ea\u6d3e\u4e00\u4e2a", "\u4eba\u683c\u6ca1\u5199\u6d3e\u5de5\u7eaa\u5f8b"),',
        "steer markers")

write(p, t)
print("validator updated")
