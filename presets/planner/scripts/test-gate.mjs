/**
 * 规划者三道防线的行为测试（不启动 Harness）。
 *
 *   1) 开工闸门①：理解文档
 *   2) 开工闸门②：计划表（两道都过才放行）
 *   3) 撞车拦截：两份任务书声明同一路径 → 第二份被拒
 *
 * 用法：node scripts/test-gate.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyConfirm } from '../confirm.js'
import { apply as applyGuard } from '../guard.js'
import { apply as applyReport } from '../report.js'
import { resetConfirmed, clearLeases, clearProgress, bumpStep, claimScopes, recentScopes } from '../gate-state.js'

const APPROVE = '确认，开工'
const REJECT = '不对，要改'

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

const SECTIONS = [
  '## 1. 任务原话',
  '## 2. 目标',
  '## 3. 为什么现在不行',
  '## 4. 谁在用',
  '## 5. 我确定知道的事实',
  '## 6. 我的假设',
  '## 7. 我还不确定的',
  '## 8. 边界',
  '## 9. 理解错了会怎样',
]

function buildDoc({ sections = SECTIONS, filler = 1400 } = {}) {
  return sections.join('\n\n- 占位的正文。\n') + '\n\n' + '细节说明。'.repeat(Math.ceil(filler / 5)) + '\n'
}

function buildPlan({ filler = 900, withAccept = true } = {}) {
  const head = '# 计划\n\n'
  const body = '## 步骤一\n改 `Assets/A.cs`，跑 `dotnet build`。\n\n'
  const accept = withAccept ? '## 验收\n编译通过，A.cs 含新字段。\n\n' : ''
  return head + body + accept + '补充说明。'.repeat(Math.ceil(filler / 5)) + '\n'
}

const root = mkdtempSync(join(tmpdir(), 'planner-gate-'))
mkdirSync(join(root, '.planner'), { recursive: true })
const docPath = join(root, '.planner', 'understanding.md')
const planPath = join(root, 'plan.md')

function makeCtx() {
  const captured = { tools: {}, guard: undefined }
  const calls = []
  const state = { reply: APPROVE, custom: '' }

  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => root }
      return undefined
    },
    userQuestions: {
      ask: async (request) => {
        calls.push(request)
        const item = { id: 'x', selected: [state.reply] }
        if (state.custom !== '') item.custom = state.custom
        return { answers: [item] }
      },
    },
    tools: {
      register(definition) {
        captured.tools[definition.name] = definition
        return () => {}
      },
      guard(fn) {
        captured.guard = fn
        return () => {}
      },
    },
    on(event, handler) {
      captured.handlers = captured.handlers || {}
      captured.handlers[event] = handler
      return () => {}
    },
    effect(fn) {
      fn()
    },
  }

  applyConfirm(ctx, { minChars: 1200, planPath: 'plan.md', planMinChars: 600 })
  applyReport(ctx)
  applyGuard(ctx, { maxWaitMs: 5000, feedbackEvery: 3, allowBasenames: ['plan.md'], allowPathPrefixes: ['.planner/'] })
  return { captured, calls, state }
}

const control = makeCtx()
const AGENT = { id: 'agent-a' }

const dispatch = (prompt) =>
  control.captured.guard({ name: 'subagent_preset', arguments: { prompt }, agent: AGENT })

const dispatchAs = (id, prompt) =>
  control.captured.guard({ name: 'subagent_preset', arguments: { prompt }, agent: { id } })

const runTool = (name, args = {}) =>
  control.captured.tools[name].execute(args, { agent: AGENT, signal: undefined })

async function throwsWith(fn, needle) {
  try {
    await fn()
    return ''
  } catch (error) {
    const message = String(error.message)
    return message.includes(needle) ? '' : message
  }
}

console.log('\n[1] 门①：文档不合格不打扰用户')
{
  let msg = await throwsWith(() => runTool('confirm_understanding'), '理解文档不存在')
  ok(msg === '', '缺文档时报错', msg)
  const before = control.calls.length
  writeFileSync(docPath, buildDoc({ sections: SECTIONS.slice(0, 5) }), 'utf8')
  msg = await throwsWith(() => runTool('confirm_understanding'), '缺这几段')
  ok(msg === '', '缺段被点出来', msg)
  ok(control.calls.length === before, '不合格时没有打扰用户')
}

console.log('\n[2] 两证未齐时，派工被拒')
{
  resetConfirmed(AGENT)
  clearLeases()
  const reason = dispatch('随便一个任务书')
  ok(typeof reason === 'string' && reason.includes('开工闸门'), '没确认就派工 → 拒绝', String(reason).slice(0, 100))
}

console.log('\n[3] 只确认理解 → 仍然不能派工（缺计划表那道门）')
{
  writeFileSync(docPath, buildDoc(), 'utf8')
  control.state.reply = APPROVE
  const r = await runTool('confirm_understanding')
  ok(r.confirmed === true, '理解文档已确认')
  const reason = dispatch('随便一个任务书')
  ok(typeof reason === 'string' && reason.includes('计划表'), '派工被计划表这道门挡住', String(reason).slice(0, 120))
}

console.log('\n[4] 门②：计划表质量检查')
{
  let msg = await throwsWith(() => runTool('confirm_plan'), '计划表不存在')
  ok(msg === '', '缺计划表时报错', msg)

  writeFileSync(planPath, '太短了', 'utf8')
  msg = await throwsWith(() => runTool('confirm_plan'), '太短')
  ok(msg === '', '过短被拒', msg)

  writeFileSync(planPath, buildPlan({ withAccept: false }), 'utf8')
  msg = await throwsWith(() => runTool('confirm_plan'), '验收')
  ok(msg === '', '没写验收被拒', msg)
}

console.log('\n[5] 计划表确认后放行')
{
  writeFileSync(planPath, buildPlan(), 'utf8')
  const r = await runTool('confirm_plan')
  ok(r.confirmed === true, '计划表已确认')
  ok(dispatch('任务书甲\n写权限：`Assets/A.cs`\n') === undefined, '两道门都过 → 派工放行')
}

console.log('\n[6] 撞车拦截：两条任务书同一路径')
{
  const second = claimScopes(AGENT, '任务书乙\n写权限：`Assets/A.cs`\n')
  ok(
    second === undefined,
    '同一 agent 的短期重叠当「上次没派成功的重试」处理，放行（修掉撞自己）',
    String(second),
  )
  ok(dispatch('任务书丙\n写权限：`Assets/C.cs`\n') === undefined, '不重叠的第三路照常放行')

  // 真撞（另一个 agent）：只提示一次，同一条任务书再发一次放行。
  // 直接调 claimScopes：闸门是另一层，这里只测撞车语义。
  const A = { id: 'agent-a' }
  const B = { id: 'agent-b' }
  clearLeases()
  claimScopes(A, '任务书甲\n写权限：`Assets/Z.cs`\n')
  const warn = claimScopes(B, '任务书癸\n写权限：`Assets/Z.cs`\n')
  ok(warn === undefined, '别的 agent 声明同一路径也不拦', String(warn))
  const seen = recentScopes().map((r) => r.scope)
  ok(
    seen.filter((x) => x.includes('Assets/Z.cs')).length === 2,
    '两路都登记进「最近写域」，供 list_workers 展示',
    JSON.stringify(seen),
  )
}

console.log('\n[7] 确认后又改文件 → 闸门重开')
{
  writeFileSync(planPath, buildPlan({ filler: 2000 }), 'utf8')
  const reason = dispatch('任务书丁')
  ok(typeof reason === 'string' && reason.includes('又被改过'), '计划表改动后派工被拒', String(reason).slice(0, 120))
}

console.log('\n[8] 用户驳回')
{
  writeFileSync(planPath, buildPlan(), 'utf8')
  resetConfirmed(AGENT)
  clearLeases()
  writeFileSync(docPath, buildDoc(), 'utf8')
  await runTool('confirm_understanding')
  control.state.reply = REJECT
  control.state.custom = '步骤顺序反了'
  const r = await runTool('confirm_plan')
  ok(r.confirmed === false, '驳回不开门')
  ok(String(r.feedback).includes('顺序'), '驳回意见被带回', r.feedback)
  ok(dispatch('任务书戊') !== undefined, '驳回后仍不能派工')
  control.state.custom = ''
  control.state.reply = APPROVE
}

console.log('\n[9] 旧守卫规则没被挤掉')
{
  const wait = control.captured.guard({ name: 'job_output', arguments: { wait: true }, agent: AGENT })
  ok(typeof wait === 'string' && wait.includes('禁止同步等待'), 'wait:true 仍被拦')
  const outside = control.captured.guard({ name: 'write', arguments: { file_path: 'D:/x/y.ts' }, agent: AGENT })
  ok(typeof outside === 'string' && outside.includes('写权限受限'), '白名单外 write 仍被拦')
}

console.log('\n[10] 实战回归：带空格的路径 / 否定句 / 目录包含')
{
  clearLeases()
  writeFileSync(docPath, buildDoc(), 'utf8')
  await runTool('confirm_understanding')
  writeFileSync(planPath, buildPlan(), 'utf8')
  await runTool('confirm_plan')
  clearLeases()
  const first = dispatch('任务书戊\n写权限：D:\\AI Company\\_planner-test\\demo\\a.py\n')
  ok(first === undefined, '带空格的绝对路径第一次派工放行', String(first))
  clearLeases()
  claimScopes({ id: 'agent-sp1' }, '任务书己一\n写权限：D:\\AI Company\\_planner-test\\demo\\a.py\n')
  const sameSpace = claimScopes({ id: 'agent-sp2' }, '任务书己二\n写权限：D:\\AI Company\\_planner-test\\demo\\a.py\n')
  ok(
    sameSpace === undefined &&
      recentScopes().some((r) => r.scope === 'D:/AI Company/_planner-test/demo/a.py'),
    '带空格的路径整条识别（没被切成 D:/AI）',
    JSON.stringify(recentScopes().map((r) => r.scope)),
  )
  const negationOnly = dispatch('任务书庚\n不许动 `D:\\AI Company\\_planner-test\\other\\x.py`\n')
  ok(negationOnly === undefined, '否定句里的路径不算写域', String(negationOnly))
  const dirScope = claimScopes({ id: 'agent-dir' }, '任务书辛\n写权限：D:\\AI Company\\_planner-test\\demo\n')
  const scopesNow = recentScopes().map((r) => r.scope)
  ok(
    dirScope === undefined &&
      scopesNow.some((x) => x === 'D:/AI Company/_planner-test/demo') &&
      scopesNow.some((x) => x === 'D:/AI Company/_planner-test/demo/a.py'),
    '目录与其中的文件都登记下来（供人自己判断）',
    JSON.stringify(scopesNow),
  )
}

console.log('\n[11] 进度提醒：连跑三步不拦人，只插一条提醒')
{
  clearLeases()
  clearProgress()
  control.state.reply = APPROVE
  writeFileSync(docPath, buildDoc(), 'utf8')
  await runTool('confirm_understanding')
  writeFileSync(planPath, buildPlan(), 'utf8')
  await runTool('confirm_plan')
  clearLeases()

  const call = (name) => control.captured.guard({ name, arguments: {}, agent: AGENT })
  call('run_code')
  ok(call('read') === undefined, '第 1 步放行')
  call('run_code')
  ok(call('read') === undefined, '第 2 步放行')
  call('run_code')
  ok(call('read') === undefined, '第 4 次调用也不拦——提醒不是拒绝', String(call('read')))
  ok(call('run_code') === undefined, 'run_code 永远放行')

  // report_progress 仍然把步数清零
  const r = await runTool('report_progress', { stage: '测试', summary: '刚跑完三步' })
  ok(r.reported === true, '汇报记账成功')
}

console.log('\n[12] 理解文档长度上限：超了按「你写的是实现」处理')
{
  clearLeases()
  clearProgress()
  const tooLong = buildDoc({ filler: 4200 })
  writeFileSync(docPath, tooLong, 'utf8')
  const msg = await throwsWith(() => runTool('confirm_understanding'), '太长')
  ok(msg === '', '超过 3000 字被拒', msg)
  writeFileSync(docPath, buildDoc(), 'utf8')
}
console.log('\n[13] 提醒插在工具结果返回之后，不拦调用')
{
  clearProgress()
  const g = control.captured.guard
  g({ name: 'run_code', arguments: {}, agent: AGENT })
  g({ name: 'run_code', arguments: {}, agent: AGENT })
  g({ name: 'run_code', arguments: {}, agent: AGENT })

  const post = control.captured.handlers && control.captured.handlers['tools/post-execute']
  ok(typeof post === 'function', 'report.js 挂了 tools/post-execute')

  const downstream = { kind: 'continue' }
  const out = await post({ name: 'run_code', arguments: {}, agent: AGENT }, undefined, async () => downstream)
  const added = out.additionalContexts || []
  const text = added.length === 0 ? '' : added[0].content[0].text
  ok(added.length === 1, '插入了一条提醒', JSON.stringify(added))
  ok(text.includes('进度提醒') && text.includes('正文'), '提醒内容指向「正文里说一句」', text)

  // 汇报之后不该再提醒
  await runTool('report_progress', { stage: 'x', summary: 'y' })
  const out2 = await post({ name: 'run_code', arguments: {}, agent: AGENT }, undefined, async () => downstream)
  ok((out2.additionalContexts || []).length === 0, '汇报后不再提醒')
}

rmSync(root, { recursive: true, force: true })

console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ' — ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
