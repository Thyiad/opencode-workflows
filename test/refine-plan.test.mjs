import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  acceptanceCheck, auditRun, baselineDiff, blockingIssueIds, changedPaths, checkRound, collectDecisions, diffStat, displaySpec, documentsInScope,
  fenced, finishRun, locate, mailFor,
  outcomeOf, outsideScope, parseArgs, parseVerdict, readRounds, renderReport, repoPath, runDirsSince, section, startRun, worktreeSnapshot,
} from '../src/refine-plan.mjs'
import { repoRootOf } from '../src/config.mjs'
import { splitFrontmatter } from '../src/run-milestones.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REFINE_PLAN = join(packageRoot, 'src', 'refine-plan.mjs')
// The template every repository copies its .opencode from.
const EXAMPLES = join(packageRoot, 'examples')

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'refine-plan-'))
  execFileSync('git', ['init', '-q', '-b', 'feat/test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  return dir
}

const PLAN = [
  '# M99：示例',
  '',
  '## 目标',
  '',
  '做一件事。',
  '',
  '## 验收命令',
  '',
  '```bash',
  'node --version',
  '```',
  '',
].join('\n')

test('arguments: one milestone directory, rounds, extra documents', () => {
  const options = parseArgs(['specs/35-foo', '--max-rounds', '3', '--also', 'docs/A.md,docs/B.md', '--also', 'docs/C.md'])
  assert.equal(options.spec, 'specs/35-foo')
  assert.equal(options.maxRounds, 3)
  assert.deepEqual(options.also, ['docs/A.md', 'docs/B.md', 'docs/C.md'])
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs([]), /缺少里程碑目录/u)
  assert.throws(() => parseArgs(['a', 'b']), /只能给一个/u)
  assert.throws(() => parseArgs(['a', '--max-rounds', '0']), /正整数/u)
  assert.throws(() => parseArgs(['a', '--max-rounds']), /需要一个值/u)
  assert.throws(() => parseArgs(['a', '--bogus']), /未知参数/u)
  assert.equal(parseArgs(['--start', 'specs/35-foo', '--max-rounds', '2']).start, true)
  assert.equal(parseArgs(['--finish', '.plan-refine-logs/r']).finish, '.plan-refine-logs/r')
  assert.equal(parseArgs(['--check', '.plan-refine-logs/r']).check, '.plan-refine-logs/r')
  assert.throws(() => parseArgs(['--finish', 'r', 'specs/35-foo']), /只需要记录目录/u)
  assert.throws(() => parseArgs(['--check', 'r', 'specs/35-foo']), /只需要记录目录/u)
  assert.throws(() => parseArgs(['--start', '--check', 'r', 'specs/35-foo']), /只能用一个/u)
  assert.equal(parseArgs(['a', '--agent-timeout-hours', '2']).agentTimeoutHours, 2)
  assert.match(parseArgs(['a', '--notify-config', 'x.env']).notifyConfig, /x\.env$/u)
})

test('repository paths stay inside the repository', () => {
  assert.equal(repoPath('specs/35-foo/', '/repo'), 'specs/35-foo')
  assert.equal(repoPath('/repo/docs/A.md', '/repo'), 'docs/A.md')
  assert.equal(repoPath('../other', '/repo'), null)
  assert.equal(repoPath('.', '/repo'), null)
})

test('the verdict is the first non-empty line only', () => {
  assert.equal(parseVerdict('\nAPPROVED\n\n理由'), 'APPROVED')
  assert.equal(parseVerdict('**CHANGES_REQUESTED**\n## 阻塞问题'), 'CHANGES_REQUESTED')
  assert.equal(parseVerdict('`APPROVED`'), 'APPROVED')
  assert.equal(parseVerdict('我先看一下。\nAPPROVED'), null)
  assert.equal(parseVerdict('APPROVED WITH CHANGES'), null)
  assert.equal(parseVerdict(''), null)
})

test('blocking issue IDs come from the blocking section of this round', () => {
  const review = [
    'CHANGES_REQUESTED',
    '## 阻塞问题',
    '### R2-1：路径不对',
    '见 R1-3。',
    '### R2-2：命令不存在',
    '重复提到 R2-1',
    '## 需人工决定',
    '### R2-3：要不要做',
  ].join('\n')
  assert.deepEqual(blockingIssueIds(review, 2), ['R2-1', 'R2-2'])
  assert.equal(section(review, '需人工决定'), '### R2-3：要不要做')
  assert.equal(section(review, '非阻塞建议'), '')
})

