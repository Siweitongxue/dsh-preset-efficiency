/**
 * 模式扫描注册器：modes/<id>/mode.yml → 预设 + dispatch_mode 派工工具。
 *
 * 契约在 MODES.md，这里只做它写的四件事：
 *   1) 扫 modes/<id>/mode.yml；
 *   2) 每个模式调 ctx.agentPresets.register({ id, name, description, order, plugins })；
 *      plugins = 公共底座行 + persona 行（prefix 取 base-persona.prefix.md，
 *      suffix 取 base-persona.suffix.md + 空行 + 模式 persona）+ tool-mask 行 + 本模式 plugins 行 + 自动补的 skill provider 行；
 *   3) skill provider 行写死 includeDefaultRoots: false + customSkillDirs + watch: true；
 *   4) 挂 dispatch_mode，枚举从目录算出来，不写死。
 *
 * 决策树走到了第 1 条：ctx.subagents.startActivation 的 request 本来就收 agentPreset
 * （dsh-subagent 的 assertCapabilities 认这个字段，provider 声明 capabilities.agentPreset）。
 * 所以直接用它，不动态挂 tool-subagent 实例。
 *
 * 两条注意：
 *   - 注册发生在 apply 时，加模式要重启一次（MODES.md 硬规矩 2）。
 *   - 一个模式写坏了不拖垮别的模式：记 warn、跳过它。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['agentPresets', 'subagents', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const ID_RE = /^[a-z][a-z0-9-]*$/
const DEFAULT_ORDER = 100
const DEFAULT_SKILL_DIRS = ['shipped']
const SKILL_PROVIDER = '@deepseek-ai/dsh-skill-filesystem'

/**
 * 公共底座：所有模式共用的「读写跑 + 纪律守卫」。
 * MODES.md 里它叫 base/；base 目录还没建，行就先放在这个常量里。
 * 想换一套底座：传 config.basePlugins（同一形状的数组）。
 */
export const BASE_PLUGINS = [
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'stuck-guard', name: 'dsh-preset-efficiency/guard', config: { slowGapMs: 20000, repeatLimit: 3 } },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      {
        id: 'compaction-basic',
        name: '@deepseek-ai/dsh-compaction-basic',
        config: { thresholdRatio: 0.4, headroomTokens: 8192, auto: true },
      },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ],
  },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true },
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' },
      },
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', disabled: true, config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', disabled: true },
    ],
  },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'ptc' } },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  { id: 'no-block-guard', name: 'dsh-preset-efficiency/guard', config: { maxWaitMs: 5000 } },
]

/** 底座人格的 `prefix` 正文（身份声明 3 行）：由 cordis.patch.yml 的 persona 行程序化抽出。 */
const BASE_PREFIX_PATH = join(HERE, 'base-persona.prefix.md')
/** 底座人格的 `suffix` 正文（纪律全文：指令遵循 / 省时纪律 / 回执格式）：同一处抽出。 */
const BASE_SUFFIX_PATH = join(HERE, 'base-persona.suffix.md')
/** 本包自带的工具面遮罩插件（package.json exports: "./tool-mask"）。 */
const TOOL_MASK_PLUGIN = 'dsh-preset-efficiency/tool-mask'

/**
 * 「附、技能提案」尾巴：所有模式共用（底座纪律之后、模式人格之前）。
 * 内容逐字固定——改这里就等于改每个模式的人格。
 */
export const MODE_TAIL = [
  '━━━ 附、技能提案（所有模式都适用）━━━',
  '',
  '你不是一次性工具。干完活，如果你这次摸出了一套下次还能用的做法，把它写下来交上去。',
  '',
  '- 什么时候写：这件活有套路——步骤有先后、有踩过的坑、有验收方式。一次性的搬运不用写。',
  '- 写到哪：`<工作区>/.planner/<任务slug>/proposals/<skill-name>/SKILL.md`',
  '- 名字规矩：目录名与 front-matter 的 `name` 都必须是 `mode-<模式id>-<短名>`，全小写加连字符。',
  '- front-matter 必须有 `name` 和 `description`；`description` 写「什么时候该用它」，一句话，不写「它能干什么」。',
  '- 正文写四段：什么时候用 / 步骤 / 踩过的坑 / 怎么算做完。写下次还成立的东西，不写这次的具体文件名。',
  '- 写完在回执里单独一行：`提案：<绝对路径>（<一句话>）`。',
  '- **你没资格把它塞进库。** 进不进库由用户点头，你不许复制到任何 skills 目录，也不许改 `mode-skills` 下的东西。',
  '- 没有值得沉淀的就别写。一份垃圾提案比零份更糟。',
].join('\n')

