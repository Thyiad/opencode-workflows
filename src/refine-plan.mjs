#!/usr/bin/env node
// Refines a draft milestone plan before it is implemented, unattended, by
// running the opencode `/refine-plan` command (.opencode/commands/refine-plan.md)
// the way run-milestones.mjs runs implement-plan. opencode does the work: the
// plan-editor agent (DeepSeek) calls the plan-reviewer subagent (GPT), revises
// the plan, and repeats until the reviewer approves or the round limit is
// reached. This script only orchestrates and guards:
//
//   1. check the milestone, the agents and opencode before anything starts
//   2. run `/refine-plan <milestone> <max-rounds>` in a fresh
//      `opencode run --standalone` session, with the watchdog, the timeout and
//      Ctrl+C handling of run-milestones.mjs
//   3. afterwards, do not trust the agent: no file outside the documents in
//      scope may have changed, every round must have a review with a verdict,
//      and the rounds must stay within the limit
//   4. regenerate <milestone>/refine-report.md from the records, so the
//      rounds, the unresolved issues and the full diff are the runner's own
//   5. send an email (notify-mail.mjs settings, when present)
//
// Nothing is committed: review the diff and refine-report.md, then commit.
//
//   refine-plan specs/35-foo                    # up to 5 review rounds
//   refine-plan specs/35-foo --max-rounds 3
//   refine-plan specs/35-foo --also docs/BUSINESS-API.md   # the editor may change it too
//   refine-plan specs/35-foo --dry-run          # show scope, models and checks
//   refine-plan ../OPOC/specs/oauth-foo         # a plan in another repository
//   refine-plan specs/25-opoc-oauth-provider    # a cross-repository placeholder: its target
//
// The documents in scope are the plan.md and the --also files (paths in the
// plan's repository). Other files next to the plan, such as a contract
// snapshot, stay read-only unless named with --also.
//
// The plan's repository is found with git (it need not be the current one),
// opencode runs there with that repository's own .opencode (its /refine-plan
// command calls this command's steps, `refine-plan --start` and so on), and the
// records go to that repository's .plan-refine-logs/. Paths on the command line
// are relative to the current directory.
//
// In the opencode TUI the same command runs interactively: `/refine-plan specs/35-foo 3`.
//
// The command itself calls three steps of this script, so the records and the
// report are the same however it was started:
//   --start <milestone>   copy the documents in scope as the baseline into a new
//                         record directory .plan-refine-logs/<milestone>-<time>/
//   --check <record dir>  before each review: record the hashes of the documents
//                         it will see, and parse the `## 验收命令` block the way
//                         run-milestones.mjs does
//   --finish <record dir> check the run (scope since --start, rounds, verdicts,
//                         approval of the current documents) and write
//                         <milestone>/refine-report.md from the records
//
// Exit code: 0 approved, 3 finished with blocking issues left, 1 anything else.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, loadConfig, repoRootOf } from './config.mjs'
import { DEFAULT_CONFIG_FILE, loadMailConfig, sendMail } from './notify-mail.mjs'
import {
  MIN_OPENCODE_VERSION, acceptanceCommands, crossRepoTarget, expandCommand, formatDuration, installInterruptHandler, milestoneTitle,
  opencodeVersionSupported, processTable, run, splitFrontmatter, windowsShellCommand,
} from './run-milestones.mjs'

// The current directory's repository: paths are shown relative to it.
const root = repoRootOf()
const LOGS = '.plan-refine-logs'
export const REPORT_FILE = 'refine-report.md'
// Never part of the documents in scope: the milestone runner's marker and the report.
const NOT_DOCUMENTS = new Set(['STATUS', REPORT_FILE])
// Where plan-editor may write (its edit permission says the same): documents
// in scope must lie in the first two, the records go to the last.
export const EDITABLE = ['specs', 'docs', LOGS]
const COMMAND = 'refine-plan'
const REVIEWER = 'plan-reviewer'
const FALLBACK_REVIEWER = 'plan-reviewer-fallback'

const USAGE = `用法：refine-plan <规格目录> [选项]

  例：refine-plan specs/35-foo --max-rounds 3
      refine-plan ../OPOC/specs/01-foo      （其他仓库的 plan）

选项：
  --max-rounds <n>              最多评审几轮（含最后一轮），默认 5
  --also <文件>[,<文件>]        另外允许修改的文档（相对 plan 所在仓库），可重复；默认只改 plan.md
  --agent-timeout-hours <n>     opencode 运行的超时，默认 6
  --stall-minutes <n>           看门狗：多少分钟没有进展算卡住，默认 10
  --stall-cpu-seconds <n>       看门狗：这段时间内 CPU 增长低于多少秒算没有进展，默认 10
  --notify-config <文件>        邮件配置，默认 ~/.opencode-workflows/notify.env（不存在就不发邮件）
  --dry-run                     只显示范围、模型和检查结果
  -h, --help                    显示本说明

/refine-plan 命令自己调用的分步模式：
  --start <里程碑目录>          保存评审前的原文，建立记录目录（可带 --also、--max-rounds）
  --check <记录目录>            每轮评审前：记录文档版本，并检查「## 验收命令」能否被里程碑脚本解析
  --finish <记录目录>           根据记录目录里的各轮记录生成 refine-report.md`

