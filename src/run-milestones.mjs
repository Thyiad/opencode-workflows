#!/usr/bin/env node
// Drives the milestones in specs/ of the current git repository one by one
// through its opencode implementer -> reviewer workflow (.opencode/), unattended.
// Repository settings (required environment variables and so on) come from
// .opencode/workflows.json, see config.mjs.
//
// For each milestone directory specs/NN-*/ that is not yet committed as done:
//   1. run the implement-plan command (.opencode/commands/implement-plan.md)
//      for specs/NN-* in a fresh `opencode run --standalone` session
//   2. require the agent to have written APPROVED into specs/NN-*/STATUS
//   3. re-run the plan's acceptance commands ourselves (do not trust the agent)
//   4. commit everything as one milestone commit, then continue with the next
// Any failure stops the run with a hint on how to resume.
//
// Cross-repository milestones: a plan.md containing
//   <!-- milestone-repo: ../OPOC -->
//   <!-- milestone-spec: specs/harness-api -->
// is a placeholder. The agent runs inside that repository on that spec (using
// the repository's own .opencode), STATUS is read from there, the acceptance
// commands of the placeholder still run from this repository's root, and the
// commit is made in the target repository.
//
//   run-milestones                 # all remaining milestones
//   run-milestones --from 03       # start at milestone 03
//   run-milestones --only 03       # just milestone 03
//   run-milestones --only 23,24    # exactly these (ranges too: --only 23-26,29)
//   run-milestones --from 23 --to 26   # a contiguous range, both ends included
//   run-milestones --dry-run       # show what would run
//   run-milestones --push          # git push after each commit; also pushes commits an earlier run left behind
//   run-milestones --report        # print the time report only
//   run-milestones --from 16 --resume  # continue an interrupted run
//   run-milestones --only 21 --review  # same, straight to the review
//
// --resume: the first milestone that still needs the agent may start on a dirty
// tree, and its prompt says those uncommitted changes are the partial work of
// the interrupted previous run (with the file list and that run's log), so the
// agent reviews and finishes them instead of starting over. Without it, a fresh
// agent treats them as someone else's changes and re-implements around them.
//
// --review: --resume for a run that was interrupted after the implementation
// was finished and validated (typically while the reviewer was unreachable).
// The agent skips re-checking the changes against the plan and re-running the
// acceptance commands, and starts with the independent review; repairs, the
// review loop and the runner's own acceptance run before the commit are
// unchanged. It needs uncommitted changes to review.
//
// Timeouts (so nothing can hang forever): --agent-timeout-hours (default 6) for
// one opencode run, --command-timeout-minutes (default 45) for one acceptance
// command. A timeout kills the whole process tree and stops the run.
//
// Watchdog: a command that makes no progress is killed long before those
// timeouts. Every shell the agent starts for a command, and every acceptance
// command, is watched; when the CPU time of its whole process tree (processes
// that already exited included) grows by less than --stall-cpu-seconds
// (default 10) within --stall-minutes (default 10), the tree is killed and the
// event is logged. The agent then sees a failed command and has to deal with
// it. This catches the known pnpm 11.7.0 install hang and deadlocked tests
// (for example a test that synchronously waits on a child process that talks
// to a server inside the test process), which would otherwise wait forever.
//
// Ctrl+C / SIGTERM stops opencode and every process it started, then exits.
//
// OpenCode v2 (at least MIN_OPENCODE_VERSION) is required. v2 removed
// `opencode run --command` and `--dir`, so the runner expands the command file
// itself, sends the prompt on stdin and starts opencode in the target
// directory. `--standalone` keeps the OpenCode server, and so every command the
// agent runs, inside the watched process tree instead of the shared background
// service.
//
// Timings of every attempt are appended to .milestone-logs/timings.jsonl, so a
// run that was stopped and resumed still adds up; the report is printed at the
// end of every run and on failure.
//
// Requirements: the opencode CLI on PATH (or OPENCODE_BIN), and the variables
// the repository's .opencode/workflows.json lists under requiredEnv (for a
// cross-repository milestone, the target repository's as well).
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, loadConfig, missingEnv, repoRootOf } from './config.mjs'

// The repository this run works on: the one of the current directory.
const root = repoRootOf()
const specsDir = join(root, 'specs')
const logsDir = join(root, '.milestone-logs')
const timingsFile = join(logsDir, 'timings.jsonl')
// A run commits to or pushes these branches only with --allow-main.
const PROTECTED_BRANCHES = ['master', 'main']

// Milestone numbers have at least two digits: 01 … 99, then 100, 101, …
// They are compared as numbers, so 100 comes after 99.
export const MILESTONE_NUMBER = /^\d{2,}$/u
const MILESTONE_DIR = /^(\d{2,})-/u
const byNumber = (left, right) => Number(left) - Number(right)

// `--only` takes one or more milestone numbers: "23", "23,24", "23-26,29", "99-101".
// Returns the de-duplicated numbers in order, at least two digits each.
export function parseNumberSpec(spec) {
  const text = String(spec ?? '')
  const numbers = new Set()
  for (const part of text.split(',')) {
    const match = /^(\d{2,})(?:-(\d{2,}))?$/u.exec(part.trim())
    if (!match) throw new Error(`--only 需要两位或以上的数字，可以用逗号和连字符组合，例如 03、23,24 或 23-26,29（收到：${text || '空'}）`)
    const first = Number(match[1])
    const last = match[2] === undefined ? first : Number(match[2])
    if (first > last) throw new Error(`--only 的范围写反了：${part.trim()}`)
    for (let value = first; value <= last; value += 1) numbers.add(String(value).padStart(2, '0'))
  }
  return [...numbers].sort(byNumber)
}

// The milestones a run covers: --only, --from and --to all narrow the same
// list, so the result is their intersection ("--only 23-30 --to 26" is 23-26).
export function selectMilestones(milestones, { only = null, from = null, to = null } = {}) {
  const wanted = only ? new Set(parseNumberSpec(only).map(Number)) : null
  const number = item => Number(item.number)
  return milestones.filter(item => (!wanted || wanted.has(number(item))) && (!from || number(item) >= Number(from)) && (!to || number(item) <= Number(to)))
}

