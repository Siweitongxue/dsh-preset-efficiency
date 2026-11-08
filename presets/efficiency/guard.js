/**
 * 效率模式的反打转守卫。
 *
 * 存在的理由（一次真实观测）：
 *   操作 Unity 编辑器的 MCP 工具在编辑器失焦时全部阻塞，单次调用把 run_code 拖到 120 秒上限。
 *   Agent 的应对是**换一个假设再试一次**，21 步里有 8 步在跟同一个阻塞打交道，
 *   中间还夹了 4 次 recompile、3 次 Refresh。它不缺能力，缺一个「你已经在原地打转了」的提醒。
 *
 * 只做两条，都很窄：
 *
 *   1) 慢的 MCP 调用之后，别再连着来一次。
 *      判据：上一次调用是 mcp__*，且距现在超过 slowGapMs（默认 20 秒），
 *      而这一次**又是** mcp__* —— 那几乎不可能是正常推进，是同一个坑。
 *      只拦一次，把话说清楚，然后放行。
 *
 *   2) 同一个工具 + 同一份参数，连着来第三次。
 *      判据：连续三次调用（中间没插别的）完全一样。
 *      轮询一两次是正常的，第三次还一样就是打转。
 *
 * 刻意不做的事：
 *   - 不做「失败预算」。守卫跑在调用**之前**，看不到结果，分不清失败和还在跑，硬做会乱杀。
 *   - 不拦不同参数的连续调用。参数变了就是在推进，那是活。
 *   - 不永久禁用任何工具。拦一次、说完就放行，决定权还给模型。
 */

export const inject = ['tools']

const DEFAULT_SLOW_GAP_MS = 20000
/** 连续第几次完全相同的调用算打转。2 会误伤轮询，3 刚好。 */
const DEFAULT_REPEAT_LIMIT = 3
const MCP_PREFIX = 'mcp__'

function positiveNumber(config, key, fallback) {
  const value = config === null || config === undefined ? undefined : config[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function isMcp(name) {
  return typeof name === 'string' && name.startsWith(MCP_PREFIX)
}

/** 稳定的参数指纹。参数里键序不同也当同一个调用。 */
function fingerprint(name, args) {
  let body = ''
  try {
    body = JSON.stringify(args === null || args === undefined ? null : args, Object.keys(args || {}).sort())
  } catch {
    body = String(args)
  }
  return name + '\u0000' + body
}

function shortArgs(args) {
  let s = ''
  try {
    s = JSON.stringify(args === null || args === undefined ? null : args)
  } catch {
    s = String(args)
  }
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

export function apply(ctx, config) {
  const slowGapMs = positiveNumber(config, 'slowGapMs', DEFAULT_SLOW_GAP_MS)
  const repeatLimit = Math.max(2, Math.round(positiveNumber(config, 'repeatLimit', DEFAULT_REPEAT_LIMIT)))

  /** agentKey -> { lastAt, lastName, lastWasMcp, sameRun } */
  const state = new Map()

  const keyOf = (agent) => (agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : 'anon')

  const guard = (exec) => {
    const name = typeof exec.name === 'string' && exec.name !== '' ? exec.name : 'tool'
    const now = Date.now()
    const key = keyOf(exec.agent)
    const rec = state.get(key)

    if (rec === undefined) {
      state.set(key, { lastAt: now, lastName: name, lastWasMcp: isMcp(name), fp: fingerprint(name, exec.arguments), sameRun: 1 })
      return undefined
    }

    const gap = now - rec.lastAt
    const fp = fingerprint(name, exec.arguments)

    // ── 1) 慢的 MCP 调用之后又调 MCP ──────────────────────────────────────
    if (rec.lastWasMcp && isMcp(name) && gap > slowGapMs) {
      rec.lastAt = now
      rec.lastName = name
      rec.lastWasMcp = true
      rec.fp = fp
      rec.sameRun = 1
      return (
        '你上一次 MCP 调用花了约 ' + Math.round(gap / 1000) + ' 秒还没回——' +
        '这不是参数问题，是那个工具在阻塞（编辑器失焦、服务端卡住都长这样）。' +
        '**别再连着来一次。** 换一条路（改成读文件 / 走命令行 / 看日志），' +
        '或者直接上报「外部编辑器无响应，需要人把它前置」，让上游决定。'
      )
    }

    // ── 2) 完全相同的连续调用第三次 ────────────────────────────────────────
    rec.sameRun = fp === rec.fp ? rec.sameRun + 1 : 1
    if (rec.sameRun >= repeatLimit) {
      rec.lastAt = now
      rec.lastName = name
      rec.lastWasMcp = isMcp(name)
      rec.fp = fp
      rec.sameRun = 0
      return (
        '打转检测：你连续 ' + repeatLimit + ' 次调用 `' + name + '`，参数一字不差：' +
        shortArgs(exec.arguments) +
        '。同样的输入不会有不同的输出。' +
        '**三个选择**：换参数重试一次 / 换一条路 / 认为这条路走不通、把它写进结果交回上游。' +
        '不许第四次。'
      )
    }

    rec.lastAt = now
    rec.lastName = name
    rec.lastWasMcp = isMcp(name)
    rec.fp = fp
    return undefined
  }

  // 同一棵 activation 结束也不清，进程内一直记着——这张表很便宜，留着更稳。
  ctx.effect(
    () => ctx.tools.guard(guard),
    'efficiency: 反打转守卫（慢 MCP 连击 / 同参数连击）',
  )
}
