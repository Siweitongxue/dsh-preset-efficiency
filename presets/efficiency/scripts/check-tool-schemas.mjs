#!/usr/bin/env node
/**
 * check-tool-schemas.mjs —— 工具 output schema 的静态防复发检查。
 *
 * 背景：真激活时 ctx.tools.register 会因为 output.schema 里写了属性级
 * `required: true`（per-property 布尔）抛 JsonSchemaError，整行回滚，
 * 所有模式预设和 dispatch_mode 全都没注册出来。这个检查在离线 CI 里提前拦住。
 *
 * 三道检查（针对每个 output 声明）：
 *   1. output 必须同时有 schema 与 render；
 *   2. properties 下每个字段都必须有 type；
 *   3. 不许出现属性级 required: true|false（正确写法是对象级 required: [...]）。
 * 附带：schema 自己的 required 写了就必须是数组。
 *
 * 实现是启发式的：先把字符串 / 注释 / 正则字面量涂成空格（mask），
 * 再做花括号配对与顶层 key 扫描；不是完整的 JS / JSON Schema 解析器。
 * 认不出来的写法会记成 problem（宁可疑，不放过）。
 *
 * 用法：node scripts/check-tool-schemas.mjs
 *       node scripts/check-tool-schemas.mjs --root <目录>
 * 不传 --root 时行为不变：只扫自己这个 bundle。传了就扫指定目录（报告路径相对该目录）。
 * 输出：OK — x checked / 0 problems  或  FAIL — 逐条列出 文件:行号: 问题
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function parseRootArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value === '' || value.startsWith('--')) return { error: '--root 后面要跟一个目录' }
      return { dir: value }
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length)
      if (value === '') return { error: '--root= 后面要跟一个目录' }
      return { dir: value }
    }
  }
  return { dir: null }
}

const rootArg = parseRootArg(process.argv.slice(2))
if (rootArg.error !== undefined) {
  console.error('check-tool-schemas: ' + rootArg.error + '\n用法：node scripts/check-tool-schemas.mjs [--root <目录>]')
  process.exit(2)
}

const ROOT = rootArg.dir === null ? SELF_ROOT : resolve(rootArg.dir)
let rootStat = null
try {
  rootStat = statSync(ROOT)
} catch {
  rootStat = null
}
if (rootStat === null || !rootStat.isDirectory()) {
  console.error('check-tool-schemas: 目录不存在：' + ROOT)
  process.exit(2)
}
const SKIP_DIRS = new Set(['node_modules', 'scripts', '.git', '_oss'])

function collectSourceFiles(dir, files) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectSourceFiles(full, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(full)
  }
  return files
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** i 指向引号字符；返回闭合引号之后的下标。 */
function skipQuoted(text, i) {
  const quote = text[i]
  i += 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i += 1
  }
  return i
}

/** i 指向正则字面量开头的 /；返回结尾 / 之后的下标。 */
function skipRegex(text, i) {
  let j = i + 1
  let inClass = false
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '\n') return j
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return j + 1
    j += 1
  }
  return j
}

const REGEX_PREFIX_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])

/** 字符串 / 注释 / 正则字面量涂成空格（保留换行），长度与原文一致。 */
function maskCode(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  let prevSignificant = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      let j = i + 2
      while (j < text.length && text[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      let j = i + 2
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j += 1
      j = Math.min(text.length, j + 2)
      blank(i, j)
      i = j
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const j = skipQuoted(text, i)
      blank(i, j)
      i = j
      prevSignificant = 'x'
      continue
    }
    if (ch === '/' && REGEX_PREFIX_CHARS.has(prevSignificant)) {
      const j = skipRegex(text, i)
      blank(i, j)
      i = j
      prevSignificant = 'x'
      continue
    }
    if (!/\s/.test(ch)) prevSignificant = ch
    i += 1
  }
  return out.join('')
}

/** 从 open 处的括号找到配对的那个下标；找不到返回 -1。输入是已 mask 的代码。 */
function matchBracket(code, open) {
  const openCh = code[open]
  const closeCh = openCh === '{' ? '}' : openCh === '(' ? ')' : ']'
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === openCh) depth += 1
    else if (ch === closeCh) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 所有对象字面量的区间。 */
function objectRanges(code) {
  const ranges = []
  const stack = []
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '{') stack.push(i)
    else if (code[i] === '}') {
      const start = stack.pop()
      if (start !== undefined) ranges.push({ start, end: i })
    }
  }
  return ranges
}

/** 在 code[start] === '{'、code[end] === '}' 的区间里读出顶层 key 及其 value 区间。 */
function topLevelKeys(code, start, end) {
  const keys = []
  let i = start + 1
  let depth = 0
  let lastSignificant = '{'
  while (i < end) {
    const ch = code[i]
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1
      lastSignificant = ch
      i += 1
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1
      lastSignificant = ch
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (depth === 0 && (lastSignificant === '{' || lastSignificant === ',') && /[A-Za-z_$]/.test(ch)) {
      let keyEnd = i
      while (keyEnd < end && /[A-Za-z0-9_$]/.test(code[keyEnd])) keyEnd += 1
      const key = code.slice(i, keyEnd)
      let j = keyEnd
      while (j < end && /\s/.test(code[j])) j += 1
      if (code[j] === ':' && code[j + 1] !== ':') {
        let valueStart = j + 1
        while (valueStart < end && /\s/.test(code[valueStart])) valueStart += 1
        let valueEnd
        if (code[valueStart] === '{' || code[valueStart] === '[' || code[valueStart] === '(') {
          const close = matchBracket(code, valueStart)
          valueEnd = close < 0 ? end : close + 1
        } else {
          valueEnd = valueStart
          while (valueEnd < end && code[valueEnd] !== ',') valueEnd += 1
        }
        keys.push({ key, keyIndex: i, valueStart, valueEnd })
        i = valueEnd
        lastSignificant = 'x'
        continue
      }
    }
    lastSignificant = ch
    i += 1
  }
  return keys
}

