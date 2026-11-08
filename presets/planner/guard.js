/**
 * 规划者的运行时守卫（宿主平面，挂在 preset 作用域里）。
 *
 * 三件事：
 *   1) 开工闸门 —— 没拿到用户对理解文档的确认，派工一律拒绝。
 *      确认由工具 confirm_understanding 写入（见 confirm.js），锚定的是那一版文档的哈希：
 *      确认之后又改文档，闸门自动重新关上。
 *      这一条存在的理由：一份错的理解，派 10 路工人只会错 10 倍。
 *   2) 禁止同步等待 —— 派工之后不许在原地等结果。
 *      拦 `wait: true`，以及 `timeout_ms` 超过上限。
 *      （不拦 `timeoutMs`：那是 run_code / pwsh 自己的执行预算，拦了会误伤正常计算。）
 *   3) 写权限白名单 —— write / edit 只许写 plan.md 与 .planner/ 下的文件。
 *      只要它手里有一支能改任何文件的笔，它迟早替工人把活干了，"派工"就退化成"我顺手做了"。
 *
 * 契约：`ctx.tools.guard(fn)` 的 fn 返回字符串 = 拒绝并附理由，返回 undefined = 放行。
 *
 * 边界（如实说明）：
 *   - 只拦得住 write / edit 这两个入口。别的写文件路径（脚本、子进程重定向）它看不见。
 *     真正的兜底是沙箱与人格，不是这里。
 *   - 白名单按路径后缀与目录前缀判断，不做符号链接解析。
 *   - 闸门只拦派工通道。读文件、写文档、提问不拦——开工前本来就要干这些。
 */

import { bumpStep, checkGate, claimScopes, stepCount } from './gate-state.js'

/** 需要工具注册表。 */
export const inject = ['tools'];

/** 派工通道：这些一响，就等于「开工了」。 */
const DISPATCH_TOOLS = new Set(['subagent', 'subagent_preset', 'subagent_fork', 'workflow']);

const DEFAULT_MAX_WAIT_MS = 5000;
// 每连跑这么多步没汇报，就卡住不让继续。
const DEFAULT_FEEDBACK_EVERY = 3;
const DEFAULT_ALLOW_BASENAMES = ['plan.md'];
const DEFAULT_ALLOW_PREFIXES = ['.planner/'];

/** 会写文件的工具名。 */
const WRITE_TOOLS = new Set(['write', 'edit']);

