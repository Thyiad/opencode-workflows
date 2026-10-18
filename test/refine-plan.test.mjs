import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EXIT_CODES, acceptanceCheck, auditRun, baselineDiff, batchMail, blockingIssueIds, changedPaths, checkRound, claudeReportSection, collectDecisions, diffStat,
  displaySpec, documentsInScope, fenced, finishRun, fixPrompt, followUpPrompt, locate, mailFor,
  outcomeOf, outsideScope, parseArgs, parseVerdict, pendingKind, readRounds, refinableSpecs, refineCommand, refineSpec, renderReport, repoPath, resultsRecord, runDirsSince,
  reviewedRecord, section, startRun, worstResult, worktreeSnapshot,
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

test('arguments: a batch selects several specs with --only, --from and --to', () => {
  const batch = parseArgs(['--only', '35,36', '--max-rounds', '3'])
  assert.equal(batch.spec, null, 'a batch takes no milestone directory')
  assert.equal(batch.only, '35,36')
  assert.equal(batch.maxRounds, 3)
  assert.equal(parseArgs(['--from', '35', '--to', '37']).from, '35')
  assert.equal(parseArgs(['--only', '35-37,40']).only, '35-37,40')
  assert.throws(() => parseArgs(['--only', '35', 'specs/36-foo']), /不要再给里程碑目录/u)
  assert.throws(() => parseArgs(['--only', '35', '--start']), /不能和 --start\/--check\/--finish/u)
  assert.throws(() => parseArgs(['--only', '35', '--finish', 'r']), /不能和 --start\/--check\/--finish/u)
  assert.throws(() => parseArgs(['--from', '3']), /两位或以上/u)
  assert.throws(() => parseArgs(['--only', 'foo']), /两位或以上/u)
  assert.throws(() => parseArgs(['--from', '37', '--to', '35']), /不能大于/u)
  assert.equal(parseArgs(['--only', '35', '--dry-run']).dryRun, true)
})