/** 人格 suffix：底座纪律 → 附·技能提案 → 模式人格；模式人格为空时不留尾巴空行。 */
export function composePersonaSuffix(baseSuffix, persona) {
  const head = baseSuffix + '\n\n' + MODE_TAIL
  return persona === '' || persona === undefined || persona === null ? head : head + '\n\n' + persona
}

/** 原样读一段人格正文（只把 CRLF 归一成 LF，不 trim——尾随换行要跟 YAML 逐字对齐）。 */
function readPersonaPart(target) {
  try {
    return readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}

/**
 * 读底座 `prefix`（身份声明）。读不到返回空串：只丢身份，纪律还在。
 * @param {string} [filePath]
 * @returns {string}
 */
export function readBasePrefix(filePath) {
  return readPersonaPart(filePath === undefined || filePath === '' ? BASE_PREFIX_PATH : filePath)
}

/**
 * 读底座 `suffix`（纪律全文）。读不到返回空串——调用方必须 warn，
 * 因为空 suffix 会把整部纪律（指令遵循 / 省时纪律 / 回执格式）丢掉。
 * @param {string} [filePath]
 * @returns {string}
 */
export function readBaseSuffix(filePath) {
  return readPersonaPart(filePath === undefined || filePath === '' ? BASE_SUFFIX_PATH : filePath)
}

/** 兼容旧名：等价于 readBasePrefix（老调用方拿的是身份那段）。 */
export function readBasePersona(filePath) {
  return readBasePrefix(filePath)
}

/**
 * mode.yml 的 denyPrefixes / deny → 一行 tool-mask。两条都没写就不生成。
 * @param {string} modeId
 * @param {string[]} denyPrefixes
 * @param {string[]} deny
 * @returns {object | null}
 */
export function buildToolMaskRow(modeId, denyPrefixes, deny) {
  const prefixes = Array.isArray(denyPrefixes) ? denyPrefixes.map(String).filter((entry) => entry !== '') : []
  const exact = Array.isArray(deny) ? deny.map(String).filter((entry) => entry !== '') : []
  if (prefixes.length === 0 && exact.length === 0) return null
  const config = {}
  if (prefixes.length > 0) config.denyPrefixes = prefixes
  if (exact.length > 0) config.deny = exact
  return { id: 'mode-' + modeId + '-tool-mask', name: TOOL_MASK_PLUGIN, config }
}

// ─────────────────────────────────────────────────────────────────────────────
// 极简 YAML 子集解析：只认 mode.yml 用到的那部分（映射 / 序列 / 标量 / | > 块）
// 不引第三方包——这个 bundle 没有运行时依赖，也不想因为读一个 mode.yml 就装东西。
// ─────────────────────────────────────────────────────────────────────────────

function stripComment(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

/** 找 key: value 里的那个冒号：不在引号内、后面是空白或行尾。 */
function findColon(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i
  }
  return -1
}

function unquote(text) {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}

function splitFlow(text) {
  const body = text.trim().slice(1, -1)
  const parts = []
  let quote = ''
  let current = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote !== '') {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((part) => parseScalar(part))
}

function parseScalar(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return splitFlow(trimmed)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return null
  const bare = unquote(trimmed)
  if (bare === 'true') return true
  if (bare === 'false') return false
  if (bare === 'null' || bare === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(bare) && trimmed === bare) return Number(bare)
  return bare
}

/**
 * 解析 mode.yml。
 * @param {string} text 文件正文
 * @returns {Record<string, unknown>} 顶层映射
 */
export function parseModeYaml(text) {
  const raw = String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
  const toks = []
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i].replace(/\t/g, '    ')
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    toks.push({ indent, text: stripComment(line.slice(indent)).trimEnd(), raw: i })
  }
  let pos = 0
  const peek = () => toks[pos]

  const fail = (token, why) => {
    const lineNo = token === undefined ? raw.length : token.raw + 1
    throw new Error('mode.yml 第 ' + lineNo + ' 行：' + why)
  }

  function blockScalar(header, rawIndex, parentIndent) {
    const lines = []
    let endRaw = rawIndex
    for (let i = rawIndex + 1; i < raw.length; i += 1) {
      const line = raw[i].replace(/\t/g, '    ')
      if (/^\s*$/.test(line)) {
        lines.push('')
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent <= parentIndent) break
      lines.push(line)
      endRaw = i
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const indents = lines.filter((line) => line !== '').map((line) => line.length - line.trimStart().length)
    const cut = indents.length === 0 ? 0 : Math.min(...indents)
    const dedented = lines.map((line) => (line === '' ? '' : line.slice(cut)))
    if (header.startsWith('>')) {
      const out = []
      let buffer = ''
      for (const line of dedented) {
        if (line === '') {
          if (buffer !== '') out.push(buffer)
          buffer = ''
          out.push('')
          continue
        }
        buffer = buffer === '' ? line : buffer + ' ' + line
      }
      if (buffer !== '') out.push(buffer)
      return { value: out.join('\n').replace(/\n+$/, ''), endRaw }
    }
    return { value: dedented.join('\n').replace(/\n+$/, ''), endRaw }
  }

  function parseSeq(indent) {
    const items = []
    while (pos < toks.length) {
      const token = peek()
      if (token.indent !== indent) break
      if (token.text !== '-' && !token.text.startsWith('- ')) break
      const rest = token.text === '-' ? '' : token.text.slice(2).trim()
      if (rest === '') {
        pos += 1
        const next = peek()
        items.push(next !== undefined && next.indent > indent ? parseBlock(next.indent) : null)
        continue
      }
      if (findColon(rest) >= 0) {
        // 列表项即映射：把这一行改写成映射的第一行，接着按映射解析
        token.indent = indent + 2
        token.text = rest
        items.push(parseMap(indent + 2))
        continue
      }
      pos += 1
      items.push(parseScalar(rest))
    }
    return items
  }

  function parseMap(indent) {
    const obj = {}
    while (pos < toks.length) {
      const token = peek()
      if (token.indent < indent) break
      if (token.indent > indent) fail(token, '缩进对不上（多缩进了）')
      if (token.text === '-' || token.text.startsWith('- ')) break
      const colon = findColon(token.text)
      if (colon < 0) fail(token, '这一行不是「键: 值」')
      const key = unquote(token.text.slice(0, colon))
      const rest = token.text.slice(colon + 1).trim()
      pos += 1
      if (rest === '') {
        const next = peek()
        obj[key] = next !== undefined && next.indent > indent ? parseBlock(next.indent) : null
      } else if (/^[|>][+-]?\s*$/.test(rest)) {
        const block = blockScalar(rest, token.raw, indent)
        obj[key] = block.value
        // 块标量的正文也被 token 化过，跳过它们，否则缩进检查会误判
        while (pos < toks.length && toks[pos].raw <= block.endRaw) pos += 1
      } else {
        obj[key] = parseScalar(rest)
      }
    }
    return obj
  }

  function parseBlock(indent) {
    const token = peek()
    if (token === undefined) return null
    if (token.text === '-' || token.text.startsWith('- ')) return parseSeq(indent)
    return parseMap(indent)
  }

  const first = peek()
  if (first === undefined) return {}
  if (first.indent !== 0) fail(first, '顶层不该缩进')
  const parsed = parseBlock(0)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('mode.yml 顶层必须是映射（key: value）')
  }
  return parsed
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫描 + 组预设定义
// ─────────────────────────────────────────────────────────────────────────────