export function parseArgs(argv) {
  const options = { spec: null, maxRounds: 5, also: [], dryRun: false, help: false, start: false, check: null, finish: null,
    agentTimeoutHours: 6, stallMinutes: 10, stallCpuSeconds: 10, notifyConfig: DEFAULT_CONFIG_FILE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return next
    }
    if (arg === '--max-rounds') options.maxRounds = Number(value())
    else if (arg === '--also') options.also.push(...value().split(',').map(item => item.trim()).filter(Boolean))
    else if (arg === '--agent-timeout-hours') options.agentTimeoutHours = Number(value())
    else if (arg === '--stall-minutes') options.stallMinutes = Number(value())
    else if (arg === '--stall-cpu-seconds') options.stallCpuSeconds = Number(value())
    else if (arg === '--notify-config') options.notifyConfig = resolve(value())
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--start') options.start = true
    else if (arg === '--check') options.check = value()
    else if (arg === '--finish') options.finish = value()
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
    else if (options.spec === null) options.spec = arg
    else throw new Error(`只能给一个里程碑目录（多出：${arg}）`)
  }
  if (options.help) return options
  if ([options.start, options.check !== null, options.finish !== null, options.dryRun].filter(Boolean).length > 1) {
    throw new Error('--start、--check、--finish、--dry-run 只能用一个')
  }
  if (options.finish !== null || options.check !== null) {
    if (options.spec !== null) throw new Error('--check 和 --finish 只需要记录目录，不要再给里程碑目录')
    return options
  }
  if (options.spec === null) throw new Error('缺少里程碑目录，例如 specs/35-foo')
  if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1) throw new Error('--max-rounds 需要正整数')
  for (const key of ['agentTimeoutHours', 'stallMinutes', 'stallCpuSeconds']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} 需要正数`)
  }
  return options
}

// Repository-relative path with forward slashes, or null when it leaves the repository.
export function repoPath(path, base = root) {
  const rel = relative(base, resolve(base, path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

// The documents the editor may change: plan.md and the --also files. Other
// files next to the plan (for example a contract snapshot) stay read-only.
export function documentsInScope(spec, also = []) {
  return [...new Set([`${spec}/plan.md`, ...also])]
}

function gitTop(dir) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${dir} 不在 git 仓库里`)
  return realpathSync(result.stdout.trim())
}

// The repository and the spec directory in it for a directory given on the
// command line (relative to `cwd`). A cross-repository placeholder of
// run-milestones.mjs stands for its target spec.
export function locate(path, cwd = process.cwd()) {
  const dir = resolve(cwd, path)
  if (!existsSync(join(dir, 'plan.md'))) throw new Error(`找不到 ${path}/plan.md`)
  const real = realpathSync(dir)
  const repo = gitTop(real)
  const spec = repoPath(real, repo)
  if (!spec) throw new Error(`${path} 是仓库根目录，不是规格目录`)
  // The placeholder names its target relative to its own repository.
  const cross = crossRepoTarget(readFileSync(join(real, 'plan.md'), 'utf8'), repo)
  if (!cross) return { repo, spec, placeholder: null }
  if (!existsSync(join(cross.repo, cross.spec, 'plan.md'))) throw new Error(`占位 ${spec} 指向的规格不存在：${join(cross.repo, cross.spec, 'plan.md')}`)
  const target = gitTop(cross.repo)
  return { repo: target, spec: repoPath(realpathSync(join(cross.repo, cross.spec)), target), placeholder: spec }
}

// How to name a spec of `repo` from this repository: "specs/35-foo" here, "../OPOC/specs/x" elsewhere.
export function displaySpec(repo, spec) {
  return repo === realpathSync(root) ? spec : relative(realpathSync(root), join(repo, spec)).split(sep).join('/')
}