test('a batch lists numbered specs in order, skips implemented ones and needs plan.md', () => {
  const dir = tempRepo()
  try {
    for (const name of ['35-foo', '36-bar', '37-done']) {
      mkdirSync(join(dir, 'specs', name), { recursive: true })
      writeFileSync(join(dir, 'specs', name, 'plan.md'), PLAN)
    }
    writeFileSync(join(dir, 'specs/37-done/STATUS'), 'APPROVED\n')
    mkdirSync(join(dir, 'specs/38-empty'), { recursive: true })
    const picked = refinableSpecs({ only: '35-37', from: null, to: null }, join(dir, 'specs'))
    assert.deepEqual(picked.specs.map(item => item.rel), ['specs/35-foo', 'specs/36-bar'])
    assert.deepEqual(picked.skipped, ['specs/37-done'])
    assert.deepEqual(refinableSpecs({ only: null, from: '35', to: '36' }, join(dir, 'specs')).specs.map(item => item.rel), ['specs/35-foo', 'specs/36-bar'])
    assert.throws(() => refinableSpecs({ only: '38', from: null, to: null }, join(dir, 'specs')), /找不到 specs\/38-empty\/plan\.md/u)
    assert.deepEqual(refinableSpecs({ only: '35', from: null, to: null }, join(dir, 'no-specs')), { specs: [], skipped: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repository paths stay inside the repository', () => {
  assert.equal(repoPath('specs/35-foo/', '/repo'), 'specs/35-foo')
  assert.equal(repoPath('/repo/docs/A.md', '/repo'), 'docs/A.md')
  assert.equal(repoPath('../other', '/repo'), null)
  assert.equal(repoPath('.', '/repo'), null)
})

test('the batch mail sums the outcomes, the decisions and the time', () => {
  const mail = batchMail([
    { shown: 'specs/35-foo', result: 'approved', outcome: '第 2 轮评审通过', problems: [], reportFile: 'specs/35-foo/refine-report.md', durationMs: 65_000, decisions: [] },
    { shown: 'specs/36-bar', result: 'failed', outcome: '运行检查未通过', problems: ['改动了范围以外的文件：code.js'], reportFile: 'specs/36-bar/refine-report.md', durationMs: 55_000, decisions: [{ source: 'x', text: 'y' }] },
  ], '[REPO]')
  assert.match(mail.subject, /^\[REPO\] ❌ plan 评审 2 个：通过 1、失败 1$/u)
  assert.match(mail.text, /总用时：2 分 0 秒/u)
  assert.match(mail.text, /需要你决定的问题：1 个/u)
  assert.match(mail.text, /✅ specs\/35-foo：第 2 轮评审通过[\s\S]*改动说明：specs\/35-foo\/refine-report\.md/u)
  assert.match(mail.text, /❌ specs\/36-bar：运行检查未通过[\s\S]*改动了范围以外的文件：code\.js/u)
  assert.match(batchMail([{ shown: 'specs/x', result: 'unresolved', outcome: '达到 5 轮上限', problems: [], reportFile: null, durationMs: 1000, decisions: [] }], '').subject,
    /^⚠️ plan 评审 1 个：未解决 1$/u)
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

test('record selection excludes previous runs in the same second but keeps every new start', () => {
  const { dir, runDir } = startedRepo()
  try {
    const since = new Date('2026-10-05T01:00:00Z')
    const previousNames = new Set([basename(runDir)])
    const start = milliseconds => startRun({ spec: 'specs/35-foo', documents: ['specs/35-foo/plan.md'], title: 'M99：示例',
      models: MODELS, maxRounds: 2, cwd: dir, now: new Date(since.getTime() + milliseconds) })
    const second = start(250)
    assert.deepEqual(runDirsSince('specs/35-foo', since, dir, previousNames), [second])
    const third = start(500)
    assert.deepEqual(runDirsSince('specs/35-foo', since, dir, previousNames), [third, second])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
    const report = readFileSync(join(dir, result.reportFile), 'utf8')
    assert.match(report, /## 运行检查发现的问题/u)
    assert.equal(reviewedRecord(report), null, 'no approved version to record')
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
    // The approved version and the decision gate, for refine-and-run to tell a later edit from it.
    const documents = { 'specs/35-foo/plan.md': createHash('sha1').update(PLAN).digest('hex') }
    assert.deepEqual(reviewedRecord(report), { documents, decisions: 1, accepted: false })
    finishRun(runDir, { cwd: dir, acceptDecisions: true })
    assert.deepEqual(reviewedRecord(readFileSync(join(dir, result.reportFile), 'utf8')), { documents, decisions: 1, accepted: true })
    assert.equal(reviewedRecord('<!-- refine-plan reviewed: {"specs/35-foo/plan.md":"a"} -->'), null, 'an incomplete record counts for nothing')
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
    const fixedByClaude = require('node:fs').readFileSync(spec + '/plan.md', 'utf8').includes('CLAUDE FIXED')
    const approve = fixedByClaude ? n === 1 : !env.FAKE_LIMIT && !env.FAKE_OVER && n === 2
    const verdict = env.FAKE_BAD_VERDICT ? 'LGTM' : approve ? 'APPROVED' : 'CHANGES_REQUESTED'
    writeFileSync(run + '/round-' + n + '-review.md', verdict + '\\n\\n## 阻塞问题\\n\\n### R' + n + '-1：缺少说明\\n' + (approve ? '\\n## 非阻塞建议\\n\\n- 可以再短一点\\n' : ''))
    if (env.FAKE_FALLBACK) writeFileSync(run + '/round-' + n + '-reviewer', 'plan-reviewer-fallback\\n')
    if (approve && env.FAKE_EDIT_AFTER) appendFileSync(spec + '/plan.md', '\\n审过之后又改\\n')
    if (approve || env.FAKE_BAD_VERDICT || (n === max && !env.FAKE_OVER)) break
    if (env.FAKE_CRASH) process.exit(2)
    appendFileSync(spec + '/plan.md', '\\nFIXED ' + n + '\\n')
    if (env.FAKE_EDIT_ALSO === spec) appendFileSync('docs/API.md', 'edited for ' + spec + '\\n')
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
      cwd: dir, env: { ...process.env, OPENCODE_BIN: join(dir, 'fake-opencode'), FAKE_REFINE_PLAN: REFINE_PLAN, CLAUDE_BIN: join(dir, 'no-claude'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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

test('end to end: --only reviews several plans one after another', unix, () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'specs/36-bar'))
  writeFileSync(join(dir, 'specs/36-bar/plan.md'), PLAN.replace('# M99：示例', '# M99：另一个'))
  // Both plans must be tracked before the run to distinguish edits from new reports.
  execFileSync('git', ['add', 'specs/36-bar/plan.md'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'add second plan'], { cwd: dir })
  const { code, output } = await runRefine(dir, ['--only', '35,36'])
  assert.equal(code, 0, output)
  assert.match(output, /批量评审 2 个规格/u)
  assert.match(output, /✅ plan 评审 2 个：通过 2/u)
  for (const spec of ['35-foo', '36-bar']) {
    assert.match(readFileSync(join(dir, 'specs', spec, 'plan.md'), 'utf8'), /FIXED 1/u, spec)
    assert.match(readFileSync(join(dir, 'specs', spec, 'refine-report.md'), 'utf8'), /第 2 轮评审通过/u, spec)
  }
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  assert.deepEqual(status, [
    ' M specs/35-foo/plan.md', ' M specs/36-bar/plan.md',
    '?? specs/35-foo/refine-report.md', '?? specs/36-bar/refine-report.md',
  ], 'each plan edited, each report written, nothing else touched')
}))

test('end to end: a batch skips an already implemented spec', unix, () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'specs/36-done'))
  writeFileSync(join(dir, 'specs/36-done/plan.md'), PLAN)
  writeFileSync(join(dir, 'specs/36-done/STATUS'), 'APPROVED\n')
  const { code, output } = await runRefine(dir, ['--only', '35,36'])
  assert.equal(code, 0, output)
  assert.match(output, /已实现，跳过：specs\/36-done/u)
  // One spec is left: the mail is the plain single-run one, not a batch summary.
  assert.match(output, /✅ plan 评审 M99：示例：第 2 轮评审通过/u)
  assert.doesNotMatch(output, /批量评审/u)
  assert.ok(existsSync(join(dir, 'specs/35-foo/refine-report.md')))
  assert.ok(!existsSync(join(dir, 'specs/36-done/refine-report.md')))
}))

test('end to end: a batch reports every failure and exits 1', unix, () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'specs/36-bar'))
  writeFileSync(join(dir, 'specs/36-bar/plan.md'), PLAN)
  const { code, output } = await runRefine(dir, ['--only', '35,36'], { FAKE_STRAY: 'code.js' })
  assert.equal(code, 1, output)
  assert.match(output, /❌ plan 评审 2 个：失败 2/u)
  for (const spec of ['35-foo', '36-bar']) {
    assert.match(readFileSync(join(dir, 'specs', spec, 'refine-report.md'), 'utf8'), /改动了范围以外的文件/u, spec)
  }
}))

