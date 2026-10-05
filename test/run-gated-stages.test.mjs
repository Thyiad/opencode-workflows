import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  GATE_SCHEMA, commitSubject, gateClaudeArgs, gatePrompt, gateReport, judgeRound, loadPipeline, parseArgs, parseGateOutput,
  runGate, selectStages, stagePlan, validateGateAnswer, validatePipeline, waitForPort,
} from '../src/run-gated-stages.mjs'

const finding = (severity, status, title = `${severity}-${status}`) => ({ severity, status, title, location: 'src/a.ts:1', attack: '攻击路径' })
const answer = (findings = [], extra = {}) => ({ summary: '经过', findings, userActions: [], ...extra })
const GATE = { title: '测试评审', focus: ['检查项一', '检查项二'] }

test('judgeRound：低危不拦，高/中危修了再来一轮，没修就失败', () => {
  assert.equal(judgeRound(answer()), 'pass')
  assert.equal(judgeRound(answer([finding('low', 'open')])), 'pass')
  assert.equal(judgeRound(answer([finding('high', 'fixed'), finding('low', 'open')])), 'again')
  assert.equal(judgeRound(answer([finding('medium', 'fixed')])), 'again')
  assert.equal(judgeRound(answer([finding('high', 'fixed'), finding('medium', 'open')])), 'fail')
})

test('validateGateAnswer：拒绝缺字段和不在枚举里的值', () => {
  assert.equal(validateGateAnswer(answer([finding('high', 'fixed')])), null)
  assert.match(validateGateAnswer(null), /structured_output/u)
  assert.match(validateGateAnswer({ ...answer(), summary: ' ' }), /summary/u)
  assert.match(validateGateAnswer(answer([finding('critical', 'fixed')])), /severity/u)
  assert.match(validateGateAnswer(answer([finding('high', 'maybe')])), /status/u)
  assert.match(validateGateAnswer({ ...answer(), userActions: [1] }), /userActions/u)
  assert.deepEqual(GATE_SCHEMA.required, ['summary', 'findings', 'userActions'])
})

test('parseGateOutput：取最后一个 JSON 对象，识别错误结果和格式不对', () => {
  const ok = { type: 'result', subtype: 'success', is_error: false, structured_output: answer() }
  assert.deepEqual(parseGateOutput(`log line\n${JSON.stringify(ok)}\n`).answer, answer())
  assert.match(parseGateOutput('not json').error, /JSON/u)
  assert.match(parseGateOutput(JSON.stringify({ ...ok, subtype: 'error_max_turns' })).error, /error_max_turns/u)
  assert.match(parseGateOutput(JSON.stringify({ ...ok, structured_output: { summary: 'x' } })).error, /格式不对/u)
})

test('gateClaudeArgs：无人值守参数与新会话，不带 --resume', () => {
  const args = gateClaudeArgs({ sessionId: 'sid', name: 'n' })
  assert.deepEqual(args.slice(0, 2), ['-p', '--output-format'])
  assert.ok(args.includes('--json-schema'))
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none')
  assert.equal(args[args.indexOf('--session-id') + 1], 'sid')
  assert.ok(!args.includes('--resume'))
})

test('gatePrompt：写明范围、检查清单、验收命令和不许提交', () => {
  const prompt = gatePrompt({ gate: GATE, repoName: 'OPOC', base: 'abc^', round: 2, maxRounds: 3, verify: ['pnpm test', 'pnpm lint'] })
  assert.match(prompt, /git diff abc\^\.\.HEAD/u)
  assert.match(prompt, /- 检查项一\n- 检查项二/u)
  assert.match(prompt, /```bash\npnpm test\npnpm lint\n```/u)
  assert.match(prompt, /round 2 of at most 3/u)
  assert.match(prompt, /Never `git commit`/u)
})

// A scripted world for runGate: Claude answers from a queue; `dirty` says
// whether that round changed files.
function gateWorld({ answers, dirty = [], verifyFails = false, commitOk = true }) {
  const calls = { prompts: [], sessions: [], verify: 0, commits: [] }
  let round = 0
  const deps = {
    uuid: () => `sid-${++round}`,
    log: () => {},
    claude: async (prompt, _name, sessionId) => { calls.prompts.push(prompt); calls.sessions.push(sessionId); return answers.shift() },
    dirty: () => Boolean(dirty[round - 1]),
    verify: () => { calls.verify += 1; return verifyFails ? 'pnpm test' : null },
    commit: number => { calls.commits.push(number); return commitOk ? { ok: true, sha: `c${number}` } : { ok: false, output: 'hook rejected' } },
  }
  const run = (maxRounds = 3) => runGate({ gate: GATE, repoName: 'OPOC', base: 'abc^', verify: ['pnpm test'], maxRounds, deps })
  return { run, calls }
}

test('runGate：第一轮就没有高/中危，不提交，直接通过', async () => {
  const { run, calls } = gateWorld({ answers: [{ answer: answer([finding('low', 'open')]) }] })
  const result = await run()
  assert.equal(result.outcome, 'pass')
  assert.equal(calls.commits.length, 0)
  assert.equal(calls.verify, 0)
})

test('runGate：修了高危 → 验收 → 提交 → 新会话复评通过', async () => {
  const { run, calls } = gateWorld({
    answers: [{ answer: answer([finding('high', 'fixed')]) }, { answer: answer() }],
    dirty: [true, false],
  })
  const result = await run()
  assert.equal(result.outcome, 'pass')
  assert.deepEqual(calls.commits, [1])
  assert.equal(calls.verify, 1)
  assert.deepEqual(calls.sessions, ['sid-1', 'sid-2'])
  assert.equal(result.rounds[0].committed, 'c1')
  assert.match(result.report, /修复提交：c1/u)
})

