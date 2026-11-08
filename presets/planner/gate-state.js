/**
 * 规划者的共享状态：开工闸门 + 写域租约。
 *
 * confirm.js（工具）写，guard.js（守卫）读。同一个进程里是同一个模块实例。
 *
 * 两块状态：
 *   1) confirmed  用户对「理解文档」和「计划表」的确认，锚定那一版内容的哈希。
 *   2) leases     写域租约。派工时要登记这批工人要写哪些路径；第二个工人声明到
 *                 重叠路径时直接被拒绝。撞车不是事后发现的，是派之前就挡住。
 *
 * 租约为什么要 TTL：规划者拿不到工人结束的可靠信号，只能给一个上限。
 * 默认 25 分钟，过期自动释放。这是妥协，不是完备——但比"完全不管"强得多。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** agentId -> { docPath, docHash, planPath, planHash, at } */
const gates = new Map()
/** 租约数组：{ scope, owner, at, ttlMs } */
const leases = []

const FALLBACK_KEY = '*'
const DEFAULT_LEASE_TTL_MS = 25 * 60 * 1000
// 同一个 agent 在这么久之内的重叠，当「上一次没派成功的重试」处理，不拦。
const RETRY_GRACE_MS = 3 * 60 * 1000
/** 已经提示过的组合：同一条任务书只提示一次。 */
const warnedOnce = new Set()

export function agentKey(agent) {
  const id = agent === null || agent === undefined ? undefined : agent.id
  return typeof id === 'string' && id !== '' ? id : FALLBACK_KEY
}

export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function slot(agent) {
  const key = agentKey(agent)
  let entry = gates.get(key)
  if (entry === undefined) {
    entry = {}
    gates.set(key, entry)
  }
  return entry
}

export function markConfirmed(agent, docPath, hash) {
  const entry = slot(agent)
  entry.docPath = docPath
  entry.docHash = hash
  entry.at = Date.now()
}

export function markPlanConfirmed(agent, planPath, hash) {
  const entry = slot(agent)
  entry.planPath = planPath
  entry.planHash = hash
  entry.planAt = Date.now()
}

export function resetConfirmed(agent) {
  gates.delete(agentKey(agent))
}