test('end to end: a batch --dry-run lists the plans without running opencode', () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'specs/36-bar'))
  writeFileSync(join(dir, 'specs/36-bar/plan.md'), PLAN)
  const { code, output } = await runRefine(dir, ['--only', '35,36', '--dry-run'])
  assert.equal(code, 0, output)
  assert.match(output, /批量评审 2 个规格/u)
  assert.match(output, /规格：M99：示例（specs\/35-foo）/u)
  assert.match(output, /规格：M99：示例（specs\/36-bar）/u)
  assert.ok(!existsSync(join(dir, 'specs/35-foo/refine-report.md')))
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

// ---- Claude after a run that needs the user ---------------------------------

test('arguments: Claude rounds, handover, decisions, mail and the continue command', () => {
  const defaults = parseArgs(['specs/35-foo'])
  assert.equal(defaults.fixRounds, 1)
  assert.equal(defaults.claudeTimeoutMinutes, 60)
  assert.equal(defaults.handover, true)
  assert.equal(defaults.acceptDecisions, false)
  assert.equal(defaults.successMail, true)
  assert.equal(defaults.continueCommand, null)
  const set = parseArgs(['specs/35-foo', '--fix-rounds', '0', '--claude-timeout-minutes', '5', '--no-handover', '--accept-decisions',
    '--no-success-mail', '--continue-command', 'refine-and-run --only 35'])
  assert.deepEqual([set.fixRounds, set.claudeTimeoutMinutes, set.handover, set.acceptDecisions, set.successMail, set.continueCommand],
    [0, 5, false, true, false, 'refine-and-run --only 35'])
  assert.throws(() => parseArgs(['specs/35-foo', '--fix-rounds', '-1']), /需要一个值|非负整数/u)
  assert.throws(() => parseArgs(['specs/35-foo', '--fix-rounds', '1.5']), /非负整数/u)
  assert.equal(refineCommand(parseArgs(['specs/35-foo']), 'specs/35-foo'), 'refine-plan specs/35-foo')
  assert.equal(refineCommand(parseArgs(['specs/35-foo', '--max-rounds', '3', '--also', 'docs/A.md']), 'specs/35-foo'),
    'refine-plan specs/35-foo --max-rounds 3 --also docs/A.md')
})

