/**
 * 技能提案闸门：`skill_proposal`。
 *
 * 为什么需要这个文件：
 *   工人干完活会在 `.planner/<slug>/proposals/<skill>/SKILL.md` 里交一份「这次摸出来的套路」。
 *   那份东西进不进库，是**用户**的事，不是模型的事。所以这里把它做成一次真实的用户交互：
 *
 *     propose → 只校验 + 记账，一个字节都不写
 *     promote → 先把全文推给用户点「确认入库」/「先不要」，点头了才复制进库
 *
 * 硬约束（这条是整个文件存在的理由）：
 *   **确认状态只能来自 ctx.userQuestions.ask 的返回。**
 *   参数里没有 `confirmed` 这样的字段，也没读它 —— 模型塞什么进来都无效。
 *   ask 抛错、超时、返回空、用户点「先不要」—— 一律按「没确认」处理，
 *   目标目录下的文件数一个都不许变。
 *
 * 库的位置：<DSH_HOME 或 ~/.dsh>/mode-skills/<mode>/<skill>/SKILL.md
 *   DSH_HOME 在**调用时**读，不在模块加载时读 —— 测试才敢把它指到临时目录。
 *
 * 边界（如实说明）：
 *   - 拦得住走工具注册表的路。绕过工具、直接写文件的野路子它看不见，那是沙箱与人格的事。
 *   - 记账是进程内一份 Map，重启就没了。它的用途是给人看「提过什么」，不是当数据库。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const inject = ['tools', 'userQuestions']

const TOOL_NAME = 'skill_proposal'
const APPROVE_LABEL = '确认入库'
const REJECT_LABEL = '先不要'
const MAX_PREVIEW_CHARS = 1200

/** 进程内账本：mode/skill → 提案记录。只记账，不当数据库。 */
const proposals = new Map()

function text(value) {
  return [{ type: 'text', text: value }]
}

function fail(message) {
  throw new Error(message)
}

function pickString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 库根目录。DSH_HOME 以调用时为准，便于测试把它指到临时目录。 */
function resolveHome() {
  const env = pickString(process.env.DSH_HOME)
  if (env !== '') return resolve(env)
  return join(homedir(), '.dsh')
}

function targetOf(mode, skill) {
  return join(resolveHome(), 'mode-skills', mode, skill, 'SKILL.md')
}

function asSlashes(value) {
  return resolve(value).split('\\').join('/')
}

/** 提案必须躺在某个 .planner 目录下 —— 这是提案区的定义，不是建议。 */
function underPlanner(file) {
  return asSlashes(file)
    .split('/')
    .some((part) => part.toLowerCase() === '.planner')
}

function checkMode(mode) {
  if (mode === '') fail('skill_proposal 需要 mode（模式 id，例如 ppt）。')
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(mode)) {
    fail('mode 不合法：' + mode + '。只允许字母、数字、下划线和短横线。')
  }
}

function checkSkill(skill, mode) {
  if (skill === '') fail('skill_proposal 需要 skill（技能名，例如 mode-ppt-deck）。')
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill)) {
    fail('skill 不合法：' + skill + '。只允许字母、数字、下划线和短横线。')
  }
  const prefix = 'mode-' + mode + '-'
  if (!skill.startsWith(prefix)) {
    fail('skill 必须以 ' + prefix + ' 开头（模式 ' + mode + ' 的技能都带这个前缀），实际是 ' + skill + '。')
  }
}

/** 读 front-matter：第一行 ---，到下一个 --- 为止，只认 key: value。 */
function readFrontMatter(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    fail('提案 SKILL.md 读不出来：' + file)
  }
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    fail('提案 SKILL.md 缺 front-matter：第一行必须是 ---。文件：' + file)
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) fail('提案 SKILL.md 的 front-matter 没有闭合（缺第二个 ---）：' + file)
  const fields = {}
  for (let i = 1; i < end; i += 1) {
    const hit = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i])
    if (hit !== null) {
      fields[hit[1].toLowerCase()] = hit[2].trim().replace(/^["']|["']$/g, '').trim()
    }
  }
  return { fields, raw }
}

