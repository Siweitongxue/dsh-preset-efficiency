/**
 * 效率模式的「禁止阻塞等待」守门插件（宿主平面，挂在 preset 里）。
 *
 * 用途：把「不许同步等」从提示词变成运行时硬约束。任何工具调用只要带
 * `wait: true`，或者 `timeout_ms` / `timeoutMs` 超过上限，就直接拒绝，
 * 并把「该怎么做」写进拒绝理由，让模型下一次调用立刻改道。
 *
 * 契约：`ctx.tools.guard(fn)` 的 fn 返回字符串 = 拒绝并附带理由，返回 undefined = 放行。
 *
 * 边界（如实说明）：
 *   - 它只能拦「事前声明会等多久」的调用，拦不住一个本来就要跑 30 秒的命令。
 *     后者由人格约束（长活儿必须 run_in_background）。
 *   - guard 是预先检查，不会中断已经在执行的调用。
 */

/** 需要工具注册表。 */
export const inject = ['tools'];

const DEFAULT_MAX_WAIT_MS = 5000;

/** 从行配置里读一个正整数，否则用默认值。 */
function positiveNumber(config, key, fallback) {
  const value = config === null || config === undefined ? undefined : config[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 拒绝阻塞式调用。
 *
 * @param ctx - Host plugin context.
 * @param config - Loader 行配置（`{ maxWaitMs }`）。
 */
export function apply(ctx, config) {
  const maxWaitMs = positiveNumber(config, 'maxWaitMs', DEFAULT_MAX_WAIT_MS);

  const guard = (exec) => {
    const name = typeof exec.name === 'string' && exec.name !== '' ? exec.name : 'tool';
    const args = exec.arguments;
    if (args === null || typeof args !== 'object') return undefined;

    if (args.wait === true) {
      return (
        `禁止同步等待：${name}(wait: true) 被拒绝。` +
        '改用 wait: false 收割已有增量；作业没跑完就先做别的步骤，交付时点明「仍在运行」。'
      );
    }

    // 只拦「等待类」超时（job_output / wait_agent 用的是 timeout_ms）。
    // 不拦 timeoutMs：那是 run_code / pwsh 自己的执行预算，不是等待，拦了会误伤正常计算。
    const declaredWait = args.timeout_ms;
    if (typeof declaredWait === 'number' && declaredWait > maxWaitMs) {
      return (
        `禁止阻塞等待：${name} 声明了 ${declaredWait}ms 的等待，超过上限 ${maxWaitMs}ms。` +
        '长活儿请用 run_in_background 起后台作业；不要同步等，也不要为了等它而调大等待上限。'
      );
    }

    return undefined;
  };

  ctx.effect(() => ctx.tools.guard(guard), 'efficiency: 禁止阻塞等待（上限 ' + maxWaitMs + 'ms）');
}