test('what still needs the user: failures, unresolved issues, and decisions unless accepted', () => {
  const decisions = [{ source: '第 1 轮评审', text: '### R1-2：要不要保留旧接口' }]
  assert.equal(pendingKind({ result: 'approved', decisions: [] }), null)
  assert.equal(pendingKind({ result: 'approved', decisions }), 'decisions')
  assert.equal(pendingKind({ result: 'approved', decisions }, true), null)
  assert.equal(pendingKind({ result: 'unresolved', decisions: [] }, true), 'unresolved')
  assert.equal(pendingKind({ result: 'failed', decisions: [] }), 'failed')
  assert.equal(worstResult([{ result: 'approved' }, { result: 'decisions' }]), 'decisions')
  assert.equal(worstResult([{ result: 'decisions' }, { result: 'unresolved' }]), 'unresolved')
  assert.equal(worstResult([{ result: 'unresolved' }, { result: 'failed' }]), 'failed')
  assert.deepEqual(EXIT_CODES, { approved: 0, decisions: 4, unresolved: 3, failed: 1 })
})

const runResult = (result, extra = {}) => ({
  repo: '/repo', spec: 'specs/35-foo', shown: 'specs/35-foo', title: 'M35：示例', result, outcome: `结论-${result}`, problems: [],
  reportFile: 'specs/35-foo/refine-report.md', runDir: `.plan-refine-logs/35-foo-${result}`, logFile: '.plan-refine-logs/35-foo.runner.log',
  durationMs: 60_000, rounds: [{ round: 1 }], decisions: [], paths: { logFile: '/repo/log', runDir: '/repo/run', reportFile: '/repo/specs/35-foo/refine-report.md' },
  ...extra,
})
const fixDecision = (next, extra = {}) => ({
  next, rootCause: `根因-${next}`, summary: `经过-${next}`, actionsTaken: [`做了-${next}`],
  userActions: next === 'give-up' ? ['R1-2：保留旧接口（兼容老客户端）还是删掉（少维护一套）；推荐删掉'] : [], ...extra,
})

// refineSpec with fakes: the runs and Claude's answers come from queues; an
// answer's `stray` lists the files it changed outside the documents in scope.
function refineWorld({ runs, answers = [], claudeProblem = null }) {
  const calls = { runs: 0, claude: [], log: '' }
  let clock = 0
  let stray = []
  const deps = {
    claudeProblem, label: 'M35',
    refineOnce: async () => {
      calls.runs += 1
      const next = runs.shift()
      assert.ok(next, 'unexpected refine run')
      return next
    },
    context: result => ({
      title: result.title, spec: result.spec, repo: result.repo, documents: ['specs/35-foo/plan.md'], outcome: result.outcome, problems: result.problems,
      reportFile: result.paths.reportFile, runDir: result.paths.runDir, logFile: result.paths.logFile,
      continueCommand: 'refine-and-run --only 35', rerunCommand: 'refine-plan specs/35-foo', machineNotes: ['Docker 有时要重启'],
    }),
    runClaude: async request => {
      calls.claude.push(request)
      const answer = answers.shift()
      assert.ok(answer, 'unexpected Claude call')
      stray = answer.stray ?? []
      return { started: true, logFile: '/repo/.plan-refine-logs/claude-35-foo.log', sessionId: request.sessionId, ...answer }
    },
    snapshot: () => stray.length,
    stray: (before, after) => (after > before ? stray : []),
    uuid: () => 'session-1',
    now: () => (clock += 60_000),
    log: text => { calls.log += text },
  }
  return { deps, calls }
}
const refineOptions = (...extra) => parseArgs(['specs/35-foo', ...extra])