/** propose / promote 共用的入参校验。任何一条不过就直接报错，问题不递到用户面前。 */
function inspect(args) {
  const input = args !== null && typeof args === 'object' ? args : {}
  const mode = pickString(input.mode).toLowerCase()
  const skill = pickString(input.skill)
  checkMode(mode)
  checkSkill(skill, mode)

  const rawPath = pickString(input.path)
  if (rawPath === '') fail('skill_proposal 需要 path（提案 SKILL.md 的绝对路径）。')
  if (!isAbsolute(rawPath)) {
    fail('path 必须是绝对路径（相对路径解析到哪儿说不准）。收到的：' + rawPath)
  }
  const file = resolve(rawPath)
  if (!underPlanner(file)) {
    fail('path 必须在某个 .planner 目录下（提案区在 .planner/<slug>/proposals/<skill>/）。收到的：' + file)
  }
  if (!existsSync(file)) fail('提案文件不存在：' + file)
  let stat
  try {
    stat = statSync(file)
  } catch {
    fail('提案文件读不出属性：' + file)
  }
  if (!stat.isFile()) fail('提案路径不是文件：' + file)

  const { fields, raw } = readFrontMatter(file)
  if (fields.name === undefined || fields.name === '') {
    fail('提案 SKILL.md 的 front-matter 缺 name 字段（技能名，例如 mode-ppt-deck）。文件：' + file)
  }
  if (fields.description === undefined || fields.description === '') {
    fail('提案 SKILL.md 的 front-matter 缺 description 字段（一句话：什么时候派它）。文件：' + file)
  }
  if (fields.name !== skill) {
    fail(
      'front-matter 的 name（' + fields.name + '）与 skill 参数（' + skill + '）不一致。' +
        '两边必须一模一样，否则入库之后模型按名字找不到它。',
    )
  }
  return { mode, skill, file, raw, description: fields.description }
}

function propose(spot, input) {
  const summary = pickString(input.summary)
  if (summary === '') {
    fail('propose 需要 summary（一句话：这次摸出来的是什么套路，给用户看的）。')
  }
  const key = spot.mode + '/' + spot.skill
  proposals.set(key, {
    mode: spot.mode,
    skill: spot.skill,
    path: spot.file,
    summary,
    at: Date.now(),
  })
  return {
    ok: true,
    mode: spot.mode,
    skill: spot.skill,
    path: spot.file,
    target: targetOf(spot.mode, spot.skill),
    bytes: 0,
    recorded: proposals.size,
    message:
      '收到了：' + spot.skill + ' 的提案（' + summary + '）。还没入库——等你点头。',
    next:
      '下一步：跟用户确认这是不是他要的那套之后，调 skill_proposal 的 action: "promote"（同 mode / skill / path）。' +
      'promote 会把这份 SKILL.md 的正文推给用户点「确认入库」；没点头，一个字节都不会写进库。',
  }
}

function refuse(spot, reason, recorded) {
  return {
    ok: false,
    mode: spot.mode,
    skill: spot.skill,
    path: spot.file,
    target: '',
    bytes: 0,
    recorded,
    message:
      '没入库。' + reason + '\n这份 ' + spot.skill + ' 还在提案区：' + spot.file,
    next:
      '不要绕路：不许自己写 <DSH_HOME>/mode-skills/...，也不许在参数里塞「已确认」之类的字段——' +
      '确认只认用户点的那颗按钮。先把用户的话带回去改提案，改完再调一次 promote。',
  }
}