/** 模式的 shipped / local 库目录。 */
export function resolveSkillDir(entry, options) {
  if (entry === 'shipped') return resolve(options.modeDir, 'skills')
  if (entry === 'local') return resolve(options.profileDir, 'mode-skills', options.modeId)
  return isAbsolute(entry) ? resolve(entry) : resolve(options.modeDir, entry)
}

/** 一行 skill provider：不继承工作区/用户级库，只看出厂库 + 本地积累库。 */
export function buildSkillProviderRow(modeId, skillDirs) {
  return {
    id: 'mode-' + modeId + '-skill-filesystem',
    name: SKILL_PROVIDER,
    config: {
      includeDefaultRoots: false,
      customSkillDirs: skillDirs,
      watch: true,
    },
  }
}

function normalizeMode(file, data, modeDir, warnings) {
  const id = typeof data.id === 'string' ? data.id.trim() : ''
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  if (!ID_RE.test(id)) {
    warnings.push(file + '：id ' + JSON.stringify(data.id) + ' 不是小写英文+连字符，跳过')
    return null
  }
  if (name === '' || description === '') {
    warnings.push(file + '：name / description 是必填，跳过')
    return null
  }
  const order = Number.isFinite(data.order) ? Number(data.order) : DEFAULT_ORDER
  const persona = typeof data.persona === 'string' ? data.persona.trim() : ''
  const denyPrefixes = Array.isArray(data.denyPrefixes) ? data.denyPrefixes.map(String).filter((entry) => entry !== '') : []
  const deny = Array.isArray(data.deny) ? data.deny.map(String).filter((entry) => entry !== '') : []
  const declared = Array.isArray(data.plugins) ? data.plugins : []
  const skillEntries = Array.isArray(data.skillDirs) && data.skillDirs.length > 0
    ? data.skillDirs.map((entry) => String(entry))
    : DEFAULT_SKILL_DIRS
  return { id, name, description, order, persona, denyPrefixes, deny, declared, skillEntries, modeDir }
}

