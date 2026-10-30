import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  APPROVED_REPORT, alsoOf, commitReviewed, continueCommand, dirtyOutside, parseArgs, planCommitMessage, refineAndRun, selectionArgs, stepsOf, stillReviewed, unchangedSince,
} from '../src/refine-and-run.mjs'

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'refine-and-run.mjs')

const M35 = { number: '35', name: '35-foo', rel: 'specs/35-foo', title: 'M35：示例' }
const M36 = { number: '36', name: '36-bar', rel: 'specs/36-bar', title: 'M36：另一个' }
const M37 = { number: '37', name: '37-baz', rel: 'specs/37-baz', title: 'M37：第三个' }

test('arguments: the selection, and which options go to refine-plan, run-milestones-auto or both', () => {
  const options = parseArgs(['--only', '35,36', '--max-rounds', '3', '--also', 'docs/A.md', '--accept-decisions', '--fix-rounds', '1', '--no-handover',
    '--allow-main', '--command-timeout-minutes', '30', '--resume', '--push'])
  assert.equal(options.only, '35,36')
  assert.deepEqual(options.refineArgs, ['--max-rounds', '3', '--also', 'docs/A.md', '--accept-decisions', '--fix-rounds', '1', '--no-handover'])
  assert.deepEqual(options.autoArgs, ['--fix-rounds', '1', '--no-handover', '--allow-main', '--command-timeout-minutes', '30', '--resume'])
  // What a re-run repeats: everything but the selection, --resume and --review.
  assert.deepEqual(options.passArgs, ['--max-rounds', '3', '--also', 'docs/A.md', '--accept-decisions', '--fix-rounds', '1', '--no-handover', '--allow-main', '--command-timeout-minutes', '30'])
  assert.equal(parseArgs(['--from', '35', '--skip-refine']).skipRefine, true)
  assert.throws(() => parseArgs([]), /需要选择里程碑/u)
  assert.throws(() => parseArgs(['--from', '5']), /两位或以上/u)
  assert.throws(() => parseArgs(['--from', '37', '--to', '35']), /--from 不能大于 --to/u)
  assert.throws(() => parseArgs(['specs/35-foo', '--only', '35']), /不要再给/u)
  assert.throws(() => parseArgs(['docs/35-foo']), /不是本仓库 specs\/ 下带编号的规格目录/u)
  assert.throws(() => parseArgs(['--only', '35', '--max-rounds']), /需要一个值/u)
})

test('one spec directory or a selection, passed on as run-milestones takes it', () => {
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  assert.deepEqual(selectionArgs(parseArgs(['specs/35-foo'], root)), ['--only', '35'])
  assert.deepEqual(selectionArgs(parseArgs(['--only', '35-37,40'])), ['--only', '35-37,40'])
  assert.deepEqual(selectionArgs(parseArgs(['--from', '35', '--to', '37'])), ['--from', '35', '--to', '37'])
  assert.equal(continueCommand(parseArgs(['--from', '35', '--max-rounds', '3', '--review'])), 'refine-and-run --from 35 --max-rounds 3')
})

test('what each milestone needs', () => {
  const options = parseArgs(['--only', '35'])
  assert.equal(stepsOf({ status: 'done', statusFile: true, refined: true }, options), 'skip')
  assert.equal(stepsOf({ status: 'approved-uncommitted', statusFile: true, refined: false }, options), 'ready')
  assert.equal(stepsOf({ status: 'pending', statusFile: true, refined: false }, options), 'ready')
  assert.equal(stepsOf({ status: 'pending', statusFile: false, refined: true }, options), 'ready')
  assert.equal(stepsOf({ status: 'pending', statusFile: false, refined: false }, options), 'refine')
  assert.equal(stepsOf({ status: 'pending', statusFile: false, refined: false }, parseArgs(['--only', '35', '--skip-refine'])), 'ready')
})

test('an approved report is recognised by its result row only', () => {
  assert.ok(APPROVED_REPORT.test('# x\n\n| 项目 | 结果 |\n|---|---|\n| 结论 | 第 2 轮评审通过 |\n'))
  assert.ok(!APPROVED_REPORT.test('| 结论 | 达到 5 轮上限，仍有 2 个阻塞问题未解决 |\n'))
  assert.ok(!APPROVED_REPORT.test('| 结论 | 运行检查未通过（评审记录：第 2 轮评审通过） |\n'))
})