function findKey(keys, name) {
  return keys.find((entry) => entry.key === name)
}

const problems = []
const reportedRequired = new Set()
let checked = 0
let fileCount = 0

function report(file, text, index, message) {
  problems.push(relative(ROOT, file) + ':' + lineOf(text, index) + ': ' + message)
}

/** 属性级 required 的两条路径会命中同一行：只报一次。 */
function reportRequired(file, text, index, message) {
  const key = file + '#' + lineOf(text, index)
  if (reportedRequired.has(key)) return
  reportedRequired.add(key)
  report(file, text, index, message)
}

function checkSchema(file, text, code, schema) {
  const schemaKeys = topLevelKeys(code, schema.start, schema.end)
  const requiredKey = findKey(schemaKeys, 'required')
  if (requiredKey !== undefined && code[requiredKey.valueStart] !== '[') {
    report(file, text, requiredKey.keyIndex, 'schema 级 required 必须是数组（required: [...]）')
  }
  const properties = findKey(schemaKeys, 'properties')
  if (properties === undefined) {
    report(file, text, schema.start, 'schema 里没有 properties')
    return
  }
  if (code[properties.valueStart] !== '{') {
    report(file, text, properties.keyIndex, 'properties 不是对象字面量（启发式判断不了）')
    return
  }
  const propKeys = topLevelKeys(code, properties.valueStart, properties.valueEnd - 1)
  if (propKeys.length === 0) {
    report(file, text, properties.keyIndex, 'properties 是空的')
    return
  }
  const propertyRegion = code.slice(properties.valueStart, properties.valueEnd)
  const badRequired = /\brequired\s*:\s*(true|false)\b/g
  let match
  while ((match = badRequired.exec(propertyRegion)) !== null) {
    const at = properties.valueStart + match.index
    reportRequired(file, text, at, '属性级 required: ' + match[1] + '（非法 JSON Schema，改成对象级 required: [...]）')
  }
  const badOptional = /\boptional\s*:\s*(true|false)\b/g
  while ((match = badOptional.exec(propertyRegion)) !== null) {
    const at = properties.valueStart + match.index
    report(file, text, at, '属性级 optional: true|false（不是合法 JSON Schema 关键字）')
  }
  for (const property of propKeys) {
    if (code[property.valueStart] !== '{') {
      report(file, text, property.keyIndex, '字段 ' + property.key + ' 不是对象字面量（启发式判断不了）')
      continue
    }
    const fieldKeys = topLevelKeys(code, property.valueStart, property.valueEnd - 1)
    if (findKey(fieldKeys, 'type') === undefined) {
      report(file, text, property.keyIndex, '字段 ' + property.key + ' 缺 type')
    }
    const fieldRequired = findKey(fieldKeys, 'required')
    if (fieldRequired !== undefined) {
      reportRequired(file, text, fieldRequired.keyIndex, '字段 ' + property.key + ' 上有属性级 required（非法 JSON Schema）')
    }
  }
}

function checkFile(file) {
  const text = readFileSync(file, 'utf8')
  const code = maskCode(text)
  fileCount += 1
  const registerMatch = /ctx\.tools\.register\s*\(/.exec(code)
  const ranges = objectRanges(code)
  const outputPattern = /\boutput\s*:\s*\{/g
  let match
  let found = 0
  while ((match = outputPattern.exec(code)) !== null) {
    const open = code.indexOf('{', match.index + match[0].length - 1)
    if (open < 0) continue
    const close = matchBracket(code, open)
    if (close < 0) {
      report(file, text, match.index, 'output 对象括号没配对（解析不了）')
      continue
    }
    // 宿主对象必须是工具对象：同时有 name 与 output（execute 常写成方法简写，key 扫描读不到）。
    const host = ranges
      .filter((range) => range.start < match.index && range.end > close)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
    if (host === undefined) continue
    const hostKeys = topLevelKeys(code, host.start, host.end)
    if (findKey(hostKeys, 'name') === undefined || findKey(hostKeys, 'output') === undefined) continue
    found += 1
    checked += 1
    const outputKeys = topLevelKeys(code, open, close)
    const schemaKey = findKey(outputKeys, 'schema')
    const renderKey = findKey(outputKeys, 'render')
    if (schemaKey === undefined) report(file, text, open, 'output 缺 schema')
    if (renderKey === undefined) report(file, text, open, 'output 缺 render')
    if (schemaKey !== undefined) {
      if (code[schemaKey.valueStart] !== '{') {
        report(file, text, schemaKey.keyIndex, 'output.schema 不是对象字面量（启发式判断不了）')
      } else {
        checkSchema(file, text, code, { start: schemaKey.valueStart, end: schemaKey.valueEnd - 1 })
      }
    }
  }
  if (registerMatch !== null && found === 0) {
    report(file, text, registerMatch.index, '有 ctx.tools.register 调用，但没定位到任何带 output 的工具对象（启发式没解析出来，请人工确认）')
  }
}

const files = collectSourceFiles(ROOT, []).sort()
for (const file of files) checkFile(file)

const summary = (problems.length === 0 ? 'OK — ' : 'FAIL — ') + checked + ' checked / ' + problems.length + ' problems'
console.log(summary + '  (' + files.length + ' 个 js 文件；启发式检查：mask 字符串/注释/正则 + 花括号配对 + 顶层 key，非完整解析器)')
for (const problem of problems) console.log('  ' + problem)
process.exitCode = problems.length === 0 ? 0 : 1