function modePlugins(mode, basePrefix, baseSuffix) {
  const rows = []
  // 一行人格：prefix = 底座身份（base-persona.prefix.md），
  // suffix = 底座纪律全文（base-persona.suffix.md）+ 空行 + 附·技能提案（MODE_TAIL）+ 空行 + 本模式那段。
  // 纪律必须在 suffix 里：只写模式那段等于把指令遵循 / 省时纪律 / 回执格式整部扔掉，
  // 模式越专用，丢得越干净。提案纪律对所有模式都成立，所以 persona 为空也照样生成这一行。
  rows.push({
    id: 'mode-' + mode.id + '-persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: basePrefix, suffix: composePersonaSuffix(baseSuffix, mode.persona) },
  })
  const mask = buildToolMaskRow(mode.id, mode.denyPrefixes, mode.deny)
  if (mask !== null) rows.push(mask)
  for (let index = 0; index < mode.declared.length; index += 1) {
    const row = mode.declared[index]
    if (row === null || typeof row !== 'object' || typeof row.name !== 'string' || row.name === '') continue
    // 模式的插件行统一加 mode-<id>- 前缀：跟底座行撞 id 时不会让整份预设挂不上。
    const rawId = typeof row.id === 'string' && row.id !== '' ? row.id : 'plugin-' + (index + 1)
    rows.push({ ...row, id: 'mode-' + mode.id + '-' + rawId })
  }
  return rows
}

/**
 * 扫 modes/<id>/mode.yml，产出预设定义。
 * @param {{ modesDir?: string, profileDir?: string, basePlugins?: unknown[] }} options
 * @returns {{ modes: object[], definitions: object[], warnings: string[] }}
 */