// What to type to carry on at `number` with the same selection. A plain
// "--from" stays "--from NN"; once --only or --to restricted the run, "--from NN"
// would run past the selection, so the remaining numbers are listed instead.
export function continueSelection(selected, number, restricted) {
  if (!restricted) return `--from ${number}`
  return `--only ${selected.filter(item => Number(item) >= Number(number)).join(',')}`
}

function parseArgs(argv) {
  const options = { from: null, to: null, only: null, dryRun: false, push: false, allowDirty: false, allowMain: false, resume: false, review: false,
    report: false, agentTimeoutHours: 6, commandTimeoutMinutes: 45, stallMinutes: 10, stallCpuSeconds: 10 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--from') options.from = argv[++index]
    else if (arg === '--only') options.only = argv[++index]
    else if (arg === '--to') options.to = argv[++index]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--push') options.push = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--resume') options.resume = true
    else if (arg === '--review') options.resume = options.review = true
    else if (arg === '--allow-main') options.allowMain = true
    else if (arg === '--report') options.report = true
    else if (arg === '--agent-timeout-hours') options.agentTimeoutHours = Number(argv[++index])
    else if (arg === '--command-timeout-minutes') options.commandTimeoutMinutes = Number(argv[++index])
    else if (arg === '--stall-minutes') options.stallMinutes = Number(argv[++index])
    else if (arg === '--stall-cpu-seconds') options.stallCpuSeconds = Number(argv[++index])
    else throw new Error(`未知参数：${arg}`)
  }
  for (const key of ['from', 'to']) {
    if (options[key] !== null && !MILESTONE_NUMBER.test(options[key] ?? '')) throw new Error(`--${key} 需要两位或以上的数字，例如 03`)
  }
  if (options.only !== null) parseNumberSpec(options.only)
  if (options.from !== null && options.to !== null && Number(options.from) > Number(options.to)) throw new Error('--from 不能大于 --to')
  for (const key of ['agentTimeoutHours', 'commandTimeoutMinutes', 'stallMinutes', 'stallCpuSeconds']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} 需要正数`)
  }
  return options
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours) return `${hours} 小时 ${minutes} 分`
  if (minutes) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

function recordTiming(entry) {
  mkdirSync(logsDir, { recursive: true })
  appendFileSync(timingsFile, `${JSON.stringify(entry)}\n`)
}

// Sums every recorded attempt per milestone, including failed ones: the point
// is to know how much wall-clock time the whole rewrite really took.
export function summarizeTimings(entries) {
  const byMilestone = new Map()
  for (const entry of entries) {
    const item = byMilestone.get(entry.milestone) ?? { milestone: entry.milestone, attempts: 0, agentMs: 0, acceptanceMs: 0, totalMs: 0, stalls: 0, result: null }
    item.attempts += 1
    item.stalls += entry.stalls ?? 0
    item.agentMs += entry.agentMs ?? 0
    item.acceptanceMs += entry.acceptanceMs ?? 0
    item.totalMs += entry.totalMs ?? 0
    item.result = entry.result
    byMilestone.set(entry.milestone, item)
  }
  const rows = [...byMilestone.values()].sort((left, right) => left.milestone.localeCompare(right.milestone, undefined, { numeric: true }))
  const total = rows.reduce((sum, row) => sum + row.totalMs, 0)
  return { rows, total }
}

function readTimings() {
  if (!existsSync(timingsFile)) return []
  return readFileSync(timingsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function printReport() {
  const { rows, total } = summarizeTimings(readTimings())
  if (rows.length === 0) { process.stdout.write('还没有耗时记录。\n'); return }
  const label = { committed: '✓ 已提交', failed: '✗ 失败', timeout: '⏱ 超时', interrupted: '■ 手动中断' }
  process.stdout.write('\n里程碑耗时（含失败和重试的全部尝试）：\n')
  for (const row of rows) {
    process.stdout.write(`  ${row.milestone.padEnd(24)} ${String(row.attempts).padStart(2)} 次  实现与审查 ${formatDuration(row.agentMs).padEnd(10)}  验收 ${formatDuration(row.acceptanceMs).padEnd(10)}  合计 ${formatDuration(row.totalMs).padEnd(10)}  ${label[row.result] ?? row.result}${row.stalls ? `  看门狗结束卡住的命令 ${row.stalls} 次` : ''}\n`)
  }
  process.stdout.write(`  总计 ${formatDuration(total)}\n`)
}

function git(args, { allowFailure = false, cwd = root } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr.trim()}`)
  }
  return result.status === 0 ? result.stdout : null
}

// Commits of `cwd` that its upstream does not have yet; null when the branch has
// no upstream.
export function unpushedCommits(cwd) {
  const count = git(['rev-list', '--count', '@{u}..HEAD'], { allowFailure: true, cwd })
  return count === null ? null : Number(count.trim())
}

// The branch `cwd` is on when it is a protected one, else null.
export function protectedBranch(cwd) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true, cwd })?.trim()
  return PROTECTED_BRANCHES.includes(branch) ? branch : null
}

// --push: pushes every repository whose branch is ahead of its upstream (or has
// none, which `git push` then reports). A milestone committed by an earlier run
// whose push failed is skipped as done, so this is what pushes it later; that
// skip also skipped the branch check of its repository, so it is made here, for
// all repositories before the first push. Returns the repositories it pushed. A
// failed push throws "git push 失败：…（仓库 …）", which run-milestones-auto
// recognises by its start; a refused one does not start that way, so the
// wrapper does not push it behind this check's back.
export function pushPending(repositories, { allowMain = false } = {}) {
  const due = [...new Set(repositories)].filter(cwd => existsSync(cwd) && unpushedCommits(cwd) !== 0)
  for (const cwd of allowMain ? [] : due) {
    const branch = protectedBranch(cwd)
    if (branch) throw new Error(`${cwd} 当前在 ${branch} 分支，不推送。请先切到开发分支，或加 --allow-main。`)
  }
  for (const cwd of due) {
    try { git(['push'], { cwd }) } catch (error) { throw new Error(`${error.message}（仓库 ${cwd}）`) }
  }
  return due
}

// What the run reports when its push stops it: the reason from pushPending first
// (the wrapper reads the start), then what is already committed.
export function pushFailureMessage(error, committed) {
  return `${error.message}\n  ${committed}；解决后带 --push 重新运行，会补推。`
}

