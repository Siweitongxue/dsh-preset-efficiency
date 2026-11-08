/**
 * 开工闸门工具：`confirm_understanding`。
 *
 * 规划者的规矩是「先出理解文档，用户点了确认才开工」。这条规矩光写在人格里靠不住——
 * 人格是建议，模型可以绕。所以这里把它做成一次真实的用户交互：
 *
 *   文档不合格  → 直接报错，问题根本不递到用户面前（别拿半成品消耗用户注意力）
 *   文档合格    → 推到用户面前，两个按钮：「确认，开工」/「不对，要改」
 *   用户确认    → 记下这一版文档的哈希，守卫放行派工
 *   用户驳回    → 返回驳回意见，并保持闸门关闭
 *
 * 守卫在 guard.js 里按同一份哈希复核，所以「确认完又偷偷改文档」也过不去。
 *
 * 边界（如实说明）：
 *   - 拦的是派工（subagent / subagent_preset / subagent_fork / workflow），不是所有动作。
 *     读文件、写文档、问问题都不拦——开工前本来就要干这些。
 *   - 只拦得住走工具注册表的路。绕过工具、直接改文件的野路子它看不见，那是沙箱与人格的事。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { hashText, markConfirmed, markPlanConfirmed } from './gate-state.js'

export const inject = ['tools', 'userQuestions']

const DEFAULT_PATH = '.planner/understanding.md'
const DEFAULT_PLAN_PATH = '.planner/plan.md'
const DEFAULT_PLAN_MIN_CHARS = 600
const DEFAULT_MIN_CHARS = 1200
// 上限不是审美问题：超过这个长度，要么在灌水，要么把「怎么实现」写进来了。
const DEFAULT_MAX_CHARS = 3000
const MAX_DETAIL_CHARS = 16000
const APPROVE_LABEL = '确认，开工'
const REJECT_LABEL = '不对，要改'

/**
 * 九段。顺序即模板顺序；test 放宽到同义写法，宁可让人用自然语言写，
 * 也不要逼出一份八股。缺哪段会在报错里点名。
 */
const SECTIONS = [
  { key: '1 任务原话', test: /任务原话|原话/ },
  // 目标排第二、且要求有内容：理解文档的主体是「他要什么」，不是「怎么做」。
  { key: '2 目标', test: /目标/ },
  { key: '3 为什么现在不行', test: /为什么现在不行|痛点|现状|现在的问题|为什么.{0,6}不行/ },
  { key: '4 谁在用', test: /谁在用|谁用|使用者|用在什么场景/ },
  { key: '5 我确定知道的事实', test: /确定.{0,8}事实|已知.{0,8}事实|确定知道/ },
  { key: '6 我的假设', test: /假设|这是猜的|我猜|猜测/ },
  { key: '7 我还不确定的', test: /不确定|待确认|还没定/ },
  { key: '8 边界', test: /边界|这次不做|不做范围|范围外/ },
  { key: '9 理解错了会怎样', test: /理解错|理解偏|猜错/ },
]