async function promote(ctx, spot, input, exec) {
  const recorded = proposals.size
  const key = spot.mode + '/' + spot.skill
  const known = proposals.get(key)
  const summary = pickString(input.summary) !== '' ? pickString(input.summary) : known === undefined ? '' : known.summary
  const target = targetOf(spot.mode, spot.skill)
  const preview =
    spot.raw.length > MAX_PREVIEW_CHARS
      ? spot.raw.slice(0, MAX_PREVIEW_CHARS) + '\n\n……（过长，其余请看 ' + spot.file + '）'
      : spot.raw
  const detail = [
    '提案：' + spot.file,
    '入库到：' + target,
    summary !== '' ? '一句话：' + summary : '',
    '',
    preview,
  ]
    .filter((line) => line !== '')
    .join('\n')

  const questions = ctx === null || ctx === undefined ? undefined : ctx.userQuestions
  if (questions === undefined || questions === null || typeof questions.ask !== 'function') {
    return refuse(spot, '这次拿不到用户提问通道，没法确认——没有确认就不写。', recorded)
  }

  let reason = ''
  try {
    const answer = await ctx.userQuestions.ask({
      agent: exec === null || exec === undefined ? undefined : exec.agent,
      signal: exec === null || exec === undefined ? undefined : exec.signal,
      questions: [
        {
          id: 'skill-promote',
          header: '技能入库确认',
          question: '这份 ' + spot.skill + ' 要进 ' + spot.mode + ' 的库吗？',
          detail,
          options: [
            { label: APPROVE_LABEL, description: '内容没问题，复制进库' },
            { label: REJECT_LABEL, description: '先不要，留在提案区' },
          ],
        },
      ],
    })
    const item = answer !== null && answer !== undefined && Array.isArray(answer.answers) ? answer.answers[0] : undefined
    const selected = item !== undefined && Array.isArray(item.selected) ? item.selected : []
    if (!selected.includes(APPROVE_LABEL)) {
      const custom = item !== undefined && typeof item.custom === 'string' ? item.custom.trim() : ''
      const feedback = custom !== '' ? custom : selected.join('、')
      reason =
        '用户没有确认入库' +
        (feedback !== '' ? '：' + feedback : '（没点确认、也没写意见）') +
        '。'
    }
  } catch (error) {
    const message = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    reason = '问用户没有成功（' + message + '），按「没确认」处理。'
  }

  // 到这里为止：一次写操作都没发生。
  if (reason !== '') return refuse(spot, reason, proposals.size)

  const source = readFileSync(spot.file)
  const targetDir = dirname(target)
  mkdirSync(targetDir, { recursive: true })
  copyFileSync(spot.file, target)
  const copied = readFileSync(target)
  if (!source.equals(copied)) {
    fail('复制后内容不一致：' + target + '（源 ' + source.length + ' 字节，目标 ' + copied.length + ' 字节）')
  }

  proposals.set(key, {
    mode: spot.mode,
    skill: spot.skill,
    path: spot.file,
    summary,
    at: known === undefined ? Date.now() : known.at,
    promotedAt: Date.now(),
    target,
  })

  return {
    ok: true,
    mode: spot.mode,
    skill: spot.skill,
    path: spot.file,
    target,
    bytes: copied.length,
    recorded: proposals.size,
    message:
      '已入库：' + spot.skill + ' → ' + target + '（' + copied.length + ' 字节，与提案逐字节一致）',
    next:
      '用户已经点过「确认入库」，这件事到此为止，不用再问一遍。' +
      '下次做同类活直接用 ' + spot.skill + '；要改它，先在提案区出新版 SKILL.md，再走一次 propose + promote。',
  }
}

export function apply(ctx) {
  const definition = {
    name: TOOL_NAME,
    description:
      '技能提案闸门：工人在 .planner/<slug>/proposals/<skill>/SKILL.md 交上来的套路，靠它进库。' +
      'action: "propose" 只校验 + 记账（front-matter 要有 name 与 description，name 必须等于 skill，' +
      'path 必须是 .planner 下的绝对路径），一个字节都不写；' +
      'action: "promote" 会把正文推给用户点「确认入库」/「先不要」，只有用户点了确认才复制进 ' +
      '<DSH_HOME>/mode-skills/<mode>/<skill>/SKILL.md。' +
      '确认只认用户点的按钮：参数里塞任何「已确认」字段都无效。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose', 'promote'], description: 'propose = 交提案；promote = 请用户点头后入库' },
        mode: { type: 'string', description: '模式 id，例如 ppt' },
        skill: { type: 'string', description: '技能名，必须 mode-<mode>- 开头，例如 mode-ppt-deck' },
        path: { type: 'string', description: '提案 SKILL.md 的绝对路径，必须在某个 .planner 目录下' },
        summary: { type: 'string', description: '一句话：这次摸出来的是什么套路' },
      },
      required: ['action', 'mode', 'skill', 'path'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,

    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = pickString(input.action).toLowerCase()
      if (action !== 'propose' && action !== 'promote') {
        fail('action 只能是 "propose" 或 "promote"，收到的是：' + (action === '' ? '(空)' : action))
      }
      const spot = inspect(input)
      if (action === 'propose') return propose(spot, input)
      return promote(ctx, spot, input, exec)
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          skill: { type: 'string' },
          path: { type: 'string' },
          target: { type: 'string' },
          bytes: { type: 'integer' },
          recorded: { type: 'integer' },
          message: { type: 'string' },
          next: { type: 'string' },
        },
        required: ['ok', 'mode', 'skill', 'path', 'target', 'bytes', 'recorded', 'message', 'next'],
      },
      render: (_args, value) => text(String(value.message) + '\n\n' + String(value.next)),
    },
  }

  ctx.effect(() => ctx.tools.register(definition), 'planner: 技能提案闸门 skill_proposal')
}