// Node does not quote executable paths or arguments when shell:true invokes
// cmd.exe. Build one quoted command for Windows CLI shims (including .cmd).
export function windowsShellCommand(command, args) {
  return [command, ...args].map(value => {
    if (/["%\r\n]/u.test(value)) throw new Error('Windows 命令参数包含不支持的字符（引号、百分号或换行）')
    return `"${value}"`
  }).join(' ')
}

export function listMilestones(directory = specsDir) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && MILESTONE_DIR.test(entry.name))
    .map(entry => ({ number: MILESTONE_DIR.exec(entry.name)[1], name: entry.name, dir: join(directory, entry.name), rel: `specs/${entry.name}` }))
    .sort((left, right) => byNumber(left.number, right.number) || left.name.localeCompare(right.name))
}

export function milestoneTitle(planText, fallback) {
  const heading = planText.split(/\r?\n/u).find(line => line.startsWith('# '))
  return heading ? heading.slice(2).trim() : fallback
}

// The acceptance commands are the first ```bash block inside the "## 验收命令"
// section, which ends at the next "#" or "##" heading. Every line runs in a
// shell of its own, so the block has to be one self-contained command per line.
// Whatever would silently verify less than the plan says is an error instead:
// no block (or only one in a later section), an empty block, line
// continuations, heredocs and lines that merely set up a shell (export, cd, ...).
const SHELL_SETUP_ONLY = /^(?:export|unset|cd|source|\.|set)(?:\s|$)/u
const HEREDOC = /(?<!<)<<(?!<)-?\s*['"]?[A-Za-z_]/u
// A heading may be indented by up to three spaces in Markdown.
const SECTION_HEADING = /^ {0,3}#{1,2}(?:\s|$)/u

// Whether a command follows `from`: further separators and blanks are skipped;
// the end of the line or a comment is not a command.
function commandFollows(command, from) {
  const rest = command.slice(from).replace(/^[\s;&|]*/u, '')
  return rest !== '' && !rest.startsWith('#')
}

// Whether `command` has a separator (; & | && ||) outside quotes and comments
// with a second command after it. It says no where it cannot tell: after $(...),
// ${...}, $'...', `...` or <(...), which hold quotes and separators of their own,
// and for an unterminated quote. It does not look at what the second command is,
// so `export A=1; export B=2` still passes: this is a lint for the common slips
// (a lone `export`, `cd;`), not a shell parser.
export function hasCommandSeparator(command) {
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const next = command[index + 1]
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '`' || (char === '$' && next !== undefined && '({\''.includes(next))) return false
    if (quote === '"') {
      if (char === '\\') index += 1
      else if (char === '"') quote = null
      continue
    }
    if (char === '\\') index += 1
    else if (char === "'" || char === '"') quote = char
    else if ((char === '<' || char === '>') && next === '(') return false
    else if (char === '#' && (index === 0 || /\s/u.test(command[index - 1]))) return false
    else if (char === ';' || char === '|') return commandFollows(command, index + 1)
    // `>&2`, `2>&1` and `&>file` redirect; every other & ends a command.
    else if (char === '&' && !/[<>]/u.test(command[index - 1] ?? '') && next !== '>') return commandFollows(command, index + 1)
  }
  return false
}