export function scanModes(options) {
  const opts = options === undefined || options === null ? {} : options
  const modesDir = resolve(opts.modesDir !== undefined ? opts.modesDir : join(HERE, 'modes'))
  const profileDir = resolve(opts.profileDir !== undefined
    ? opts.profileDir
    : (process.env.DSH_HOME !== undefined ? process.env.DSH_HOME : join(homedir(), '.dsh')))
  const basePlugins = Array.isArray(opts.basePlugins) ? opts.basePlugins : BASE_PLUGINS
  const basePrefix = readBasePrefix(opts.basePrefixPath)
  const baseSuffix = readBaseSuffix(opts.baseSuffixPath)
  const warnings = []
  if (basePrefix === '') {
    warnings.push('读不到底座身份 ' + BASE_PREFIX_PATH + '：人格行的 prefix 会是空的')
  }
  if (baseSuffix === '') {
    warnings.push('读不到底座纪律 ' + BASE_SUFFIX_PATH + '：人格行只剩模式那段，纪律会整段丢')
  }
  const modes = []
  const seen = new Set()

  let entries = []
  try {
    entries = readdirSync(modesDir, { withFileTypes: true })
  } catch (error) {
    warnings.push('扫不到模式目录 ' + modesDir + '：' + (error instanceof Error ? error.message : String(error)))
    return { modes, definitions: [], warnings, modesDir, profileDir }
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const dirName of dirs) {
    const modeDir = join(modesDir, dirName)
    let text
    try {
      text = readFileSync(join(modeDir, 'mode.yml'), 'utf8')
    } catch {
      try {
        text = readFileSync(join(modeDir, 'mode.yaml'), 'utf8')
      } catch {
        continue
      }
    }
    let data
    try {
      data = parseModeYaml(text)
    } catch (error) {
      warnings.push(join(modeDir, 'mode.yml') + '：' + (error instanceof Error ? error.message : String(error)))
      continue
    }
    const mode = normalizeMode(join(modeDir, 'mode.yml'), data, modeDir, warnings)
    if (mode === null) continue
    if (seen.has(mode.id)) {
      warnings.push(join(modeDir, 'mode.yml') + '：id ' + mode.id + ' 重复，跳过')
      continue
    }
    seen.add(mode.id)
    modes.push(mode)
  }

  modes.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order))

  const definitions = modes.map((mode) => {
    const skillDirs = mode.skillEntries.map((entry) => resolveSkillDir(entry, {
      modeId: mode.id,
      modeDir: mode.modeDir,
      profileDir,
    }))
    return {
      id: mode.id,
      name: mode.name,
      description: mode.description,
      order: mode.order,
      plugins: [...basePlugins, ...modePlugins(mode, basePrefix, baseSuffix), buildSkillProviderRow(mode.id, [...new Set(skillDirs)])],
    }
  })

  return { modes, definitions, warnings, modesDir, profileDir }
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatch_mode
// ─────────────────────────────────────────────────────────────────────────────

const DISPATCH_NAME = 'dispatch_mode'
const DISPATCH_PROVIDER = 'spawn'

/**
 * 默认模式：永远是 general（存在时）；没有 general 就取 order 最小的那个（modes 已按 order 排好）。
 * 不能靠枚举顺序兜底——ppt 的 order(30) 比 general(100) 小，枚举第一位会变成 ppt。
 * @param {{ id: string, order?: number }[]} modes
 * @returns {string}
 */
export function defaultModeId(modes) {
  const list = Array.isArray(modes) ? modes : []
  if (list.some((mode) => mode.id === 'general')) return 'general'
  return list.length === 0 ? '' : list[0].id
}

/** 枚举顺序：general 排第一位，其余保持 order 顺序。 */
export function orderModeIds(modes) {
  const ids = (Array.isArray(modes) ? modes : []).map((mode) => mode.id)
  const index = ids.indexOf('general')
  if (index > 0) {
    ids.splice(index, 1)
    ids.unshift('general')
  }
  return ids
}

function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * 造 dispatch_mode 工具。枚举 = 扫到的 id 集合，从目录算出来，不写死。
 * @param {{ modes: object[], getProvider: Function, start: Function, providerName?: string }} deps
 */
