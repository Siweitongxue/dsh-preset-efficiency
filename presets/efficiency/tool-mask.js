/**
 * 预设自带的工具面遮罩：把宿主继承来的工具按前缀 / 精确名从 schema 里摘掉。
 *
 * 为什么是插件而不是 isolate：`isolate` 换的是服务 realm，产品 schema 仍由宿主的
 * ToolsService 按 agent scope 现算，模型侧零变化；`ctx.tools.restrict({ deny })`
 * 才真的让这些工具在提示词和 PTC 的 SDK 里一起消失。
 *
 * 四条时序纪律（踩过才知道）：
 *   1) MCP 工具是连接后才异步注册的，激活这一刻名字还不存在。所以除了启动时扫一次，
 *      必须挂 `tools/change` 再扫：名字到齐了才遮得掉。
 *   2) 名字集合取 `restrictableNames`，不是 `knownNames`。`restrict()` 内部就是拿
 *      `this.view(scope).restrictableNames` 校验的；knownNames 把 scope 本地名也算了进去，
 *      拿它取名单会撞上 "scope-local names fail"。
 *   3) 一次 restrict 批掉本轮所有新名字。一个名字一次调用会把 effect 栈堆成几百层。
 *   4) 单次 restrict 整体 try/catch：名字没齐、宿主不认这次过滤都不该让预设判死。
 *      sweep 加锁，tools/change 在 sweep 中途再触发时直接丢弃这一次。
 *
 * `run_code` 不许出现在 deny 里（那是 PTC 的传输层名字），这里显式跳过。
 */

export const inject = ['tools']

const RESERVED = 'run_code'

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item !== '')
}

/**
 * @param {object} ctx 预设 scope 的上下文
 * @param {{ denyPrefixes?: string[], deny?: string[] }} config
 */
export function apply(ctx, config) {
  const opts = config === null || config === undefined ? {} : config
  const prefixes = stringList(opts.denyPrefixes)
  const exact = new Set(stringList(opts.deny))
  if (prefixes.length === 0 && exact.size === 0) return

  const masked = new Set()
  const disposers = []
  let sweeping = false

  const sweep = () => {
    if (sweeping) return
    sweeping = true
    try {
      let view
      try {
        view = ctx.tools.view()
      } catch {
        return
      }
      const names = view === undefined || view === null ? undefined : view.restrictableNames
      if (names === undefined || names === null) return
      const batch = []
      for (const name of names) {
        if (typeof name !== 'string' || name === '' || name === RESERVED) continue
        if (masked.has(name)) continue
        if (exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) batch.push(name)
      }
      if (batch.length === 0) return
      let dispose
      try {
        dispose = ctx.tools.restrict({ deny: batch })
      } catch {
        // 名字还没齐 / 宿主不认这次过滤：留给下一次 tools/change，不标记已遮。
        return
      }
      for (const name of batch) masked.add(name)
      if (typeof dispose === 'function') disposers.push(dispose)
    } finally {
      sweeping = false
    }
  }

  ctx.effect(() => ctx.on('tools/change', sweep), '效率模式：工具面遮罩')
  sweep()
}