export function acceptanceCommands(planText) {
  const lines = planText.split(/\r?\n/u)
  const start = lines.findIndex(line => line.trim() === '## 验收命令')
  if (start < 0) throw new Error('plan.md 里没有「## 验收命令」一节')
  let open = -1
  let close = -1
  let fenced = false
  for (let index = start + 1; index < lines.length && close < 0; index += 1) {
    const text = lines[index].trim()
    if (text.startsWith('```')) {
      if (open < 0 && !fenced && /^```(?:bash|sh|shell)(?:\s.*)?$/u.test(text)) open = index
      else if (open >= 0) close = index
      fenced = !fenced
    } else if (open < 0 && !fenced && SECTION_HEADING.test(lines[index])) {
      break // the section ended; a "# ..." line inside a code block is only a shell comment
    }
  }
  if (open < 0) throw new Error('「## 验收命令」一节里没有 ```bash 代码块（代码块要写在这一节内，到下一个标题为止）')
  if (close < 0) throw new Error('「## 验收命令」里的 ```bash 代码块没有结束')
  const commands = lines.slice(open + 1, close).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (commands.length === 0) throw new Error('「## 验收命令」里的代码块是空的，至少要有一条命令')
  for (const command of commands) {
    if (command.endsWith('\\')) throw new Error(`验收命令不支持续行（行尾的 \\）：${command}。每行必须是一条完整的命令`)
    if (HEREDOC.test(command)) throw new Error(`验收命令不支持 heredoc：${command}。每行必须是一条完整的命令，复杂的步骤写成 scripts/ 下的脚本再调用`)
    if (SHELL_SETUP_ONLY.test(command) && !hasCommandSeparator(command)) {
      throw new Error(`验收命令「${command}」单独成行没有作用（引号、注释、$(…) 里的 ; & | 不算连接）：每条命令在各自的 shell 里运行，不会影响后面的命令。要和命令写在同一行（用 && 连接），或写进 scripts/ 下的脚本再调用`)
    }
  }
  return commands
}

// The top-level `key: value` scalars of a Markdown file's YAML frontmatter and
// the body after it. Enough for the keys the runner reads (agent, model).
export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (!match) return { fields: {}, body: text }
  const fields = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^([A-Za-z][\w-]*):\s*(\S.*?)\s*$/u.exec(line)
    if (field && !field[2].startsWith('#')) fields[field[1]] = field[2].replace(/^(["'])(.*)\1$/u, '$2')
  }
  return { fields, body: text.slice(match[0].length) }
}

// OpenCode v2 has no `opencode run --command` and does not expand slash
// commands in a message, so the runner expands the command file the way
// OpenCode would: $ARGUMENTS is replaced; without it, the arguments follow the
// prompt after a blank line.
export function expandCommand(text, args) {
  const { fields, body } = splitFrontmatter(text)
  const prompt = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args) : `${body.trimEnd()}\n\n${args}\n`
  return { agent: fields.agent ?? null, model: fields.model ?? null, prompt }
}

// --resume and --review concern only the first milestone that needs the agent:
// `first` says this is that milestone, `changes` is its uncommitted work (`git
// status --short`). Milestones after it start fresh, even when --review is set.
export function resumeMode({ first, review, changes }) {
  const resuming = first && changes !== ''
  return { resuming, review: resuming && review, missingChanges: first && review && !resuming }
}

// Appended to the implement-plan prompt by --resume. The implementer's own
// instructions say to preserve pre-existing changes, which on its own makes a
// fresh session re-implement around a half-finished milestone. With --review
// the previous run got as far as the review, so the agent starts there.
export function resumeNote({ spec, changes, previousLog, review = false }) {
  const lines = [
    '',
    '## Resuming an interrupted run',
    '',
    `A previous run of ${spec} was interrupted before it finished. The uncommitted changes below are that run's partial implementation of this plan. Treat them as your own work in progress, not as pre-existing changes to preserve and work around:`,
    '',
    '```',
    changes.trimEnd(),
    '```',
    '',
  ]
  if (previousLog) {
    lines.push(`The previous run's log is \`${previousLog}\`. Read its last few hundred lines to see where it stopped; do not read the whole file.`, '')
  }
  if (review) {
    lines.push(
      'The previous run had finished the implementation and all acceptance commands passed; it stopped at the independent review. Do not re-check these changes against plan.md, do not rewrite them and do not re-run the acceptance commands first: start directly with the independent review (section 5 of your instructions), giving the reviewer the plan and these changes as usual.',
      '',
      'From there everything is unchanged: fallback, repair cycles and the review-round limit (sections 6-7). If the reviewer finds missing or wrong parts, fix them and re-run the acceptance commands. If the reviewer approves without any code change, the previous run\'s passing acceptance results still apply to this unchanged code and you may write STATUS as instructed above; the runner re-runs the acceptance commands before committing anyway.',
      '',
    )
  } else {
    lines.push(
      'Before writing code, review these changes against plan.md: keep what is correct, fix what is wrong, and implement only what is still missing. Do not start over or rewrite finished parts. If a listed change clearly belongs to no part of this plan, leave it untouched and mention it in your report.',
      '',
      'Everything else is unchanged: validate, run the independent review, and write STATUS only as instructed above.',
      '',
    )
  }
  return lines.join('\n')
}

// Appended to every implement-plan prompt. OpenCode v2 moves a foreground
// command that outlives its default 2-minute timeout to the background and
// tells the model it may end its response and be woken up when the command
// finishes. `opencode run` has no such wake-up: once the response ends the
// process exits, the private server takes the background command with it and
// the milestone fails without STATUS (M17's first run died this way while
// waiting for the full CI).
export function unattendedNote() {
  return [
    '',
    '## Running unattended',
    '',
    'You are running in a one-shot `opencode run` session with nobody watching. When your response ends, the whole run ends: nothing will wake you up again, and any background command is killed.',
    '',
    '- Run long commands (the full CI, a whole test suite, packaging, `pnpm install`) in the foreground and pass a `timeout` of 3600000 (60 minutes) to the shell tool, so they are not moved to the background. The runner has its own watchdog for commands that hang.',
    '- Do not start commands with `background: true`.',
    '- If a command was moved to the background anyway, do not end your response while it is still running: wait for it by reading its output file until it has finished, then continue.',
    '- End your response only after STATUS has been written as instructed above, or when you are stopping for good.',
    '- When you delegate to the reviewer, include these rules in its prompt.',
    '',
  ].join('\n')
}

// 2.0.18 is the version the workflow was verified with; earlier v2 releases
// ignored the `permissions:` frontmatter, which would leave the unattended
// agent allowed to do anything.
export const MIN_OPENCODE_VERSION = [2, 0, 18]

export function opencodeVersionSupported(output) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(output ?? ''))
  if (!match) return false
  const version = match.slice(1, 4).map(Number)
  const index = version.findIndex((part, position) => part !== MIN_OPENCODE_VERSION[position])
  return index < 0 || version[index] > MIN_OPENCODE_VERSION[index]
}

// The milestone commit's first line. The "MNN：" of the title is dropped (the
// scope already says M35) and a leading upper-case word is lower-cased:
// repositories that enforce conventional commits reject a subject starting with
// an upper-case letter (commitlint subject-case: "OAuth …", "OPOC …", "M01：…").
// A cross-repository milestone's number belongs to this repository, so the
// target's commit has no scope.
export function commitHeader({ number, title, cross = false }) {
  const subject = title.replace(/^M\d+[：:]\s*/u, '').replace(/^[A-Z][A-Za-z0-9]*/u, word => word.toLowerCase())
  return cross ? `feat: ${subject}` : `feat(M${number}): ${subject}`
}

// `milestone-repo` is relative to the repository the placeholder lives in
// (`base`), which is the current one for run-milestones but need not be for
// refine-plan.
export function crossRepoTarget(planText, base = root) {
  const repo = /<!--\s*milestone-repo:\s*(\S+)\s*-->/u.exec(planText)?.[1]
  const spec = /<!--\s*milestone-spec:\s*(\S+)\s*-->/u.exec(planText)?.[1]
  if (!repo && !spec) return null
  if (!repo || !spec) throw new Error('跨仓库里程碑需要同时写 milestone-repo 和 milestone-spec')
  return { repo: resolve(base, repo), spec: spec.replace(/\/+$/u, '') }
}

// Where the agent runs and where STATUS lives: this repository, or the target
// repository of a cross-repository placeholder.
export function targetOf(milestone) {
  const cross = crossRepoTarget(readFileSync(join(milestone.dir, 'plan.md'), 'utf8'))
  return cross ? { cwd: cross.repo, spec: cross.spec, cross: true } : { cwd: root, spec: milestone.rel, cross: false }
}

// The newest earlier log of this milestone (the interrupted run), or null.
function previousLogOf(name, currentLog) {
  if (!existsSync(logsDir)) return null
  const earlier = readdirSync(logsDir)
    .filter(file => file.startsWith(`${name}-`) && file.endsWith('.log') && join(logsDir, file) !== currentLog)
    .sort()
  return earlier.length ? join(logsDir, earlier.at(-1)) : null
}

export function statusOf(milestone) {
  const target = targetOf(milestone)
  const committed = git(['show', `HEAD:${target.spec}/STATUS`], { allowFailure: true, cwd: target.cwd })
  if (committed?.trim() === 'APPROVED') return 'done'
  const file = join(target.cwd, target.spec, 'STATUS')
  if (existsSync(file) && readFileSync(file, 'utf8').trim() === 'APPROVED') return 'approved-uncommitted'
  return 'pending'
}

// ---- process trees -----------------------------------------------------------

// ps TIME: [[dd-]hh:]mm:ss[.xx]
export function parseCpuTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(String(text).trim())
  if (!match) return 0
  const [, days = 0, hours = 0, minutes, seconds] = match
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

// Throws when the table cannot be read: an empty answer must never pass for
// "nothing is running", or the watchdog would stop watching (agent) or judge a
// healthy command stuck (acceptance). `spawner` replaces spawnSync in tests.
export function processTable(spawner = spawnSync) {
  if (process.platform === 'win32') {
    // Win32_Process exposes parent PIDs and cumulative CPU time. The encoded
    // script is constant, so process command lines never pass through a shell.
    const script = `Get-CimInstance Win32_Process | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        ppid = [int]$_.ParentProcessId
        cpu = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000
        command = [string]$_.CommandLine
      }
    } | ConvertTo-Json -Compress`
    const result = spawner('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    if (result.error || result.status !== 0) {
      throw new Error(`无法读取 Windows 进程表：${result.error?.message ?? result.stderr?.trim() ?? '未知错误'}`)
    }
    const output = result.stdout.trim()
    if (!output) return []
    const rows = JSON.parse(output)
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({
      pid: Number(row.pid), ppid: Number(row.ppid), cpu: Number(row.cpu), command: row.command ?? '',
    }))
  }
  const result = spawner('ps', ['-axo', 'pid=,ppid=,pgid=,time=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`无法读取进程表：${result.error?.message ?? (result.stderr?.trim() || `ps 以退出码 ${result.status} 结束`)}`)
  }
  const rows = []
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), cpu: parseCpuTime(match[4]), command: match[5] })
  }
  if (rows.length === 0) throw new Error('无法读取进程表：ps 没有列出任何进程')
  return rows
}

