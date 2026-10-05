import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  DECISION_SCHEMA, autoRun, claudeArgs, claudeVersionSupported, fixPrompt, followUpPrompt, milestonesInScope, parseArgs,
  parseClaudeOutput, parseFailure, resolveClaudeBin, runnerArgsFor,
  fixRules,
} from '../src/run-milestones-auto.mjs'

const M21 = { number: '21', name: '21-maintenance', rel: 'specs/21-maintenance', title: 'M21：系统维护' }
const M22 = { number: '22', name: '22-dsh-0.2.0', rel: 'specs/22-dsh-0.2.0', title: 'M22：DSH 升级到 0.2.0-rc.2' }
const FAIL_TAIL = '$ pnpm --filter qiwi-dsh-backend test\n...\n✗ 验收命令失败：pnpm --filter qiwi-dsh-backend test\n  修好后从这里继续：run-milestones --from 22\n'

const decision = (next, extra = {}) => ({
  next, rootCause: `根因-${next}`, summary: `经过-${next}`, actionsTaken: [`做了-${next}`],
  userActions: next === 'give-up' ? ['彻底退出 Kimi 后重跑'] : [], ...extra,
})

// A scripted world: the runner and Claude answer from queues and change the
// fake repository the way the real ones would. A runner step is 'commit'
// (acceptance passed: commit and push), 'fail' (acceptance failed), or a
// function of the repository returning the result.
function world({ runs, answers = [], mail = true, tty = true, working = null }) {
  const repo = { done: new Set([M21.name]), head: 'base', upstream: 'base', commits: [], working, tree: 'tree-0', pushOk: true }
  const calls = { runner: [], claude: [], mail: [], cleared: [], pushes: 0, log: '' }
  let clock = 0
  const commit = () => {
    repo.done.add(M22.name)
    repo.working = null
    repo.head = `c${repo.commits.length}`
    repo.commits.push(`${repo.head} feat(M22): M22：DSH 升级到 0.2.0-rc.2`)
  }
  const deps = {
    command: 'run-milestones-auto --only 22', repoRoot: '/repo', mailTag: '[HARNESS]',
    now: () => (clock += 60_000),
    uuid: () => 'session-1',
    milestones: () => [M21, M22],
    targetOf: milestone => ({ cwd: '/repo', spec: milestone.rel, cross: false }),
    repoOf: () => '/repo',
    status: milestone => (repo.done.has(milestone.name) ? 'done' : repo.working === 'APPROVED' ? 'approved-uncommitted' : 'pending'),
    workingStatus: () => repo.working,
    clearStatus: milestone => { calls.cleared.push(milestone.name); repo.working = null },
    fingerprint: () => repo.tree,
    head: () => repo.head,
    isPushed: () => repo.head === repo.upstream,
    upstreamName: () => 'origin/feat/rewrite',
    protectedBranch: () => null,
    branch: () => 'feat/rewrite',
    commitsSince: () => [...repo.commits],
    push: () => {
      calls.pushes += 1
      if (repo.pushOk) repo.upstream = repo.head
      return { ok: repo.pushOk, output: repo.pushOk ? '' : 'fatal: unable to access gitee.com' }
    },
    gitStatus: () => ' M qiwi-dsh-backend/src/llm/gateway.ts',
    timingsMark: () => 0,
    timingsSince: () => [{ milestone: M22.name, agentMs: 60_000, acceptanceMs: 30_000, totalMs: 95_000, result: 'committed' }],
    attemptsOf: () => [{ startedAt: '2026-09-30T02:34:08.615Z', result: 'failed', agentMs: 0, acceptanceMs: 201_540 }],
    lastFailedMilestone: () => null,
    runnerLog: name => ({ path: `/repo/.milestone-logs/${name}-t.log`, bytes: 3_145_728 }),
    runRunner: async args => {
      calls.runner.push(args)
      const step = runs.shift()
      assert.ok(step, `unexpected runner call: ${args.join(' ')}`)
      if (step === 'commit') { commit(); repo.upstream = repo.head; return { args, code: 0, tail: '✓ 已提交' } }
      if (step === 'fail') return { args, code: 1, tail: FAIL_TAIL }
      return { args, ...step(repo, commit) }
    },
    runClaude: async request => {
      calls.claude.push(request)
      const answer = answers.shift()
      assert.ok(answer, 'unexpected Claude call')
      answer.effect?.(repo)
      return { started: true, logFile: `/repo/.milestone-logs/claude-${request.milestone.name}.log`, sessionId: request.sessionId, ...answer }
    },
    interrupted: () => false,
    canHandover: () => tty,
    sendMail: mail ? async (subject, text) => { calls.mail.push({ subject, text }) } : null,
    log: text => { calls.log += text },
  }
  return { deps, calls, repo }
}

