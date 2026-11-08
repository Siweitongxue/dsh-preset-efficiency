# dsh-presets

> Two agent presets for DeepSeek Harness: one **schedules** (planner), one **executes** (efficiency). Both exist for a single reason — an AI should not drift when nobody is watching.

[中文](README.md) | English

---

## Why these exist

Letting one agent do everything fails in three expensive ways:

1. **Misunderstanding.** It thinks you want A, builds B, and you find out at the end. Bad understanding gets amplified by parallelism — dispatch 10 workers and you get 10 times the damage.
2. **Doing it yourself.** Ask it to delegate and it quietly does the work itself. You save an hour and lose the answer to "who made this, and against what standard?"
3. **Getting stuck.** A blocked tool, a wrong environment, an ambiguous brief — it does not come back and say so. It tries another hypothesis until the budget is gone.

`planner` and `efficiency` are the answers to each.

---

## The two presets

### `planner` — reads, decomposes, dispatches, verifies

- **Asks first.** At most three questions, one screen. What can be looked up is looked up; what must be assumed is labelled as an assumption.
- **An understanding document is a hard gate.** `.planner/<slug>/understanding.md`: nine sections, 1200–3000 characters, and it must describe **what you want, never how to build it**. A tool validates it before it ever reaches you.
- **No confirmation, no dispatch.** Until the user approves, `subagent*` calls are refused and the plan file cannot even be written.
- **The plan is the second gate.** Written, shown, approved — only then does work get dispatched.
- **Everything is delegated.** Its write access is limited to `plan.md` and `.planner/`.
- **It verifies by looking.** Images get opened, diffs get read, one test gets re-run. Failures go **back to the worker**, not into its own hands.
- **Nine-element briefs**: goal / materials / deliverables / write scope / acceptance / prohibitions / shortest path / report format / environment coordinates. Missing one — no dispatch.

### `efficiency` — executes, does not deliberate

- Give it a plan, get a product. No scope negotiation, no design review.
- **Waiting is not retrying**: a blocked external tool is reported once, not retried in place.
- **Anti-spin guard**: a slow MCP call followed by another MCP call, or the same arguments three times in a row, gets blocked once with an explanation.
- **Six-section receipt**: conclusion / artifacts / evidence / acceptance matrix / corrections / leftovers.

---

## How they work together

```
user → planner: ask → understanding doc → confirm → plan → confirm
                                   ↓
              dispatch (nine-element briefs, in parallel)
                    ↓              ↓              ↓
              efficiency A     efficiency B    efficiency C
                    └────── send_message anytime ──────┘
                                   ↓
                       planner verifies by looking
                                   ↓
                                delivery
```

**The user hears exactly one voice.** Workers never talk to the user.

---

## Install

Both are DeepSeek Harness bundle patches:

```json
{
  "dependencies": {
    "dsh-preset-planner": "link:./presets/planner",
    "dsh-preset-efficiency": "link:./presets/efficiency"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-preset-efficiency",
        "dsh-preset-planner"
      ]
    }
  }
}
```

`planner` uses `efficiency` as its worker preset — install both.

> Not on DSH? `presets/planner/skills/planner/SKILL.md` is a portable skill version for any skill-loading agent host (no tool-level enforcement; discipline only).

---

## Verify

```bash
cd presets/planner    && python scripts/validate.py && node scripts/test-gate.mjs
cd presets/efficiency && python scripts/validate.py && node scripts/test-guard.mjs
```

---

## Lessons we learned the hard way

Each of these is a real observed failure, and each one shaped the implementation:

- **A child agent cannot ask the user.** The runtime only allows a "root" agent to ask (`assertLiveRoot`). So a sub-planner must **hand its questions back to whoever dispatched it**, not try to reach a human.
- **Tools are not a microphone.** In PTC mode tool calls are collapsed in the UI. Anything you put in a tool argument is invisible to the user.
- **Using refusal as a reminder creates its own failures.** We once implemented "remind every three steps" as a denial; it interrupted legitimate work. Injecting a reminder *after* the tool result is the correct mechanism.
- **Collision detection should inform, not block.** One false positive turned "edit a few lines of a shader" into "add a new shader plus a runtime switcher". Write scopes now exist so parallel workers **know about each other** — they do not gate dispatch.
- **The understanding document and the plan are different documents.** Writing implementation into the understanding document hid the actual goal. The split is now explicit.

---

## Status

- Engineering-first and discipline-first; not trying to cover every scenario.
- Only tested on Windows + DeepSeek Harness. Other platforms unverified.
- The two gates rely on tool-level enforcement; the skill version has no such protection.

## License

MIT