// The process with rootPid (if still listed) and all of its descendants.
export function subtree(rows, rootPid) {
  const children = new Map()
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid).push(row)
  }
  const found = rows.filter(row => row.pid === rootPid)
  const stack = [rootPid]
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()) ?? []) {
      found.push(child)
      stack.push(child.pid)
    }
  }
  return found
}

const isAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(done => setTimeout(done, ms))

// Kills a whole tree. The agent starts every command in its own process group,
// so signalling one group is not enough: collect the tree by parent PID first
// (children get re-parented once their parent dies), then signal each process.
export async function killTree(rootPid, graceMs = 10_000, readTable = processTable) {
  if (process.platform === 'win32') {
    // Windows has no Unix process groups. taskkill follows the child tree
    // before terminating its root, including detached child processes.
    spawnSync('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
      encoding: 'utf8', timeout: graceMs, windowsHide: true,
    })
    return
  }
  // Without a readable process table the root and its process group are still signalled.
  let rows = []
  try { rows = readTable() } catch { /* fall back to the group */ }
  const pids = subtree(rows, rootPid).map(row => row.pid)
  if (!pids.includes(rootPid)) pids.unshift(rootPid)
  const signalAll = signal => {
    try { process.kill(-rootPid, signal) } catch { /* not a group leader or gone */ }
    for (const pid of pids) { try { process.kill(pid, signal) } catch { /* gone */ } }
  }
  signalAll('SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && pids.some(isAlive)) await sleep(200)
  if (pids.some(isAlive)) signalAll('SIGKILL')
}

// A unit is one command: a shell the agent started, or an acceptance command.
// It counts as stalled when the CPU time of its whole tree grew by less than
// minCpuSeconds over the last windowMs. Processes that already exited keep
// their last seen CPU time, so a deadlocked test that keeps spawning (and
// timing out) short-lived children is still recognised as stalled.
export function createStallDetector({ windowMs, minCpuSeconds }) {
  const units = new Map()
  return function observe(now, snapshot) {
    const stalled = []
    const present = new Set()
    for (const unit of snapshot) {
      present.add(unit.pid)
      let state = units.get(unit.pid)
      if (!state) {
        state = { firstSeen: now, cpuByPid: new Map(), samples: [], command: unit.command, reported: false }
        units.set(unit.pid, state)
      }
      for (const member of unit.processes) {
        state.cpuByPid.set(member.pid, Math.max(state.cpuByPid.get(member.pid) ?? 0, member.cpu))
      }
      const total = [...state.cpuByPid.values()].reduce((sum, value) => sum + value, 0)
      state.samples.push({ at: now, total })
      // Keep the newest sample that is at least windowMs old as the baseline.
      while (state.samples.length > 1 && state.samples[1].at <= now - windowMs) state.samples.shift()
      const baseline = state.samples[0]
      if (!state.reported && baseline.at <= now - windowMs && total - baseline.total < minCpuSeconds) {
        state.reported = true
        stalled.push({ pid: unit.pid, command: state.command, idleMs: now - baseline.at, cpuGrowth: total - baseline.total })
      }
    }
    for (const pid of units.keys()) if (!present.has(pid)) units.delete(pid)
    return stalled
  }
}

const SHELL_COMMAND = /^(?:\S*\/)?(?:zsh|bash|sh|dash)\s+-c\s/u
// The executable (first token, quoted or not) of a Windows command line is a
// shell: cmd, PowerShell, or Git Bash's bash.exe/sh.exe. OpenCode runs its
// commands through Git Bash when it is installed, so bash must count too.
const WINDOWS_SHELL_COMMAND = /^(?:"(?:[^"]*[\\/])?(?:cmd|powershell|pwsh|bash|sh)(?:\.exe)?"|(?:[^"\s]*[\\/])?(?:cmd|powershell|pwsh|bash|sh)(?:\.exe)?)(?:\s|$)/iu

export function isWindowsShellCommand(command) {
  return WINDOWS_SHELL_COMMAND.test(String(command ?? '').trimStart())
}