test('a clean approval needs no Claude', async () => {
  const { deps, calls } = refineWorld({ runs: [runResult('approved')] })
  const result = await refineSpec(refineOptions(), deps)
  assert.equal(result.result, 'approved')
  assert.equal(calls.claude.length, 0)
  assert.deepEqual(result.claudeRounds, [])
  assert.equal(result.session, null)
})

test('unresolved issues: Claude fixes the plan, the review runs again and approves', async () => {
  const { deps, calls } = refineWorld({ runs: [runResult('unresolved'), runResult('approved')], answers: [{ decision: fixDecision('rerun') }] })
  const result = await refineSpec(refineOptions(), deps)
  assert.equal(result.result, 'approved')
  assert.equal(calls.runs, 2)
  const [request] = calls.claude
  assert.equal(request.resume, false)
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.name, 'M35 plan 自动处理')
  assert.match(request.prompt, /# Unattended plan review follow-up: M35：示例/u)
  assert.match(request.prompt, /The round limit was reached with blocking issues left/u)
  assert.match(request.prompt, /refine-plan's verdict: `结论-unresolved`/u)
  assert.match(request.prompt, /the only files anyone may change: `specs\/35-foo\/plan\.md`/u)
  assert.match(request.prompt, /tell them to run `refine-and-run --only 35`/u)
  assert.match(request.prompt, /- Docker 有时要重启/u)
  assert.deepEqual(result.earlierRuns, ['.plan-refine-logs/35-foo-unresolved'])
  assert.equal(result.claudeRounds.length, 1)
  assert.equal(result.claudeRounds[0].decision.next, 'rerun')
  const mail = mailFor({ ...result, spec: result.shown })
  assert.match(mail.subject, /^✅ plan 评审 M35：示例：结论-approved（Claude 处理后）$/u)
  assert.match(mail.text, /Claude 处理了什么：\n {2}第 1 轮 · rerun（重新评审）/u)
  assert.doesNotMatch(mail.text, /你需要做的/u)
  const section = claudeReportSection(result.claudeRounds, result.earlierRuns)
  assert.match(section, /## 无人值守 Claude 的处理/u)
  assert.match(section, /`\.plan-refine-logs\/35-foo-unresolved`/u)
  assert.match(section, /根因：根因-rerun/u)
})

test('a decision Claude cannot make: it gives up, and the mail carries its analysis and the session', async () => {
  const decisions = [{ source: '第 1 轮评审', text: '### R1-2：要不要保留旧接口' }]
  const { deps, calls } = refineWorld({ runs: [runResult('approved', { decisions })], answers: [{ decision: fixDecision('give-up') }] })
  const result = await refineSpec(refineOptions(), deps)
  assert.equal(result.result, 'decisions')
  assert.equal(result.outcome, '结论-approved，1 个问题需要你决定')
  assert.equal(calls.runs, 1)
  assert.match(calls.claude[0].prompt, /items are marked 需人工决定/u)
  assert.match(calls.claude[0].prompt, /Never make such a decision yourself/u)
  assert.deepEqual(result.session, { id: 'session-1', title: 'M35 plan 待处理', started: true })
  const mail = mailFor({ ...result, spec: result.shown, continueCommand: 'refine-and-run --only 35', handedOver: true })
  assert.match(mail.subject, /^❓ plan 评审 M35：示例：结论-approved，1 个问题需要你决定$/u)
  assert.match(mail.text, /根因：根因-give-up\n你需要做的：\n {2}1\. R1-2：保留旧接口/u)
  assert.match(mail.text, /Claude 已经做了：\n {2}第 1 轮 · give-up（交给你）/u)
  assert.match(mail.text, /接管 Claude 会话（会话 ID session-1）[\s\S]*电脑上已经用 Remote Control 打开了这个会话/u)
  assert.match(mail.text, /处理好后继续：refine-and-run --only 35/u)
})

test('--accept-decisions: an approval with decisions is done, without Claude', async () => {
  const decisions = [{ source: '第 1 轮评审', text: '### R1-2：要不要保留旧接口' }]
  const { deps, calls } = refineWorld({ runs: [runResult('approved', { decisions })] })
  const result = await refineSpec(refineOptions('--accept-decisions'), deps)
  assert.equal(result.result, 'approved')
  assert.equal(calls.claude.length, 0)
})

test('the round limit of Claude: a second failure after a rerun is the user\'s', async () => {
  const { deps, calls } = refineWorld({ runs: [runResult('failed'), runResult('failed')], answers: [{ decision: fixDecision('rerun') }] })
  const result = await refineSpec(refineOptions(), deps)
  assert.equal(result.result, 'failed')
  assert.equal(calls.claude.length, 1)
  assert.equal(result.stopReason, 'Claude 处理 1 轮后仍然需要你处理。')
  assert.equal(result.session.id, 'session-1')
})

test('a second round resumes the session with the new failure', async () => {
  const { deps, calls } = refineWorld({
    runs: [runResult('failed'), runResult('unresolved'), runResult('approved')],
    answers: [{ decision: fixDecision('rerun') }, { decision: fixDecision('rerun') }],
  })
  const result = await refineSpec(refineOptions('--fix-rounds', '2'), deps)
  assert.equal(result.result, 'approved')
  assert.equal(calls.claude[1].resume, true)
  assert.match(calls.claude[1].prompt, /# Round 2 of 2: the re-run did not end cleanly either/u)
  assert.match(calls.claude[1].prompt, /ran `refine-plan specs\/35-foo`/u)
  assert.match(calls.claude[1].prompt, /blocking issues left/u)
  assert.deepEqual(result.earlierRuns, ['.plan-refine-logs/35-foo-failed', '.plan-refine-logs/35-foo-unresolved'])
})

test('Claude changing files outside the documents stops the run before another review', async () => {
  const { deps, calls } = refineWorld({ runs: [runResult('unresolved')], answers: [{ decision: fixDecision('rerun'), stray: ['code.js'] }] })
  const result = await refineSpec(refineOptions(), deps)
  assert.equal(calls.runs, 1)
  assert.equal(result.result, 'unresolved')
  assert.equal(result.stopReason, 'Claude 改动了范围以外的文件：code.js，没有重新评审。')
})

test('no Claude: --fix-rounds 0, or Claude not usable, or no usable answer', async () => {
  let world = refineWorld({ runs: [runResult('unresolved')] })
  let result = await refineSpec(refineOptions('--fix-rounds', '0'), world.deps)
  assert.equal(result.result, 'unresolved')
  assert.equal(result.stopReason, null)
  world = refineWorld({ runs: [runResult('unresolved')], claudeProblem: 'Claude Code 没有登录' })
  result = await refineSpec(refineOptions(), world.deps)
  assert.equal(result.stopReason, '没有让 Claude 处理：Claude Code 没有登录')
  assert.equal(result.session, null)
  world = refineWorld({ runs: [runResult('unresolved')], answers: [{ error: 'Claude 以 error_max_turns 结束：' }] })
  result = await refineSpec(refineOptions(), world.deps)
  assert.equal(result.stopReason, 'Claude 没有给出可用的结论：Claude 以 error_max_turns 结束：')
  assert.match(mailFor({ ...result, spec: result.shown }).text, /错误：Claude 以 error_max_turns 结束/u)
})

test('the prompts describe a run that never got to a review', () => {
  const context = {
    title: 'M35：示例', spec: 'specs/35-foo', repo: '/repo', documents: ['specs/35-foo/plan.md', 'docs/API.md'], kind: 'failed',
    outcome: '运行没有正常完成，没有评审记录', problems: ['没有执行 --start，找不到这次的记录目录'], reportFile: null, runDir: null, logFile: '/repo/log',
    round: 1, maxRounds: 1, continueCommand: 'refine-plan specs/35-foo', rerunCommand: 'refine-plan specs/35-foo',
  }
  const prompt = fixPrompt(context)
  assert.match(prompt, /`specs\/35-foo\/plan\.md`, `docs\/API\.md`/u)
  assert.match(prompt, /- 没有执行 --start/u)
  assert.match(prompt, /No report was written/u)
  assert.match(prompt, /No record directory/u)
  assert.doesNotMatch(prompt, /Known facts about this machine/u)
  assert.match(followUpPrompt({ ...context, round: 2, maxRounds: 2 }), /Round 2 of 2/u)
})

test('the batch mail counts decisions and names each session to take over', () => {
  const mail = batchMail([
    { shown: 'specs/35-foo', repo: '/repo', result: 'approved', outcome: '第 1 轮评审通过', problems: [], reportFile: null, durationMs: 1000, decisions: [] },
    {
      shown: 'specs/36-bar', repo: '/repo', result: 'decisions', outcome: '第 2 轮评审通过，1 个问题需要你决定', problems: [], reportFile: null, durationMs: 1000,
      decisions: [{ source: 'x', text: 'R2-1' }], claudeRounds: [{ decision: fixDecision('give-up') }], session: { id: 'session-2', title: 'M36 plan 待处理' },
    },
  ], '')
  assert.match(mail.subject, /^❓ plan 评审 2 个：通过 1、待决定 1$/u)
  assert.match(mail.text, /❓ specs\/36-bar：[\s\S]*Claude 处理 1 轮：根因-give-up[\s\S]*→ R1-2：保留旧接口[\s\S]*claude --resume session-2 --remote-control "M36 plan 待处理"/u)
})

// A stand-in for `claude` (version, login and one -p round): FAKE_CLAUDE says
// what the round does to the plan named in the prompt and what it answers.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0) }
if (args[0] === 'auth') process.exit(0)
let prompt = ''
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
  const plan = /- Plan: \\x60([^\\x60]+)\\x60/.exec(prompt)[1]
  const mode = process.env.FAKE_CLAUDE
  if (mode === 'fix') appendFileSync(plan, '\\nCLAUDE FIXED\\n')
  if (mode === 'stray') appendFileSync('code.js', 'stray\\n')
  const next = mode === 'give-up' ? 'give-up' : 'rerun'
  const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1]
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, structured_output: {
    next, rootCause: '评审轮次用完', summary: '补了缺少的说明', actionsTaken: ['在 plan.md 补了说明'], userActions: next === 'give-up' ? ['决定要不要保留旧接口'] : [],
  } }))
})
`

function withFakeClaude(dir) {
  writeFileSync(join(dir, 'fake-claude'), FAKE_CLAUDE)
  chmodSync(join(dir, 'fake-claude'), 0o755)
  return join(dir, 'fake-claude')
}

test('end to end: Claude fixes an unresolved plan and the second review approves it', unix, () => withFakeRepo(async dir => {
  const claude = withFakeClaude(dir)
  const { code, output } = await runRefine(dir, ['specs/35-foo', '--max-rounds', '2'], { FAKE_LIMIT: '1', CLAUDE_BIN: claude, FAKE_CLAUDE: 'fix' })
  assert.equal(code, 0, output)
  assert.match(output, /交给 Claude（第 1\/1 轮/u)
  assert.match(output, /✅ plan 评审 M99：示例：第 1 轮评审通过（Claude 处理后）/u)
  assert.match(readFileSync(join(dir, 'specs/35-foo/plan.md'), 'utf8'), /FIXED 1[\s\S]*CLAUDE FIXED/u)
  assert.match(report(dir), /## 无人值守 Claude 的处理[\s\S]*根因：评审轮次用完/u)
  const logs = readdirSync(join(dir, '.plan-refine-logs'))
  assert.equal(logs.filter(name => !name.endsWith('.log')).length, 2, 'two record directories')
  assert.ok(logs.some(name => name.startsWith('claude-35-foo-')), 'the Claude round is logged')
}))

test('end to end: Claude gives up, the run exits 3 and names the session', unix, () => withFakeRepo(async dir => {
  const claude = withFakeClaude(dir)
  const { code, output } = await runRefine(dir, ['specs/35-foo', '--max-rounds', '2'], { FAKE_LIMIT: '1', CLAUDE_BIN: claude, FAKE_CLAUDE: 'give-up' })
  assert.equal(code, 3, output)
  assert.match(output, /你需要做的：\n {2}1\. 决定要不要保留旧接口/u)
  assert.match(output, /claude --resume [0-9a-f-]{36} --remote-control "M35 plan 待处理"/u)
  assert.match(output, /处理好后继续：refine-plan specs\/35-foo --max-rounds 2/u)
}))

test('end to end: Claude touching code stops before another review', unix, () => withFakeRepo(async dir => {
  const claude = withFakeClaude(dir)
  const { code, output } = await runRefine(dir, ['specs/35-foo', '--max-rounds', '2'], { FAKE_LIMIT: '1', CLAUDE_BIN: claude, FAKE_CLAUDE: 'stray' })
  assert.equal(code, 3, output)
  assert.match(output, /Claude 改动了范围以外的文件：code\.js/u)
}))

test('the results record: each spec\'s result and the hashes of what was reviewed', () => {
  assert.equal(parseArgs(['specs/35-foo', '--results-file', 'out.json']).resultsFile, resolve('out.json'))
  const hashes = { 'specs/35-foo/plan.md': 'a', 'docs/A.md': 'b', 'specs/35-foo/refine-report.md': 'c' }
  const record = resultsRecord([
    { label: 'specs/35-foo', repo: '/repo', spec: 'specs/35-foo', result: 'approved', hashes, outcome: 'not in the record' },
    { label: 'specs/36-bar', result: 'failed' },
  ])
  assert.deepEqual(record, [
    { label: 'specs/35-foo', repo: '/repo', spec: 'specs/35-foo', result: 'approved', hashes },
    { label: 'specs/36-bar', repo: null, spec: null, result: 'failed', hashes: {} },
  ])
})

test('end to end: each spec\'s hashes are its own review\'s, even when a later review edits a shared document', unix, () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs/API.md'), '# API\n')
  mkdirSync(join(dir, 'specs/36-bar'))
  writeFileSync(join(dir, 'specs/36-bar/plan.md'), PLAN)
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'add docs and a second plan'], { cwd: dir })
  const file = join(dir, 'results.json')
  const { code, output } = await runRefine(dir, ['--only', '35,36', '--also', 'docs/API.md', '--results-file', file], { FAKE_EDIT_ALSO: 'specs/36-bar' })
  assert.equal(code, 0, output)
  const [first, second] = JSON.parse(readFileSync(file, 'utf8'))
  const sha = text => createHash('sha1').update(text).digest('hex')
  assert.equal(first.hashes['docs/API.md'], sha('# API\n'), 'M35 was approved with the original document')
  assert.equal(second.hashes['docs/API.md'], sha(readFileSync(join(dir, 'docs/API.md'))), 'M36 with its own edit')
  assert.notEqual(first.hashes['docs/API.md'], second.hashes['docs/API.md'])
}))

test('end to end: a batch writes its results file, with no mail when all pass under --no-success-mail', unix, () => withFakeRepo(async dir => {
  mkdirSync(join(dir, 'specs/36-bar'))
  writeFileSync(join(dir, 'specs/36-bar/plan.md'), PLAN)
  const file = join(dir, 'results.json')
  const { code, output } = await runRefine(dir, ['--only', '35,36', '--no-success-mail', '--results-file', file])
  assert.equal(code, 0, output)
  assert.match(output, /全部通过，按 --no-success-mail 不发邮件/u)
  const records = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(records.map(item => [item.label, item.result]), [['specs/35-foo', 'approved'], ['specs/36-bar', 'approved']])
  assert.equal(records[0].hashes['specs/35-foo/plan.md'], createHash('sha1').update(readFileSync(join(dir, 'specs/35-foo/plan.md'))).digest('hex'))
  assert.ok(records[0].hashes['specs/35-foo/refine-report.md'])
}))

test('end to end: without a usable claude the run says so and mails as before', unix, () => withFakeRepo(async dir => {
  const { code, output } = await runRefine(dir, ['specs/35-foo', '--max-rounds', '2'], { FAKE_LIMIT: '1' })
  assert.equal(code, 3, output)
  assert.match(output, /没有让 Claude 处理：/u)
}))