test('runGate：高危没修（open）→ 失败，不再来一轮', async () => {
  const { run, calls } = gateWorld({ answers: [{ answer: answer([finding('high', 'open')], { userActions: ['决定令牌有效期'] }) }] })
  const result = await run()
  assert.equal(result.outcome, 'fail')
  assert.equal(calls.sessions.length, 1)
  assert.match(result.report, /决定令牌有效期/u)
})

test('runGate：修复没通过验收 → 失败且不提交', async () => {
  const { run, calls } = gateWorld({ answers: [{ answer: answer([finding('high', 'fixed')]) }], dirty: [true], verifyFails: true })
  const result = await run()
  assert.equal(result.outcome, 'fail')
  assert.match(result.reason, /pnpm test/u)
  assert.equal(calls.commits.length, 0)
})

test('runGate：提交失败、Claude 出错、轮数用完都算失败', async () => {
  const committing = gateWorld({ answers: [{ answer: answer([finding('medium', 'fixed')]) }], dirty: [true], commitOk: false })
  assert.match((await committing.run()).reason, /hook rejected/u)

  const broken = gateWorld({ answers: [{ error: '超时' }] })
  const brokenResult = await broken.run()
  assert.equal(brokenResult.outcome, 'fail')
  assert.match(brokenResult.reason, /超时/u)

  const endless = gateWorld({
    answers: [1, 2].map(() => ({ answer: answer([finding('high', 'fixed')]) })), dirty: [true, true],
  })
  const endlessResult = await endless.run(2)
  assert.equal(endlessResult.outcome, 'fail')
  assert.match(endlessResult.reason, /2 轮/u)
  assert.deepEqual(endless.calls.commits, [1, 2])
})

test('runGate：只改了文件但发现都是低危，也要验收并提交，然后通过', async () => {
  const { run, calls } = gateWorld({ answers: [{ answer: answer([finding('low', 'open')]) }], dirty: [true] })
  const result = await run()
  assert.equal(result.outcome, 'pass')
  assert.deepEqual(calls.commits, [1])
})

test('gateReport：列出每轮的发现和结果', () => {
  const report = gateReport({
    gate: GATE, repoName: 'OPOC', base: 'abc^', outcome: 'fail', reason: '原因',
    rounds: [{ number: 1, sessionId: 's1', answer: answer([finding('high', 'fixed', '重放')]), committed: 'c1' }],
  })
  assert.match(report, /未通过：原因/u)
  assert.match(report, /\[高\] 重放（src\/a\.ts:1）已修复/u)
})

test('parseArgs：流水线参数与透传参数分开，阶段决定的参数不能传', () => {
  const options = parseArgs(['--pipeline', 'oauth', '--stages', 'provider,harness', '--gate-rounds', '2', '--fix-rounds', '1', '--allow-dirty'])
  assert.equal(options.pipeline, 'oauth')
  assert.deepEqual(options.stages, ['provider', 'harness'])
  assert.equal(options.gateRounds, 2)
  assert.deepEqual(options.passthrough, ['--fix-rounds', '1', '--allow-dirty'])
  assert.throws(() => parseArgs(['--only', '25']), /由阶段决定/u)
  assert.throws(() => parseArgs(['--gate-rounds', '0']), /正整数/u)
  assert.throws(() => parseArgs(['--stages']), /需要一个值/u)
})

const PIPELINE = {
  stages: [
    { name: 'a', title: 'A', milestones: '25-26', default: true, gate: 'g' },
    { name: 'b', title: 'B', milestones: '27', default: true, check: 'c' },
    { name: 'c', title: 'C', milestones: '32,33', default: false },
  ],
  gates: { g: { title: 'G', focus: ['x'] } },
  checks: { c: { title: 'C', script: 'scripts/x.mjs', servers: [{ name: 's', command: ['pnpm', 'dev'], port: 1234 }] } },
}

test('validatePipeline：接受合法文件，指出引用不存在、重名、写法不对', () => {
  assert.deepEqual(validatePipeline(PIPELINE), [])
  const bad = {
    stages: [{ name: 'a', title: 'A', milestones: '25..26', gate: 'nope' }, { name: 'a', title: 'A', milestones: '27', check: 'nope' }],
    gates: { g: { title: 'G', focus: [] } }, checks: { c: { script: 1, servers: [{ name: 's', command: [], port: 'x' }] } },
  }
  const problems = validatePipeline(bad).join('\n')
  for (const expected of ['milestones', 'gate「nope」', 'check「nope」', '重名', 'focus', 'script', 'port']) assert.match(problems, new RegExp(expected, 'u'))
})

test('selectStages：默认只取 default，--stages 按流水线顺序，未知阶段报错', () => {
  assert.deepEqual(selectStages(PIPELINE, null).map(stage => stage.name), ['a', 'b'])
  assert.deepEqual(selectStages(PIPELINE, ['c', 'a']).map(stage => stage.name), ['a', 'c'])
  assert.throws(() => selectStages(PIPELINE, ['zzz']), /未知阶段/u)
  assert.throws(() => selectStages({ stages: [{ name: 'x' }] }, null), /default/u)
})

test('commitSubject：有 scope 写 scope，跨仓库的没有', () => {
  assert.equal(commitSubject({ commitScope: 'M27-M30' }, 2), 'fix(M27-M30): 安全评审修复（第 2 轮）')
  assert.equal(commitSubject({ commitScope: null }, 1), 'fix: 安全评审修复（第 1 轮）')
})

test('waitForPort：端口开着就返回，一直不开就超时报错', async () => {
  const server = createServer()
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  await waitForPort(port, { timeoutMs: 5000 })
  await new Promise(resolvePromise => server.close(resolvePromise))
  await assert.rejects(waitForPort(port, { timeoutMs: 800 }), /还没起来/u)
})