// Windows: the agent is not a direct child of the root (the root is the cmd.exe
// that `shell: true` starts, and npm shims add more layers), so shells are
// looked up in the whole tree. Only the outermost ones count: pnpm and npm run
// their scripts through another `cmd /c`, and that nested shell must not become
// a second unit for the same command.
export function windowsShellUnits(rows, rootPid) {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const insideAnotherShell = row => {
    const seen = new Set()
    for (let parent = byPid.get(row.ppid); parent && parent.pid !== rootPid && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      seen.add(parent.pid)
      if (isWindowsShellCommand(parent.command)) return true
    }
    return false
  }
  return subtree(rows, rootPid)
    .filter(row => row.pid !== rootPid && isWindowsShellCommand(row.command) && !insideAnotherShell(row))
    .map(row => ({ pid: row.pid, command: row.command, processes: subtree(rows, row.pid) }))
}

// OpenCode v2 runs tools below its standalone server. A shell can also exec
// its final command, leaving only a Node/Python/etc. process in ps. Those tool
// commands retain the separate process group created for the shell.
export function unixAgentUnits(rows, rootPid) {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const isServer = row => /^(?:"[^"\n]*\/opencode"|(?:\S*\/)?opencode)\s+serve(?:\s|$)/u.test(row?.command ?? '')
  const candidates = subtree(rows, rootPid).filter(row => row.pid !== rootPid && !isServer(row)
    && (SHELL_COMMAND.test(row.command)
      || (row.pgid === row.pid && isServer(byPid.get(row.ppid)))))
  const commandPids = new Set(candidates.map(row => row.pid))
  return candidates.filter(row => {
    const seen = new Set()
    for (let parent = byPid.get(row.ppid); parent && parent.pid !== rootPid && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      seen.add(parent.pid)
      if (commandPids.has(parent.pid)) return false
    }
    return true
  }).map(row => ({ pid: row.pid, command: row.command, processes: subtree(rows, row.pid) }))
}

// 'agent': each outermost tool command below the agent or standalone server
// is one unit; the server and helpers sharing its group are not watched.
// 'command': the whole tree of an acceptance command is one unit.
function watchedUnits(rootPid, mode) {
  const rows = processTable()
  if (mode === 'command') {
    return [{ pid: rootPid, command: rows.find(row => row.pid === rootPid)?.command ?? '', processes: subtree(rows, rootPid) }]
  }
  if (process.platform === 'win32') return windowsShellUnits(rows, rootPid)
  return unixAgentUnits(rows, rootPid)
}

// Reading the process table can fail transiently (a slow WMI query on a busy
// Windows machine). Only this many failures in a row end the command.
export const PROCESS_TABLE_FAILURE_LIMIT = 3

const runningRoots = new Set()

// Resolves { code, timedOut, stalls }. `input`, when given, is written to the
// command's stdin. `stall` is { windowMs, minCpuSeconds, pollMs?, readUnits? };
// `readUnits(rootPid, watch)` replaces the process-table read in tests.
export function run(command, args, { logFile, shell = false, timeoutMs, cwd = root, watch = null, stall = null, input } = {}) {
  return new Promise((resolvePromise) => {
    // Unix: its own process group, so the whole group can be signalled.
    // Windows: taskkill /T follows the tree without that, and a detached child
    // gets its own console, where opencode reads no stdin and writes no output.
    const child = spawn(command, args, { cwd, shell, detached: process.platform !== 'win32', windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // PWD too: tools that read it instead of the real cwd would otherwise stay in the parent's repository.
      env: { ...process.env, PWD: cwd } })
    if (input !== undefined) {
      child.stdin.on('error', () => { /* the command exited without reading everything */ })
      child.stdin.end(input)
    }
    runningRoots.add(child.pid)
    const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null
    const forward = target => chunk => { target.write(chunk); log?.write(chunk) }
    const note = text => { process.stderr.write(text); log?.write(text) }
    let timedOut = false
    let stalls = 0
    const detector = watch && stall ? createStallDetector(stall) : null
    let tableFailures = 0
    const poll = detector ? setInterval(() => {
      const now = Date.now()
      let snapshot
      try {
        snapshot = (stall.readUnits ?? watchedUnits)(child.pid, watch)
        tableFailures = 0
      } catch (error) {
        tableFailures += 1
        const reason = error instanceof Error ? error.message : String(error)
        if (tableFailures < PROCESS_TABLE_FAILURE_LIMIT) {
          note(`\n⚠ 看门狗这一轮读不到进程状态，下一轮重试（${tableFailures}/${PROCESS_TABLE_FAILURE_LIMIT}）：${reason}\n`)
        } else if (tableFailures === PROCESS_TABLE_FAILURE_LIMIT) {
          stalls += 1
          note(`\n⚠ 看门狗连续 ${tableFailures} 次读不到进程状态，无法判断是否卡住，结束它：${reason}\n`)
          void killTree(child.pid)
        }
        return
      }
      for (const unit of detector(now, snapshot)) {
        stalls += 1
        note(`\n⚠ 看门狗：这条命令已经 ${formatDuration(unit.idleMs)} 没有进展（整棵进程树的 CPU 时间只增加了 ${unit.cpuGrowth.toFixed(1)} 秒），判定为卡住，结束它：\n  ${unit.command.slice(0, 300)}\n`)
        void killTree(unit.pid)
      }
    }, stall.pollMs ?? 30_000) : null
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      note(`\n⏱ 超过 ${formatDuration(timeoutMs)}，结束进程。\n`)
      void killTree(child.pid)
    }, timeoutMs) : null
    const done = result => {
      clearTimeout(timer)
      clearInterval(poll)
      runningRoots.delete(child.pid)
      log?.end()
      // While interrupting, the main flow must not carry on and report a
      // failure: the interrupt handler finishes the cleanup and exits.
      if (!interrupting) resolvePromise(result)
    }
    child.stdout.on('data', forward(process.stdout))
    child.stderr.on('data', forward(process.stderr))
    child.on('close', code => done({ code: code ?? 1, timedOut, stalls }))
    child.on('error', error => { process.stderr.write(`${error.message}\n`); done({ code: 1, timedOut, stalls }) })
  })
}