test('the plan commit keeps the title, starts its subject in Chinese and names the report', () => {
  const message = planCommitMessage({ number: '35', title: 'M35：OAuth 登录', spec: 'specs/35-foo', cross: false })
  assert.equal(message.split('\n')[0], 'docs(M35): 完善 plan：OAuth 登录')
  assert.deepEqual(message.split('\n').slice(2), ['经 refine-plan 无人值守评审通过。', 'plan：specs/35-foo/plan.md', '评审记录：specs/35-foo/refine-report.md'])
  assert.equal(planCommitMessage({ number: '25', title: 'M25：占位', spec: 'specs/foo', cross: true }).split('\n')[0], 'docs: 完善 plan：占位')
})

test('the plan commit body fits commitlint\'s body-max-line-length with a long spec name', () => {
  const message = planCommitMessage({ number: '04', title: 'M04：harness 新增 4 个工作量数据集', spec: 'specs/04-harness-ops-datasets', cross: false })
  for (const line of message.split('\n')) assert.ok(line.length <= 100, line)
})

test('a plan is committed only as it was reviewed', () => {
  const hashes = { 'specs/35-foo/plan.md': 'a', 'specs/35-foo/refine-report.md': 'b' }
  assert.ok(unchangedSince(hashes, path => hashes[path]))
  assert.ok(!unchangedSince(hashes, path => (path.endsWith('plan.md') ? 'edited' : hashes[path])))
})

test('tracked changes outside the selected plans and the --also documents are refused', () => {
  assert.deepEqual(dirtyOutside(['specs/35-foo/plan.md', 'docs/A.md', 'src/x.js'], [M35], ['docs/A.md']), ['src/x.js'])
})

test('--also is relative to the plan\'s repository, as refine-plan takes it, whatever the current directory', () => {
  const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  const options = parseArgs(['--only', '35', '--also', 'docs/shared.md,docs/B.md', '--also', 'specs/00-conventions.md'], join(repo, 'specs'))
  assert.deepEqual(alsoOf(options, repo), ['docs/shared.md', 'docs/B.md', 'specs/00-conventions.md'])
})

// A scripted world: refine-plan answers with one record per milestone (its
// result), the commit and run-milestones-auto from their arguments. A
// committed plan reads as reviewed afterwards; `afterRefine(states)` changes
// what the reviews did to the others.
function world({ states = {}, results = {}, refineCode = 0, implementCode = 0, commit = () => ({ ok: true, message: '✓ 已提交评审通过的 plan' }),
  onMain = [], unpushed = [], afterRefine = () => {} } = {}) {
  const calls = { order: [], refine: [], mail: [], log: '' }
  const deps = {
    scope: () => [M35, M36, M37],
    state: milestone => states[milestone.number] ?? { status: 'pending', statusFile: false, refined: false },
    refine: async (milestones, command) => {
      calls.order.push(`refine ${milestones.map(item => item.number).join(',')}`)
      calls.refine.push(command)
      afterRefine(states)
      return { code: refineCode, records: milestones.map(item => ({ label: item.rel, result: results[item.number] ?? 'approved', hashes: {} })) }
    },
    commitPlan: milestone => {
      calls.order.push(`commit ${milestone.number}`)
      const result = commit(milestone)
      if (result.ok && !result.changed) states[milestone.number] = { status: 'pending', statusFile: false, refined: true }
      return result
    },
    implement: async () => { calls.order.push('implement'); return implementCode },
    protectedBranches: () => onMain,
    unpushed: () => unpushed,
    interrupted: () => false,
    log: text => { calls.log += text },
    mailFailure: async (subject, text) => { calls.mail.push({ subject, text }) },
  }
  return { deps, calls }
}

