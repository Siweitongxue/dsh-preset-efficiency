/**
 * 反打转守卫的行为测试（不启动 Harness）。
 * 用法：node scripts/test-guard.mjs
 */

import { apply as applyGuard } from '../guard.js'

let failed = 0
let passed = 0

function ok(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS  ' + label)
  } else {
    failed += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : '\n        ' + detail))
  }
}

function makeGuard(config = {}) {
  let captured
  const ctx = {
    tools: {
      guard(fn) {
        captured = fn
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  applyGuard(ctx, { slowGapMs: 20000, repeatLimit: 3, ...config })
  return captured
}

const AGENT = { id: 'worker-a' }
const call = (g, name, args = {}) => g({ name, arguments: args, agent: AGENT })

// ── 1. 同参数连击 ─────────────────────────────────────────────────────
console.log('\n[1] 同一工具 + 同一参数，连续第 3 次被拦')
{
  const g = makeGuard()
  ok(call(g, 'pwsh', { command: 'ls' }) === undefined, '第 1 次放行')
  ok(call(g, 'pwsh', { command: 'ls' }) === undefined, '第 2 次放行')
  const denied = call(g, 'pwsh', { command: 'ls' })
  ok(typeof denied === 'string' && denied.includes('打转检测'), '第 3 次被拦', String(denied))
  ok(call(g, 'pwsh', { command: 'ls' }) === undefined, '被拦后放行，不永久禁用')
}

// ── 2. 不同参数不算打转 ────────────────────────────────────────────────
console.log('\n[2] 参数变了就是在推进，不拦')
{
  const g = makeGuard()
  for (let i = 0; i < 6; i += 1) {
    const r = call(g, 'pwsh', { command: 'ls ' + i })
    ok(r === undefined, '第 ' + (i + 1) + ' 次不同参数放行', String(r))
  }
}

// ── 3. 中间插入别的调用会打断连击 ───────────────────────────────────────
console.log('\n[3] 中间插了别的调用，连击重算')
{
  const g = makeGuard()
  call(g, 'pwsh', { command: 'ls' })
  call(g, 'pwsh', { command: 'ls' })
  call(g, 'read', { file_path: 'a.md' })
  ok(call(g, 'pwsh', { command: 'ls' }) === undefined, '插了读文件后，同参数重新计为第 1 次')
}

// ── 4. 慢 MCP 之后又调 MCP ────────────────────────────────────────────
console.log('\n[4] 慢的 MCP 调用之后又调 MCP，被拦一次')
{
  const g = makeGuard()
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t
  try {
    call(g, 'mcp__unity_stick__get_scene_info', {})
    t += 37_000 // 上一次调用了 37 秒
    const denied = call(g, 'mcp__unity_stick__execute_menu_item', { menuPath: 'X' })
    ok(typeof denied === 'string' && denied.includes('阻塞'), '被拦并说明是阻塞', String(denied))
    t += 1_000
    ok(call(g, 'mcp__unity_stick__execute_menu_item', { menuPath: 'X' }) === undefined, '拦一次之后放行')
  } finally {
    Date.now = realNow
  }
}

// ── 5. 快的 MCP 调用不拦 ───────────────────────────────────────────────
console.log('\n[5] 快的 MCP 调用正常放行')
{
  const g = makeGuard()
  const realNow = Date.now
  let t = 2_000_000
  Date.now = () => t
  try {
    call(g, 'mcp__unity_stick__get_scene_info', {})
    t += 300
    ok(
      call(g, 'mcp__unity_stick__execute_menu_item', { menuPath: 'Y' }) === undefined,
      '300ms 的往返不触发',
    )
  } finally {
    Date.now = realNow
  }
}

// ── 6. 慢的不是 MCP 就不拦 ─────────────────────────────────────────────
console.log('\n[6] 慢调用只对 MCP 生效')
{
  const g = makeGuard()
  const realNow = Date.now
  let t = 3_000_000
  Date.now = () => t
  try {
    call(g, 'pwsh', { command: 'sleep 30' })
    t += 40_000
    ok(call(g, 'pwsh', { command: 'echo hi' }) === undefined, '慢的 pwsh 之后调 pwsh 不拦')
  } finally {
    Date.now = realNow
  }
}

console.log('')
console.log((failed === 0 ? 'OK' : 'FAIL') + ' — ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
