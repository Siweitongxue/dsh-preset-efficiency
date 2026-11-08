/**
 * 向用户汇报一次进度。
 *
 * 为什么需要一个工具而不是只靠人格（实测结论）：
 *   - 人格里写「每三步说一声」，模型会遵守一阵子，然后在忙起来的时候忘掉；
 *   - 用户那边看到的是「它半天没动静」，分不清是在干活还是卡死了。
 *   所以这条做成硬的：`guard.js` 数步数，连跑超过上限就拒绝执行下一步，
 *   唯一解套的办法就是调这个工具。汇报落地了，账才清零。
 *
 * 汇报写什么：一句话。做到哪、成了还是卡住了、下一步是什么。
 * 不需要礼貌、不需要过程、不需要复述任务书。
 */

import { randomUUID } from 'node:crypto'

import { lastReport, resetSteps, stepCount } from './gate-state.js'

export const name = 'dsh-preset-planner/report'

export const inject = ['tools']

const DESCRIPTION =
  '向用户汇报一次进度的**记账动作**，同时解锁反馈闸门。做完一个阶段、或者连着跑了几步之后调用它。' +
  '⚠️ 重要：在 PTC 模式下你只能通过 run_code 调工具，这类子调用在界面上是**折叠**的——用户看不见。' +
  '所以调用它**之前**，必须先在同一步的正文里用一句话把这件事说出来（做到哪、成了没有、卡在哪）；' +
  '工具只负责记账和解锁，不是给人看的渠道。成功和失败都要说——只报喜等于隐瞒。'

/** 每连跑这么多步没汇报，就在下一步的上下文里插一条提醒。 */
const DEFAULT_FEEDBACK_EVERY = 3
/** 提醒的出处标记，方便以后排查是谁塞的。 */
const NUDGE_SOURCE = { kind: 'planner-progress-nudge', form: 'notice', summary: '进度提醒' }

function buildNudge(steps) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          '【进度提醒】你已经连跑 ' + steps + ' 步没跟用户说话了。' +
          '下一步请**先在正文里用一句话说清**：做到哪了、成了没有、卡在哪——' +
          '然后调 `report_progress` 记账。' +
          '注意工具卡片在界面上是折叠的，用户能看到的只有正文。',
      },
    ],
    source: NUDGE_SOURCE,
  }
}

export function apply(ctx, config) {
  const feedbackEvery =
    config !== null && config !== undefined && typeof config.feedbackEvery === 'number' && config.feedbackEvery > 0
      ? Math.round(config.feedbackEvery)
      : DEFAULT_FEEDBACK_EVERY

  // 只在「一步做完、结果已经返回」的时候提醒——不拦任何调用。
  // 判据：run_code 是 PTC 下的一步；report_progress 是解套动作，自己不触发提醒。
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next()
    try {
      if (exec.name !== 'run_code') return downstream
      if (stepCount(exec.agent) < feedbackEvery) return downstream
      const nudge = buildNudge(stepCount(exec.agent))
      const rest = downstream.additionalContexts === undefined ? [] : downstream.additionalContexts
      return { ...downstream, additionalContexts: [nudge, ...rest] }
    } catch {
      return downstream
    }
  })

  const definition = {
    name: 'report_progress',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: '阶段名，例如「理解完成」「第一批已派出」「A 路交回」「收工验收」。',
        },
        summary: {
          type: 'string',
          description: '一句话：做到哪了、成了还是没成、下一步是什么。',
        },
        state: {
          type: 'string',
          enum: ['ok', 'blocked', 'failed'],
          description: 'ok = 按计划推进中；blocked = 卡在等东西（等确认/等工人/等权限）；failed = 这条路失败了。',
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reported: { type: 'boolean' },
          stage: { type: 'string' },
          stepsReported: { type: 'integer' },
        },
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            '【进度记账】' +
            (typeof args.stage === 'string' && args.stage !== '' ? args.stage + ' · ' : '') +
            String(args.summary === undefined ? '' : args.summary) +
            '\n（这条是记账，界面上默认折叠；用户看到的是你自己在正文里说的那一句。）',
        },
      ],
    },
    isConcurrencySafe: () => true,

    async execute(args, exec) {
      const input = args !== null && args !== undefined && typeof args === 'object' ? args : {}
      const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
      if (summary === '') throw new Error('report_progress 需要一句 summary：做到哪了。')
      const stage = typeof input.stage === 'string' ? input.stage.trim() : ''
      const state = typeof input.state === 'string' ? input.state : 'ok'

      const stepsReported = resetSteps(exec.agent, stage)
      lastReport(exec.agent)

      return {
        reported: true,
        stage: stage === '' ? state : stage,
        stepsReported,
      }
    },
  }

  ctx.effect(() => ctx.tools.register(definition), 'planner: 进度汇报（解锁反馈闸门）')
}