test('every plan is reviewed and committed before any code is written', async () => {
  const { deps, calls } = world({ states: { 36: { status: 'done', statusFile: true, refined: true } } })
  const result = await refineAndRun(parseArgs(['--only', '35-37', '--max-rounds', '3']), deps)
  assert.equal(result.code, 0)
  assert.deepEqual(calls.order, ['refine 35,37', 'commit 35', 'commit 37', 'implement'])
  assert.deepEqual(calls.refine, ['refine-and-run --only 35-37 --max-rounds 3'])
  assert.match(calls.log, /specs\/36-bar 已实现，跳过/u)
  assert.match(calls.log, /评审 2 个 plan：specs\/35-foo、specs\/37-baz/u)
  assert.match(calls.log, /plan 全部就绪，开始实现：specs\/35-foo、specs\/37-baz/u)
  assert.match(calls.log, /✓ 全部完成/u)
})

test('plans already reviewed go straight to the implementation', async () => {
  const refined = { status: 'pending', statusFile: false, refined: true }
  const { deps, calls } = world({ states: { 35: refined, 36: refined, 37: { status: 'approved-uncommitted', statusFile: true, refined: false } } })
  const result = await refineAndRun(parseArgs(['--from', '35']), deps)
  assert.equal(result.code, 0)
  assert.deepEqual(calls.order, ['implement'])
})

test('a plan that needs the user: the others are still reviewed and committed, no code is written', async () => {
  const { deps, calls } = world({ results: { 36: 'decisions' }, refineCode: 4 })
  const result = await refineAndRun(parseArgs(['--from', '35']), deps)
  assert.equal(result.code, 4)
  assert.equal(result.phase, 'refine')
  assert.deepEqual(result.pending, [M36])
  assert.deepEqual(calls.order, ['refine 35,36,37', 'commit 35', 'commit 37'])
  assert.match(calls.log, /还有 plan 需要你处理：specs\/36-bar。没有开始写代码。处理好后：refine-and-run --from 35/u)
  assert.equal(calls.mail.length, 0, 'refine-plan mailed itself')
})

test('a plan edited after its review is not committed and holds the code back', async () => {
  const { deps, calls } = world({ commit: milestone => (milestone.number === '35'
    ? { ok: true, changed: true, message: 'specs/35-foo 的 plan 评审之后又改过' } : { ok: true, message: '✓' }) })
  const result = await refineAndRun(parseArgs(['--only', '35,36']), deps)
  assert.equal(result.code, 1)
  assert.deepEqual(result.pending, [M35])
  assert.ok(!calls.order.includes('implement'))
  // Every review passed, so refine-plan mailed nothing: this run does.
  assert.equal(calls.mail.length, 1)
  assert.equal(calls.mail[0].subject, '⏸ plan 评审后又改过，没有开始写代码（--only 35,36）')
  assert.match(calls.mail[0].text, /specs\/35-foo 的 plan 评审通过后又改过[\s\S]*处理好后继续：refine-and-run --only 35,36/u)
})

test('refine-plan failing without results holds every plan back', async () => {
  const { deps, calls } = world({ refineCode: 1 })
  deps.refine = async () => { calls.order.push('refine'); return { code: 1, records: [] } }
  const result = await refineAndRun(parseArgs(['--only', '35']), deps)
  assert.equal(result.code, 1)
  assert.deepEqual(result.pending, [M35, M36, M37])
  assert.deepEqual(calls.order, ['refine'])
})

test('a failed implementation is reported with the command to carry on', async () => {
  const { deps, calls } = world({ implementCode: 1 })
  const result = await refineAndRun(parseArgs(['--only', '35-37']), deps)
  assert.equal(result.code, 1)
  assert.equal(result.phase, 'implement')
  assert.match(calls.log, /实现没有全部完成（run-milestones-auto 退出码 1）。处理好后：refine-and-run --only 35-37/u)
})

test('a refused plan commit is mailed and stops the run before the code', async () => {
  const { deps, calls } = world({ commit: () => ({ ok: false, message: 'git commit 失败（/repo）：commitlint: subject may not be empty' }) })
  const result = await refineAndRun(parseArgs(['--only', '35']), deps)
  assert.equal(result.code, 1)
  assert.equal(result.phase, 'commit')
  assert.deepEqual(calls.order, ['refine 35,36,37', 'commit 35'])
  assert.equal(calls.mail[0].subject, '❌ M35：示例：plan 提交失败')
  assert.match(calls.mail[0].text, /commitlint: subject may not be empty[\s\S]*还没有开始写代码。处理好后：refine-and-run --only 35/u)
})