// The verdict is the first non-empty line, as the reviewer is told to write it;
// Markdown emphasis around it is tolerated, anything else is no verdict.
export function parseVerdict(text) {
  const first = String(text ?? '').split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? ''
  const word = first.replace(/^[#>*_`\s]+|[*_`\s.:：]+$/gu, '')
  return word === 'APPROVED' || word === 'CHANGES_REQUESTED' ? word : null
}

// The text of one "## <heading>" section, up to the next "## " heading.
export function section(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const start = lines.findIndex(line => line.trim().replace(/^##\s+/u, '') === heading && /^##\s/u.test(line.trim()))
  if (start < 0) return ''
  const end = lines.findIndex((line, index) => index > start && /^##\s/u.test(line.trim()))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

// Distinct issue IDs (R<round>-<n>) in the review's blocking section.
export function blockingIssueIds(review, round) {
  const ids = section(review, '阻塞问题').match(new RegExp(`R${round}-\\d+`, 'gu')) ?? []
  return [...new Set(ids)]
}

export function fileHash(file) {
  return existsSync(file) && statSync(file).isFile() ? createHash('sha1').update(readFileSync(file)).digest('hex') : 'missing'
}

// `git status` of the whole working tree with a content hash per entry, so an
// edit to an already modified file is noticed too, plus the git-ignored files
// where plan-editor may write (git status does not list those).
export function worktreeSnapshot(cwd = root) {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { cwd, encoding: 'utf8' })
  if (status.status !== 0) throw new Error(`git status 失败：${status.stderr}`)
  const snapshot = new Map()
  for (const entry of status.stdout.split('\0').filter(Boolean)) {
    const path = entry.slice(3)
    snapshot.set(path, `${entry.slice(0, 2)} ${fileHash(join(cwd, path))}`)
  }
  const dirs = EDITABLE.filter(dir => dir !== LOGS && existsSync(join(cwd, dir)))
  if (dirs.length > 0) {
    const ignored = spawnSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...dirs], { cwd, encoding: 'utf8' })
    if (ignored.status !== 0) throw new Error(`git ls-files 失败：${ignored.stderr}`)
    for (const path of ignored.stdout.split('\0').filter(Boolean)) snapshot.set(path, `!! ${fileHash(join(cwd, path))}`)
  }
  return snapshot
}

export function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
}

// The editor may change the documents in scope and nothing else.
export function outsideScope(paths, documents) {
  const allowed = new Set(documents)
  return paths.filter(path => !allowed.has(path))
}

export function acceptanceCheck(planText) {
  try {
    const commands = acceptanceCommands(planText)
    return { ok: true, text: `OK：解析出 ${commands.length} 条命令：\n${commands.map(command => `    ${command}`).join('\n')}` }
  } catch (error) {
    return { ok: false, text: `错误（阻塞）：${error.message}` }
  }
}

// A tilde fence longer than any tilde run in the content, so the diff of a
// Markdown document with its own ``` blocks stays inside it (some Markdown
// link checkers, e.g. OPOC-DSH's check-doc-links, close a fence on the same
// character only).
export function fenced(content, info = '') {
  const longest = Math.max(3, ...(String(content).match(/~+/gu) ?? []).map(tildes => tildes.length))
  const fence = '~'.repeat(longest + 1)
  return `${fence}${info}\n${String(content).trimEnd()}\n${fence}`
}

export function diffStat(diff) {
  const stats = new Map()
  let current = null
  for (const line of String(diff).split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line)
    if (header) {
      current = header[2] === 'dev/null' ? header[1] : header[2]
      stats.set(current, { added: 0, removed: 0 })
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) stats.get(current).added += 1
    else if (current && line.startsWith('-') && !line.startsWith('---')) stats.get(current).removed += 1
  }
  return stats
}

export function renderReport({ title, date, reviewerModels, editorModel, runDir, outcome, rounds, body, unresolved, diff, durationMs,
  problems = [], decisions = [] }) {
  const stats = diffStat(diff)
  const lines = [
    `# ${title}：plan 自动评审与修改记录`,
    '',
    `> 由 \`refine-plan\` 生成于 ${date}。这是修改记录，**不是需求**：实现以同目录的 plan.md 为准。`,
    `> 评审：${reviewerModels.map(model => `\`${model}\``).join('、')}；修改：\`${editorModel}\`。各轮原文在本地 \`${runDir}\`（不提交）。`,
    '',
    '| 项目 | 结果 |',
    '|---|---|',
    `| 结论 | ${outcome} |`,
    `| 评审轮次 | ${rounds.length} |`,
    `| 改动的文档 | ${stats.size === 0 ? '无' : [...stats].map(([path, stat]) => `\`${path}\`（+${stat.added} / -${stat.removed}）`).join('<br>')} |`,
    `| 耗时 | ${formatDuration(durationMs)} |`,
    '',
    '## 各轮评审',
    '',
    '| 轮次 | 评审模型 | 结论 | 阻塞问题 | 修改方回应 |',
    '|---|---|---|---|---|',
    ...rounds.map(round => `| ${round.round} | \`${round.model}\` | ${round.verdict} | ${round.issues.length === 0 ? '—' : round.issues.join('、')} | ${round.responseFile ? '已回应' : '—'} |`),
    '',
  ]
  if (problems.length > 0) {
    lines.push('## 运行检查发现的问题', '', '下面这些说明这次的评审结果不可靠，需要先处理：', '', ...problems.map(problem => `- ${problem}`), '')
  }
  if (body) lines.push(body.trim(), '')
  if (decisions.length > 0) {
    lines.push('## 需人工决定的问题（各轮原文汇总）', '', ...decisions.flatMap(item => [`### ${item.source}`, '', item.text.trim(), '']))
  }
  if (unresolved) lines.push('## 仍未解决的阻塞问题（最后一轮评审）', '', unresolved.trim(), '')
  if (diff.trim()) {
    lines.push('## 完整 diff', '', '<details>', '<summary>展开（相对评审前的原文）</summary>', '', fenced(diff, 'diff'), '', '</details>', '')
  }
  return lines.join('\n')
}