// On Unix, Ctrl+C reaches only this process: the agent runs in its own process
// group. On Windows it shares the console and gets Ctrl+C too. Either way, stop
// everything it started before exiting, so nothing keeps running orphaned.
let onInterrupt = null
let interrupting = false
// `afterStop` runs once everything is stopped, before exiting; other drivers
// (scripts/refine-plan.mjs) pass their own.
export function installInterruptHandler(afterStop = () => {
  onInterrupt?.()
  process.stderr.write('已全部结束。工作区里的改动保留，之后可以用 --resume 让 agent 接着上次的半成品做；实现已完成、只差审查时用 --review。\n')
  printReport()
}) {
  const handler = async signal => {
    if (interrupting) process.exit(130)
    interrupting = true
    process.stderr.write(`\n收到 ${signal}，正在结束 opencode 和它启动的全部进程……（再按一次 Ctrl+C 立即退出）\n`)
    await Promise.all([...runningRoots].map(pid => killTree(pid)))
    afterStop()
    process.exit(130)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, handler)
}

// The numbers this run covers, and whether --only/--to narrowed them, for the
// "continue here" hint. Set by main() once the arguments are read.
let selection = { numbers: [], restricted: false }

function fail(message, milestone, report = true) {
  process.stderr.write(`\n✗ ${message}\n`)
  if (milestone) process.stderr.write(`  修好后从这里继续：run-milestones ${continueSelection(selection.numbers, milestone.number, selection.restricted)}\n`)
  if (report) printReport()
  process.exit(1)
}