test('all implemented: nothing to run', async () => {
  const done = { status: 'done', statusFile: true, refined: true }
  const { deps, calls } = world({ states: { 35: done, 36: done, 37: done } })
  assert.equal((await refineAndRun(parseArgs(['--from', '35']), deps)).code, 0)
  assert.deepEqual(calls.order, [])
  assert.match(calls.log, /选中的里程碑都已实现并推送/u)
})

test('all implemented but not pushed: run-milestones-auto pushes the leftovers', async () => {
  const done = { status: 'done', statusFile: true, refined: true }
  const { deps, calls } = world({ states: { 35: done, 36: done, 37: done }, unpushed: ['/repo'] })
  assert.equal((await refineAndRun(parseArgs(['--from', '35']), deps)).code, 0)
  assert.deepEqual(calls.order, ['implement'])
  assert.match(calls.log, /还有没推送的提交（\/repo），交给 run-milestones-auto 推送/u)
})

test('master/main without --allow-main is refused before any review or commit', async () => {
  const { deps, calls } = world({ onMain: [{ cwd: '/repo', branch: 'main' }] })
  const result = await refineAndRun(parseArgs(['--only', '35']), deps)
  assert.equal(result.code, 1)
  assert.equal(result.phase, 'branch')
  assert.deepEqual(calls.order, [])
  assert.match(calls.log, /\/repo 在 main 分支上：不带 --allow-main 不会在这里提交 plan/u)
  assert.equal(calls.mail[0].subject, '❌ 没有开始：在 master/main 分支上（--only 35）')
  const allowed = world({ onMain: [{ cwd: '/repo', branch: 'main' }] })
  assert.equal((await refineAndRun(parseArgs(['--only', '35', '--allow-main']), allowed.deps)).code, 0)
  assert.deepEqual(allowed.calls.order, ['refine 35,36,37', 'commit 35', 'commit 36', 'commit 37', 'implement'])
})

test('a committed report counts only for the version it approved', () => {
  const report = (documents, gate = { decisions: 0, accepted: false }) =>
    `| 项目 | 结果 |\n|---|---|\n| 结论 | 第 1 轮评审通过 |\n\n<!-- refine-plan reviewed: ${JSON.stringify({ documents, ...gate })} -->\n`
  const now = { 'specs/35-foo/plan.md': 'a', 'docs/A.md': 'b' }
  const current = path => now[path]
  assert.ok(stillReviewed(report(now), ['specs/35-foo/plan.md', 'docs/A.md'], current))
  // Edited (and committed) after the review.
  assert.ok(!stillReviewed(report({ ...now, 'specs/35-foo/plan.md': 'old' }), ['specs/35-foo/plan.md'], current))
  // A document the review did not cover: --also added since.
  assert.ok(!stillReviewed(report({ 'specs/35-foo/plan.md': 'a' }), ['specs/35-foo/plan.md', 'docs/A.md'], current))
  // A report without the record, or not approved.
  assert.ok(!stillReviewed('| 结论 | 第 1 轮评审通过 |\n', ['specs/35-foo/plan.md'], current))
  assert.ok(!stillReviewed(report(now).replace('第 1 轮评审通过', '达到 5 轮上限'), ['specs/35-foo/plan.md'], current))
  // 需人工决定 items: committed by hand, they still wait, unless accepted then or now.
  const waiting = report(now, { decisions: 2, accepted: false })
  assert.ok(!stillReviewed(waiting, ['specs/35-foo/plan.md'], current))
  assert.ok(stillReviewed(waiting, ['specs/35-foo/plan.md'], current, true))
  assert.ok(stillReviewed(report(now, { decisions: 2, accepted: true }), ['specs/35-foo/plan.md'], current))
  assert.equal(parseArgs(['--only', '35', '--accept-decisions']).acceptDecisions, true)
})