// The diff from the baseline copies to the current documents, with the
// baseline prefix removed so both sides show the repository path.
export function baselineDiff({ runDir, documents, cwd = root }) {
  const runRel = repoPath(runDir, cwd)
  const empty = join(runDir, 'empty')
  writeFileSync(empty, '')
  const parts = []
  for (const document of documents) {
    const before = join(runDir, 'baseline', document)
    const after = join(cwd, document)
    const left = existsSync(before) ? `${runRel}/baseline/${document}` : repoPath(empty, cwd)
    const right = existsSync(after) ? document : repoPath(empty, cwd)
    const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--', left, right], { cwd, encoding: 'utf8' })
    if (result.status === 0) continue
    if (result.status !== 1) throw new Error(`git diff 失败：${result.stderr}`)
    parts.push(result.stdout
      .replaceAll(`${runRel}/baseline/`, '')
      .replaceAll(repoPath(empty, cwd), existsSync(before) ? document : 'dev/null'))
  }
  return parts.join('')
}

// Starts a run (`--start`): copies the documents in scope as the baseline,
// keeps a snapshot of the working tree for the final check, and records in
// meta.json what the report needs.
export function startRun({ spec, documents, title, models, maxRounds, cwd = root, now = new Date() }) {
  const runDir = join(cwd, LOGS, `${basename(spec)}-${now.toISOString().replace(/[:.]/gu, '-')}`)
  for (const document of documents) {
    mkdirSync(dirname(join(runDir, 'baseline', document)), { recursive: true })
    copyFileSync(join(cwd, document), join(runDir, 'baseline', document))
  }
  const meta = { spec, documents, title, models, maxRounds, startedAt: now.toISOString() }
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  writeFileSync(join(runDir, 'worktree.json'), `${JSON.stringify(Object.fromEntries(worktreeSnapshot(cwd)), null, 2)}\n`)
  return runDir
}

