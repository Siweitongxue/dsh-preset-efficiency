/**
 * 规划者的「方向盘」：steer_worker / stop_worker / list_workers。
 *
 * 为什么需要这个文件：
 *   规划者用 subagent_preset 派出去的工人，是**可续子代理**（目录里 mode: continuable），
 *   本来就能被 steer、被 interrupt。但本 profile 装了 Agent Teams，团队的
 *   `send_message` / `interrupt_agent` / `list_agents` 与子代理控制工具**同名**，
 *   把后者影子掉了（tool-agent-team 文档原话：shadow those globals for team members only）。
 *   团队版按**队友名字**查找，找不到一次性子代理，于是工人一派出去就失去控制 ——
 *   实测报错 `active teammate "xxx" not found`。
 *
 *   解法不是去抢名字，而是换名字：团队没注册过 steer_worker / stop_worker / list_workers。
 *   这三个工具直接调 `ctx.subagents` 的公开服务，不依赖任何被影子掉的注册。
 *
 * 边界（如实说明）：
 *   - 只能操控**直接子级**（服务层规定：direct-parent / direct-child），跨代不行。
 *   - 只能操控 `mode: continuable` 的子代理；one-shot 的拒绝，理由说清楚。
 *   - sendMessage 只保证「进了对方收件箱」，不保证它读懂了。
 */

import { recentScopes } from './gate-state.js'

export const inject = ['tools', 'subagents']

const SEND_NAME = 'steer_worker'
const STOP_NAME = 'stop_worker'
const LIST_NAME = 'list_workers'

function text(value) {
  return [{ type: 'text', text: value }]
}

function describe(entry) {
  const mode = typeof entry.mode === 'string' ? entry.mode : 'unknown'
  const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : '(无标签)'
  return mode + ' — ' + label + ' — ' + String(entry.id)
}

export function apply(ctx) {
  const send = {
    name: SEND_NAME,
    description:
      '给一个已经派出去的子代理追加一条消息，它会就近在这一步结束时收到；' +
      '它如果已经停下来了，会重新唤醒。这是规划者操控工人的唯一正确入口。' +
      '注意：send_message 是团队版、按队友名字找，找不到你的工人；不要用它。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '工人会话 id，就是 subagent_preset 返回的那个' },
        message: { type: 'string', description: '追加给工人的话，写成新的任务约束' },
      },
      required: ['agent_id', 'message'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = typeof args.agent_id === 'string' ? args.agent_id.trim() : ''
      const message = typeof args.message === 'string' ? args.message : ''
      if (id === '') throw new Error('steer_worker 需要 agent_id。')
      if (message.trim() === '') throw new Error('steer_worker 需要 message。')
      await ctx.subagents.sendMessage(exec.agent, id, text(message), { signal: exec.signal })
      return { delivered: true, agent_id: id, summary: '已送进工人 ' + id + ' 的收件箱。' }
    },
    output: {
      schema: {
        type: 'object',
        properties: { delivered: { type: 'boolean' }, agent_id: { type: 'string' }, summary: { type: 'string' } },
        required: ['delivered', 'agent_id', 'summary'],
      },
      render: (_a, v) => text(String(v.summary)),
    },
  }

  const stop = {
    name: STOP_NAME,
    description:
      '停掉一个正在跑的子代理的当前回合。它没做完的收件箱会保留，任务所有权不变，可以再唤醒。' +
      '注意：interrupt_agent 是团队版，找不到你的工人。',
    parameters: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: '要停的工人会话 id' } },
      required: ['agent_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const id = typeof args.agent_id === 'string' ? args.agent_id.trim() : ''
      if (id === '') throw new Error('stop_worker 需要 agent_id。')
      ctx.subagents.interrupt(id, { kind: 'ancestor', agent: exec.agent })
      return { stopped: true, agent_id: id, summary: '已向工人 ' + id + ' 发出停止信号（它可能还要一两步才停）。' }
    },
    output: {
      schema: {
        type: 'object',
        properties: { stopped: { type: 'boolean' }, agent_id: { type: 'string' }, summary: { type: 'string' } },
        required: ['stopped', 'agent_id', 'summary'],
      },
      render: (_a, v) => text(String(v.summary)),
    },
  }

  const list = {
    name: LIST_NAME,
    description:
      '列出你派出去的工人（直接子级），带 mode 标签。派新活之前先看一次：谁已经交活了、谁还挂着。' +
      '注意：list_agents 是团队版，列的是队友，不是你派出去的工人。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const entries = await ctx.subagents.listChildren(exec.agent.id, exec.signal)
      const rows = Array.isArray(entries) ? entries : []
      const lines = rows.length === 0 ? ['(没有工人)'] : rows.map(describe)
      const scopes = recentScopes().map(
        (r) => '  · ' + r.scope + '（' + Math.max(1, Math.round(r.ageMs / 60000)) + ' 分钟前声明）',
      )
      const scopeText = scopes.length === 0 ? '(还没有人声明写域)' : scopes.join('\n')
      return {
        count: rows.length,
        workers: lines,
        writing: scopes,
        summary:
          '共 ' + rows.length + ' 个工人：\n' + lines.join('\n') +
          '\n\n最近声明的写域（仅供参考，不拦人）：\n' + scopeText,
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          workers: { type: 'array', items: { type: 'string' } },
          writing: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
        required: ['count', 'workers', 'summary'],
      },
      render: (_a, v) => text(String(v.summary)),
    },
  }

  ctx.effect(() => ctx.tools.register(send), 'planner: steer_worker')
  ctx.effect(() => ctx.tools.register(stop), 'planner: stop_worker')
  ctx.effect(() => ctx.tools.register(list), 'planner: list_workers')
}