test('a review this run that invalidates an earlier approval holds the code back', async () => {
  const refined = { status: 'pending', statusFile: false, refined: true }
  // M35 was ready; reviewing M36 edited a document M35's approval covered.
  const { deps, calls } = world({ states: { 35: refined, 37: refined }, afterRefine: states => { states[35] = { ...refined, refined: false } } })
  const result = await refineAndRun(parseArgs(['--from', '35']), deps)
  assert.equal(result.code, 1)
  assert.equal(result.phase, 'stale')
  assert.deepEqual(result.pending, [M35])
  assert.deepEqual(calls.order, ['refine 36', 'commit 36'])
  assert.match(calls.log, /specs\/35-foo 的 plan 已经不是评审通过的版本了[\s\S]*重跑会重新评审。[\s\S]*处理好后继续：refine-and-run --from 35/u)
  // All reviews passed and nothing was implemented: neither command mailed, so this run does.
  assert.equal(calls.mail.length, 1)
  assert.equal(calls.mail[0].subject, '⏸ plan 评审已失效，没有开始写代码（--from 35）')
  assert.match(calls.mail[0].text, /本轮其他评审改了它的文档[\s\S]*处理好后继续：refine-and-run --from 35/u)
})

function tempRepo() {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'refine-and-run-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'feat/test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  return { dir, git }
}
const sha = text => createHash('sha1').update(text).digest('hex')