export function readMeta(runDir) {
  const file = join(runDir, 'meta.json')
  if (!existsSync(file)) throw new Error(`${file} 不存在：这不是 --start 建立的记录目录`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

// The record directories `--start` made since `since`, newest first.
export function runDirsSince(spec, since, cwd = root) {
  const dir = join(cwd, LOGS)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.startsWith(`${basename(spec)}-`) && existsSync(join(dir, name, 'meta.json')))
    .map(name => ({ dir: join(dir, name), meta: readMeta(join(dir, name)) }))
    .filter(item => item.meta.spec === spec && new Date(item.meta.startedAt) >= since)
    .sort((left, right) => right.meta.startedAt.localeCompare(left.meta.startedAt))
    .map(item => item.dir)
}

export function documentHashes(documents, cwd = root) {
  return Object.fromEntries(documents.map(document => [document, fileHash(join(cwd, document))]))
}

// `--check <run>`, run right before each review: records the hashes of the
// documents the coming review will see, so an approval is bound to them.
export function checkRound(runDir, cwd = root) {
  const meta = readMeta(runDir)
  const round = readRounds(runDir, cwd).length + 1
  writeFileSync(join(runDir, `round-${round}-documents.json`), `${JSON.stringify(documentHashes(meta.documents, cwd), null, 2)}\n`)
  return { round, check: acceptanceCheck(readFileSync(join(cwd, meta.spec, 'plan.md'), 'utf8')) }
}

// The rounds, read back from round-<n>-review.md, round-<n>-response.md,
// round-<n>-documents.json (from --check) and round-<n>-reviewer (written when
// the fallback reviewer gave that review).
export function readRounds(runDir, cwd = root) {
  const meta = readMeta(runDir)
  const runRel = repoPath(runDir, cwd)
  return readdirSync(runDir)
    .map(name => /^round-(\d+)-review\.md$/u.exec(name)?.[1]).filter(Boolean).map(Number).sort((left, right) => left - right)
    .map(round => {
      const text = readFileSync(join(runDir, `round-${round}-review.md`), 'utf8').trim()
      const response = join(runDir, `round-${round}-response.md`)
      const reviewerFile = join(runDir, `round-${round}-reviewer`)
      const documentsFile = join(runDir, `round-${round}-documents.json`)
      const reviewer = existsSync(reviewerFile) ? readFileSync(reviewerFile, 'utf8').trim() : REVIEWER
      return {
        round, text, reviewer, model: meta.models?.[reviewer] ?? reviewer,
        verdict: parseVerdict(text) ?? '无结论', issues: blockingIssueIds(text, round),
        reviewFile: `${runRel}/round-${round}-review.md`,
        responseFile: existsSync(response) ? `${runRel}/round-${round}-response.md` : null,
        responseText: existsSync(response) ? readFileSync(response, 'utf8') : '',
        documents: existsSync(documentsFile) ? JSON.parse(readFileSync(documentsFile, 'utf8')) : null,
      }
    })
}

export function outcomeOf(rounds, maxRounds) {
  const last = rounds.at(-1)
  if (!last) return '没有完成任何一轮评审'
  if (last.verdict === 'APPROVED') return `第 ${last.round} 轮评审通过`
  if (last.responseFile) return `第 ${last.round} 轮评审后改了文档，但没有再评审：这些修改未经复核`
  const left = `仍有 ${last.issues.length || '若干'} 个阻塞问题未解决`
  return last.round >= maxRounds ? `达到 ${maxRounds} 轮上限，${left}` : `停在第 ${last.round} 轮，${left}`
}

// Every 需人工决定 item of the run: the reviewers' sections and the editor's
// escalations, whatever the verdict and whether or not a document changed.
export function collectDecisions(rounds) {
  const items = []
  for (const round of rounds) {
    const reviewed = section(round.text, '需人工决定')
    if (reviewed) items.push({ source: `第 ${round.round} 轮评审`, text: reviewed })
    const escalated = round.responseText.split(/^(?=###\s)/mu).filter(block => /^###\s/u.test(block) && /结论[：:]\s*需人工决定/u.test(block))
    if (escalated.length > 0) items.push({ source: `第 ${round.round} 轮修改方`, text: escalated.join('\n').trim() })
  }
  return items
}

// Changes since --start outside the documents in scope, the report and the records.
export function strayChanges(before, after, documents, spec) {
  const changed = changedPaths(before, after).filter(path => !path.startsWith(`${LOGS}/`))
  return outsideScope(changed, [...documents, `${spec}/${REPORT_FILE}`])
}

// The final check shared by `--finish` and the unattended run: what the
// records and the working tree must show for the result to be trusted.
export function auditRun(runDir, { cwd = root, rounds = readRounds(runDir, cwd), now = worktreeSnapshot(cwd) } = {}) {
  const meta = readMeta(runDir)
  const problems = []
  const startFile = join(runDir, 'worktree.json')
  if (existsSync(startFile)) {
    const stray = strayChanges(new Map(Object.entries(JSON.parse(readFileSync(startFile, 'utf8')))), now, meta.documents, meta.spec)
    if (stray.length > 0) problems.push(`改动了范围以外的文件：${stray.join('、')}`)
  } else {
    problems.push('记录目录里没有工作区基准（worktree.json），无法检查改动范围')
  }
  if (rounds.length === 0) problems.push('一轮评审记录也没有')
  if (rounds.length > meta.maxRounds) problems.push(`评审了 ${rounds.length} 轮，超过上限 ${meta.maxRounds}`)
  rounds.forEach((round, index) => {
    if (round.round !== index + 1) problems.push(`评审记录不连续：缺少第 ${index + 1} 轮`)
    if (round.verdict === '无结论') problems.push(`第 ${round.round} 轮评审记录的第一行不是 APPROVED 或 CHANGES_REQUESTED`)
    if (!round.documents) problems.push(`第 ${round.round} 轮评审前没有执行 --check，不知道评审的是哪个版本`)
  })
  const last = rounds.at(-1)
  if (last?.documents) {
    const current = documentHashes(meta.documents, cwd)
    const edited = meta.documents.filter(document => current[document] !== last.documents[document])
    if (edited.length > 0) problems.push(`第 ${last.round} 轮评审之后又改了文档，当前内容没有经过评审：${edited.join('、')}`)
  }
  const plan = join(cwd, meta.spec, 'plan.md')
  const check = acceptanceCheck(existsSync(plan) ? readFileSync(plan, 'utf8') : '')
  if (!check.ok) problems.push(`当前 plan.md 的验收命令无法使用：${check.text.replace(/^错误（阻塞）：/u, '')}`)
  return [...new Set(problems)]
}

// Writes <spec>/refine-report.md from the records (`--finish`): the final check,
// the rounds, the body the editor wrote to report-body.md, every 需人工决定
// item, the unresolved issues and the full diff. `approved` needs both the
// reviewer's APPROVED and a clean final check.
export function finishRun(runDir, { cwd = root, now = new Date(), extraProblems = [] } = {}) {
  const meta = readMeta(runDir)
  const rounds = readRounds(runDir, cwd)
  if (rounds.length === 0) throw new Error(`${repoPath(runDir, cwd)} 里还没有任何一轮评审记录（round-1-review.md）`)
  const problems = [...new Set([...extraProblems, ...auditRun(runDir, { cwd, rounds })])]
  const last = rounds.at(-1)
  const reviewed = outcomeOf(rounds, meta.maxRounds)
  const approved = last.verdict === 'APPROVED' && problems.length === 0
  const outcome = problems.length > 0 ? `运行检查未通过（评审记录：${reviewed}）` : reviewed
  const diff = baselineDiff({ runDir, documents: meta.documents, cwd })
  writeFileSync(join(runDir, 'changes.diff'), diff)
  const bodyFile = join(runDir, 'report-body.md')
  let body = existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8').trim() : ''
  if (!body) {
    body = rounds.some(round => round.responseFile)
      ? '## 概要\n\n（修改方没有写出改动说明，请直接看下面的各轮记录和完整 diff。）'
      : '## 概要\n\n第一轮评审即通过，文档没有改动。'
  }
  const suggestions = section(last.text, '非阻塞建议')
  if (last.verdict === 'APPROVED' && suggestions) body += `\n\n## 最后一轮的非阻塞建议（未处理）\n\n${suggestions}`
  const decisions = collectDecisions(rounds)
  const report = renderReport({
    title: meta.title, date: now.toLocaleString('zh-CN', { hour12: false }), reviewerModels: [...new Set(rounds.map(round => round.model))],
    editorModel: meta.models?.['plan-editor'] ?? 'plan-editor', runDir: repoPath(runDir, cwd), outcome, rounds, body, problems, decisions,
    unresolved: last.verdict !== 'CHANGES_REQUESTED' ? null : last.text.replace(/^.*\r?\n/u, ''),
    diff, durationMs: now - new Date(meta.startedAt),
  })
  const reportFile = `${meta.spec}/${REPORT_FILE}`
  writeFileSync(join(cwd, reportFile), report)
  return { approved, verdict: last.verdict, outcome, problems, decisions, reportFile, rounds }
}

// Appended to the expanded command. `opencode run` ends with the response, so
// nothing may be left in the background and the whole loop must finish first.
export function unattendedNote() {
  return [
    '',
    '## Running unattended',
    '',
    'You are running in a one-shot `opencode run` session started by `refine-plan`, with nobody watching. When your response ends, the whole run ends: nothing will wake you up again, and any background command is killed.',
    '',
    '- Do not start commands with `background: true`.',
    '- End your response only after `--finish` has run, or when you are stopping for good.',
    '- Afterwards the runner repeats the final check of `--finish` (only the documents in scope changed, every round has a `--check` and a saved review with a verdict, the round limit held, nothing changed after the last review) and regenerates the report from the records. Breaking a rule is reported as a failed run.',
    '- When you invoke the reviewer, tell it it is running unattended too.',
    '',
  ].join('\n')
}

export function mailFor({ title, spec, result, outcome, problems = [], reportFile = null, runDir = null, logFile, durationMs, rounds = [],
  decisions: decisionItems = [], diffCommand = `git diff -- ${spec}`, tag = '' }) {
  const icon = { approved: '✅', unresolved: '⚠️', failed: '❌' }[result]
  const decisions = new Set(decisionItems.flatMap(item => item.text.match(/R\d+-\d+/gu) ?? [])).size || decisionItems.length
  const lines = [
    `里程碑：${title}（${spec}）`,
    `结果：${outcome}`,
    `评审轮次：${rounds.length}`,
    ...(decisions ? [`需要你决定的问题：${decisions} 个（见报告）`] : []),
    `用时：${formatDuration(durationMs)}`,
    '',
    ...(problems.length ? ['运行检查发现的问题：', ...problems.map(problem => `- ${problem}`), ''] : []),
    ...(reportFile ? [`改动说明：${reportFile}`, `查看改动：${diffCommand}`] : []),
    ...(runDir ? [`各轮记录：${runDir}`] : []),
    `运行日志：${logFile}`,
    '',
    '文档改动没有提交，复核后自行提交。',
  ]
  return { subject: `${tag ? `${tag} ` : ''}${icon} plan 评审 ${title}：${outcome}`, text: lines.join('\n') }
}

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`)
  process.exit(1)
}

function modelOf(agentFile) {
  return existsSync(agentFile) ? splitFrontmatter(readFileSync(agentFile, 'utf8')).fields.model ?? null : null
}

// The plan, its repository, documents and models, checked; shared by the full run and --start.
function prepare(options) {
  let located
  try { located = locate(options.spec) } catch (error) { fail(error.message) }
  const { repo, spec, placeholder } = located
  const shown = displaySpec(repo, spec)
  if (existsSync(join(repo, spec, 'STATUS'))) fail(`${shown}/STATUS 已存在：这个规格已经实现过，不再改它的 plan。`)
  const also = options.also.map(path => {
    const rel = repoPath(path, repo)
    if (!rel || NOT_DOCUMENTS.has(basename(rel)) || !existsSync(join(repo, rel)) || !statSync(join(repo, rel)).isFile()) {
      fail(`--also 的文件不存在、不在 plan 所在的仓库里，或者不能修改：${path}（路径相对 ${repo}）`)
    }
    if (!EDITABLE.some(dir => dir !== LOGS && rel.startsWith(`${dir}/`))) {
      fail(`--also 只能是 ${EDITABLE.filter(dir => dir !== LOGS).join('/、')}/ 下的文档（plan-editor 只能写这些目录）：${path}`)
    }
    return rel
  })
  const commandFile = join(repo, '.opencode', 'commands', `${COMMAND}.md`)
  if (!existsSync(commandFile)) fail(`找不到 opencode 命令文件：${commandFile}`)
  const command = splitFrontmatter(readFileSync(commandFile, 'utf8'))
  const editor = command.fields.agent
  if (!editor) fail(`${commandFile} 的 frontmatter 没有写 agent。`)
  const models = {}
  for (const agent of [editor, REVIEWER, FALLBACK_REVIEWER]) {
    models[agent] = modelOf(join(repo, '.opencode', 'agents', `${agent}.md`))
    if (!models[agent]) fail(`找不到 ${agent} 的模型：${join(repo, '.opencode', 'agents', `${agent}.md`)} 的 frontmatter 需要写 model。`)
  }
  const planText = readFileSync(join(repo, spec, 'plan.md'), 'utf8')
  return {
    repo, spec, shown, placeholder, also, documents: documentsInScope(spec, also), editor, models, commandFile,
    title: milestoneTitle(planText, basename(spec)), check: acceptanceCheck(planText),
  }
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) { fail(`${error.message}\n\n${USAGE}`) }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return }

  // The steps the /refine-plan command runs.
  if (options.finish) {
    let result
    try {
      const runDir = realpathSync(resolve(options.finish))
      result = finishRun(runDir, { cwd: gitTop(runDir) })
    } catch (error) { fail(error.message) }
    process.stdout.write([
      `${result.approved ? '✓' : '✗'} ${result.outcome}。`,
      ...(result.problems.length ? ['运行检查发现的问题：', ...result.problems.map(problem => `  - ${problem}`)] : []),
      `改动说明：${result.reportFile}`,
      '',
    ].join('\n'))
    process.exit(result.problems.length ? 1 : 0)
  }
  if (options.check) {
    let result
    try {
      const runDir = realpathSync(resolve(options.check))
      result = checkRound(runDir, gitTop(runDir))
    } catch (error) { fail(error.message) }
    process.stdout.write(`第 ${result.round} 轮评审前的文档版本已记录。\n验收命令：${result.check.text}\n`)
    process.exit(result.check.ok ? 0 : 1)
  }

  const { repo, spec, shown, placeholder, also, documents, editor, models, commandFile, title, check } = prepare(options)
  if (options.start) {
    const runDir = startRun({ spec, documents, title, models, maxRounds: options.maxRounds, cwd: repo })
    process.stdout.write([
      `记录目录：${repoPath(runDir, repo)}`,
      '范围内的文档：',
      ...documents.map(document => `  ${document}`),
      `最多 ${options.maxRounds} 轮评审`,
      `验收命令：${check.text}`,
      '',
    ].join('\n'))
    return
  }

  // A full unattended run: opencode does the work, this script guards it.
  process.stdout.write([
    `规格：${title}（${shown}${placeholder ? `，占位 ${placeholder}` : ''}）`,
    ...(repo === realpathSync(root) ? [] : [`仓库：${repo}（用它自己的 .opencode）`]),
    '范围内的文档：',
    ...documents.map(document => `  ${document}`),
    `opencode：/${COMMAND}，${editor}（${models[editor]}）调用 ${REVIEWER}（${models[REVIEWER]}；不可用时 ${FALLBACK_REVIEWER}，${models[FALLBACK_REVIEWER]}）`,
    `最多 ${options.maxRounds} 轮评审`,
    `验收命令：${check.text}`,
    '',
  ].join('\n'))
  if (options.dryRun) return

  const opencode = process.env.OPENCODE_BIN || 'opencode'
  const version = spawnSync(process.platform === 'win32' ? windowsShellCommand(opencode, ['--version']) : opencode,
    process.platform === 'win32' ? [] : ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
  if (version.status !== 0) fail(`找不到 opencode 命令行（${opencode}）。请先安装 opencode CLI，或用 OPENCODE_BIN 指定路径。`)
  if (!opencodeVersionSupported(version.stdout)) fail(`opencode 版本过低（${version.stdout.trim()}），需要 ${MIN_OPENCODE_VERSION.join('.')} 或更高。`)
  try { processTable() } catch (error) { fail(`看门狗读不到进程表：${error.message}\n  请在能运行 ps 的终端里启动。`) }
  let mailConfig = null
  try {
    mailConfig = loadMailConfig(options.notifyConfig)
    process.stdout.write(mailConfig ? `邮件通知：${mailConfig.to.join('、')}\n` : `邮件通知未启用：找不到 ${options.notifyConfig}。\n`)
  } catch (error) {
    process.stderr.write(`⚠ ${error.message}。本次不发邮件。\n`)
  }

  // Whole seconds: meta.json's startedAt from --start must not sort before this.
  const started = new Date(Math.floor(Date.now() / 1000) * 1000)
  mkdirSync(join(repo, LOGS), { recursive: true })
  const logFile = join(repo, LOGS, `${basename(spec)}-${started.toISOString().replace(/[:.]/gu, '-')}.runner.log`)
  const inRepo = path => displaySpec(repo, repoPath(path, repo))
  process.stdout.write(`运行日志：${inRepo(logFile)}\n\n`)
  installInterruptHandler(() => {
    process.stderr.write(`已全部结束。文档的改动保留在工作区；评审前的原文和各轮记录在 ${LOGS}/ 下这次的记录目录里。\n`)
  })

  const args = [spec, String(options.maxRounds), ...also.flatMap(path => ['--also', path])].join(' ')
  const prompt = expandCommand(readFileSync(commandFile, 'utf8'), args).prompt + unattendedNote()
  const before = worktreeSnapshot(repo)
  const agentArgs = ['run', '--standalone', '--agent', editor, '--model', models[editor], '--title', `refine ${basename(spec)}`]
  const agent = await run(process.platform === 'win32' ? windowsShellCommand(opencode, agentArgs) : opencode, process.platform === 'win32' ? [] : agentArgs, {
    logFile, cwd: repo, shell: process.platform === 'win32', input: prompt, watch: 'agent',
    stall: { windowMs: options.stallMinutes * 60_000, minCpuSeconds: options.stallCpuSeconds },
    timeoutMs: options.agentTimeoutHours * 3_600_000,
  })

  // What only this runner can see; the rest is the final check of --finish,
  // which runs again here on the records whatever the agent did.
  const runDirs = runDirsSince(spec, started, repo)
  const problems = []
  if (agent.timedOut) problems.push(`opencode 超过 ${options.agentTimeoutHours} 小时没有结束，已终止`)
  else if (agent.code !== 0) problems.push(`opencode 以退出码 ${agent.code} 结束`)
  const stray = strayChanges(before, worktreeSnapshot(repo), documents, spec)
  if (stray.length > 0) problems.push(`改动了范围以外的文件：${stray.join('、')}`)
  if (runDirs.length === 0) problems.push('没有执行 --start，找不到这次的记录目录')
  if (runDirs.length > 1) problems.push(`执行了 ${runDirs.length} 次 --start，只看最新的记录目录`)
  const meta = runDirs[0] ? readMeta(runDirs[0]) : null
  if (meta && (meta.maxRounds !== options.maxRounds || meta.documents.join('\n') !== documents.join('\n'))) {
    problems.push('--start 用的轮次上限或文档范围和这次运行的不一致')
  }

  let finished = null
  if (runDirs[0] && readRounds(runDirs[0], repo).length > 0) {
    try { finished = finishRun(runDirs[0], { cwd: repo, extraProblems: problems }) } catch (error) { problems.push(`生成报告失败：${error.message}`) }
  } else if (runDirs[0]) {
    problems.push('一轮评审记录也没有')
  }
  if (finished) problems.splice(0, problems.length, ...finished.problems)
  const result = problems.length > 0 || !finished ? 'failed' : finished.approved ? 'approved' : 'unresolved'
  // finishRun's outcome already says when the final check failed.
  const outcome = finished ? finished.outcome : '运行没有正常完成，没有评审记录'
  const durationMs = Date.now() - started
  const mail = mailFor({ title, spec: shown, result, outcome, problems, reportFile: finished ? `${shown}/${REPORT_FILE}` : null,
    runDir: runDirs[0] ? inRepo(runDirs[0]) : null, logFile: inRepo(logFile), durationMs, rounds: finished?.rounds ?? [],
    decisions: finished?.decisions ?? [], tag: `[${loadConfig(repo).name}]`,
    diffCommand: repo === realpathSync(root) ? `git diff -- ${spec}` : `git -C ${relative(realpathSync(root), repo).split(sep).join('/')} diff -- ${spec}` })
  process.stdout.write(`\n${mail.subject}\n\n${mail.text}\n`)
  if (mailConfig) {
    try {
      await sendMail(mailConfig, mail)
      process.stdout.write('✉ 已发送邮件通知。\n')
    } catch (error) {
      process.stderr.write(`⚠ 邮件发送失败：${error.message}\n`)
    }
  }
  process.exit({ approved: 0, unresolved: 3, failed: 1 }[result])
}

if (isMain(import.meta.url)) {
  main().catch(error => fail(error.message))
}