function positiveInt(config, key, fallback) {
  const value = config === null || config === undefined ? undefined : config[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 拿会话的工作目录；拿不到就退回进程目录，并在回执里说明。 */
async function resolveRoot(pluginCtx, agent, signal) {
  const directory = pluginCtx.get('workingDirectory')
  if (directory !== undefined && agent !== undefined && agent !== null) {
    try {
      const root = await directory.ensure(agent, signal)
      if (typeof root === 'string' && root !== '') return { root, exact: true }
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return { root: process.cwd(), exact: false }
}

function inspectDocument(text, minChars, maxChars) {
  const missing = []
  for (const section of SECTIONS) {
    if (!section.test.test(text)) missing.push(section.key)
  }
  const chars = text.trim().length
  return { missing, chars, tooShort: chars < minChars, tooLong: chars > maxChars }
}

function describeProblems(problems, docPath, minChars, maxChars) {
  const lines = ['理解文档不合格，没有递给用户。问题：']
  if (problems.missing.length > 0) {
    lines.push('- 缺这几段：' + problems.missing.join('、'))
  }
  if (problems.tooShort) {
    lines.push('- 太短：' + problems.chars + ' 字，至少要 ' + minChars + ' 字。理解不够就是不够，别拿篇幅凑。')
  }
  if (problems.tooLong) {
    lines.push(
      '- 太长：' + problems.chars + ' 字，上限 ' + maxChars + ' 字。' +
        '超长通常意味着你把「怎么实现」写进来了——那是 plan.md 的事。' +
        '删掉技术细节、模块划分、命令和退出码，只留「他要什么」。',
    )
  }
  lines.push('')
  lines.push('文档位置：' + docPath)
  lines.push(
    '九段：1 任务原话 / 2 目标（写厚） / 3 为什么现在不行 / 4 谁在用 / ' +
      '5 我确定知道的事实 / 6 我的假设 / 7 我还不确定的 / 8 边界 / 9 理解错了会怎样。' +
      '这里只讲「他要什么」；怎么实现、派几路、验收跑什么命令，全部归 plan.md。',
  )
  lines.push('改完再调一次这个工具。文档是你自己一次写完的，不是挤给用户拼的。')
  return lines.join('\n')
}

function text(value) {
  return [{ type: 'text', text: value }]
}

export function apply(ctx, config) {
  const minChars = positiveInt(config, 'minChars', DEFAULT_MIN_CHARS)
  const maxChars = positiveInt(config, 'maxChars', DEFAULT_MAX_CHARS)
  const defaultPath =
    config !== null && config !== undefined && typeof config.path === 'string' && config.path !== ''
      ? config.path
      : DEFAULT_PATH

  const definition = {
    name: 'confirm_understanding',
    description:
      '开工闸门的唯一钥匙。把已经写好的理解文档推给用户，让用户点「确认，开工」或「不对，要改」。' +
      '在你拿到确认之前，任何 subagent / subagent_preset / subagent_fork 都会被守卫直接拒绝。' +
      '文档不合格时它直接报错、不会打扰用户；所以先自己把九段写完再来调。' +
      '用户驳回后，按意见改文档，然后再调一次。每接一个新任务都要重新走一遍。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '理解文档路径，相对工作目录或绝对路径。默认 .planner/understanding.md',
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,

    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const agent = exec.agent
      const signal = exec.signal

      const { root, exact } = await resolveRoot(ctx, agent, signal)
      const raw = typeof input.path === 'string' && input.path !== '' ? input.path : defaultPath
      const docPath = isAbsolute(raw) ? raw : resolve(root, raw)

      let document
      try {
        document = readFileSync(docPath, 'utf8')
      } catch {
        throw new Error(
          '理解文档不存在：' +
            docPath +
            '\n开工前必须先写这份文档，再调 confirm_understanding。' +
            '\n九段：1 任务原话 / 2 目标（写厚） / 3 为什么现在不行 / 4 谁在用 / ' +
            '5 我确定知道的事实 / 6 我的假设 / 7 我还不确定的 / 8 边界 / 9 理解错了会怎样。' +
            '\n注意：这里只讲「他要什么」，怎么实现归 plan.md。',
        )
      }

      const problems = inspectDocument(document, minChars, maxChars)
      if (problems.missing.length > 0 || problems.tooShort || problems.tooLong) {
        throw new Error(describeProblems(problems, docPath, minChars, maxChars))
      }

      const detail =
        document.length > MAX_DETAIL_CHARS
          ? document.slice(0, MAX_DETAIL_CHARS) + '\n\n……（文档过长，其余部分请直接打开 ' + docPath + ' 查看）'
          : document

      const answer = await ctx.userQuestions.ask({
        agent,
        signal,
        questions: [
          {
            id: 'confirm',
            header: '理解文档确认',
            question: '开工前确认：这份理解文档，是不是你要的东西？',
            detail,
            options: [
              { label: APPROVE_LABEL, description: '理解无误，照这份文档开工' },
              { label: REJECT_LABEL, description: '我理解错了，按下面写的改' },
            ],
            intent: { kind: 'plan-review', approve: APPROVE_LABEL },
          },
        ],
      })

      const item = Array.isArray(answer.answers) ? answer.answers[0] : undefined
      const selected = item !== undefined && Array.isArray(item.selected) ? item.selected : []
      const custom = item !== undefined && typeof item.custom === 'string' ? item.custom.trim() : ''
      const approved = selected.includes(APPROVE_LABEL)

      if (!approved) {
        const feedback = custom !== '' ? custom : selected.join('、')
        return {
          confirmed: false,
          path: docPath,
          chars: problems.chars,
          feedback,
          summary:
            '用户没有确认，闸门仍然关着，不许开工。' +
            (feedback !== ''
              ? '\n用户的意见：' + feedback + '\n按这个意见改理解文档，改完再调一次 confirm_understanding。'
              : '\n用户没写意见。别自己猜——用 ask_user_question 问清楚哪里理解错了。'),
        }
      }

      markConfirmed(agent, docPath, hashText(document))

      const lines = [
        '用户已确认，闸门打开，可以开工。',
        '文档：' + docPath + '（' + problems.chars + ' 字）',
      ]
      if (!exact) {
        lines.push('注意：没拿到会话工作目录，这份文档是按进程目录解析的，确认一下路径对不对。')
      }
      lines.push('下一步：把计划表写进 plan.md，然后按第八节并发派工。文档再改一次，闸门会自动重新关上。')

      return {
        confirmed: true,
        path: docPath,
        chars: problems.chars,
        feedback: '',
        summary: lines.join('\n'),
      }
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          path: { type: 'string' },
          chars: { type: 'integer' },
          feedback: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['confirmed', 'path', 'chars', 'feedback', 'summary'],
      },
      render: (_args, value) => text(String(value.summary)),
    },
  }

  ctx.effect(() => ctx.tools.register(definition), 'planner: 开工闸门 confirm_understanding')

  // ── 第二道门：计划表 ───────────────────────────────────────────────────────
  // 一次真实事故：规划者写了 plan.md 就直接开工，用户从头到尾一眼没看到计划。
  // 所以计划表也要过同一张卡：全文推给用户，看过才算数。
  // 两道门都过了才允许派工（守卫在 checkGate 里依次复核两边的哈希）。
  const planMinChars = positiveInt(config, 'planMinChars', DEFAULT_PLAN_MIN_CHARS)
  const planDefault =
    config !== null && config !== undefined && typeof config.planPath === 'string' && config.planPath !== ''
      ? config.planPath
      : DEFAULT_PLAN_PATH

  const planDefinition = {
    name: 'confirm_plan',
    description:
      '第二道开工门。把已经写好的计划表 plan.md 推给用户看一眼，拿到确认之后才允许派工。' +
      '没有它，用户从头到尾看不到你打算怎么干——实测就这么翻过车。' +
      '计划表质量不达标时它直接报错，不会拿半成品打扰用户。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '计划表路径。默认 .planner/plan.md；建议按任务分目录：.planner/<任务slug>/plan.md' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,

    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const agent = exec.agent
      const signal = exec.signal
      const { root } = await resolveRoot(ctx, agent, signal)
      const rawInput = typeof input.path === 'string' && input.path !== '' ? input.path : planDefault
      const planPath = isAbsolute(rawInput) ? rawInput : resolve(root, rawInput)

      let plan
      try {
        plan = readFileSync(planPath, 'utf8')
      } catch {
        throw new Error(
          '计划表不存在：' + planPath + '\n先把计划写进 plan.md 再来。没有计划表的开工，用户看不到你要干什么。',
        )
      }

      const chars = plan.trim().length
      if (chars < planMinChars) {
        throw new Error(
          '计划表太短（' + chars + ' 字，至少 ' + planMinChars + '）。' +
            '一条一步、带路径和命令、带验收方式的表才叫计划；把任务名换了个说法的清单不算。',
        )
      }
      if (!/验收/.test(plan)) {
        throw new Error('计划表里没有任何「验收」字样——每条改动都要有用户能判真假的验收方式。改完再来。')
      }

      const detail = plan.length > MAX_DETAIL_CHARS ? plan.slice(0, MAX_DETAIL_CHARS) + '\n\n……（过长，其余请看 ' + planPath + '）' : plan

      const answer = await ctx.userQuestions.ask({
        agent,
        signal,
        questions: [
          {
            id: 'plan',
            header: '计划表确认',
            question: '这是打算怎么干。看一遍，行就开工。',
            detail,
            options: [
              { label: APPROVE_LABEL, description: '计划可以，照这个干' },
              { label: REJECT_LABEL, description: '计划不对，按下面写的改' },
            ],
            intent: { kind: 'plan-review', approve: APPROVE_LABEL },
          },
        ],
      })

      const item = Array.isArray(answer.answers) ? answer.answers[0] : undefined
      const selected = item !== undefined && Array.isArray(item.selected) ? item.selected : []
      const custom = item !== undefined && typeof item.custom === 'string' ? item.custom.trim() : ''

      if (!selected.includes(APPROVE_LABEL)) {
        const feedback = custom !== '' ? custom : selected.join('、')
        return {
          confirmed: false,
          path: planPath,
          chars,
          feedback,
          summary:
            '计划表没有通过，闸门仍然关着，不许派工。' +
            (feedback !== '' ? '\n用户意见：' + feedback + '\n按这个改计划，改完再调一次 confirm_plan。' : '\n用户没写意见——用 ask_user_question 问清哪里不对。'),
        }
      }

      markPlanConfirmed(agent, planPath, hashText(plan))

      return {
        confirmed: true,
        path: planPath,
        chars,
        feedback: '',
        summary: '计划表已确认，两道门都开了，可以派工。计划改动一次，这道门会自动重新关上。',
      }
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          path: { type: 'string' },
          chars: { type: 'integer' },
          feedback: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['confirmed', 'path', 'chars', 'feedback', 'summary'],
      },
      render: (_args, value) => text(String(value.summary)),
    },
  }

  ctx.effect(() => ctx.tools.register(planDefinition), 'planner: 计划表闸门 confirm_plan')
}
