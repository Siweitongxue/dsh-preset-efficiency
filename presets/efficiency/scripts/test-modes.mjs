/**
 * 模式扫描注册器的离线冒烟测试（不启动 Harness）。
 * 用法：node scripts/test-modes.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BASE_PLUGINS, MODE_TAIL, apply, composePersonaSuffix, createDispatchTool, defaultModeId, parseModeYaml, scanModes } from '../modes-registry.js'
import { apply as applyMask } from '../tool-mask.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODES_DIR = join(ROOT, 'modes')
const BASE_PREFIX_PATH = join(ROOT, 'base-persona.prefix.md')
const BASE_SUFFIX_PATH = join(ROOT, 'base-persona.suffix.md')
// 底座身份（3 行）与底座纪律（245 行）是两份文件：纪律在 suffix 里，丢 prefix 只丢身份。
const BASE_PREFIX = readFileSync(BASE_PREFIX_PATH, 'utf8').replace(/\r\n/g, '\n')
const BASE_SUFFIX = readFileSync(BASE_SUFFIX_PATH, 'utf8').replace(/\r\n/g, '\n')
const PATCH_PATH = join(ROOT, 'cordis.patch.yml')

let failed = 0
let passed = 0

function ok(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS  ' + label)
  } else {
    failed += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : '\n        ' + String(detail)))
  }
}

function same(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}

function fixture(root, dirName, lines) {
  const modeDir = join(root, dirName)
  mkdirSync(modeDir, { recursive: true })
  writeFileSync(join(modeDir, 'mode.yml'), lines.join('\n') + '\n', 'utf8')
  mkdirSync(join(modeDir, 'skills'), { recursive: true })
  return modeDir
}

/**
 * 从 cordis.patch.yml 里把 preset-efficiency 那份 preset 的 plugins id 按出现顺序读出来。
 * 只认「缩进 = plugins 行 + 2 的 `- id:` 序列项」——嵌套组（compaction / delegation）的子行缩进更深，
 * 不会被算成顶层行。要的不是完整 YAML，是那份清单本身。
 * @returns {string[]}
 */
function patchPresetPluginIds() {
  const lines = readFileSync(PATCH_PATH, 'utf8').replace(/\r\n/g, '\n').split('\n')
  let presetIndent = -1
  let pluginsIndent = -1
  const ids = []
  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (presetIndent < 0) {
      if (/^- id:\s*preset-efficiency\s*$/.test(body)) presetIndent = indent
      continue
    }
    if (pluginsIndent < 0) {
      if (indent > presetIndent && /^plugins:\s*$/.test(body)) pluginsIndent = indent
      continue
    }
    if (indent <= pluginsIndent) break
    if (indent !== pluginsIndent + 2) continue
    const match = /^-\s+id:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/.exec(body)
    if (match !== null) ids.push(match[1])
  }
  return ids
}

const GARBAGE = mkdtempSync(join(tmpdir(), 'dsh-modes-test-'))

