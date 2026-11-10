/**
 * 技能提案闸门的行为测试（不启动 Harness）。
 *
 *   1) propose：校验 front-matter / 路径 / 名字前缀，且一个字节都不写
 *   2) promote：确认只能来自 ctx.userQuestions.ask，参数里的「已确认」一律无效
 *   3) promote：用户点头后才复制，且与源文件逐字节一致
 *
 * 隔离：DSH_HOME 指到 %TEMP%\skillgate-test-<随机>，跑完删掉。
 * 绝对不碰真 profile（C:\Users\<user>\.dsh）。
 *
 * 用法：node scripts/test-skill-gate.mjs
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applySkillGate } from '../skill-gate.js'

const APPROVE = '确认入库'
const REJECT = '先不要'

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

const work = mkdtempSync(join(tmpdir(), 'skillgate-src-'))
const profile = mkdtempSync(join(tmpdir(), 'skillgate-test-'))
process.env.DSH_HOME = profile

const LIB = join(profile, 'mode-skills')
const SRC_DIR = join(work, '.planner', 'demo', 'proposals', 'mode-ppt-deck')
const SRC = join(SRC_DIR, 'SKILL.md')
mkdirSync(SRC_DIR, { recursive: true })

const GOOD = [
  '---',
  'name: mode-ppt-deck',
  'description: 要做幻灯片、改现成模板、把一堆材料排成能讲的演示文稿时派它',
  '---',
  '',
  '# mode-ppt-deck',
  '',
  '- 先问清场合和页数。',
  '- 每页一个信息点。',
  '',
].join('\n')
writeFileSync(SRC, GOOD, 'utf8')

function countFiles(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
  }
  return total
}

// 假 ctx：tools.register 捕获工具定义，userQuestions.ask 按 state 作答。
function makeCtx() {
  const captured = { tools: {} }
  const calls = []
  const state = { reply: APPROVE, custom: '', throws: '', answers: undefined }

  const ctx = {
    userQuestions: {
      ask: async (request) => {
        calls.push(request)
        if (state.throws !== '') throw new Error(state.throws)
        if (state.answers !== undefined) return state.answers
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
    },
    effect(fn) {
      fn()
    },
  }
  applySkillGate(ctx)
  return { captured, calls, state }
}

const gate = makeCtx()
const AGENT = { id: 'agent-a' }
const run = (args) => gate.captured.tools['skill_proposal'].execute(args, { agent: AGENT, signal: undefined })

async function throwsWith(fn, needle) {
  try {
    await fn()
    return ''
  } catch (error) {
    const message = String(error.message)
    if (!message.includes(needle)) return '错误信息里没有「' + needle + '」：' + message
    return ''
  }
}

function withFile(name, content) {
  const dir = join(work, '.planner', 'cases')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

const baseArgs = { mode: 'ppt', skill: 'mode-ppt-deck', path: SRC, summary: '先问场合再排页' }

console.log('\n[1] propose：合法提案被记账，且不写任何文件')
{
  const before = countFiles(LIB)
  const r = await run({ ...baseArgs, action: 'propose' })
  ok(r.ok === true, 'propose 通过', JSON.stringify(r))
  ok(r.recorded >= 1, '记账条数被带回', String(r.recorded))
  ok(typeof r.message === 'string' && r.message.includes('还没入库'), '给人看的那句说了「还没入库」', String(r.message))
  ok(typeof r.next === 'string' && r.next.includes('promote'), '给模型的那句指向下一步 promote', String(r.next))
  ok(gate.calls.length === 0, 'propose 没有打扰用户')
  ok(countFiles(LIB) === before && countFiles(LIB) === 0, 'propose 之后库里一个文件都没有', String(countFiles(LIB)))
}

console.log('\n[2] propose：front-matter 不合格就拒，理由里点名字段')
{
  let msg = await throwsWith(
    () => run({ ...baseArgs, action: 'propose', path: withFile('no-desc.md', '---\nname: mode-ppt-deck\n---\n\n正文\n') }),
    'description',
  )
  ok(msg === '', '缺 description 被拒且点名字段', msg)

  msg = await throwsWith(
    () => run({ ...baseArgs, action: 'propose', path: withFile('no-name.md', '---\ndescription: 什么时候派\n---\n') }),
    'name',
  )
  ok(msg === '', '缺 name 被拒且点名字段', msg)

  msg = await throwsWith(
    () => run({ ...baseArgs, action: 'propose', path: withFile('wrong-name.md', '---\nname: mode-ppt-other\ndescription: x\n---\n') }),
    '不一致',
  )
  ok(msg === '', 'name 与 skill 不一致被拒', msg)

  msg = await throwsWith(
    () => run({ ...baseArgs, action: 'propose', path: withFile('no-fm.md', '# 没有 front-matter\n') }),
    'front-matter',
  )
  ok(msg === '', '缺 front-matter 被拒', msg)
}

console.log('\n[3] propose：路径与名字的硬约束')
{
  const outside = join(work, 'outside', 'SKILL.md')
  mkdirSync(join(work, 'outside'), { recursive: true })
  writeFileSync(outside, GOOD, 'utf8')
  let msg = await throwsWith(() => run({ ...baseArgs, action: 'propose', path: outside }), '.planner')
  ok(msg === '', '不在 .planner 下的路径被拒', msg)

  msg = await throwsWith(() => run({ ...baseArgs, action: 'propose', path: 'SKILL.md' }), '绝对路径')
  ok(msg === '', '相对路径被拒', msg)

  msg = await throwsWith(
    () => run({ ...baseArgs, action: 'propose', path: join(work, '.planner', 'nope', 'SKILL.md') }),
    '不存在',
  )
  ok(msg === '', '文件不存在被拒', msg)

  msg = await throwsWith(() => run({ ...baseArgs, action: 'propose', skill: 'mode-doc-x' }), 'mode-ppt-')
  ok(msg === '', 'skill 前缀与 mode 不符被拒', msg)

  msg = await throwsWith(() => run({ ...baseArgs, action: 'propose', action2: 1, skill: '../mode-ppt-deck' }), '不合法')
  ok(msg === '', '带路径分隔符的 skill 被拒', msg)
}

console.log('\n[4] promote：用户不点头，一个字节都不写')
{
  await run({ ...baseArgs, action: 'propose' })
  const before = countFiles(LIB)
  gate.state.reply = REJECT
  const r = await run({ ...baseArgs, action: 'promote' })
  ok(r.ok === false, '用户点「先不要」→ 拒绝', JSON.stringify({ ok: r.ok }))
  ok(r.target === '' && r.bytes === 0, '拒绝时不给目标路径、不报字节数', JSON.stringify(r.target))
  ok(/没有确认/.test(r.message), '拒绝理由说清了是「没确认」', String(r.message))
  ok(countFiles(LIB) === before && countFiles(LIB) === 0, '库里的文件数一个都没变', String(countFiles(LIB)))
  gate.state.reply = APPROVE
}

console.log('\n[5] promote：模型自己在参数里塞「已确认」也放不过去')
{
  const before = countFiles(LIB)
  gate.state.reply = REJECT
  const r = await run({
    ...baseArgs,
    action: 'promote',
    confirmed: true,
    approved: true,
    userConfirmed: true,
    force: true,
    yes: true,
    skipConfirm: true,
  })
  ok(r.ok === false, '带 confirmed: true 仍被拒', JSON.stringify({ ok: r.ok }))
  ok(countFiles(LIB) === before && countFiles(LIB) === 0, '带 confirmed: true 仍没写出任何文件', String(countFiles(LIB)))

  // 静态断言：参数表里根本没有「确认」这一类字段，只有 ask 能放行。
  const source = readFileSync(new URL('../skill-gate.js', import.meta.url), 'utf8')
  ok(!/confirmed\s*:\s*\{\s*type/.test(source), 'parameters 里没有声明 confirmed 字段')
  ok(/additionalProperties:\s*false/.test(source), '参数表关掉了额外字段')
  ok(source.includes('ctx.userQuestions.ask('), '确认只来自 ctx.userQuestions.ask')
  gate.state.reply = APPROVE
}

console.log('\n[6] promote：ask 抛错 / 返回空，都按「没确认」处理')
{
  const before = countFiles(LIB)
  gate.state.throws = 'DELEGATED_CALLER: 子会话问不了人'
  let r = await run({ ...baseArgs, action: 'promote' })
  ok(r.ok === false && /没有成功/.test(r.message), 'ask 抛错 → 拒绝并说明', String(r.message))
  ok(countFiles(LIB) === before, 'ask 抛错后库没变', String(countFiles(LIB)))
  gate.state.throws = ''

  gate.state.answers = { answers: [] }
  r = await run({ ...baseArgs, action: 'promote' })
  ok(r.ok === false, 'ask 返回空 answers → 拒绝', JSON.stringify({ ok: r.ok }))
  gate.state.answers = undefined

  gate.state.answers = { answers: [{}] }
  r = await run({ ...baseArgs, action: 'promote' })
  ok(r.ok === false, '用户既没选也没写 → 拒绝', JSON.stringify({ ok: r.ok }))
  gate.state.answers = undefined
  ok(countFiles(LIB) === before, '这三种失败之后库依旧没变', String(countFiles(LIB)))
}

console.log('\n[7] promote：用户点头才复制，逐字节一致')
{
  gate.state.reply = APPROVE
  gate.state.custom = ''
  const r = await run({ ...baseArgs, action: 'promote' })
  const target = join(LIB, 'ppt', 'mode-ppt-deck', 'SKILL.md')
  ok(r.ok === true, '确认后入库成功', JSON.stringify({ ok: r.ok, target: r.target }))
  ok(r.target === target, '返回的目标是绝对路径且位置正确', String(r.target))
  ok(existsSync(target), '文件真的落在 <DSH_HOME>/mode-skills/ppt/mode-ppt-deck/SKILL.md')
  ok(readFileSync(target).equals(readFileSync(SRC)), '内容与源文件逐字节一致')
  ok(r.bytes === readFileSync(SRC).length, '字节数与源文件相同', String(r.bytes))
  ok(countFiles(LIB) === 1, '库里恰好 1 个文件（没多写）', String(countFiles(LIB)))
  ok(gate.calls.length >= 1 && String(gate.calls[0].questions[0].question).includes('这份 mode-ppt-deck 要进 ppt 的库吗？'), '问用户的原话符合要求', JSON.stringify(gate.calls[0] && gate.calls[0].questions))

  // 再入库一次也是覆盖，不是追加
  const again = await run({ ...baseArgs, action: 'promote' })
  ok(again.ok === true && countFiles(LIB) === 1, '重复 promote 只覆盖，不追加', String(countFiles(LIB)))
}

console.log('\n[8] 不同模式下互不干扰（换一个 mode 重新走一遍）')
{
  mkdirSync(join(work, '.planner', 'demo2'), { recursive: true })
  const other = join(work, '.planner', 'demo2', 'SKILL.md')
  writeFileSync(other, GOOD.replace('mode-ppt-deck', 'mode-doc-md').replace('ppt', 'doc'), 'utf8')
  const before = countFiles(LIB)
  gate.state.reply = REJECT
  const args = { action: 'promote', mode: 'doc', skill: 'mode-doc-md', path: other, summary: 'md 套路' }
  const r = await run(args)
  ok(r.ok === false, 'doc 模式未确认 → 拒绝', JSON.stringify({ ok: r.ok }))
  ok(countFiles(LIB) === before, 'doc 模式拒绝后库没变', String(countFiles(LIB)))
  gate.state.reply = APPROVE
  const yes = await run(args)
  ok(yes.ok === true && existsSync(join(LIB, 'doc', 'mode-doc-md', 'SKILL.md')), 'doc 模式确认后入库到自己的目录', String(yes.target))
}

rmSync(work, { recursive: true, force: true })
rmSync(profile, { recursive: true, force: true })

console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ' — ' + passed + ' passed, ' + failed + ' failed')
console.log(passed + ' passed / ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