function positiveNumber(config, key, fallback) {
  const value = config === null || config === undefined ? undefined : config[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringList(config, key, fallback) {
  const value = config === null || config === undefined ? undefined : config[key];
  if (!Array.isArray(value) || value.length === 0) return fallback;
  return value.filter((item) => typeof item === 'string' && item !== '');
}

/** 取调用目标路径（write / edit 用 file_path，个别工具用 path）。 */
function targetPath(args) {
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** 归一化：反斜杠转正斜杠、去掉开头的 ./ 与多余的斜杠。 */
function normalize(p) {
  let s = p.replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/\/{2,}/g, '/');
  return s;
}

function basenameOf(p) {
  const parts = p.split('/');
  return parts[parts.length - 1] || '';
}

export function apply(ctx, config) {
  const maxWaitMs = positiveNumber(config, 'maxWaitMs', DEFAULT_MAX_WAIT_MS);
  const allowBasenames = stringList(config, 'allowBasenames', DEFAULT_ALLOW_BASENAMES);
  const allowPrefixes = stringList(config, 'allowPathPrefixes', DEFAULT_ALLOW_PREFIXES).map(normalize);
  const feedbackEvery = positiveNumber(config, 'feedbackEvery', DEFAULT_FEEDBACK_EVERY);

  const guard = (exec) => {
    const name = typeof exec.name === 'string' && exec.name !== '' ? exec.name : 'tool';
    const args = exec.arguments;

    // ── 0) 计步 ──────────────────────────────────────────────────────────
    // PTC 下每一步就是一次 run_code；里面的子调用不算步，否则一次并发派 3 路就爆了。
    const stepsBefore = stepCount(exec.agent);
    if (name === 'run_code') bumpStep(exec.agent);

    // ── 1) 开工闸门（写域只记录，不拦）────────────────────────────────────
    // 闸门在最前面：没确认就不开工，比什么都优先。
    // 写域**不拦**：多路并行是常态，工人之间知道彼此就够了。
    // 实测过一次假阳性：它把「改 shader 里几行」逼成「新建 shader + 切换组件」。
    if (DISPATCH_TOOLS.has(name)) {
      const blocked = checkGate(exec.agent);
      if (blocked !== undefined) return blocked;

      const raw = exec.arguments;
      if (raw !== null && typeof raw === 'object') claimScopes(exec.agent, raw.prompt);
    }

    if (args === null || typeof args !== 'object') return undefined;

    // ── 2) 不许同步等待 ──────────────────────────────────────────────────
    if (args.wait === true) {
      return (
        `禁止同步等待：${name}(wait: true) 被拒绝。` +
        '派完就去做别的；要收增量用 wait: false，作业没跑完就在交付里点明「仍在运行」。'
      );
    }

    const declaredWait = args.timeout_ms;
    if (typeof declaredWait === 'number' && declaredWait > maxWaitMs) {
      return (
        `禁止同步等待：${name} 声明了 ${declaredWait}ms 的等待，超过上限 ${maxWaitMs}ms。` +
        '工人跑得慢就缩小任务书重派，或者先做别的；不要为了等它而调大等待上限。'
      );
    }

    // ── 3) 写权限白名单 ──────────────────────────────────────────────────
    if (WRITE_TOOLS.has(name)) {
      const raw = targetPath(args);
      if (typeof raw === 'string' && raw !== '') {
        const p = normalize(raw);
        const base = basenameOf(p);
        const allowedByBasename = allowBasenames.includes(base);
        const allowedByPrefix = allowPrefixes.some(
          (prefix) => p.startsWith(prefix) || p.includes('/' + prefix),
        );
        // 文档按任务分目录：plan.md 落在工作区根，等于和下一个项目共用同一份。
        if (base === 'plan.md' && !p.includes('/')) {
          return (
            '文档要按任务分目录：`plan.md` 不许直接写在工作区根。' +
            '改成 `.planner/<任务slug>/plan.md`（slug 用短英文/拼音，见名知意），' +
            '理解文档同理放 `.planner/<任务slug>/understanding.md`。' +
            '同一工作区跑第二个项目时，另开一个 slug 目录——两边互不覆盖。'
          )
        }

        // 计划表是「理解确认之后」才能写的东西。没确认就写 plan.md，等于跳过第一道门。
        // 只放 .planner/ 下的文档（理解文档本身就在那儿）。
        if (allowedByBasename && !allowedByPrefix) {
          const unconfirmed = checkGate(exec.agent)
          if (unconfirmed !== undefined) {
            return (
              '还没过第一道门：`' + raw + '` 是计划表，必须在理解文档确认之后才写。' +
              '先把理解文档写到 `.planner/understanding.md`，调 `confirm_understanding` 让用户点确认，再回来写计划。'
            )
          }
        }

        if (!allowedByBasename && !allowedByPrefix) {
          return (
            `写权限受限：规划者只能写 ${allowBasenames.join('、')} 与 ` +
            `${allowPrefixes.join('、')} 下的文件；目标「${raw}」不属于这些位置。` +
            '改代码、改配置、改别人的产物都属于执行范畴 —— 请派工给效率模式智能体。'
          );
        }
      }
    }

    return undefined;
  };

  ctx.effect(
    () => ctx.tools.guard(guard),
    'planner: 开工闸门 + 禁止阻塞等待 + 写权限白名单（' + allowBasenames.join('、') + ' / ' + allowPrefixes.join('、') + '）',
  );
}