test('the plan commit holds exactly the reviewed files; anything else staged stays staged', () => {
  const { dir, git } = tempRepo()
  try {
    writeFileSync(join(dir, 'README.md'), 'x\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    mkdirSync(join(dir, 'specs/35-foo'), { recursive: true })
    mkdirSync(join(dir, 'specs/36-bar'), { recursive: true })
    const plan = '# M35：示例\n'
    const report = '| 结论 | 第 1 轮评审通过 |\n'
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), plan)
    writeFileSync(join(dir, 'specs/35-foo/refine-report.md'), report)
    // Staged before, not part of M35's review.
    writeFileSync(join(dir, 'specs/36-bar/plan.md'), '# M36：待决定\n')
    git('add', 'specs/36-bar/plan.md')
    const hashes = { 'specs/35-foo/plan.md': sha(plan), 'specs/35-foo/refine-report.md': sha(report) }
    const result = commitReviewed({ repo: dir, spec: 'specs/35-foo', hashes, number: '35', label: 'specs/35-foo', cross: false })
    assert.ok(result.ok, result.message)
    assert.equal(git('log', '-1', '--format=%s'), 'docs(M35): 完善 plan：示例\n')
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['specs/35-foo/plan.md', 'specs/35-foo/refine-report.md'])
    assert.equal(git('diff', '--cached', '--name-only'), 'specs/36-bar/plan.md\n', 'M36 is still staged')

    // Edited after its review: not committed.
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), `${plan}改了\n`)
    const edited = commitReviewed({ repo: dir, spec: 'specs/35-foo', hashes: { 'specs/35-foo/plan.md': sha(plan) }, number: '35', label: 'specs/35-foo', cross: false })
    assert.equal(edited.changed, true)
    assert.equal(git('log', '--format=%s').split('\n').filter(Boolean).length, 2)

    // A reviewed document the review deleted: the deletion is committed too.
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), plan)
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs/OLD.md'), '# 旧\n')
    git('add', 'docs/OLD.md')
    git('commit', '-qm', 'old doc', '--', 'docs/OLD.md')
    rmSync(join(dir, 'docs/OLD.md'))
    const report2 = `${report}第二次\n`
    writeFileSync(join(dir, 'specs/35-foo/refine-report.md'), report2)
    const deleted = commitReviewed({ repo: dir, spec: 'specs/35-foo', number: '35', label: 'specs/35-foo', cross: false,
      hashes: { 'specs/35-foo/plan.md': sha(plan), 'docs/OLD.md': 'missing', 'specs/35-foo/refine-report.md': sha(report2) } })
    assert.ok(deleted.ok && !deleted.changed, deleted.message)
    assert.deepEqual(git('show', '--name-status', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['D\tdocs/OLD.md', 'M\tspecs/35-foo/refine-report.md'])
    assert.equal(git('status', '--porcelain', '--', 'docs'), '', 'nothing left behind')
    assert.equal(git('diff', '--cached', '--name-only'), 'specs/36-bar/plan.md\n', 'M36 is still staged')

    // The same with the deletion staged already (git rm): no longer in the index, still in HEAD.
    writeFileSync(join(dir, 'docs/GONE.md'), '# 也要删\n')
    git('add', 'docs/GONE.md')
    git('commit', '-qm', 'another doc', '--', 'docs/GONE.md')
    git('rm', '-q', 'docs/GONE.md')
    const report3 = `${report2}第三次\n`
    writeFileSync(join(dir, 'specs/35-foo/refine-report.md'), report3)
    const staged = commitReviewed({ repo: dir, spec: 'specs/35-foo', number: '35', label: 'specs/35-foo', cross: false,
      hashes: { 'specs/35-foo/plan.md': sha(plan), 'docs/GONE.md': 'missing', 'docs/NEVER.md': 'missing', 'specs/35-foo/refine-report.md': sha(report3) } })
    assert.ok(staged.ok && !staged.changed, staged.message)
    assert.deepEqual(git('show', '--name-status', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['D\tdocs/GONE.md', 'M\tspecs/35-foo/refine-report.md'])
    assert.equal(git('diff', '--cached', '--name-only'), 'specs/36-bar/plan.md\n', 'only M36 is left staged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Ctrl+C during the reviews ends the run there', async () => {
  const { deps, calls } = world()
  deps.interrupted = () => calls.order.length > 0
  const result = await refineAndRun(parseArgs(['--only', '35']), deps)
  assert.equal(result.code, 130)
  assert.deepEqual(calls.order, ['refine 35,36,37'])
})

// The real side effects behind --dry-run, in a real repository: no opencode needed.
test('end to end: --dry-run reads the state of each milestone from git', () => {
  const { dir, git } = tempRepo()
  try {
    const plan = name => `# ${name}：示例\n\n## 验收命令\n\n\`\`\`bash\nnode --version\n\`\`\`\n`
    const approved = name => `| 项目 | 结果 |\n|---|---|\n| 结论 | 第 1 轮评审通过 |\n\n<!-- refine-plan reviewed: ${JSON.stringify({ documents: { [`specs/${name}/plan.md`]: sha(plan(name)) }, decisions: 0, accepted: false })} -->\n`
    const names = ['35-new', '36-done', '37-refined', '38-edited', '39-recommitted']
    for (const name of names) mkdirSync(join(dir, 'specs', name), { recursive: true })
    for (const name of names.slice(1)) writeFileSync(join(dir, 'specs', name, 'plan.md'), plan(name))
    writeFileSync(join(dir, 'specs/36-done/STATUS'), 'APPROVED\n')
    for (const name of names.slice(2)) writeFileSync(join(dir, 'specs', name, 'refine-report.md'), approved(name))
    git('add', '.')
    git('commit', '-qm', 'init')
    // A new draft, untracked; a reviewed plan edited afterwards; and one edited and committed afterwards.
    writeFileSync(join(dir, 'specs/35-new/plan.md'), plan('35-new'))
    writeFileSync(join(dir, 'specs/38-edited/plan.md'), `${plan('38-edited')}\n改了\n`)
    writeFileSync(join(dir, 'specs/39-recommitted/plan.md'), `${plan('39-recommitted')}\n改了还提交了\n`)
    git('commit', '-qam', 'edit a reviewed plan')
    const result = spawnSync(process.execPath, [SCRIPT, '--from', '35', '--dry-run', '--notify-config', join(dir, 'no-mail.env')], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /specs\/35-new（35-new：示例）：评审 plan，通过后提交/u)
    assert.match(result.stdout, /specs\/36-done（36-done：示例）：已实现，跳过/u)
    assert.match(result.stdout, /specs\/37-refined（37-refined：示例）：不用评审/u)
    assert.match(result.stdout, /specs\/38-edited（38-edited：示例）：评审 plan，通过后提交/u)
    assert.match(result.stdout, /specs\/39-recommitted（39-recommitted：示例）：评审 plan，通过后提交/u)
    assert.match(result.stdout, /全部评审通过后，实现：run-milestones-auto --from 35 --notify-config /u)
    assert.doesNotMatch(result.stdout, /--allow-main/u)
    git('branch', '-m', 'main')
    const onMain = spawnSync(process.execPath, [SCRIPT, '--from', '35', '--dry-run', '--notify-config', join(dir, 'no-mail.env')], { cwd: dir, encoding: 'utf8' })
    assert.match(onMain.stdout, /在 main 分支上：不带 --allow-main 时会直接拒绝/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
