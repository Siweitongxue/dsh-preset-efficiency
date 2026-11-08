# dsh-preset-efficiency

An **efficiency agent preset** for [DeepSeek Harness](https://github.com/deepseek-ai): fewest round trips, least waiting, correct results.

It is not a prompt trick. It clones the built-in **PTC mode** (the model only sees `run_code` plus a generated SDK, so N tool calls collapse into one code block), swaps in an efficiency persona, drops the tools that invite hesitation, and enables `dsh-ops`' PTC component to cut tokens.

```
Standard  PTC  Minimal  Creator   ← built-in
Planner   Program-tree  Efficiency ← custom (appears after installing this bundle)
```

## What it changes

| Layer | Change |
|---|---|
| Tool presentation | `tool-presentation: mode ptc` — `run_code` + SDK, batched calls |
| Persona | Stop/go discipline, background-first, write-once, conclusion-first |
| Tool surface | Cloned from PTC and trimmed: keeps pwsh + jobs (the background channel), fs / fs-search, skills, compaction, delegation, todo, ask-user, native web, present; **drops** plan-mode, goal, schedule, plugin-manager, workflow |
| Token savings | Overrides `dsh-ops-ptc` to enable `ops_batch` (native Rust batch operations) + `ops_result` (bounded result references) |
| Runtime guard | Bundled `guard.js` rejects any call with `wait: true`, or a wait parameter `timeout_ms > 5000`, and returns a redirect hint — no blocking waits, enforced at runtime (scoped to this preset only) |

### The five rules in the persona

0. **Instruction following comes first.** You are an executor, not a planner: you never write the plan, never design, never shrink the scope. Every line of the task brief or plan is a hard constraint; split it into numbered items before starting and hand back an item-by-item receipt (done / not done + reason + evidence) at delivery. **Doing one item less to go faster is worse than being three times slower.**
1. **Stop means stop, go means go.** Ask every question once, in one `ask_user_question` (including destructive-operation and spending authorization). After that: no questions, no confirmations, no option lists. Only a *new* ambiguity, a destructive action, or spending may interrupt execution.
2. **Long work always runs in the background.** Anything longer than ~5s goes through `run_in_background`; independent calls fire together in one `run_code`; never poll.
3. **Harvest at output boundaries.** Call `job_output(wait:false)` right before emitting prose; fold in whatever is ready. Run `job_list` once before delivering.
4. **No debug loops.** Only basic compile/type-check/single-test verification is allowed. One repair attempt; a second failure stops and hands back the blocking error.

## Install

### Option A — let the agent install it

Ask the DSH agent:

> Install the bundle at absolute path `<bundle dir>` with plugin_manager.

```jsonc
{ "action": "install_bundle", "target": "<absolute path to this repo>" }
```

`install_bundle` performs dependency installation and bundle selection itself — do not reproduce those steps with shell commands. Restart the host if it tells you to.

### Option B — manual

1. In your profile directory (e.g. `~/.dsh/profiles/desktop/`), run `pnpm add link:<absolute path to this repo>`.
2. Add `dsh-preset-efficiency` to `dsh.profile.bundles` in that profile's `package.json` (after `dsh-ops`, so the PTC-component override applies).
3. Restart DeepSeek Harness.

### Verify

- `plugin_manager` → `list_bundles` lists `dsh-preset-efficiency`.
- `plugin_manager` → `list_plugins` shows the `preset-efficiency` row enabled.
- Start a **new** task; the preset picker offers **效率模式 / Efficiency** (custom group, `order: 5`).

> Preset changes only affect **newly created** tasks. Running sessions keep the composition they started with.

## Design notes

- **Why not `complete: true`?** `dsh-ops/ptc` activates by recognizing the host-assembled `tools:ptc-only` prompt section. Replacing the whole system prompt would silently deactivate the token-saving component. Efficiency comes from fewer tools and a short persona, not from cutting the prompt.
- **Why PTC rather than native tools?** Native calls cost one model round trip each; PTC compresses N calls into one program. Small tasks are even or slightly faster, batch tasks are clearly faster — as long as no debug loop starts, which is exactly what rule 4 prevents.
- **Why not edit the built-in presets?** This bundle only inserts its own rows and overrides one `dsh-ops-ptc` row. Standard / PTC / minimal / creator are untouched, so DSH upgrades cannot clobber them.
- **`dsh-ops-ptc` is optional.** Delete the last block of `cordis.patch.yml` to opt out; the preset does not depend on it. On profiles without `dsh-ops` the override targets nothing and the loader just warns.

## Uninstall

```jsonc
{ "action": "remove_bundle", "target": "dsh-preset-efficiency" }
```

## Known limitations

- The preset can only appear in the **custom** group; the built-in group is pinned by the client's `BUILT_IN_PRESET_KEYS` and its i18n labels.
- Preset ids are global: if a preset named `efficiency` already exists, remove or rename it first.
- `ops_batch` / `ops_result` exist only for PTC-only sessions; native presets see neither the tools nor any extra prompt.

## License

MIT