test('the scope check notices edits to already modified files and anything outside the documents', () => {
  const dir = tempRepo()
  try {
    mkdirSync(join(dir, 'specs/35-foo'), { recursive: true })
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), PLAN)
    writeFileSync(join(dir, 'specs/35-foo/notes.md'), 'notes\n')
    writeFileSync(join(dir, 'specs/35-foo/STATUS'), 'APPROVED\n')
    writeFileSync(join(dir, 'specs/35-foo/refine-report.md'), 'old report\n')
    writeFileSync(join(dir, 'code.js'), 'one\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
    // Only plan.md by default: notes, snapshots and the like stay read-only unless named with --also.
    assert.deepEqual(documentsInScope('specs/35-foo'), ['specs/35-foo/plan.md'])
    assert.deepEqual(documentsInScope('specs/35-foo', ['specs/35-foo/notes.md', 'specs/35-foo/plan.md']), ['specs/35-foo/plan.md', 'specs/35-foo/notes.md'])

    writeFileSync(join(dir, 'specs/35-foo/plan.md'), `${PLAN}draft\n`)
    const before = worktreeSnapshot(dir)
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), `${PLAN}draft, edited\n`)
    writeFileSync(join(dir, 'code.js'), 'two\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const changed = changedPaths(before, worktreeSnapshot(dir))
    assert.deepEqual(changed, ['code.js', 'new.txt', 'specs/35-foo/plan.md'])
    assert.deepEqual(outsideScope(changed, ['specs/35-foo/plan.md']), ['code.js', 'new.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the baseline diff shows repository paths on both sides', () => {
  const dir = tempRepo()
  try {
    mkdirSync(join(dir, 'specs/35-foo'), { recursive: true })
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), 'line one\nline two\n')
    writeFileSync(join(dir, 'specs/35-foo/same.md'), 'same\n')
    const runDir = join(dir, '.plan-refine-logs/run')
    for (const name of ['plan.md', 'same.md']) {
      mkdirSync(join(runDir, 'baseline/specs/35-foo'), { recursive: true })
      copyFileSync(join(dir, 'specs/35-foo', name), join(runDir, 'baseline/specs/35-foo', name))
    }
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), 'line one\nline 2\nline three\n')
    const diff = baselineDiff({ runDir, documents: ['specs/35-foo/plan.md', 'specs/35-foo/same.md'], cwd: dir })
    assert.match(diff, /^diff --git a\/specs\/35-foo\/plan\.md b\/specs\/35-foo\/plan\.md$/mu)
    assert.match(diff, /^--- a\/specs\/35-foo\/plan\.md$/mu)
    assert.doesNotMatch(diff, /baseline|same\.md/u)
    assert.deepEqual([...diffStat(diff)], [['specs/35-foo/plan.md', { added: 2, removed: 1 }]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a diff of Markdown with its own code blocks stays inside one fence', () => {
  const diff = ' ```bash\n-node a\n+node b\n ```\n ~~~ tilde\n'
  const block = fenced(diff, 'diff')
  assert.ok(block.startsWith('~~~~ '.trim()))
  const fence = block.split('\n')[0].replace('diff', '')
  assert.equal(fence, '~~~~')
  assert.ok(block.endsWith(`\n${fence}`))
})

test('the acceptance block is checked the way the milestone runner parses it', () => {
  assert.equal(acceptanceCheck(PLAN).ok, true)
  assert.match(acceptanceCheck(PLAN).text, /node --version/u)
  const broken = acceptanceCheck('# M99：示例\n\n## 验收命令\n\n```bash\nexport A=1\nnode a\n```\n')
  assert.equal(broken.ok, false)
  assert.match(broken.text, /阻塞/u)
})

test('the report lists rounds, changed documents, unresolved issues and the diff', () => {
  const report = renderReport({
    title: 'M99：示例', date: '2026/10/5 10:00:00', reviewerModels: ['openai/gpt-6-sol#xhigh'], editorModel: 'deepseek/deepseek-flash#max',
    runDir: '.plan-refine-logs/r', outcome: '达到 2 轮上限', durationMs: 65_000,
    rounds: [
      { round: 1, model: 'openai/gpt-6-sol#xhigh', verdict: 'CHANGES_REQUESTED', issues: ['R1-1', 'R1-2'], responseFile: 'x' },
      { round: 2, model: 'openai/gpt-6-sol#xhigh', verdict: 'CHANGES_REQUESTED', issues: ['R2-1'], responseFile: null },
    ],
    body: '## 概要\n\n改了验收命令。', unresolved: '## 阻塞问题\n\n### R2-1：还有问题',
    diff: 'diff --git a/specs/x/plan.md b/specs/x/plan.md\n--- a/specs/x/plan.md\n+++ b/specs/x/plan.md\n@@ -1 +1 @@\n-a\n+b\n',
  })
  assert.match(report, /^# M99：示例：plan 自动评审与修改记录/u)
  assert.match(report, /不是需求/u)
  assert.match(report, /`specs\/x\/plan\.md`（\+1 \/ -1）/u)
  assert.match(report, /\| 1 \| `openai\/gpt-6-sol#xhigh` \| CHANGES_REQUESTED \| R1-1、R1-2 \| 已回应 \|/u)
  assert.match(report, /## 仍未解决的阻塞问题/u)
  assert.match(report, /~~~~diff\n/u)
  assert.match(report, /1 分 5 秒/u)
})

test('the example agents and command: editor drives, reviewer and fallback stay read-only twins', () => {
  const read = path => readFileSync(join(EXAMPLES, path), 'utf8')
  const command = splitFrontmatter(read('.opencode/commands/refine-plan.md'))
  assert.equal(command.fields.agent, 'plan-editor')
  for (const step of ['--start', '--check', '--finish']) assert.ok(command.body.includes(`refine-plan ${step}`), step)
  assert.doesNotMatch(command.body, /scripts\/refine-plan|node [^\n]*refine-plan/u, 'the command calls the global command, not a path')
  assert.match(command.body, /\$ARGUMENTS/u)

  const editor = read('.opencode/agents/plan-editor.md')
  assert.equal(splitFrontmatter(editor).fields.mode, 'primary')
  for (const agent of ['plan-reviewer', 'plan-reviewer-fallback']) {
    assert.ok(editor.includes(`action: subagent, resource: ${agent}, effect: allow`), agent)
  }
  for (const step of ['--start', '--check', '--finish']) assert.ok(editor.includes(`"refine-plan ${step} *"`), step)

  const reviewer = read('.opencode/agents/plan-reviewer.md')
  const fallback = read('.opencode/agents/plan-reviewer-fallback.md')
  for (const [name, text] of [['plan-reviewer', reviewer], ['plan-reviewer-fallback', fallback], ['plan-editor', editor]]) {
    assert.match(splitFrontmatter(text).fields.model ?? '', /^[\w-]+\/[\w.-]+#\w+$/u, name)
  }
  assert.equal(splitFrontmatter(reviewer).fields.mode, 'subagent')
  assert.doesNotMatch(reviewer, /action: (edit|subagent)[^\n]*effect: allow/u, 'the reviewer stays read-only')
  const strip = text => text.split('\n').filter(line => !/^(description|model):|^# Keep identical/u.test(line)).join('\n')
  assert.equal(strip(fallback), strip(reviewer), 'plan-reviewer-fallback.md differs from plan-reviewer.md beyond description and model')
})

const MODELS = { 'plan-editor': 'e/m#y', 'plan-reviewer': 'r/m#x', 'plan-reviewer-fallback': 'f/m#z' }

// A temporary repository with specs/35-foo/plan.md and a started run.
function startedRepo({ maxRounds = 2 } = {}) {
  const dir = tempRepo()
  mkdirSync(join(dir, 'specs/35-foo'), { recursive: true })
  writeFileSync(join(dir, 'specs/35-foo/plan.md'), PLAN)
  writeFileSync(join(dir, '.gitignore'), '.plan-refine-logs/\ndocs/ignored/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  const runDir = startRun({ spec: 'specs/35-foo', documents: ['specs/35-foo/plan.md'], title: 'M99：示例', models: MODELS,
    maxRounds, cwd: dir, now: new Date('2026-10-05T01:00:00Z') })
  // One round the way the command does it: --check, then the saved review.
  const round = (review, { response = null, edit = null } = {}) => {
    const { round: n } = checkRound(runDir, dir)
    writeFileSync(join(runDir, `round-${n}-review.md`), review)
    if (edit) writeFileSync(join(dir, 'specs/35-foo/plan.md'), edit)
    if (response) writeFileSync(join(runDir, `round-${n}-response.md`), response)
  }
  return { dir, runDir, round }
}

test('the command steps: --start, --check per round, --finish writes the report from the records', () => {
  const { dir, runDir, round } = startedRepo()
  try {
    assert.equal(readFileSync(join(runDir, 'baseline/specs/35-foo/plan.md'), 'utf8'), PLAN)
    assert.ok(existsSync(join(runDir, 'worktree.json')))
    assert.deepEqual(runDirsSince('specs/35-foo', new Date('2026-10-05T01:00:00Z'), dir), [runDir])
    assert.deepEqual(runDirsSince('specs/35-foo', new Date('2026-10-05T01:00:01Z'), dir), [])
    assert.throws(() => finishRun(runDir, { cwd: dir }), /还没有任何一轮评审记录/u)

    round('CHANGES_REQUESTED\n\n## 阻塞问题\n\n### R1-1：缺一句\n', { edit: `${PLAN}补一句。\n`,
      response: '## 处理结果\n\n### R1-1：缺一句\n- 结论：已修改\n\n### R1-2：要不要做\n- 结论：需人工决定\n- 理由：这是产品决定\n' })
    round('CHANGES_REQUESTED\n\n## 阻塞问题\n\n### R2-1：还缺\n\n## 需人工决定\n\n### R2-2：要不要做\n')
    writeFileSync(join(runDir, 'round-2-reviewer'), 'plan-reviewer-fallback\n')
    writeFileSync(join(runDir, 'report-body.md'), '## 概要\n\n补了一句。\n')
    const rounds = readRounds(runDir, dir)
    assert.deepEqual(rounds.map(item => [item.round, item.verdict, item.issues, Boolean(item.responseFile), item.model, Boolean(item.documents)]),
      [[1, 'CHANGES_REQUESTED', ['R1-1'], true, 'r/m#x', true], [2, 'CHANGES_REQUESTED', ['R2-1'], false, 'f/m#z', true]])
    assert.notDeepEqual(rounds[0].documents, rounds[1].documents, 'round 2 saw the edited plan')
    assert.equal(outcomeOf(rounds, 2), '达到 2 轮上限，仍有 1 个阻塞问题未解决')
    assert.equal(outcomeOf(rounds, 5), '停在第 2 轮，仍有 1 个阻塞问题未解决')
    assert.match(outcomeOf(rounds.slice(0, 1), 5), /没有再评审/u)
    assert.deepEqual(collectDecisions(rounds).map(item => item.source), ['第 1 轮修改方', '第 2 轮评审'])

    const result = finishRun(runDir, { cwd: dir, now: new Date('2026-10-05T01:02:00Z') })
    assert.deepEqual(result.problems, [])
    assert.equal(result.outcome, '达到 2 轮上限，仍有 1 个阻塞问题未解决')
    assert.equal(result.reportFile, 'specs/35-foo/refine-report.md')
    const report = readFileSync(join(dir, result.reportFile), 'utf8')
    assert.match(report, /补了一句。/u)
    assert.match(report, /## 需人工决定的问题（各轮原文汇总）[\s\S]*第 1 轮修改方[\s\S]*R1-2[\s\S]*第 2 轮评审[\s\S]*R2-2/u)
    assert.match(report, /## 仍未解决的阻塞问题[\s\S]*R2-1/u)
    assert.match(report, /\+补一句。/u)
    assert.match(report, /2 分 0 秒/u)
    assert.match(report, /评审：`r\/m#x`、`f\/m#z`；修改：`e\/m#y`/u)
    assert.doesNotMatch(report, /运行检查发现的问题/u)

    const mail = mailFor({ title: 'M99：示例', spec: 'specs/35-foo', result: 'unresolved', outcome: result.outcome, reportFile: result.reportFile,
      runDir: '.plan-refine-logs/r', logFile: '.plan-refine-logs/r.runner.log', durationMs: 120_000, rounds: result.rounds, decisions: result.decisions })
    assert.match(mail.subject, /^⚠️ plan 评审 M99：示例：达到 2 轮上限/u)
    assert.match(mail.text, /需要你决定的问题：2 个/u)
    assert.match(mail.text, /git diff -- specs\/35-foo/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The four gaps found in review, each reproduced and caught by the final check.
test('an approval counts only for the version it saw: editing afterwards is caught', () => {
  const { dir, runDir, round } = startedRepo()
  try {
    round('APPROVED\n')
    writeFileSync(join(dir, 'specs/35-foo/plan.md'), '# M99：示例\n\n改坏了，验收命令也删了。\n')
    const result = finishRun(runDir, { cwd: dir })
    assert.equal(result.approved, false)
    assert.equal(result.verdict, 'APPROVED')
    assert.match(result.problems.join('\n'), /第 1 轮评审之后又改了文档，当前内容没有经过评审：specs\/35-foo\/plan\.md/u)
    assert.match(result.problems.join('\n'), /验收命令无法使用/u)
    assert.match(result.outcome, /^运行检查未通过（评审记录：第 1 轮评审通过）/u)
    assert.match(readFileSync(join(dir, result.reportFile), 'utf8'), /## 运行检查发现的问题/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('需人工决定 items reach the report when round 1 approves without any edit', () => {
  const { dir, runDir, round } = startedRepo()
  try {
    round('APPROVED\n\n## 需人工决定\n\n### R1-1：问候语用哪种措辞\n- 建议：你好，名字\n')
    const result = finishRun(runDir, { cwd: dir })
    assert.equal(result.approved, true)
    const report = readFileSync(join(dir, result.reportFile), 'utf8')
    assert.match(report, /第一轮评审即通过/u)
    assert.match(report, /## 需人工决定的问题（各轮原文汇总）[\s\S]*R1-1：问候语用哪种措辞/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--finish alone (the interactive entry) checks the scope since --start, ignored files included', () => {
  const { dir, runDir, round } = startedRepo()
  try {
    round('APPROVED\n')
    mkdirSync(join(dir, 'docs/ignored'), { recursive: true })
    writeFileSync(join(dir, 'docs/ignored/notes.md'), 'written by the editor\n')
    writeFileSync(join(dir, 'code.js'), 'stray\n')
    const result = finishRun(runDir, { cwd: dir })
    assert.equal(result.approved, false)
    assert.deepEqual(result.problems, ['改动了范围以外的文件：code.js、docs/ignored/notes.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the final check: missing --check, missing or extra rounds, reviews without a verdict', () => {
  const { dir, runDir, round } = startedRepo()
  try {
    assert.deepEqual(auditRun(runDir, { cwd: dir }), ['一轮评审记录也没有'])
    round('CHANGES_REQUESTED\n')
    writeFileSync(join(runDir, 'round-2-review.md'), 'LGTM\n')
    assert.deepEqual(auditRun(runDir, { cwd: dir }), [
      '第 2 轮评审记录的第一行不是 APPROVED 或 CHANGES_REQUESTED',
      '第 2 轮评审前没有执行 --check，不知道评审的是哪个版本',
    ])
    writeFileSync(join(runDir, 'round-4-review.md'), 'APPROVED\n')
    assert.match(auditRun(runDir, { cwd: dir }).join('\n'), /评审了 3 轮，超过上限 2[\s\S]*缺少第 3 轮/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A stand-in for opencode playing plan-editor under /refine-plan: it runs the
// command's steps the way the agent is told to; FAKE_* switches make it misbehave.
const FAKE_OPENCODE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('2.0.18'); process.exit(0) }
let prompt = ''
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
  const env = process.env
  if (env.FAKE_NO_START) { console.log('nothing to do'); return }
  const argv = /The arguments are: \\x60([^\\x60]*)\\x60/.exec(prompt)[1].split(' ')
  const [spec, max] = [argv[0], Number(argv[1])]
  // The command calls the global \x60refine-plan\x60; here it is the package's file.
  if (!/refine-plan --start/.test(prompt)) throw new Error('the command does not call refine-plan --start')
  const step = (...rest) => execFileSync(process.execPath, [env.FAKE_REFINE_PLAN, ...rest], { encoding: 'utf8' })
  const started = step('--start', spec, '--max-rounds', String(max), ...argv.slice(2))
  console.log(started)
  const run = /记录目录：(\\S+)/.exec(started)[1]
  const rounds = env.FAKE_OVER ? max + 1 : max
  for (let n = 1; n <= rounds; n += 1) {
    if (!env.FAKE_SKIP_CHECK) step('--check', run)
    const approve = !env.FAKE_LIMIT && !env.FAKE_OVER && n === 2
    const verdict = env.FAKE_BAD_VERDICT ? 'LGTM' : approve ? 'APPROVED' : 'CHANGES_REQUESTED'
    writeFileSync(run + '/round-' + n + '-review.md', verdict + '\\n\\n## 阻塞问题\\n\\n### R' + n + '-1：缺少说明\\n' + (approve ? '\\n## 非阻塞建议\\n\\n- 可以再短一点\\n' : ''))
    if (env.FAKE_FALLBACK) writeFileSync(run + '/round-' + n + '-reviewer', 'plan-reviewer-fallback\\n')
    if (approve && env.FAKE_EDIT_AFTER) appendFileSync(spec + '/plan.md', '\\n审过之后又改\\n')
    if (approve || env.FAKE_BAD_VERDICT || (n === max && !env.FAKE_OVER)) break
    if (env.FAKE_CRASH) process.exit(2)
    appendFileSync(spec + '/plan.md', '\\nFIXED ' + n + '\\n')
    if (env.FAKE_STRAY) { mkdirSync(require('node:path').dirname(env.FAKE_STRAY), { recursive: true }); appendFileSync(env.FAKE_STRAY, 'stray\\n') }
    writeFileSync(run + '/round-' + n + '-response.md', '## 处理结果\\n\\n### R' + n + '-1\\n- 结论：已修改\\n')
  }
  writeFileSync(run + '/report-body.md', '## 概要\\n\\n补了说明。\\n')
  // --finish exits 1 when its check finds problems; the agent reports them and ends normally.
  try { console.log(step('--finish', run)) } catch (error) { console.log(error.stdout, error.stderr) }
})
`

function fakeRepo() {
  const dir = tempRepo()
  for (const path of ['.opencode/commands/refine-plan.md', '.opencode/agents/plan-editor.md', '.opencode/agents/plan-reviewer.md', '.opencode/agents/plan-reviewer-fallback.md']) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(join(EXAMPLES, path), join(dir, path))
  }
  mkdirSync(join(dir, 'specs/35-foo'), { recursive: true })
  writeFileSync(join(dir, 'specs/35-foo/plan.md'), PLAN)
  writeFileSync(join(dir, 'code.js'), 'code\n')
  writeFileSync(join(dir, '.gitignore'), '.plan-refine-logs/\ndocs/ignored/\n')
  writeFileSync(join(dir, 'fake-opencode'), FAKE_OPENCODE)
  chmodSync(join(dir, 'fake-opencode'), 0o755)
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

// Never the real mail settings: a test must not send email.
function runRefine(dir, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [REFINE_PLAN, ...args, '--notify-config', join(dir, 'no-mail.env')], {
      cwd: dir, env: { ...process.env, OPENCODE_BIN: join(dir, 'fake-opencode'), FAKE_REFINE_PLAN: REFINE_PLAN, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out:\n${output}`)) }, 60_000)
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, output }) })
  })
}

const unix = { skip: process.platform === 'win32' ? 'the fake opencode is a Unix script' : false }
const report = dir => readFileSync(join(dir, 'specs/35-foo/refine-report.md'), 'utf8')

async function withFakeRepo(fn) {
  const dir = fakeRepo()
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('end to end: opencode runs /refine-plan, the runner checks it and regenerates the report', unix, () => withFakeRepo(async dir => {
  const { code, output } = await runRefine(dir, ['specs/35-foo'])
  assert.equal(code, 0, output)
  assert.match(output, /✅ plan 评审 M99：示例：第 2 轮评审通过/u)
  assert.match(output, /邮件通知未启用/u)
  assert.match(readFileSync(join(dir, 'specs/35-foo/plan.md'), 'utf8'), /FIXED 1/u)
  assert.match(report(dir), /补了说明。/u)
  assert.match(report(dir), /可以再短一点/u)
  assert.match(report(dir), /\+FIXED 1/u)
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  assert.deepEqual(status, [' M specs/35-foo/plan.md', '?? specs/35-foo/refine-report.md'], 'nothing committed, nothing else touched')
  const logs = readdirSync(join(dir, '.plan-refine-logs'))
  assert.ok(logs.some(name => name.endsWith('.runner.log')))
  const runDir = logs.find(name => !name.endsWith('.log'))
  assert.equal(readFileSync(join(dir, '.plan-refine-logs', runDir, 'baseline/specs/35-foo/plan.md'), 'utf8'), PLAN)
  // The runner log holds the agent's output, here the steps it ran with the runner's round limit.
  assert.match(readFileSync(join(dir, '.plan-refine-logs', logs.find(name => name.endsWith('.runner.log'))), 'utf8'), /最多 5 轮评审/u)
}))

test('end to end: the round limit is reported as unresolved (exit 3)', unix, () => withFakeRepo(async dir => {
  const { code, output } = await runRefine(dir, ['specs/35-foo', '--max-rounds', '3'], { FAKE_LIMIT: '1' })
  assert.equal(code, 3, output)
  assert.match(report(dir), /达到 3 轮上限/u)
  assert.match(report(dir), /## 仍未解决的阻塞问题[\s\S]*R3-1/u)
}))

test('end to end: rule breaking is a failed run, with the report still written', unix, async () => {
  const cases = [
    [{ FAKE_STRAY: 'code.js' }, /改动了范围以外的文件：code\.js/u],
    [{ FAKE_OVER: '1' }, /评审了 6 轮，超过上限 5/u],
    [{ FAKE_BAD_VERDICT: '1' }, /第一行不是 APPROVED/u],
    [{ FAKE_CRASH: '1' }, /opencode 以退出码 2 结束/u],
    [{ FAKE_EDIT_AFTER: '1' }, /第 2 轮评审之后又改了文档/u],
    [{ FAKE_SKIP_CHECK: '1' }, /第 1 轮评审前没有执行 --check/u],
    [{ FAKE_STRAY: 'docs/ignored/x.md' }, /改动了范围以外的文件：docs\/ignored\/x\.md/u],
  ]
  for (const [env, problem] of cases) {
    await withFakeRepo(async dir => {
      const { code, output } = await runRefine(dir, ['specs/35-foo'], env)
      assert.equal(code, 1, output)
      assert.match(output, /❌ plan 评审/u)
      assert.match(output, problem)
      assert.ok(existsSync(join(dir, 'specs/35-foo/refine-report.md')), `report for ${JSON.stringify(env)}`)
    })
  }
})

test('end to end: an agent that never started a run fails without a report', unix, () => withFakeRepo(async dir => {
  const { code, output } = await runRefine(dir, ['specs/35-foo'], { FAKE_NO_START: '1' })
  assert.equal(code, 1, output)
  assert.match(output, /没有执行 --start/u)
  assert.ok(!existsSync(join(dir, 'specs/35-foo/refine-report.md')))
}))

test('end to end: the fallback reviewer is named in the report; --also reaches the command', unix, () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs/API.md'), '# API\n')
  const { code, output } = await runRefine(dir, ['specs/35-foo', '--also', 'docs/API.md'], { FAKE_FALLBACK: '1' })
  assert.equal(code, 0, output)
  assert.match(report(dir), /blackaicoding\/claude-opus-5#xhigh/u)
  const runDir = readdirSync(join(dir, '.plan-refine-logs')).find(name => !name.endsWith('.log'))
  assert.ok(existsSync(join(dir, '.plan-refine-logs', runDir, 'baseline/docs/API.md')))
}))

test('a milestone that was already implemented is refused', unix, () => withFakeRepo(async dir => {
  writeFileSync(join(dir, 'specs/35-foo/STATUS'), 'APPROVED\n')
  const { code, output } = await runRefine(dir, ['specs/35-foo'])
  assert.equal(code, 1, output)
  assert.match(output, /已经实现过/u)
}))

test('locate: a plan in another repository, and a placeholder standing for its target', () => {
  const parent = mkdtempSync(join(tmpdir(), 'refine-locate-'))
  try {
    for (const name of ['hub', 'target']) {
      mkdirSync(join(parent, name))
      execFileSync('git', ['init', '-q'], { cwd: join(parent, name) })
    }
    mkdirSync(join(parent, 'target/specs/foo'), { recursive: true })
    writeFileSync(join(parent, 'target/specs/foo/plan.md'), PLAN)
    const target = realpathSync(join(parent, 'target'))
    assert.deepEqual(locate('../target/specs/foo', join(parent, 'hub')), { repo: target, spec: 'specs/foo', placeholder: null })
    assert.deepEqual(locate('specs/foo/', target), { repo: target, spec: 'specs/foo', placeholder: null })
    assert.throws(() => locate('specs/missing', target), /找不到 specs\/missing\/plan\.md/u)
    // A placeholder names its target relative to its own repository, wherever
    // the command is started: from that repository, from the target, or from a third one.
    mkdirSync(join(parent, 'hub/specs/35-foo'), { recursive: true })
    writeFileSync(join(parent, 'hub/specs/35-foo/plan.md'), '# M35：占位\n\n<!-- milestone-repo: ../target -->\n<!-- milestone-spec: specs/foo -->\n')
    mkdirSync(join(parent, 'elsewhere/deep/repo'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: join(parent, 'elsewhere/deep/repo') })
    for (const [path, cwd] of [['specs/35-foo', join(parent, 'hub')], ['../hub/specs/35-foo', target], [join(parent, 'hub/specs/35-foo'), join(parent, 'elsewhere/deep/repo')]]) {
      assert.deepEqual(locate(path, cwd), { repo: target, spec: 'specs/foo', placeholder: 'specs/35-foo' }, `${path} from ${cwd}`)
    }
    assert.equal(displaySpec(repoRootOf(), 'specs/35-foo'), 'specs/35-foo')
    // Paths are shown relative to the repository the command runs in (here: where the tests run).
    assert.equal(displaySpec(target, 'specs/foo'), `${relative(repoRootOf(), target).split(sep).join('/')}/specs/foo`)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

// Two repositories side by side: the command runs in `hub`, the plan lives in
// `target`, which has its own .opencode (like OPOC-DSH and OPOC).
function fakeRepos() {
  const hub = fakeRepo()
  const parent = mkdtempSync(join(tmpdir(), 'refine-two-'))
  const hubDir = join(parent, 'hub')
  execFileSync('mv', [hub, hubDir])
  const target = join(parent, 'target')
  mkdirSync(join(target, 'specs/foo'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'feat/test'], { cwd: target })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: target })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: target })
  for (const path of ['.opencode/commands/refine-plan.md', '.opencode/agents/plan-editor.md', '.opencode/agents/plan-reviewer.md', '.opencode/agents/plan-reviewer-fallback.md']) {
    mkdirSync(dirname(join(target, path)), { recursive: true })
    copyFileSync(join(hubDir, path), join(target, path))
  }
  writeFileSync(join(target, 'specs/foo/plan.md'), PLAN)
  writeFileSync(join(target, 'specs/foo/SNAPSHOT.md'), '# 契约快照\n')
  execFileSync('git', ['add', '.'], { cwd: target })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: target })
  return { parent, hub: hubDir, target }
}

test('end to end: a plan in another repository runs there, with its own .opencode and records', unix, async () => {
  const { parent, hub, target } = fakeRepos()
  try {
    const { code, output } = await runRefine(hub, ['../target/specs/foo'])
    assert.equal(code, 0, output)
    assert.match(output, /规格：M99：示例（\.\.\/target\/specs\/foo）/u)
    assert.match(output, /仓库：.*target（用它自己的 \.opencode）/u)
    assert.match(output, /查看改动：git -C \.\.\/target diff -- specs\/foo/u)
    assert.match(readFileSync(join(target, 'specs/foo/plan.md'), 'utf8'), /FIXED 1/u)
    assert.match(readFileSync(join(target, 'specs/foo/refine-report.md'), 'utf8'), /第 2 轮评审通过/u)
    // The target does not ignore the records; they are still not counted as stray edits.
    assert.ok(existsSync(join(target, '.plan-refine-logs')))
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: hub, encoding: 'utf8' }), '', 'the hub is untouched')

    // A snapshot next to the plan is not in scope unless named with --also.
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: target })
    const stray = await runRefine(hub, ['../target/specs/foo'], { FAKE_STRAY: 'specs/foo/SNAPSHOT.md' })
    assert.equal(stray.code, 1, stray.output)
    assert.match(stray.output, /改动了范围以外的文件：specs\/foo\/SNAPSHOT\.md/u)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('end to end: a placeholder refines its target spec', unix, async () => {
  const { parent, hub, target } = fakeRepos()
  try {
    mkdirSync(join(hub, 'specs/36-target'), { recursive: true })
    writeFileSync(join(hub, 'specs/36-target/plan.md'), '# M36：占位\n\n<!-- milestone-repo: ../target -->\n<!-- milestone-spec: specs/foo -->\n')
    const { code, output } = await runRefine(hub, ['specs/36-target'])
    assert.equal(code, 0, output)
    assert.match(output, /（\.\.\/target\/specs\/foo，占位 specs\/36-target）/u)
    assert.ok(existsSync(join(target, 'specs/foo/refine-report.md')))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