export function confirmedEntry(agent) {
  return gates.get(agentKey(agent))
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function verify(entry, pathKey, hashKey, label) {
  const path = entry[pathKey]
  if (typeof path !== 'string' || path === '') {
    return (
      '开工闸门：' + label + '还没经过用户确认，派工被拒绝。' +
      '先把它写出来，全文推给用户看一眼，拿到确认再派。'
    )
  }
  const text = readText(path)
  if (text === undefined) {
    return '开工闸门：已确认的' + label + '读不到了（' + path + '）。文件没了等于确认失效，重写、重新确认。'
  }
  if (hashText(text) !== entry[hashKey]) {
    return '开工闸门：' + label + '在确认之后又被改过（' + path + '）。改过就得重新确认，不许拿旧确认开工。'
  }
  return undefined
}

/** 理解文档 + 计划表，两样都要确认过。 */
export function checkGate(agent) {
  const entry = confirmedEntry(agent)
  if (entry === undefined) {
    return (
      '开工闸门：这次任务还没拿到用户对理解文档的确认，所以派工被拒绝。' +
      '先写 .planner/understanding.md，调 confirm_understanding；再写 plan.md，调 confirm_plan。'
    )
  }
  const doc = verify(entry, 'docPath', 'docHash', '理解文档')
  if (doc !== undefined) return doc
  return verify(entry, 'planPath', 'planHash', '计划表 plan.md')
}

// ── 写域租约 ────────────────────────────────────────────────────────────────

function norm(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .trim()
}

/**
 * 从任务书里抠出它声明要写的路径。
 *
 * 实测踩过的两个坑（2026-11-08，mdclean 实战）：
 *   1. 按空格切分把「D:\AI Company\...」切成 «D:\AI» + «Company\...»，
 *      于是每一路都撞在 «D:/AI» 上——满盘误拦，规划者以为守卫坏了。
 *   2. 把「不许写 `mdclean.py`」这种否定句里的文件名也算成声明，
 *      于是 B 路被自己任务书里的禁令拦住。
 *
 * 所以现在的规矩：
 *   - 绝对路径整段取，空格是路径的一部分，只在中英文分隔符/换行处断。
 *   - 只认「写域/写权限/白名单/只许/可写/文件范围」这类行（及其后紧跟的列表项）。
 *   - 否定行（不许/禁止/不要…）整行跳过。
 *   - 兜底只认反引号里的**带分隔符或盘符**的路径，裸文件名不再算。
 *
 * 抠不全就是抠不全——少抠一个，那一路就不会触发拦截。宁可漏拦，不可误拦。
 */
const SCOPE_KEYWORD = /(写域|写权限|白名单|只许|只可以写|可写|文件范围)/
const SCOPE_NEGATION = /(不许|不得|不能|不要|禁止|请勿|勿动|只读|别改|别碰)/
const PATH_STOP = /[,，、;；:：()（）\[\]【】|<>。\n"'“”]/

function looksLikePath(p) {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (/^[\\/]/.test(p) && p.length > 1) return true
  return false
}

function harvestLine(line, found) {
  // 1) 绝对路径整段：空格不断，分隔符才断
  for (const raw of line.match(/[A-Za-z]:[\\/][^,，、;；:：()（）\[\]【】|<>。\n"'“”]*/g) || []) {
    const p = raw.replace(/[.．。]+$/, '').trim()
    if (p.length > 3) found.add(norm(p))
  }
  // 2) 反引号里的路径：同样整段取，不再按空格切
  for (const raw of line.match(/`([^`\n]+)`/g) || []) {
    const p = raw.slice(1, -1).trim()
    if (looksLikePath(p) || /[\\/]/.test(p)) found.add(norm(p))
  }
}

export function declaredScopes(prompt) {
  const text = String(prompt === null || prompt === undefined ? '' : prompt)
  const found = new Set()

  const lines = text.split(/\r?\n/)
  let inBlock = false
  let blockLeft = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      inBlock = false
      continue
    }
    const negated = SCOPE_NEGATION.test(trimmed)
    const declares = SCOPE_KEYWORD.test(trimmed)

    if (declares && !negated) {
      inBlock = true
      blockLeft = 6
    } else if (inBlock) {
      blockLeft -= 1
      // 列表项也算同一声明的延续；别的行就把块关掉
      if (blockLeft <= 0 || !/^[-*•·]|^\d+[.、)]/.test(trimmed)) inBlock = false
    }

    if (negated) continue
    if (inBlock || declares) harvestLine(trimmed, found)
  }

  // 没声明写域就是不登记租约。全文里随手提到的路径不算数——
  // 实测里「不许写 mdclean.py」就是这样把 B 路自己拦住的。
  return [...found]
}

// 目录与其中的文件也算撞车：A 路声明「.../mdclean」、B 路声明「.../mdclean/tests」，
// 同时派出去 B 会在 A 的地盘里写东西。
function overlaps(a, b) {
  if (a === b) return true
  return a.startsWith(b + '/') || b.startsWith(a + '/')
}

function pruneLeases(now, ttlMs) {  for (let i = leases.length - 1; i >= 0; i -= 1) {
    const lease = leases[i]
    if (now - lease.at > (lease.ttlMs === undefined ? ttlMs : lease.ttlMs)) leases.splice(i, 1)
  }
}

/**
 * 派工前登记写域。
 *
 * **它不拦任何东西。** 拦是错的设计：正常就是要多路并行，工人之间只需要**知道彼此的存在**。
 * 一个假阳性（比如上次没派成功的幽灵租约）会让规划者把「改 shader 里几行」
 * 退化成「新建一份 shader + 一个切换组件」——那是守卫制造出来的复杂度，不是技术必要。
 *
 * 所以这里只做一件事：把「谁声明了写哪儿」记下来，供 `list_workers` 展示。
 * 撞了怎么办，由规划者看了信息自己判断。
 *
 * @returns 永远是 undefined（保留返回值形状，方便以后换语义）
 */
export function claimScopes(agent, prompt, ttlMs = DEFAULT_LEASE_TTL_MS) {
  const now = Date.now()
  pruneLeases(now, ttlMs)

  const text = String(prompt === null || prompt === undefined ? '' : prompt)
  const want = declaredScopes(text)
  if (want.length === 0) return undefined

  const owner = agentKey(agent) + '#' + hashText(text).slice(0, 12)

  // 同一份任务书重发：先抹掉旧记录，避免越积越多。
  for (let i = leases.length - 1; i >= 0; i -= 1) {
    if (leases[i].owner === owner) leases.splice(i, 1)
  }
  for (const scope of want) leases.push({ scope, owner, at: now, ttlMs })
  return undefined
}

/** 最近有人声明过的写域，按年龄排序，给 list_workers 用。 */
export function recentScopes(ttlMs = DEFAULT_LEASE_TTL_MS) {
  const now = Date.now()
  pruneLeases(now, ttlMs)
  return leases
    .map((l) => ({ scope: l.scope, ageMs: now - l.at, owner: l.owner }))
    .sort((a, b) => a.scope.localeCompare(b.scope))
}

export function activeLeases() {
  const now = Date.now()
  pruneLeases(now, DEFAULT_LEASE_TTL_MS)
  return leases.map((l) => ({ scope: l.scope, at: now - l.at }))
}

export function clearLeases() {
  leases.length = 0
  warnedOnce.clear()
}

// ── 反馈闸门：连跑几步没跟用户说话 ──────────────────────────────────────────

/** agentKey -> { steps: number, lastAt: number, lastStage: string|null } */
const progress = new Map()

function progressOf(agent) {
  const key = agentKey(agent)
  let rec = progress.get(key)
  if (rec === undefined) {
    rec = { steps: 0, lastAt: 0, lastStage: null }
    progress.set(key, rec)
  }
  return rec
}

/** 记一步。返回记完之后的步数。 */
export function bumpStep(agent) {
  const rec = progressOf(agent)
  rec.steps += 1
  return rec.steps
}

/** 当前这一步之前已经连跑了几步。 */
export function stepCount(agent) {
  return progressOf(agent).steps
}

/**
 * 汇报一次：清零并记下阶段。
 * @returns 汇报前攒了多少步
 */
export function resetSteps(agent, stage) {
  const rec = progressOf(agent)
  const before = rec.steps
  rec.steps = 0
  rec.lastAt = Date.now()
  rec.lastStage = typeof stage === 'string' ? stage : null
  return before
}

export function lastReport(agent) {
  const rec = progressOf(agent)
  return { steps: rec.steps, lastAt: rec.lastAt, lastStage: rec.lastStage }
}

export function clearProgress() {
  progress.clear()
}