// pushPending for a run. A failed or refused push stops it, but the commits are
// made, so running again with --push pushes them.
function pushOrFail(repositories, committed, options) {
  try { return pushPending(repositories, { allowMain: options.allowMain }) } catch (error) {
    return fail(pushFailureMessage(error, committed), null, false)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const opencode = process.env.OPENCODE_BIN || 'opencode'
  if (options.report) { printReport(); return }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (PROTECTED_BRANCHES.includes(branch) && !options.allowMain) {
    fail(`当前在 ${branch} 分支。请先切到开发分支，或加 --allow-main。`)
  }

  const milestones = selectMilestones(listMilestones(), options)
  if (milestones.length === 0) fail('没有匹配的里程碑。')
  selection = { numbers: milestones.map(item => item.number), restricted: Boolean(options.only || options.to) }

  const plan = milestones.map(item => ({ ...item, target: targetOf(item) })).map(item => ({ ...item, status: statusOf(item) }))
  process.stdout.write(`分支：${branch}\n`)
  for (const item of plan) {
    const where = item.target.cross ? `  → ${item.target.cwd} ${item.target.spec}` : ''
    process.stdout.write(`  ${item.name}  ${{ done: '✓ 已完成', 'approved-uncommitted': '… 已审查通过，待验收提交', pending: '· 待执行' }[item.status]}${where}\n`)
  }
  // An acceptance block the runner cannot use would only be noticed after the
  // agent has worked for hours (or, worse, verify nothing), so every milestone
  // still to run is checked now, --dry-run included.
  const unusablePlans = []
  for (const item of plan.filter(entry => entry.status !== 'done')) {
    try { acceptanceCommands(readFileSync(join(item.dir, 'plan.md'), 'utf8')) } catch (error) { unusablePlans.push(`  ${item.name}：${error.message}`) }
  }
  if (unusablePlans.length > 0) fail(`这些里程碑的验收命令无法使用，请先修改 plan.md：\n${unusablePlans.join('\n')}`, null, false)
  if (options.dryRun) return

  const opencodeVersionCommand = process.platform === 'win32'
    ? windowsShellCommand(opencode, ['--version'])
    : opencode
  const opencodeVersion = spawnSync(opencodeVersionCommand, process.platform === 'win32' ? [] : ['--version'], {
    encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
  })
  if (opencodeVersion.status !== 0) {
    fail(`找不到 opencode 命令行（${opencode}）。请先安装 opencode CLI，或用 OPENCODE_BIN 指定路径。`)
  }
  if (!opencodeVersionSupported(opencodeVersion.stdout)) {
    fail(`opencode 版本过低（${opencodeVersion.stdout.trim()}），需要 ${MIN_OPENCODE_VERSION.join('.')} 或更高。请运行 opencode upgrade。`)
  }
  let config
  try { config = loadConfig(root) } catch (error) { fail(error.message) }
  const missing = missingEnv(config)
  if (missing.length > 0) fail(`没有设置这些环境变量（${config.file} 的 requiredEnv 要求）：\n  ${missing.join('\n  ')}`)
  // The watchdog judges a command stuck by the CPU time in the process table. Where
  // that cannot be read (typically a sandbox that blocks ps) it would end the agent
  // minutes in, so it is better to say so before anything starts.
  try { processTable() } catch (error) {
    fail(`看门狗靠读取进程表判断命令有没有卡住，但这里读不到：${error.message}\n  请在能运行 ps 的终端里启动（沙箱里常被禁止）。`, null, false)
  }
  mkdirSync(logsDir, { recursive: true })
  installInterruptHandler()
  const stall = { windowMs: options.stallMinutes * 60_000, minCpuSeconds: options.stallCpuSeconds }

  const runStarted = Date.now()
  // --resume applies to the first milestone that needs the agent, nothing later.
  let resumePending = options.resume
  for (const milestone of plan) {
    if (milestone.status === 'done') continue
    const started = Date.now()
    let agentMs = 0
    let acceptanceMs = 0
    let stalls = 0
    const finish = (result, message) => {
      onInterrupt = null
      recordTiming({ milestone: milestone.name, startedAt: new Date(started).toISOString(), agentMs, acceptanceMs, totalMs: Date.now() - started, stalls, result })
      if (message) fail(message, milestone)
    }
    onInterrupt = () => recordTiming({ milestone: milestone.name, startedAt: new Date(started).toISOString(), agentMs, acceptanceMs, totalMs: Date.now() - started, stalls, result: 'interrupted' })
    const planText = readFileSync(join(milestone.dir, 'plan.md'), 'utf8')
    const title = milestoneTitle(planText, milestone.name)
    const logFile = join(logsDir, `${milestone.name}-${new Date().toISOString().replace(/[:.]/gu, '-')}.log`)
    process.stdout.write(`\n=== ${title} ===\n日志：${logFile}\n`)

    const { target } = milestone
    if (target.cross) {
      if (!existsSync(join(target.cwd, target.spec, 'plan.md'))) fail(`找不到跨仓库规格：${join(target.cwd, target.spec, 'plan.md')}`, milestone, false)
      const targetBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target.cwd }).trim()
      if (PROTECTED_BRANCHES.includes(targetBranch) && !options.allowMain) {
        fail(`${target.cwd} 当前在 ${targetBranch} 分支。请先切到开发分支，或加 --allow-main。`, milestone, false)
      }
      let targetConfig
      try { targetConfig = loadConfig(target.cwd) } catch (error) { fail(error.message, milestone, false) }
      const targetMissing = missingEnv(targetConfig)
      if (targetMissing.length > 0) {
        fail(`没有设置目标仓库要求的环境变量（${targetConfig.file} 的 requiredEnv）：\n  ${targetMissing.join('\n  ')}`, milestone, false)
      }
      process.stdout.write(`目标仓库：${target.cwd}（分支 ${targetBranch}），规格：${target.spec}\n`)
    }
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: target.cwd }).trim()
    if (milestone.status === 'pending') {
      const changes = git(['status', '--short', '--untracked-files=all'], { cwd: target.cwd }).trim()
      const resume = resumeMode({ first: resumePending, review: options.review, changes })
      resumePending = false
      if (resume.missingChanges) {
        fail(`--review 需要工作区里有 ${milestone.name} 已完成的未提交改动，但工作区是干净的。`, milestone, false)
      }
      if (dirty && !options.allowDirty && !resume.resuming) {
        fail(`工作区有未提交的改动，无法开始 ${milestone.name}。确认这些改动属于本里程碑后加 --allow-dirty 继续，否则先处理掉。`, milestone, false)
      }
      // The target repository's own .opencode: opencode runs with the target
      // as its working directory, which also selects the project.
      const commandFile = join(target.cwd, '.opencode', 'commands', 'implement-plan.md')
      if (!existsSync(commandFile)) fail(`找不到 opencode 命令文件：${commandFile}`, milestone, false)
      const command = expandCommand(readFileSync(commandFile, 'utf8'), target.spec)
      if (!command.agent) fail(`${commandFile} 的 frontmatter 没有写 agent。`, milestone, false)
      // `opencode run --agent` keeps the session's default model instead of the
      // agent's own, so the model is passed explicitly (command first, as in OpenCode).
      const agentFile = join(target.cwd, '.opencode', 'agents', `${command.agent}.md`)
      const model = command.model ?? (existsSync(agentFile) ? splitFrontmatter(readFileSync(agentFile, 'utf8')).fields.model : null)
      if (!model) fail(`找不到 ${command.agent} 的模型：${agentFile} 的 frontmatter 需要写 model。`, milestone, false)
      let prompt = command.prompt + unattendedNote()
      if (resume.resuming) {
        prompt += resumeNote({ spec: target.spec, changes, previousLog: previousLogOf(milestone.name, logFile), review: resume.review })
        process.stdout.write(resume.review
          ? '从独立审查继续：工作区里的改动作为本里程碑已完成的实现，agent 直接进入 review。\n'
          : '继续上次中断的实现：工作区里的改动作为本里程碑的半成品交给 agent。\n')
      }
      const agentStarted = Date.now()
      const agentArgs = ['run', '--standalone', '--agent', command.agent, '--model', model, '--title', milestone.name]
      const agentCommand = process.platform === 'win32' ? windowsShellCommand(opencode, agentArgs) : opencode
      const agent = await run(agentCommand, process.platform === 'win32' ? [] : agentArgs,
        { logFile, cwd: target.cwd, shell: process.platform === 'win32', input: prompt,
          timeoutMs: options.agentTimeoutHours * 3_600_000, watch: 'agent', stall })
      agentMs = Date.now() - agentStarted
      stalls += agent.stalls
      if (agent.timedOut) finish('timeout', `opencode 超过 ${options.agentTimeoutHours} 小时没有结束，已终止。`)
      if (agent.code !== 0) finish('failed', `opencode 以退出码 ${agent.code} 结束。`)
      if (statusOf(milestone) !== 'approved-uncommitted') {
        finish('failed', `${target.spec}/STATUS 没有写入 APPROVED：实现或审查没有完成，看日志了解原因。`)
      }
    } else {
      process.stdout.write('审查已通过，直接重新验收。\n')
    }

    const acceptanceStarted = Date.now()
    for (const command of acceptanceCommands(planText)) {
      process.stdout.write(`\n$ ${command}\n`)
      const result = await run(command, [], { logFile, shell: true, timeoutMs: options.commandTimeoutMinutes * 60_000, watch: 'command', stall })
      acceptanceMs = Date.now() - acceptanceStarted
      stalls += result.stalls
      if (result.timedOut) finish('timeout', `验收命令超过 ${options.commandTimeoutMinutes} 分钟：${command}`)
      if (result.stalls) finish('failed', `验收命令卡住（${options.stallMinutes} 分钟没有进展），被看门狗结束：${command}`)
      if (result.code !== 0) finish('failed', `验收命令失败：${command}`)
    }
    acceptanceMs = Date.now() - acceptanceStarted

    git(['add', '-A', '--', '.'], { cwd: target.cwd })
    const timing = `耗时：实现与审查 ${formatDuration(agentMs)}，验收 ${formatDuration(acceptanceMs)}，合计 ${formatDuration(Date.now() - started)}。`
    const header = commitHeader({ number: milestone.number, title, cross: target.cross })
    const message = `${header}\n\n按 ${target.spec}/plan.md 实现，经 opencode 实现与审查工作流完成并通过验收命令。\n${timing}`
    git(['commit', '-q', '-m', message], { cwd: target.cwd })
    finish('committed')
    process.stdout.write(`✓ 已提交（${target.cwd}）：${git(['log', '--oneline', '-1'], { cwd: target.cwd }).trim()}\n  ${timing}\n`)
    if (options.push) pushOrFail([target.cwd], `${milestone.name} 已提交`, options)
  }
  // Milestones skipped above as done may still wait for a push an earlier run could not make.
  if (options.push) {
    for (const cwd of pushOrFail(plan.map(item => item.target.cwd), '里程碑都已提交', options)) process.stdout.write(`已补推：${cwd}\n`)
  }
  process.stdout.write(`\n本次运行完成，用时 ${formatDuration(Date.now() - runStarted)}。\n`)
  printReport()
}

if (isMain(import.meta.url)) {
  main().catch(error => fail(error.message))
}