const only22 = (...extra) => parseArgs(['--only', '22', ...extra])

test('success on the first run: --push added once, one email with commits and time', async () => {
  const { deps, calls } = world({ runs: ['commit'] })
  const result = await autoRun(only22('--push'), deps)
  assert.equal(result.outcome, 'success')
  assert.deepEqual(calls.runner, [['--only', '22', '--push']])
  assert.equal(calls.claude.length, 0)
  assert.equal(calls.mail.length, 1)
  const [{ subject, text }] = calls.mail
  assert.equal(subject, '[HARNESS] M22 ✅ 成功')
  assert.match(text, /M22：DSH 升级到 0\.2\.0-rc\.2（specs\/22-dsh-0\.2\.0）/u)
  assert.match(text, /推送到 origin\/feat\/rewrite 的提交：\n {2}c0 feat\(M22\)/u)
  assert.match(text, /22-dsh-0\.2\.0 {2}1 次 {2}实现与审查 1 分 0 秒/u)
  assert.doesNotMatch(text, /Claude/u)
})

test('a transient failure: Claude accepts, the runner re-runs acceptance and commits', async () => {
  const { deps, calls } = world({ runs: ['fail', 'commit'], working: 'APPROVED', answers: [{ decision: decision('accept') }] })
  const result = await autoRun(only22('--resume'), deps)
  assert.equal(result.outcome, 'success')
  // The user's --resume applies to the first run only.
  assert.deepEqual(calls.runner, [['--only', '22', '--resume', '--push'], ['--only', '22', '--push']])
  assert.deepEqual(calls.cleared, [])
  const [request] = calls.claude
  assert.equal(request.resume, false)
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.name, 'M22 自动修复')
  assert.match(request.prompt, /✗ 验收命令失败：pnpm --filter qiwi-dsh-backend test/u)
  assert.match(request.prompt, /\/repo\/\.milestone-logs\/22-dsh-0\.2\.0-t\.log` \(3\.0 MB\)/u)
  assert.match(request.prompt, /`specs\/22-dsh-0\.2\.0\/STATUS` in the working tree: `APPROVED`/u)
  const [{ subject, text }] = calls.mail
  assert.equal(subject, '[HARNESS] M22 ✅ 成功（Claude 修复后）')
  assert.match(text, /第 1 轮 · 22-dsh-0\.2\.0 · accept（重新验收）/u)
  assert.match(text, /根因：根因-accept[\s\S]*- 做了-accept/u)
})

test('Claude changed code: STATUS is cleared and the runner re-reviews with --review', async () => {
  const { deps, calls } = world({
    runs: ['fail', 'commit'], working: 'APPROVED',
    answers: [{ decision: decision('review'), effect: repo => { repo.tree = 'tree-1' } }],
  })
  assert.equal((await autoRun(only22(), deps)).outcome, 'success')
  assert.deepEqual(calls.cleared, [M22.name])
  assert.deepEqual(calls.runner[1], ['--only', '22', '--review', '--push'])
})

test('accept after changing files is downgraded to review, so the change is reviewed', async () => {
  const { deps, calls } = world({
    runs: ['fail', 'commit'], working: 'APPROVED',
    answers: [{ decision: decision('accept'), effect: repo => { repo.tree = 'tree-1' } }],
  })
  assert.equal((await autoRun(only22(), deps)).outcome, 'success')
  assert.deepEqual(calls.runner[1], ['--only', '22', '--review', '--push'])
  assert.match(calls.mail[0].text, /accept（重新验收） → 按 review 处理[\s\S]*改按 review 处理/u)
})

test('accept without APPROVED in STATUS stops instead of re-running a fresh agent', async () => {
  const { deps, calls } = world({ runs: ['fail'], working: null, answers: [{ decision: decision('accept') }] })
  const result = await autoRun(only22(), deps)
  assert.equal(result.outcome, 'failure')
  assert.equal(calls.runner.length, 1)
  assert.match(calls.mail[0].text, /Claude 选择 accept，但 specs\/22-dsh-0\.2\.0\/STATUS 不是 APPROVED/u)
})

test('--resume from Claude clears STATUS and continues the implementation', async () => {
  const { deps, calls } = world({ runs: ['fail', 'commit'], answers: [{ decision: decision('resume') }] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'success')
  assert.deepEqual(calls.runner[1], ['--only', '22', '--resume', '--push'])
  assert.deepEqual(calls.cleared, [M22.name])
})

test('give-up: failure email with root cause, user actions, logs and how to take over', async () => {
  const { deps, calls } = world({ runs: ['fail'], answers: [{ decision: decision('give-up', { rootCause: 'Kimi 占用了 out\\ci-package 里的 asar' }) }] })
  const result = await autoRun(only22(), deps)
  assert.equal(result.outcome, 'failure')
  assert.deepEqual(result.handover, { id: 'session-1', title: 'M22 待处理', started: true })
  const [{ subject, text }] = calls.mail
  assert.equal(subject, '[HARNESS] M22 ❌ 失败：Kimi 占用了 out\\ci-package 里的 asar')
  assert.match(text, /你需要做的：\n {2}1\. 彻底退出 Kimi 后重跑/u)
  assert.match(text, /驱动脚本报告：✗ 验收命令失败/u)
  assert.match(text, /驱动脚本：\/repo\/\.milestone-logs\/22-dsh-0\.2\.0-t\.log/u)
  assert.match(text, /日志：\/repo\/\.milestone-logs\/claude-22-dsh-0\.2\.0\.log/u)
  assert.match(text, /电脑上已经用 Remote Control 打开了这个会话，在 Claude App → Code 的会话列表里找「M22 待处理」/u)
  assert.match(text, /电脑：在 \/repo 运行 claude --resume session-1/u)
  // The run was --only 22: carrying on with "--from 22" would run past it.
  assert.match(text, /修好后继续：run-milestones-auto --only 22\n/u)
})

test('the failure email keeps a --from run open-ended and a restricted run inside its selection', async () => {
  const open = world({ runs: ['fail'], answers: [{ decision: decision('give-up') }] })
  await autoRun(parseArgs(['--from', '22']), open.deps)
  assert.match(open.calls.mail[0].text, /修好后继续：run-milestones-auto --from 22\n/u)
  const bounded = world({ runs: ['fail'], answers: [{ decision: decision('give-up') }] })
  await autoRun(parseArgs(['--from', '21', '--to', '22']), bounded.deps)
  assert.match(bounded.calls.mail[0].text, /修好后继续：run-milestones-auto --only 22\n/u)
})

test('without a terminal nothing is reopened; the email says how to open it', async () => {
  const { deps, calls } = world({ runs: ['fail'], tty: false, answers: [{ decision: decision('give-up') }] })
  const result = await autoRun(only22(), deps)
  assert.equal(result.handover, null)
  assert.match(calls.mail[0].text, /先在电脑上运行下面第二条命令[\s\S]*claude --resume session-1 --remote-control "M22 待处理"/u)
})

test('two rounds that do not fix it: round two resumes the same session, then it gives up', async () => {
  const { deps, calls } = world({
    runs: ['fail', 'fail', 'fail'],
    answers: [{ decision: decision('review'), effect: repo => { repo.tree = 'tree-1' } }, { decision: decision('review', { rootCause: '第二次还是超时' }) }],
  })
  const result = await autoRun(only22(), deps)
  assert.equal(result.outcome, 'failure')
  assert.equal(calls.runner.length, 3)
  assert.equal(calls.claude.length, 2)
  assert.equal(calls.claude[1].resume, true)
  assert.equal(calls.claude[1].sessionId, 'session-1')
  assert.match(calls.claude[1].prompt, /^# Round 2 of 2: the re-run failed again/u)
  assert.match(calls.claude[1].prompt, /You answered `next: review`\. The wrapper then ran `run-milestones --only 22 --review --push`/u)
  const [{ subject, text }] = calls.mail
  assert.equal(subject, '[HARNESS] M22 ❌ 失败：第二次还是超时')
  assert.match(text, /说明：Claude 修复 2 轮后仍然失败。/u)
  assert.match(text, /第 1 轮[\s\S]*第 2 轮/u)
})

test('without mail settings everything still runs, just without email', async () => {
  const { deps, calls } = world({ runs: ['fail', 'commit'], working: 'APPROVED', mail: false, answers: [{ decision: decision('accept') }] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'success')
  assert.match(calls.log, /邮件通知未启用/u)
})

test('an unusable Claude answer ends with a failure email that keeps the runner message', async () => {
  const { deps, calls } = world({ runs: ['fail'], answers: [{ error: 'Claude 没有输出可解析的 JSON：oops' }] })
  const result = await autoRun(only22(), deps)
  assert.equal(result.outcome, 'failure')
  const [{ subject, text }] = calls.mail
  assert.equal(subject, '[HARNESS] M22 ❌ 失败：验收命令失败：pnpm --filter qiwi-dsh-backend test')
  assert.match(text, /说明：Claude 没有给出可用的结论：Claude 没有输出可解析的 JSON：oops/u)
  assert.match(text, /错误：Claude 没有输出可解析的 JSON：oops/u)
})

test('a Claude that never started leaves no session to take over', async () => {
  const { deps, calls } = world({ runs: ['fail'], answers: [{ started: false, error: '找不到 claude.exe' }] })
  const result = await autoRun(only22(), deps)
  assert.equal(result.handover, null)
  assert.doesNotMatch(calls.mail[0].text, /claude --resume/u)
})

test('a failure before any milestone started is reported without Claude', async () => {
  const { deps, calls } = world({ runs: [() => ({ code: 1, tail: '\n✗ 没有设置 HARNESS_TEST_MONGODB_URI（…）。\n' })] })
  const result = await autoRun(only22(), deps)
  assert.equal(result.outcome, 'failure')
  assert.equal(calls.claude.length, 0)
  assert.match(calls.mail[0].subject, /M22 ❌ 失败：没有设置 HARNESS_TEST_MONGODB_URI/u)
  assert.match(calls.mail[0].text, /说明：驱动脚本在开始里程碑之前就失败了/u)
  assert.match(calls.mail[0].text, /修好后继续：run-milestones-auto --only 22\n/u)
})

test('--fix-rounds 0 only reports the failure', async () => {
  const { deps, calls } = world({ runs: ['fail'] })
  assert.equal((await autoRun(only22('--fix-rounds', '0'), deps)).outcome, 'failure')
  assert.equal(calls.claude.length, 0)
  assert.match(calls.mail[0].text, /自动修复已关闭/u)
})

test('a failed push is retried once, then the run carries on', async () => {
  const pushFailed = (repo, commit) => { commit(); return { code: 1, tail: '\n✗ git push 失败：fatal: unable to access\n' } }
  const { deps, calls } = world({ runs: [pushFailed, () => ({ code: 0, tail: '' })] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'success')
  assert.equal(calls.pushes, 1)
  assert.equal(calls.runner.length, 2)
  assert.equal(calls.claude.length, 0)
  assert.match(calls.mail[0].text, /c0 feat\(M22\)/u)
})

// The runner's own wording of a push that stopped it, with the milestone already committed.
async function pushStopped(error) {
  const { pushFailureMessage } = await import('../src/run-milestones.mjs')
  return `\n✗ ${pushFailureMessage(error, '22-dsh-0.2.0 已提交')}\n`
}

test('a failed push as the runner words it today is retried once, then the run carries on', async () => {
  const tail = await pushStopped(new Error('git push 失败：fatal: unable to access（仓库 /repo）'))
  const pushFailed = (repo, commit) => { commit(); return { code: 1, tail } }
  const { deps, calls } = world({ runs: [pushFailed, () => ({ code: 0, tail: '' })] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'success')
  assert.equal(calls.pushes, 1)
  assert.equal(calls.runner.length, 2)
  assert.equal(calls.claude.length, 0)
})

test('a push the runner refused (a protected branch) is not pushed by the wrapper behind its back', async () => {
  const tail = await pushStopped(new Error('/repo 当前在 main 分支，不推送。请先切到开发分支，或加 --allow-main。'))
  const refused = (repo, commit) => { commit(); return { code: 1, tail } }
  const { deps, calls } = world({ runs: [refused] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'failure')
  assert.equal(calls.pushes, 0)
  assert.equal(calls.claude.length, 0)
  assert.match(calls.mail[0].text, /--allow-main/u)
})

// Two repositories are in scope: M21's, another one on main with a commit that was
// never pushed (its milestone is finished), and M22's, the one being run.
function twoRepositories(options) {
  const { deps, calls, repo } = world(options)
  const pushed = []
  deps.repoOf = milestone => (milestone.name === M21.name ? '/other' : '/repo')
  deps.isPushed = cwd => (cwd === '/other' ? pushed.includes(cwd) : repo.head === repo.upstream)
  deps.protectedBranch = cwd => (cwd === '/other' ? 'main' : null)
  deps.push = cwd => {
    calls.pushes += 1
    pushed.push(cwd)
    if (cwd === '/repo') repo.upstream = repo.head
    return { ok: true, output: '' }
  }
  return { deps, calls, pushed }
}

test('a push retry after one repository failed does not push the repository that is on main', async () => {
  const tail = await pushStopped(new Error('git push 失败：fatal: unable to access（仓库 /repo）'))
  const pushFailed = (repo, commit) => { commit(); return { code: 1, tail } }
  const { deps, calls, pushed } = twoRepositories({ runs: [pushFailed] })
  assert.equal((await autoRun(parseArgs(['--only', '21,22']), deps)).outcome, 'failure')
  // Nothing is pushed, not even the repository that is fine, so that nothing is left pushed halfway.
  assert.deepEqual(pushed, [])
  assert.equal(calls.pushes, 0)
  assert.equal(calls.claude.length, 0)
  assert.match(calls.mail[0].text, /\/other：当前在 main 分支/u)
  assert.match(calls.mail[0].text, /驱动脚本报告：✗ git push 失败/u)
  assert.match(calls.mail[0].text, /--allow-main/u)
})

test('with --allow-main the retry pushes every repository, the one on main included', async () => {
  const tail = await pushStopped(new Error('git push 失败：fatal: unable to access（仓库 /repo）'))
  const pushFailed = (repo, commit) => { commit(); return { code: 1, tail } }
  const { deps, calls, pushed } = twoRepositories({ runs: [pushFailed, () => ({ code: 0, tail: '' })] })
  assert.equal((await autoRun(parseArgs(['--only', '21,22', '--allow-main']), deps)).outcome, 'success')
  assert.deepEqual(pushed.sort(), ['/other', '/repo'])
  assert.equal(calls.runner.length, 2)
  assert.ok(calls.runner.every(args => args.includes('--allow-main')))
})

test('a push that keeps failing is reported with what to do', async () => {
  const pushFailed = (repo, commit) => { commit(); repo.pushOk = false; return { code: 1, tail: '\n✗ git push 失败：fatal\n' } }
  const { deps, calls } = world({ runs: [pushFailed] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'failure')
  assert.match(calls.mail[0].text, /里程碑已提交，但推送失败[\s\S]*git push[\s\S]*fatal: unable to access gitee\.com/u)
})

test('an interrupted run neither calls Claude nor sends mail', async () => {
  const { deps, calls } = world({ runs: [() => ({ code: 130, tail: '', interrupted: true })] })
  assert.equal((await autoRun(only22(), deps)).outcome, 'interrupted')
  assert.equal(calls.claude.length + calls.mail.length, 0)
})

test('own options are split from the runner arguments', () => {
  const options = parseArgs(['--from', '22', '--fix-rounds', '1', '--no-handover', '--resume', '--claude-timeout-minutes', '30'])
  assert.deepEqual(options.runnerArgs, ['--from', '22', '--resume'])
  assert.equal(options.fixRounds, 1)
  assert.equal(options.claudeTimeoutMinutes, 30)
  assert.equal(options.handover, false)
  assert.equal(parseArgs(['-h']).help, true)
  assert.throws(() => parseArgs(['--fix-rounds', '-1']), /非负整数/u)
  assert.throws(() => parseArgs(['--notify-config']), /需要一个值/u)
})

test('runner arguments per mode', () => {
  const base = ['--from', '21', '--review', '--push']
  assert.deepEqual(runnerArgsFor(base), ['--from', '21', '--review', '--push'])
  assert.deepEqual(runnerArgsFor(base, 'accept'), ['--from', '21', '--push'])
  assert.deepEqual(runnerArgsFor(base, 'resume'), ['--from', '21', '--resume', '--push'])
  assert.deepEqual(milestonesInScope(['--from', '22'], [M21, M22]), [M22])
  assert.deepEqual(milestonesInScope(['--only', '21'], [M21, M22]), [M21])
  assert.deepEqual(milestonesInScope([], [M21, M22]), [M21, M22])
  assert.deepEqual(milestonesInScope(['--only', '21,22'], [M21, M22]), [M21, M22])
  assert.deepEqual(milestonesInScope(['--only', '21-22', '--to', '21'], [M21, M22]), [M21])
  assert.deepEqual(milestonesInScope(['--from', '21', '--to', '21'], [M21, M22]), [M21])
})

test('the runner failure line and resume hint are found in its output', () => {
  assert.equal(parseFailure('✗ x\n  修好后从这里继续：run-milestones --only 24,25\n').number, '24')
  assert.deepEqual(parseFailure(FAIL_TAIL), { message: '验收命令失败：pnpm --filter qiwi-dsh-backend test', number: '22' })
  assert.deepEqual(parseFailure('✗ 未知参数：--frm\n'), { message: '未知参数：--frm', number: null })
})

test('Claude output: structured decision, errors and malformed answers', () => {
  const ok = { type: 'result', subtype: 'success', is_error: false, session_id: 's-9', total_cost_usd: 0.5, structured_output: decision('review') }
  assert.deepEqual(parseClaudeOutput(`${JSON.stringify(ok)}\n`), { sessionId: 's-9', costUsd: 0.5, decision: decision('review') })
  assert.deepEqual(parseClaudeOutput(`warning: something\n${JSON.stringify(ok)}`).decision, decision('review'))
  assert.match(parseClaudeOutput(JSON.stringify({ ...ok, subtype: 'error_max_structured_output_retries', is_error: true })).error, /error_max_structured_output_retries/u)
  assert.match(parseClaudeOutput(JSON.stringify({ ...ok, structured_output: { ...decision('review'), next: 'merge' } })).error, /next 不是/u)
  assert.match(parseClaudeOutput(JSON.stringify({ ...ok, structured_output: { ...decision('review'), userActions: 'x' } })).error, /userActions/u)
  assert.match(parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })).error, /^Claude 报错：Not logged in/u)
  assert.match(parseClaudeOutput('not json').error, /没有输出可解析的 JSON/u)
  assert.equal(parseClaudeOutput(JSON.stringify(ok)).sessionId, 's-9')
})

test('claude arguments: headless, schema, auto permissions without prompts', () => {
  const first = claudeArgs({ sessionId: 'u-1', resume: false, name: 'M22 自动修复' })
  assert.deepEqual(first.slice(0, 3), ['-p', '--output-format', 'json'])
  assert.deepEqual(JSON.parse(first[first.indexOf('--json-schema') + 1]), DECISION_SCHEMA)
  assert.equal(first[first.indexOf('--permission-mode') + 1], 'auto')
  assert.equal(first[first.indexOf('--permission-prompts') + 1], 'none')
  assert.deepEqual(first.slice(-4), ['--session-id', 'u-1', '--name', 'M22 自动修复'])
  assert.ok(!first.includes('--bare'))
  const later = claudeArgs({ sessionId: 'u-1', resume: true, name: 'x', addDirs: ['/other'] })
  assert.deepEqual(later.slice(-4), ['--resume', 'u-1', '--add-dir', '/other'])
  assert.equal(claudeVersionSupported('2.1.282 (Claude Code)'), true)
  assert.equal(claudeVersionSupported('2.1.200 (Claude Code)'), false)
  assert.equal(claudeVersionSupported('3.0.0'), true)
})

test('on Windows claude.exe is found directly or through the npm shim', () => {
  const nodeDir = 'D:\\Program Files\\nodejs'
  const exe = join(nodeDir, 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
  const shim = '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
  const files = new Map([[join(nodeDir, 'claude.cmd'), shim], [exe, '']])
  const fs = { exists: file => files.has(file), read: file => files.get(file) }
  assert.equal(resolveClaudeBin({ env: { PATH: `C:\\Windows;"${nodeDir}"` }, platform: 'win32', ...fs }), exe)
  files.set(join('C:\\Users\\me\\.local\\bin', 'claude.exe'), '')
  assert.equal(resolveClaudeBin({ env: { Path: `C:\\Users\\me\\.local\\bin;${nodeDir}` }, platform: 'win32', ...fs }), join('C:\\Users\\me\\.local\\bin', 'claude.exe'))
  assert.equal(resolveClaudeBin({ env: { CLAUDE_BIN: 'X:\\claude.exe' }, platform: 'win32', ...fs }), 'X:\\claude.exe')
  assert.equal(resolveClaudeBin({ env: {}, platform: 'darwin' }), 'claude')
  assert.throws(() => resolveClaudeBin({ env: { PATH: 'C:\\Windows' }, platform: 'win32', ...fs }), /CLAUDE_BIN/u)
})

test('the fix prompt carries the failure, the decision rules and the machine facts', () => {
  const context = {
    milestone: M22, target: { cwd: '/repo', spec: M22.rel, cross: false }, failure: parseFailure(FAIL_TAIL),
    runnerLog: { path: '/repo/.milestone-logs/x.log', bytes: 1_048_576 }, repoRoot: '/repo', round: 1, maxRounds: 2,
    runnerCommand: 'run-milestones --only 22 --push', statusPath: 'specs/22-dsh-0.2.0/STATUS',
    workingStatus: null, attempts: [], tail: FAIL_TAIL, gitStatus: '', runnerPath: '/pkg/src/run-milestones.mjs',
    // From the repository's .opencode/workflows.json.
    protectedDocs: ['docs/REWRITE-PLAN.md', 'docs/BUSINESS-API.md'],
    machineNotes: ['Kimi keeps handles on .asar files; check with icacls.', 'The Docker MongoDB stalls now and then.'],
  }
  const prompt = fixPrompt(context)
  for (const expected of [
    /`specs\/22-dsh-0\.2\.0\/STATUS` in the working tree: missing/u, /Never `git commit`, `push`/u,
    /Do not edit `specs\/\*\*\/plan\.md`, `specs\/00-conventions\.md`, `docs\/REWRITE-PLAN\.md` or `docs\/BUSINESS-API\.md`/u,
    /Do not kill, close or restart the user's desktop applications/u, /Read big logs with grep\/tail/u,
    /Read the header comment of `\/pkg\/src\/run-milestones\.mjs`/u,
    /## Known facts about this machine\n\n- Kimi keeps handles[^\n]*icacls\.\n- The Docker MongoDB/u, /Simplified Chinese/u, /round 1 of at most 2/u,
    /```\n\(clean\)\n```/u,
  ]) assert.match(prompt, expected)
  const follow = followUpPrompt({ ...context, round: 2, previous: { decision: decision('accept'), applied: 'review', note: '工作区有改动' } })
  assert.match(follow, /You answered `next: accept`\. The wrapper applied it as `review`: 工作区有改动/u)
})

test('without protected documents or machine notes the prompt keeps the fixed rules and drops the facts section', () => {
  const prompt = fixPrompt({
    milestone: M22, target: { cwd: '/repo', spec: M22.rel, cross: false }, failure: parseFailure(FAIL_TAIL), runnerLog: null,
    repoRoot: '/repo', round: 1, maxRounds: 2, runnerCommand: 'run-milestones --only 22', statusPath: 'specs/22-dsh-0.2.0/STATUS',
    workingStatus: null, attempts: [], tail: FAIL_TAIL, gitStatus: '',
  })
  assert.match(prompt, /Do not edit `specs\/\*\*\/plan\.md` or `specs\/00-conventions\.md`/u)
  assert.doesNotMatch(prompt, /Known facts about this machine/u)
})

test('a cross-repository fix protects the target repository\'s documents too, named from here', () => {
  const rootConfig = { protectedDocs: ['docs/BUSINESS-API.md'], machineNotes: ['MongoDB 偶尔卡住'] }
  const targetConfig = { protectedDocs: ['specs/*/BUSINESS-API.md'], machineNotes: ['Redis 要在运行', 'MongoDB 偶尔卡住'] }
  const cross = fixRules({ root: '/work/OPOC-DSH', rootConfig, target: { cwd: '/work/OPOC', spec: 'specs/01-x', cross: true }, targetConfig })
  assert.deepEqual(cross.protectedDocs, ['docs/BUSINESS-API.md', '../OPOC/specs/**/plan.md', '../OPOC/specs/00-conventions.md', '../OPOC/specs/*/BUSINESS-API.md'])
  assert.deepEqual(cross.machineNotes, ['MongoDB 偶尔卡住', 'Redis 要在运行'])
  const local = fixRules({ root: '/work/OPOC-DSH', rootConfig, target: { cwd: '/work/OPOC-DSH', spec: 'specs/35-x', cross: false }, targetConfig })
  assert.deepEqual(local, { protectedDocs: ['docs/BUSINESS-API.md'], machineNotes: ['MongoDB 偶尔卡住'] })
  const prompt = fixPrompt({
    milestone: M22, target: { cwd: '/work/OPOC', spec: 'specs/01-x', cross: true }, failure: parseFailure(FAIL_TAIL), runnerLog: null,
    repoRoot: '/work/OPOC-DSH', round: 1, maxRounds: 2, runnerCommand: 'run-milestones --only 22', statusPath: 'specs/01-x/STATUS',
    workingStatus: null, attempts: [], tail: FAIL_TAIL, gitStatus: '', ...cross,
  })
  assert.match(prompt, /`\.\.\/OPOC\/specs\/\*\/BUSINESS-API\.md`/u)
  assert.match(prompt, /- Redis 要在运行/u)
})