async function main() {
  try {
    // ── 1. 真目录：1 个模式 → 1 条注册定义 ─────────────────────────────
    console.log('\n[1] modes/ 下 1 个模式 → 1 条注册定义')
    const profileDir = join(GARBAGE, 'profile')
    const real = scanModes({ modesDir: MODES_DIR, profileDir })
    // 按 id 取，不按下标：modes/ 下随时会多出别的模式目录（ppt 就是后加进来的）。
    const general = real.definitions.find((definition) => definition.id === 'general')
    ok(general !== undefined, '真目录里扫到 general', JSON.stringify(real.definitions.map((definition) => definition.id)))
    ok(real.definitions.length >= 1, '真目录至少 1 条定义', String(real.definitions.length))
    ok(real.warnings.length === 0, '没有警告', real.warnings.join(' / '))
    ok(general !== undefined && typeof general.name === 'string' && general.description !== '' && general.order === 100, 'name / description / order 齐全')

    // ── 2. 临时造 2 个目录 → 2 条定义，且按 order 排序 ────────────────
    console.log('\n[2] 临时造 2 个模式目录 → 2 条注册定义')
    const two = mkdtempSync(join(tmpdir(), 'dsh-modes-two-'))
    fixture(two, 'alpha', [
      'id: alpha',
      'name: Alpha',
      'description: alpha 模式的样例',
      'order: 20',
      'plugins:',
      "  - name: '@deepseek-ai/dsh-tool-todo'",
    ])
    fixture(two, 'beta', [
      'id: beta',
      'name: 效率模式 · Beta',
      'description: beta 模式的样例',
      'order: 10',
      'persona: |',
      '  你做 beta。',
      'plugins:',
      '  - id: tool-extra',
      "    name: '@deepseek-ai/dsh-tool-web'",
      '    config:',
      '      fetch: false',
      'skillDirs: [shipped]',
    ])
    const scanned = scanModes({ modesDir: two, profileDir })
    ok(scanned.definitions.length === 2, '扫到 2 条定义', String(scanned.definitions.length))
    same(scanned.modes.map((mode) => mode.id), ['beta', 'alpha'], '按 order 排序：beta(10) 在 alpha(20) 前')
    const beta = scanned.definitions[0]
    ok(beta !== undefined && beta.plugins.some((row) => row.id === 'mode-beta-persona'), 'persona 行挂在 beta 上')
    ok(beta !== undefined && beta.plugins.some((row) => row.id === 'mode-beta-tool-extra' && row.config.fetch === false), '模式自己的 plugins 行带上了，id 加了前缀')
    const alpha = scanned.definitions[1]
    ok(alpha !== undefined && alpha.plugins.some((row) => row.id === 'mode-alpha-plugin-1'), '没写 id 的插件行按序号补 id')
    const alphaPersona = alpha === undefined ? undefined : alpha.plugins.find((row) => row.id === 'mode-alpha-persona')
    ok(alphaPersona !== undefined, '没写 persona 也生成 persona 行（提案纪律对所有模式都生效）')
    ok(alphaPersona !== undefined && alphaPersona.config.suffix === BASE_SUFFIX + '\n\n' + MODE_TAIL, '空 persona：suffix = 底座纪律 + 空行 + MODE_TAIL', JSON.stringify(alphaPersona === undefined ? null : alphaPersona.config.suffix.slice(-30)))
    ok(alphaPersona !== undefined && !alphaPersona.config.suffix.endsWith('\n'), '空 persona：结尾不留尾巴空行')
    rmSync(two, { recursive: true, force: true })

    // ── 3. skill provider 行：includeDefaultRoots=false + 2 个绝对路径 ──
    console.log('\n[3] 自动补的 skill provider 行')
    const skillRow = general === undefined ? undefined : general.plugins[general.plugins.length - 1]
    ok(skillRow !== undefined && skillRow.name === '@deepseek-ai/dsh-skill-filesystem', '最后一行的名字是 skill-filesystem')
    ok(skillRow !== undefined && skillRow.config.includeDefaultRoots === false, 'includeDefaultRoots 是 false')
    const dirs = skillRow === undefined ? [] : skillRow.config.customSkillDirs
    ok(Array.isArray(dirs) && dirs.length === 2, 'customSkillDirs 有 2 个路径', JSON.stringify(dirs))
    ok(Array.isArray(dirs) && dirs.every((dir) => isAbsolute(dir)), '两个路径都是绝对路径', JSON.stringify(dirs))
    ok(skillRow !== undefined && skillRow.config.watch === true, 'watch 是 true')
    ok(dirs[0] !== undefined && dirs[0].endsWith(join('general', 'skills')), '出厂库指向 modes/general/skills', dirs[0])
    ok(dirs[1] !== undefined && dirs[1].endsWith(join('mode-skills', 'general')), '本地库指向 <profile>/mode-skills/general', dirs[1])

    // ── 4. dispatch_mode 的枚举 = 扫到的 id 集合 ──────────────────────
    console.log('\n[4] dispatch_mode 的 schema 枚举')
    const tool = createDispatchTool({ modes: real.modes, getProvider: () => undefined, start: async () => ({}) })
    const realIds = real.modes.map((mode) => mode.id)
    const expectedEnum = realIds.includes('general') ? ['general', ...realIds.filter((id) => id !== 'general')] : realIds
    same(tool.parameters.properties.mode.enum, expectedEnum, '真实目录：枚举 general 第一位，其余按 order')
    ok(tool.parameters.properties.mode.enum[0] === 'general', '枚举第一位是 general（不是 order 最小的 ppt）')
    ok(tool.parameters.properties.mode.default === 'general', '默认模式是 general')
    same(defaultModeId(real.modes), 'general', 'defaultModeId(真实目录) = general')
    const twoTool = createDispatchTool({ modes: scanned.modes, getProvider: () => undefined, start: async () => ({}) })
    same(twoTool.parameters.properties.mode.enum, ['beta', 'alpha'], '临时目录：枚举跟着目录走')
    ok(twoTool.parameters.properties.mode.default === 'beta', '没有 general 时默认取 order 最小的 beta')
    const noGeneralTool = createDispatchTool({ modes: [{ id: 'z', order: 5, description: '' }, { id: 'a', order: 50, description: '' }], getProvider: () => undefined, start: async () => ({}) })
    ok(noGeneralTool.parameters.properties.mode.default === 'z', '没有 general 时默认 = order 最小那个')
    ok(tool.name === 'dispatch_mode', '工具名是 dispatch_mode')
    ok(tool.output !== undefined && tool.output.schema !== undefined && typeof tool.output.render === 'function', 'output 声明齐全（schema + render）')
    const outputSchema = tool.output === undefined ? undefined : tool.output.schema
    ok(outputSchema !== undefined && Array.isArray(outputSchema.required), 'output.schema.required 是数组', JSON.stringify(outputSchema === undefined ? null : outputSchema.required))
    same(outputSchema === undefined ? null : outputSchema.required, ['kind', 'mode', 'subagentId', 'summary'], 'required 列全四个字段（对象级）')
    ok(outputSchema !== undefined && Object.values(outputSchema.properties).every((field) => typeof field.type === 'string' && field.required === undefined), '每个字段都有 type，且没有属性级 required')
    ok(outputSchema !== undefined && outputSchema.properties.kind.const === 'activation', 'kind 的 const 保留')

    // ── 5. YAML 子集解析 ───────────────────────────────────────────────
    console.log('\n[5] mode.yml 解析')
    const parsed = parseModeYaml([
      '# 顶行注释',
      'id: demo',
      'name: "Demo 模式"   # 行尾注释',
      'persona: |',
      '  第一行',
      '',
      '  第三行',
      'skillDirs: [shipped, local]',
      'n: 3',
      'flag: true',
    ].join('\n'))
    ok(parsed.id === 'demo', '标量', JSON.stringify(parsed.id))
    ok(parsed.name === 'Demo 模式', '双引号 + 行尾注释', JSON.stringify(parsed.name))
    ok(parsed.persona === '第一行\n\n第三行', '块标量保留空行', JSON.stringify(parsed.persona))
    same(parsed.skillDirs, ['shipped', 'local'], '行内数组')
    ok(parsed.n === 3 && parsed.flag === true, '数字与布尔')

    // ── 6. 坏目录不拖垮好目录 ──────────────────────────────────────────
    console.log('\n[6] 坏模式：跳过 + 警告')
    const broken = mkdtempSync(join(tmpdir(), 'dsh-modes-broken-'))
    fixture(broken, 'good', ['id: good', 'name: Good', 'description: 好的那个'])
    fixture(broken, 'bad', ['id: Bad_ID', 'name: Bad', 'description: 坏 id'])
    fixture(broken, 'dup-a', ['id: dup', 'name: Dup A', 'description: 第一个 dup'])
    fixture(broken, 'dup-b', ['id: dup', 'name: Dup B', 'description: 第二个 dup'])
    fixture(broken, 'nofile', ['id: ghost', 'name: Ghost', 'description: 没写 name 的占位'])
    const brokenScan = scanModes({ modesDir: broken, profileDir })
    same(brokenScan.modes.map((mode) => mode.id).sort(), ['dup', 'ghost', 'good'], '好目录照常出，坏 id 被跳过')
    ok(brokenScan.warnings.length >= 2, '至少 2 条警告', brokenScan.warnings.join(' / '))
    rmSync(broken, { recursive: true, force: true })

    // ── 7. skillDirs 缺省 = [shipped] ──────────────────────────────────
    console.log('\n[7] skillDirs 缺省值')
    const defaults = mkdtempSync(join(tmpdir(), 'dsh-modes-default-'))
    fixture(defaults, 'plain', ['id: plain', 'name: Plain', 'description: 不写 skillDirs'])
    const plainScan = scanModes({ modesDir: defaults, profileDir: join(GARBAGE, 'p2') })
    const plainSkill = plainScan.definitions[0].plugins[plainScan.definitions[0].plugins.length - 1]
    ok(plainSkill.config.customSkillDirs.length === 1 && plainSkill.config.customSkillDirs[0].endsWith(join('skills')), '缺省只有出厂库一个路径')
    rmSync(defaults, { recursive: true, force: true })

    // ── 8. 底座行原样在前 ─────────────────────────────────────────────
    console.log('\n[8] 底座行')
    ok(general.plugins.length === BASE_PLUGINS.length + 2, '定义 = 底座 + persona + skill（' + (BASE_PLUGINS.length + 2) + ' 行）', String(general.plugins.length))
    ok(general.plugins[0].id === 'agent-instructions', '底座第一行原样在前')

    // ── 9. apply() 装得上：注册预设 + 挂工具 ───────────────────────────
    console.log('\n[9] apply() 离线装配')
    const registered = []
    const registeredTools = []
    const effects = []
    const fakeCtx = {
      logger: { warn() {} },
      agentPresets: {
        async register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
      subagents: { getProvider: () => undefined, startActivation: async () => ({ childId: 'x' }) },
      tools: {
        register(tool) {
          registeredTools.push(tool)
          return () => {}
        },
      },
      effect(fn, label) {
        effects.push(label)
        const dispose = fn()
        if (typeof dispose === 'function') dispose()
      },
    }
    await apply(fakeCtx, { modesDir: MODES_DIR, profileDir: join(GARBAGE, 'p3') })
    ok(registered.some((definition) => definition.id === 'general'), '注册里含 general', JSON.stringify(registered.map((definition) => definition.id)))
    ok(registeredTools.length === 1 && registeredTools[0].name === 'dispatch_mode', '挂了 dispatch_mode')

    // ── 10. execute：校验 mode + 把 agentPreset 带进 request ───────────
    console.log('\n[10] execute 行为')
    const calls = []
    const execTool = createDispatchTool({
      modes: real.modes,
      getProvider: () => ({ name: 'spawn', capabilities: { agentPreset: true }, inheritsParentContext: false }),
      start: async (spec) => {
        calls.push(spec)
        return { childId: 'child-42' }
      },
    })
    const exec = { agent: { id: 'parent-1' }, signal: undefined }
    const result = await execTool.execute({ mode: 'general', prompt: '干活', description: '派工样例' }, exec)
    ok(calls.length === 1, 'start 调了一次')
    same(calls[0] === undefined ? null : calls[0].request.agentPreset, 'general', '子代理拿到 agentPreset=general')
    ok(calls[0] !== undefined && calls[0].provider === 'spawn' && calls[0].delivery === 'parent', 'provider / delivery 正确')
    ok(calls[0] !== undefined && calls[0].request.parent === exec.agent, 'parent 是调用方 agent')
    same(calls[0] === undefined ? null : calls[0].request.prompt, [{ type: 'text', text: '干活' }], 'prompt 转成 content parts')
    ok(result.kind === 'activation' && result.subagentId === 'child-42', '结果带 activation + 子代理 id')

    let rejected = false
    try {
      await execTool.execute({ mode: 'nope', prompt: '干活' }, exec)
    } catch (error) {
      rejected = String(error.message).includes('未知模式')
    }
    ok(rejected, '未知模式被拒，并列出可选项')

    let unsupported = false
    const weakTool = createDispatchTool({
      modes: real.modes,
      getProvider: () => ({ name: 'spawn', capabilities: { agentPreset: false }, inheritsParentContext: false }),
      start: async () => ({ childId: 'x' }),
    })
    try {
      await weakTool.execute({ mode: 'general', prompt: '干活' }, exec)
    } catch (error) {
      unsupported = String(error.message).includes('不支持独立选择预设')
    }
    ok(unsupported, 'provider 不支持选预设时明确报错，不硬派')

    let noProvider = false
    const noProviderTool = createDispatchTool({
      modes: real.modes,
      getProvider: () => undefined,
      start: async () => ({ childId: 'x' }),
    })
    try {
      await noProviderTool.execute({ mode: 'general', prompt: '干活' }, exec)
    } catch (error) {
      noProvider = String(error.message).includes('没注册')
    }
    ok(noProvider, 'provider 缺失时报错（getProvider 返回 undefined）')

    // ── 11. 人格合成：prefix = 底座身份，suffix = 底座纪律 + 模式那段 ──
    console.log('\n[11] 人格行合成（prefix 底座身份 + suffix 底座纪律 + 模式）')
    ok(BASE_PREFIX !== '', 'base-persona.prefix.md 有正文', JSON.stringify(BASE_PREFIX.slice(0, 30)))
    const betaPersona = beta.plugins.filter((row) => row.name === '@deepseek-ai/dsh-persona')
    ok(betaPersona.length === 1, '一个模式只生成一行 persona', String(betaPersona.length))
    const personaRow = betaPersona[0]
    const betaSuffix = personaRow === undefined ? '' : personaRow.config.suffix
    ok(personaRow !== undefined && personaRow.config.prefix === BASE_PREFIX, 'prefix 逐字等于 base-persona.prefix.md')
    ok(betaSuffix === BASE_SUFFIX + '\n\n' + MODE_TAIL + '\n\n' + '你做 beta。', 'suffix = 底座纪律 + 空行 + MODE_TAIL + 空行 + mode.persona', JSON.stringify(betaSuffix.slice(-40)))
    ok(composePersonaSuffix('B', '') === 'B\n\n' + MODE_TAIL, 'composePersonaSuffix：空 persona 不留尾巴空行')
    ok(MODE_TAIL.includes('技能提案'), 'MODE_TAIL 带「技能提案」标题')
    ok(MODE_TAIL.includes('提案：<绝对路径>（<一句话>）'), 'MODE_TAIL 要求回执写提案路径')
    ok(betaSuffix.slice(BASE_SUFFIX.length + 2).startsWith(MODE_TAIL), 'suffix 中间那段逐字是 MODE_TAIL')
    ok(betaSuffix.startsWith(BASE_SUFFIX), 'suffix 以整套 BASE_SUFFIX 开头（纪律在前）')
    ok(betaSuffix.endsWith('你做 beta。'), 'mode.persona 非空时 suffix 以它结尾')
    ok(personaRow !== undefined && personaRow.config.prefix.trim() !== '', 'prefix 非空（身份声明在）')
    const generalYml = parseModeYaml(readFileSync(join(MODES_DIR, 'general', 'mode.yml'), 'utf8'))
    const generalPersona = general.plugins.find((row) => row.id === 'mode-general-persona')
    ok(generalPersona !== undefined && generalPersona.config.prefix === BASE_PREFIX, '真实模式也拿到同一份底座 prefix')
    ok(generalPersona !== undefined && generalPersona.config.suffix.startsWith(BASE_SUFFIX), '真实模式的 suffix 也以底座纪律开头')
    ok(generalPersona !== undefined && generalPersona.config.suffix.endsWith(generalYml.persona.trim()), '真实模式的 suffix 结尾是它自己的 persona')

    // ── 12. mode.yml 的 denyPrefixes / deny → 一行 tool-mask ─────────────
    console.log('\n[12] mode.yml 的 denyPrefixes / deny → 一行 tool-mask')
    const maskedDir = mkdtempSync(join(tmpdir(), 'dsh-modes-mask-'))
    fixture(maskedDir, 'lean', [
      'id: lean',
      'name: Lean',
      'description: 带遮罩的模式',
      'denyPrefixes: [mcp__unity_]',
      'deny: [mcp__foo__bar]',
    ])
    const maskedScan = scanModes({ modesDir: maskedDir, profileDir: join(GARBAGE, 'p4') })
    const maskRows = maskedScan.definitions[0].plugins.filter((row) => row.name === 'dsh-preset-efficiency/tool-mask')
    ok(maskRows.length === 1, '恰好一行 tool-mask（不按前缀拆行）', String(maskRows.length))
    same(maskRows[0] === undefined ? null : maskRows[0].config.denyPrefixes, ['mcp__unity_'], 'denyPrefixes 原样传下去')
    same(maskRows[0] === undefined ? null : maskRows[0].config.deny, ['mcp__foo__bar'], 'deny 原样传下去')
    ok(maskRows[0] !== undefined && maskRows[0].id === 'mode-lean-tool-mask', 'tool-mask 行 id 带 mode- 前缀', String(maskRows[0] === undefined ? null : maskRows[0].id))
    ok(!general.plugins.some((row) => row.name === 'dsh-preset-efficiency/tool-mask'), '没写 deny 就不生成 tool-mask 行')
    rmSync(maskedDir, { recursive: true, force: true })

    // ── 13. tool-mask 插件：MCP 名字后到也能遮 ───────────────────────────
    console.log('\n[13] tool-mask：MCP 名字后到也能遮，且不抛异常')
    const fakeTools = () => {
      const state = { names: [], restrictCalls: [], disposers: [] }
      const handlers = []
      const ctx = {
        tools: {
          view() {
            return { restrictableNames: new Set(state.names), knownNames: new Set(state.names) }
          },
          restrict(filter) {
            state.restrictCalls.push(filter)
            const dispose = () => {}
            state.disposers.push(dispose)
            return dispose
          },
        },
        on(event, fn) {
          handlers.push({ event, fn })
          return () => {}
        },
        effect(fn) {
          return fn()
        },
      }
      const fire = () => {
        for (const handler of handlers) if (handler.event === 'tools/change') handler.fn()
      }
      return { state, ctx, fire }
    }

    const late = fakeTools()
    let activationThrew = null
    try {
      applyMask(late.ctx, { denyPrefixes: ['mcp__unity_'] })
    } catch (error) {
      activationThrew = error
    }
    ok(activationThrew === null, '激活时工具面为空也不抛异常', activationThrew === null ? undefined : String(activationThrew))
    ok(late.state.restrictCalls.length === 0, '空工具面时不调 restrict')

    late.state.names.push('mcp__unity_dde__get_scene_info', 'read')
    let fireThrew = null
    try {
      late.fire()
    } catch (error) {
      fireThrew = error
    }
    ok(fireThrew === null, 'tools/change 之后 sweep 不抛异常', fireThrew === null ? undefined : String(fireThrew))
    ok(late.state.restrictCalls.length === 1, '后到的 MCP 名字被遮掉（restrict 调了 1 次）', JSON.stringify(late.state.restrictCalls))
    same(late.state.restrictCalls[0] === undefined ? null : late.state.restrictCalls[0].deny, ['mcp__unity_dde__get_scene_info'], '只遮 MCP 那个，read 不动')
    ok(typeof late.state.disposers[0] === 'function', 'restrict 返回的 disposer 是函数')

    late.state.names.push('mcp__unity_dde__get_gameobject', 'mcp__unity_dde__create_prefab')
    late.fire()
    ok(late.state.restrictCalls.length === 2, '第二次变化只多调一次 restrict', String(late.state.restrictCalls.length))
    same(late.state.restrictCalls[1] === undefined ? null : late.state.restrictCalls[1].deny, ['mcp__unity_dde__get_gameobject', 'mcp__unity_dde__create_prefab'], '两个新名字批在一次调用里')
    late.fire()
    ok(late.state.restrictCalls.length === 2, '已遮过的名字不重复 restrict')

    const exactOnly = fakeTools()
    exactOnly.state.names.push('mcp__foo__bar', 'run_code', 'mcp__unity_x')
    applyMask(exactOnly.ctx, { deny: ['mcp__foo__bar'] })
    same(exactOnly.state.restrictCalls[0] === undefined ? null : exactOnly.state.restrictCalls[0].deny, ['mcp__foo__bar'], '精确名只遮写出来的那个，run_code 永不进 deny')

    const noDeny = fakeTools()
    noDeny.state.names.push('mcp__unity_dde__get_scene_info')
    applyMask(noDeny.ctx, {})
    noDeny.fire()
    ok(noDeny.state.restrictCalls.length === 0, '没配 deny 一个都不遮（默认全开）')
    // ── 14. 底座纪律还在：字节数 + 关键词 ─────────────────────────────
    console.log('\n[14] 底座纪律没丢（底座是 suffix，不是 prefix）')
    const suffixBytes = Buffer.byteLength(BASE_SUFFIX, 'utf8')
    ok(suffixBytes > 15000, 'base-persona.suffix.md 超过 15000 字节', String(suffixBytes))
    ok(BASE_SUFFIX.includes('指令遵循'), 'suffix 正文含「指令遵循」')
    ok(BASE_SUFFIX.includes('回执'), 'suffix 正文含「回执」')
    ok(BASE_SUFFIX.split('\n').length >= 240, 'suffix 是整篇（≥240 行），不是截断的一段', String(BASE_SUFFIX.split('\n').length))

    // ── 15. BASE_PLUGINS 补齐的三行 ───────────────────────────────────
    console.log('\n[15] 底座补齐：delegation / tool-presentation / no-block-guard')
    const delegationRow = BASE_PLUGINS.find((row) => row.id === 'delegation')
    const delegationChildIds = delegationRow === undefined || !Array.isArray(delegationRow.config)
      ? []
      : delegationRow.config.map((row) => row.id)
    ok(delegationRow !== undefined && delegationRow.name === 'cordis:group' && delegationRow.group === true
      && delegationRow.isolate !== undefined && delegationRow.isolate.workflowEngine === true
      && JSON.stringify(delegationChildIds) === JSON.stringify(['tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']),
      'delegation：组 + workflowEngine 隔离 + 5 个子行', JSON.stringify(delegationChildIds))
    ok(delegationRow !== undefined && delegationRow.config[1].config.toolName === 'subagent'
      && delegationRow.config[1].config.provider === 'spawn' && delegationRow.config[1].config.modelSelection === true
      && delegationRow.config[3].disabled === true && delegationRow.config[4].disabled === true,
      'delegation：subagent 带 provider/toolName/modelSelection，workflow 两行 disabled')
    const presentationRow = BASE_PLUGINS.find((row) => row.id === 'tool-presentation')
    ok(presentationRow !== undefined && presentationRow.name === '@deepseek-ai/dsh-agent-tool-presentation'
      && presentationRow.config.mode === 'ptc', 'tool-presentation：mode = ptc（PTC 模式）')
    const noBlockRow = BASE_PLUGINS.find((row) => row.id === 'no-block-guard')
    ok(noBlockRow !== undefined && noBlockRow.name === 'dsh-preset-efficiency/guard'
      && noBlockRow.config.maxWaitMs === 5000, 'no-block-guard：maxWaitMs = 5000')
    ok(general.plugins.some((row) => row.id === 'delegation')
      && general.plugins.some((row) => row.id === 'tool-presentation')
      && general.plugins.some((row) => row.id === 'no-block-guard'),
      '装出来的预设带上这三行（能派子代理 + 在 PTC 模式 + 有防阻塞守卫）')

    // ── 16. 防漂移：BASE_PLUGINS 对齐 cordis.patch.yml 的插件清单 ────────
    console.log('\n[16] 防漂移：BASE_PLUGINS 一个都不许少')
    const presetIds = patchPresetPluginIds()
    const SPECIAL_PLUGIN_IDS = new Set(['persona', 'skill-filesystem'])
    const baseIds = new Set(BASE_PLUGINS.map((row) => row.id))
    ok(presetIds.length === 19, 'YAML 那份 preset 读到 19 行插件', JSON.stringify(presetIds))
    ok(presetIds.includes('persona') && presetIds.includes('skill-filesystem'), '两个特例本身在 YAML 清单里')
    const missingInBase = presetIds.filter((id) => !baseIds.has(id) && !SPECIAL_PLUGIN_IDS.has(id))
    ok(missingInBase.length === 0, 'YAML 每个插件 id 要么在 BASE_PLUGINS，要么是 persona / skill-filesystem 特例', '缺少的 id：' + JSON.stringify(missingInBase))
    const orphanBaseIds = [...baseIds].filter((id) => !presetIds.includes(id))
    ok(orphanBaseIds.length === 0, 'BASE_PLUGINS 里没有 YAML 清单之外的孤儿行', '多出的 id：' + JSON.stringify(orphanBaseIds))
  } finally {
    rmSync(GARBAGE, { recursive: true, force: true })
  }

  console.log('')
  console.log((failed === 0 ? 'OK' : 'FAIL') + ' — ' + passed + ' passed / ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
}

await main()