export function createDispatchTool(deps) {
  const modes = Array.isArray(deps.modes) ? deps.modes : []
  const ids = orderModeIds(modes)
  const defaultId = defaultModeId(modes)
  const byId = new Map(modes.map((mode) => [mode.id, mode]))
  const providerName = deps.providerName !== undefined ? deps.providerName : DISPATCH_PROVIDER

  return {
    name: DISPATCH_NAME,
    description:
      '把一个活派给某个模式的子代理：子代理按该模式的预设装配（工具面、人格、技能库）。' +
      '枚举值来自 modes/ 目录，加一个模式目录就多一个可选值。' +
      '子代理会自己跑到结束，结果通过完成通知回到你这里；不要为它轮询。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ids,
          default: defaultId,
          description: '派给哪个模式（默认 ' + defaultId + '）。' + modes.map((mode) => mode.id + '：' + mode.description).join('；'),
        },
        prompt: { type: 'string', description: '完整的任务书：目标、输入、产物路径、验收标准。它看不到你的对话。' },
        description: { type: 'string', description: '3–5 个字的短标签，只用于界面显示。' },
      },
      required: ['mode', 'prompt'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mode = typeof args.mode === 'string' ? args.mode.trim() : ''
      if (!byId.has(mode)) {
        throw new Error(DISPATCH_NAME + '：未知模式 ' + JSON.stringify(args.mode) + '；可选：' + ids.join(', '))
      }
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (prompt.trim() === '') throw new Error(DISPATCH_NAME + '：prompt 不能为空')
      const parent = exec === undefined || exec === null ? undefined : exec.agent
      if (parent === undefined || parent === null) throw new Error(DISPATCH_NAME + '：需要调用方 agent（exec.agent 为空）')

      const provider = deps.getProvider(providerName)
      if (provider === undefined || provider === null) {
        throw new Error(
          DISPATCH_NAME + '：子代理 provider ' + JSON.stringify(providerName) + ' 没注册，派不出去。' +
          '检查 profile 里有没有装对应的 subagent provider 插件。',
        )
      }
      if (provider.capabilities === undefined || provider.capabilities.agentPreset !== true || provider.inheritsParentContext === true) {
        throw new Error(
          DISPATCH_NAME + '：provider ' + JSON.stringify(providerName) + ' 不支持独立选择预设' +
          '（capabilities.agentPreset / inheritsParentContext 不满足），派不出去。',
        )
      }

      const label = typeof args.description === 'string' && args.description.trim() !== ''
        ? args.description.trim()
        : 'mode:' + mode
      const activation = await deps.start({
        provider: providerName,
        label,
        request: {
          prompt: text(prompt),
          parent,
          agentPreset: mode,
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      const childId = activation === undefined || activation === null ? undefined : activation.childId
      return {
        kind: 'activation',
        mode,
        subagentId: String(childId === undefined ? '' : childId),
        summary: '已按「' + mode + '」模式派工，子代理 ' + String(childId === undefined ? '(未返回 id)' : childId) + '；等它的完成通知。',
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          mode: { type: 'string' },
          subagentId: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['kind', 'mode', 'subagentId', 'summary'],
      },
      render: (_args, value) => text(String(value.summary)),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const options = config === null || config === undefined ? {} : config
  const scan = scanModes({
    modesDir: options.modesDir,
    profileDir: options.profileDir,
    basePlugins: options.basePlugins,
  })
  const warn = (message) => {
    if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn('modes-registry: ' + message)
  }
  for (const warning of scan.warnings) warn(warning)
  if (scan.definitions.length === 0) warn(scan.modesDir + ' 下没扫到任何 mode.yml，只挂工具不注册预设')

  for (const definition of scan.definitions) {
    const dispose = await ctx.agentPresets.register(definition)
    ctx.effect(() => dispose, 'efficiency: 模式预设 ' + definition.id)
  }

  const tool = createDispatchTool({
    modes: scan.modes,
    providerName: typeof options.provider === 'string' ? options.provider : undefined,
    getProvider: (name) => ctx.subagents.getProvider(name),
    start: (spec) => ctx.subagents.startActivation(spec),
  })
  ctx.effect(() => ctx.tools.register(tool), 'efficiency: ' + DISPATCH_NAME)
}
