#!/usr/bin/env node
// Runs run-milestones hands-off in the current repository and reports the outcome by email.
//
//   1. Run the runner with the given arguments (--only/--from/…), always with
//      --push.
//   2. Success: email ✅ with the milestones completed, the commits pushed and
//      the time spent.
//   3. Failure: start headless Claude Code (`claude -p`) on the failure. It
//      investigates, fixes what it safely can and answers with a structured
//      decision, on which this script re-runs the runner:
//        accept   only the environment was at fault and no file changed since
//                 the independent review approved: STATUS stays APPROVED, the
//                 runner skips the agent, re-runs acceptance and commits
//        review   Claude changed code: STATUS is cleared and the runner re-runs
//                 with --review, so the opencode reviewer re-reviews everything
//        resume   the implementation is unfinished: STATUS cleared, --resume
//        give-up  stop
//      At most --fix-rounds rounds per milestone (default 2); a later round
//      resumes the same Claude session with the new failure.
//      Fixed: the runner commits and pushes, email ✅ with what Claude fixed.
//      Not fixed: email ❌ with the root cause and what the user has to do,
//      then (in a terminal) reopen that Claude session with Remote Control, so
//      the user can take over at this computer or from the Claude app.
//
// Success is read from git, never from Claude's words: every milestone in scope
// must have STATUS=APPROVED committed in HEAD, and HEAD must equal its
// upstream. Claude never commits or pushes; the runner does both after its own
// acceptance run. `accept` is downgraded to `review` when the working tree
// changed during Claude's round, so no change reaches a commit unreviewed.
//
//   run-milestones-auto --only 23
//   run-milestones-auto --only 23,24            # exactly these two
//   run-milestones-auto --from 23 --to 26 --fix-rounds 1
//
// Own options; everything else is passed to the runner:
//   --fix-rounds <n>              Claude rounds per milestone (default 2; 0 = never)
//   --claude-timeout-minutes <n>  one Claude round (default 60)
//   --notify-config <file>        mail settings (default ~/.opencode-workflows/notify.env)
//   --no-handover                 do not reopen the Claude session after giving up
//   -h, --help                    usage (USAGE below, in Chinese for the user)
// --dry-run and --report only call the runner.
//
// Mail settings: see notify-mail.mjs. They are read here and passed to
// the mailer only, never put into process.env, so neither the runner, opencode
// nor Claude can see them. Without the file everything runs, without email.
//
// Claude: the `claude` CLI, Claude Code 2.1.259 or later (--permission-prompts),
// logged in; handing over needs a claude.ai subscription login (Remote Control
// does not work with an API key). On Windows claude.exe is started directly
// (npm's claude.cmd shim is followed to it) rather than through cmd.exe as the
// runner does for opencode: the --json-schema argument is JSON, and
// windowsShellCommand rightly refuses quotes. CLAUDE_BIN overrides the lookup.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, loadConfig, repoRootOf } from './config.mjs'
import { DEFAULT_CONFIG_FILE, loadMailConfig, sendMail } from './notify-mail.mjs'
import { continueSelection, formatDuration, killTree, listMilestones, milestoneTitle, protectedBranch, selectMilestones, statusOf, summarizeTimings, targetOf } from './run-milestones.mjs'

// The repository this run works on (the current directory's), and the runner
// next to this file in the package.
const root = repoRootOf()
const runnerScript = join(dirname(fileURLToPath(import.meta.url)), 'run-milestones.mjs')
const logsDir = join(root, '.milestone-logs')
const timingsFile = join(logsDir, 'timings.jsonl')
const DEFAULT_MAIL_TAG = '[opencode-workflows]'
export const MIN_CLAUDE_VERSION = [2, 1, 259]

export const USAGE = `用法：run-milestones-auto [驱动脚本的参数] [本脚本的参数]

在当前仓库无人值守地跑 run-milestones（总是带 --push），结束后发邮件：
  成功       邮件「✅ 成功」：完成的里程碑、推送的提交、耗时
  失败       交给 Claude Code（claude -p）分析修复，按它的结论重跑驱动脚本：
               accept 重新验收 / review 重新审查 / resume 继续实现 / give-up 放弃
    修好了   驱动脚本重新验收、提交并推送，邮件「✅ 成功（Claude 修复后）」写明 Claude 做了什么
    没修好   邮件「❌ 失败：根因」写明你要做什么；终端里随后用 Remote Control 打开那个
             Claude 会话，电脑上直接接手，或在手机 Claude App → Code 里接手
  是否成功只看 git：范围内每个里程碑的 STATUS 在 HEAD 里是 APPROVED，且 HEAD 已推送。

驱动脚本的参数（原样转给 run-milestones.mjs，见它开头的注释）：
  --only NN（可以写多个：--only 23,24 或 --only 23-26,29）、--from NN、--to NN、--resume、--review、
  --allow-dirty、--agent-timeout-hours 等；--only、--from、--to 一起用时取交集
  --dry-run、--report 只调用驱动脚本，不修复、不发邮件

本脚本的参数：
  --fix-rounds <n>              每个里程碑最多几轮 Claude 修复（默认 2；0 = 不修，只发邮件）
  --claude-timeout-minutes <n>  一轮 Claude 的时间上限（默认 60）
  --notify-config <文件>        邮件配置（默认 ~/.opencode-workflows/notify.env）
  --no-handover                 放弃后不在终端里打开 Claude 会话
  -h, --help                    显示本说明

例子：
  run-milestones-auto --only 23
  run-milestones-auto --only 23,24
  run-milestones-auto --from 23 --to 26 --fix-rounds 1

邮件配置放在所有仓库之外（Windows：%USERPROFILE%\\.opencode-workflows\\notify.env；旧位置 .qiwi-milestones 也认），一行一个 KEY=VALUE：
  SMTP_USER=<QQ 号>@qq.com
  SMTP_PASS=<QQ 邮箱的授权码，不是 QQ 密码>
  MAIL_TO=<收件地址>             可选，默认同 SMTP_USER；多个用逗号分隔
  授权码：QQ 邮箱网页版 → 设置 → 账户 → POP3/IMAP/SMTP 服务 → 开启 → 生成授权码
  试发一封：opencode-workflows-mail --test
没有这个文件时照常运行，只是不发邮件。

Claude：需要 Claude Code 2.1.259 或更高并已登录；手机接管（Remote Control）需要用 claude.ai
订阅账号登录，不能用 API key。每一轮的提示词和输出在 .milestone-logs/claude-*.log。
详见根 README「无人值守跑里程碑」。
`

export function parseArgs(argv) {
  const options = { fixRounds: 2, claudeTimeoutMinutes: 60, notifyConfig: DEFAULT_CONFIG_FILE, handover: true, help: false, runnerArgs: [] }
  const value = index => {
    if (argv[index] === undefined) throw new Error(`${argv[index - 1]} 需要一个值`)
    return argv[index]
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fix-rounds') options.fixRounds = Number(value(++index))
    else if (arg === '--claude-timeout-minutes') options.claudeTimeoutMinutes = Number(value(++index))
    else if (arg === '--notify-config') options.notifyConfig = resolve(value(++index))
    else if (arg === '--no-handover') options.handover = false
    else if (arg === '-h' || arg === '--help') options.help = true
    else options.runnerArgs.push(arg)
  }
  if (!Number.isInteger(options.fixRounds) || options.fixRounds < 0) throw new Error('--fix-rounds 需要非负整数')
  if (!Number.isFinite(options.claudeTimeoutMinutes) || options.claudeTimeoutMinutes <= 0) throw new Error('--claude-timeout-minutes 需要正数')
  return options
}

// The first run keeps the user's own --resume/--review; a re-run carries the
// flag for Claude's decision instead. --push is always on.
export function runnerArgsFor(baseArgs, mode = null) {
  const args = baseArgs.filter(arg => arg !== '--push' && (mode === null || (arg !== '--resume' && arg !== '--review')))
  if (mode === 'review' || mode === 'resume') args.push(`--${mode}`)
  return [...args, '--push']
}

const valueOfFlag = (runnerArgs, flag) => {
  const index = runnerArgs.indexOf(flag)
  return index >= 0 ? runnerArgs[index + 1] : null
}

export function milestonesInScope(runnerArgs, milestones) {
  return selectMilestones(milestones, {
    only: valueOfFlag(runnerArgs, '--only'), from: valueOfFlag(runnerArgs, '--from'), to: valueOfFlag(runnerArgs, '--to'),
  })
}

// --only or --to narrows the run, so "--from NN" would no longer stay inside it.
export const isRestricted = runnerArgs => runnerArgs.includes('--only') || runnerArgs.includes('--to')

// The runner ends every failure with "✗ <message>" and, when a milestone was
// involved, "修好后从这里继续：run-milestones --from NN" (or
// "--only NN,…" when the run was restricted by --only/--to).
export function parseFailure(output) {
  const lines = String(output).split(/\r?\n/u)
  const message = lines.findLast(line => line.startsWith('✗ '))?.slice(2).trim() ?? null
  const number = lines.map(line => /修好后从这里继续：.*--(?:from|only) (\d{2,})\b/u.exec(line)?.[1]).findLast(Boolean) ?? null
  return { message, number }
}

// The runner's own failed push, "git push 失败：…" (pushFailureMessage in
// run-milestones.mjs keeps it at the start of the line): the commits are made and
// pushing again is safe. A push the runner refused (a protected branch) does not
// start that way, and is not pushed here either.
export const isPushFailure = message => /^git push\b/u.test(message ?? '')

// ---- Claude -----------------------------------------------------------------

export const DECISIONS = ['accept', 'review', 'resume', 'give-up']

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    next: { type: 'string', enum: DECISIONS },
    rootCause: { type: 'string', description: '一句话根因（简体中文）' },
    summary: { type: 'string', description: '分析与处理经过（简体中文）' },
    actionsTaken: { type: 'array', items: { type: 'string' }, description: '已经做了什么，每项一句（简体中文）' },
    userActions: { type: 'array', items: { type: 'string' }, description: '需要用户做什么，每项一句（简体中文）；不需要时为空数组' },
  },
  required: ['next', 'rootCause', 'summary', 'actionsTaken', 'userActions'],
  additionalProperties: false,
}

export function validateDecision(value) {
  if (!value || typeof value !== 'object') return '没有 structured_output'
  if (!DECISIONS.includes(value.next)) return `next 不是 ${DECISIONS.join(' / ')} 之一`
  for (const key of ['rootCause', 'summary']) if (typeof value[key] !== 'string' || !value[key].trim()) return `${key} 为空`
  for (const key of ['actionsTaken', 'userActions']) {
    if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string')) return `${key} 不是字符串数组`
  }
  return null
}

// `claude -p --output-format json` prints one result object:
// { type: 'result', subtype, is_error, result, session_id, structured_output, total_cost_usd, … }
export function parseClaudeOutput(stdout) {
  const text = String(stdout).trim()
  let parsed = null
  for (const candidate of [text, ...text.split(/\r?\n/u).reverse()]) {
    if (!candidate.startsWith('{')) continue
    try { parsed = JSON.parse(candidate); break } catch { /* try the next candidate */ }
  }
  if (!parsed) return { error: `Claude 没有输出可解析的 JSON：${text.slice(0, 200) || '（空）'}` }
  const sessionId = parsed.session_id ?? null
  const costUsd = parsed.total_cost_usd ?? null
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    const how = parsed.subtype && parsed.subtype !== 'success' ? `以 ${parsed.subtype} 结束` : '报错'
    return { sessionId, costUsd, error: `Claude ${how}：${String(parsed.result ?? parsed.errors ?? '').slice(0, 300)}` }
  }
  const problem = validateDecision(parsed.structured_output)
  if (problem) return { sessionId, costUsd, error: `Claude 的结论格式不对：${problem}` }
  return { sessionId, costUsd, decision: parsed.structured_output }
}

export function claudeArgs({ sessionId, resume, name, addDirs = [] }) {
  return [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(DECISION_SCHEMA),
    '--permission-mode', 'auto', '--permission-prompts', 'none',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId, '--name', name]),
    ...addDirs.flatMap(dir => ['--add-dir', dir]),
  ]
}

// CLAUDE_BIN, else `claude` on PATH. On Windows: claude.exe (native install),
// or the executable that npm's claude.cmd shim starts.
export function resolveClaudeBin({ env = process.env, platform = process.platform, exists = existsSync, read = file => readFileSync(file, 'utf8') } = {}) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN
  if (platform !== 'win32') return 'claude'
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').map(dir => dir.trim().replace(/^"(.*)"$/u, '$1')).filter(Boolean)
  for (const dir of dirs) {
    const exe = join(dir, 'claude.exe')
    if (exists(exe)) return exe
    const shim = join(dir, 'claude.cmd')
    if (!exists(shim)) continue
    const target = /"%~?dp0%?\\([^"]+?\.exe)"/iu.exec(read(shim))?.[1]
    if (target && exists(join(dir, target))) return join(dir, target)
  }
  throw new Error('找不到 claude.exe：请安装 Claude Code，或用环境变量 CLAUDE_BIN 指定 claude.exe 的完整路径')
}

export function claudeVersionSupported(output) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(output ?? ''))
  if (!match) return false
  const version = match.slice(1, 4).map(Number)
  const index = version.findIndex((part, position) => part !== MIN_CLAUDE_VERSION[position])
  return index < 0 || version[index] > MIN_CLAUDE_VERSION[index]
}

const fence = text => ['```', String(text).trimEnd() || '(empty)', '```'].join('\n')

function failureSection(context) {
  const { failure, runnerLog, statusPath, workingStatus, attempts, tail, gitStatus } = context
  const lines = [
    `- Runner's verdict: \`✗ ${failure.message ?? '(no ✗ line)'}\``,
    runnerLog
      ? `- Runner log of this attempt: \`${runnerLog.path}\` (${(runnerLog.bytes / 1_048_576).toFixed(1)} MB): the whole opencode session (implementer and reviewer) plus the acceptance commands' output. Read it with \`tail -n 300\` and \`grep -n\`, never whole.`
      : '- No runner log was written for this attempt (it failed before the agent or the acceptance commands started).',
    `- \`${statusPath}\` in the working tree: ${workingStatus === null ? 'missing' : `\`${workingStatus}\``}`,
  ]
  if (attempts.length) {
    lines.push('- Attempts recorded in `.milestone-logs/timings.jsonl`:')
    for (const entry of attempts) lines.push(`  - ${entry.startedAt}: ${entry.result}, agent ${formatDuration(entry.agentMs ?? 0)}, acceptance ${formatDuration(entry.acceptanceMs ?? 0)}`)
  }
  lines.push('- Last lines of the runner\'s output:', '', fence(tail), '', '- `git status --short`:', '', fence(gitStatus || '(clean)'))
  return lines
}

// What the fixer is told to protect and to know for one milestone. Claude runs
// in this repository; for a cross-repository milestone it works in the target
// too, so the target's protected documents count as well (named from here) and
// both repositories' machine notes apply (they describe the same machine).
export function fixRules({ root, rootConfig, target, targetConfig = null }) {
  const protectedDocs = [...rootConfig.protectedDocs]
  if (target.cross && targetConfig) {
    const prefix = relative(root, target.cwd).split(sep).join('/')
    protectedDocs.push(`${prefix}/specs/**/plan.md`, `${prefix}/specs/00-conventions.md`, ...targetConfig.protectedDocs.map(doc => `${prefix}/${doc}`))
  }
  const machineNotes = [...new Set([...rootConfig.machineNotes, ...(target.cross && targetConfig ? targetConfig.machineNotes : [])])]
  return { protectedDocs, machineNotes }
}

// The prompt of the first round. Later rounds resume the same session and get
// followUpPrompt() instead.
export function fixPrompt(context) {
  const { milestone, target, round, maxRounds, runnerCommand, repoRoot, runnerPath = 'run-milestones.mjs', protectedDocs = [], machineNotes = [] } = context
  const protectedList = ['specs/**/plan.md', 'specs/00-conventions.md', ...protectedDocs].map(item => `\`${item}\``)
  return [
    `# Unattended milestone fix: ${milestone.name}`,
    '',
    'You were started headless by `run-milestones-auto` because the milestone runner `run-milestones` failed. Nobody is watching this session and nobody will answer questions. Investigate, fix what you safely can, verify, then give your structured answer. The wrapper acts on `next` and emails your text fields to the user: write `rootCause`, `summary`, `actionsTaken` and `userActions` in Simplified Chinese, `rootCause` as one line.',
    '',
    '## The failure',
    '',
    `- Command: \`${runnerCommand}\` in \`${repoRoot}\``,
    `- Milestone: ${milestone.title} — \`${milestone.rel}/plan.md\``,
    ...(target.cross ? [`- Cross-repository milestone: the agent works in \`${target.cwd}\` on \`${target.spec}\`, and its STATUS lives there.`] : []),
    ...failureSection(context),
    '',
    '## How the runner works',
    '',
    `Read the header comment of \`${runnerPath}\` (the runner).` + ' In short: for a milestone whose STATUS is not `APPROVED` it runs the opencode implementer, who implements, validates, has an independent reviewer approve and then writes `APPROVED` into STATUS. For a milestone whose STATUS is `APPROVED` but not committed it skips the agent and re-runs the acceptance commands (the ```bash block under `## 验收命令` in plan.md) itself. Only when all of them pass does it commit (`git add -A`) and push.',
    '',
    '## Choose `next`',
    '',
    '- `accept`: the implementation was finished and approved by the independent review, and the failure was environmental or transient and is gone now. You changed no file in the repository, and the log shows no code change after the reviewer\'s approval. STATUS must contain exactly `APPROVED`; write it only when the log proves the review approved and just the runner\'s acceptance run failed. The runner then re-runs the acceptance commands and commits. If files did change during your round, the wrapper treats `accept` as `review`.',
    '- `review`: you changed code or tests to fix the failure, or the run stopped during the independent review. The wrapper clears STATUS and re-runs with `--review`: the opencode implementer starts with an independent review of all uncommitted changes (yours included), repairs what the reviewer finds, and the runner re-runs acceptance. Before answering, run the acceptance commands that failed (or the narrowest commands that cover your change) and make sure they pass.',
    '- `resume`: the implementation itself is unfinished (the agent timed out, crashed or stopped before completing plan.md). The wrapper clears STATUS and re-runs with `--resume`; a fresh agent finishes the work. Do not implement the rest of the plan yourself.',
    '- `give-up`: you cannot fix it safely, or the fix needs the user: a decision, a credential, a desktop application to close, a system or security setting, a conflict between plan.md and reality. Put the exact steps in `userActions`.',
    '',
    `This is round ${round} of at most ${maxRounds}. After the last round the user takes over this very session, from this computer or the Claude app.`,
    '',
    '## Rules',
    '',
    '- Never `git commit`, `push`, `reset`, `checkout`/`restore`, `stash` or `clean`, and never discard uncommitted changes: they are the milestone\'s work. The runner commits.',
    '- Do not weaken, skip, delete or loosen tests or acceptance commands: no `.skip`, no filters, no longer timeouts or added retries that hide a failure, no empty tests. Fix the cause.',
    `- Do not edit ${protectedList.slice(0, -1).join(', ')} or ${protectedList.at(-1)}. Follow \`specs/00-conventions.md\`; read it first.`,
    '- Do not kill, close or restart the user\'s desktop applications (editors, browsers, Docker Desktop and the like), and do not change system or security settings (icacls integrity labels or ACLs, Defender, firewall, services, registry). If the fix needs that, say exactly what in `userActions` and choose `give-up`.',
    '- Do not start commands that never end (watch mode, dev servers, interactive tools). Run long commands in the foreground with a generous timeout.',
    '- Read big logs with grep/tail, not whole.',
    '- Never copy secrets (keys, tokens, passwords, connection strings with passwords) into files or into your answer.',
    '',
    ...(machineNotes.length > 0 ? ['## Known facts about this machine', '', ...machineNotes.map(note => `- ${note}`), ''] : []),
  ].join('\n')
}

export function followUpPrompt(context) {
  const { round, maxRounds, runnerCommand, previous } = context
  const applied = previous.applied && previous.applied !== previous.decision?.next
    ? ` The wrapper applied it as \`${previous.applied}\`: ${previous.note}` : ''
  return [
    `# Round ${round} of ${maxRounds}: the re-run failed again`,
    '',
    `You answered \`next: ${previous.decision?.next}\`.${applied} The wrapper then ran \`${runnerCommand}\`, and it failed again:`,
    '',
    ...failureSection(context),
    '',
    'Same job, rules, machine facts and answer format as before. If this is the same root cause and you cannot fix it for good, choose `give-up` and tell the user exactly what to do.',
    '',
  ].join('\n')
}

// ---- reports ----------------------------------------------------------------

const label = milestones => {
  const names = milestones.map(item => `M${Number(item.number)}`)
  if (names.length === 0) return '里程碑'
  return names.length > 3 ? `${names[0]}–${names.at(-1)}` : names.join('、')
}
const oneLine = (text, max = 60) => {
  const line = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const resultLabel = { committed: '✓ 已提交', failed: '✗ 失败', timeout: '⏱ 超时', interrupted: '■ 手动中断' }
const nextLabel = { accept: 'accept（重新验收）', review: 'review（重新审查）', resume: 'resume（继续实现）', 'give-up': 'give-up（放弃）' }
const time = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false })

function timingLines(report) {
  const lines = report.timings.rows.map(row => `  ${row.milestone}  ${row.attempts} 次  实现与审查 ${formatDuration(row.agentMs)}  验收 ${formatDuration(row.acceptanceMs)}  合计 ${formatDuration(row.totalMs)}  ${resultLabel[row.result] ?? row.result}`)
  const claudeMs = report.rounds.reduce((sum, round) => sum + round.durationMs, 0)
  if (report.rounds.length) lines.push(`  Claude 分析修复 ${report.rounds.length} 轮，${formatDuration(claudeMs)}`)
  lines.push(`  总用时 ${formatDuration(report.finishedAt - report.startedAt)}（${time(report.startedAt)} → ${time(report.finishedAt)}）`)
  return lines
}

function commitLines(report) {
  const lines = []
  for (const entry of report.commits) {
    lines.push(`推送到 ${entry.upstream ?? '上游'} 的提交${entry.cwd === report.repoRoot ? '' : `（${entry.cwd}）`}：`)
    for (const line of entry.lines) lines.push(`  ${line}`)
  }
  return lines
}

function roundLines(rounds) {
  const lines = []
  for (const round of rounds) {
    const decided = round.decision ? nextLabel[round.decision.next] : '没有结论'
    lines.push(`  第 ${round.number} 轮 · ${round.milestone} · ${decided}${round.applied && round.applied !== round.decision?.next ? ` → 按 ${round.applied} 处理` : ''} · ${formatDuration(round.durationMs)}`)
    if (round.note) lines.push(`    说明：${round.note}`)
    if (round.error) lines.push(`    错误：${round.error}`)
    if (round.decision) {
      lines.push(`    根因：${round.decision.rootCause}`, `    经过：${round.decision.summary}`)
      if (round.decision.actionsTaken.length) {
        lines.push('    做了：')
        for (const item of round.decision.actionsTaken) lines.push(`      - ${item}`)
      }
    }
    lines.push(`    日志：${round.logFile}`)
  }
  return lines
}

export function successReport(report) {
  const done = report.completed.length ? report.completed : report.scope
  const subject = `${report.mailTag ?? DEFAULT_MAIL_TAG} ${label(done)} ✅ 成功${report.rounds.length ? '（Claude 修复后）' : ''}`
  const lines = [
    report.completed.length
      ? `里程碑已完成并推送（分支 ${report.branch}）。${report.rounds.length ? '中途失败过，Claude 修复后通过了驱动脚本自己的验收。' : ''}`
      : `范围内的里程碑都已完成，本次没有需要执行的（分支 ${report.branch}）。`,
    '',
  ]
  if (report.completed.length) {
    lines.push('完成的里程碑：')
    for (const item of report.completed) lines.push(`  ${item.title}（${item.rel}）`)
    lines.push('')
  }
  if (report.commits.length) lines.push(...commitLines(report), '')
  if (report.rounds.length) lines.push('Claude 修复了什么：', ...roundLines(report.rounds), '')
  lines.push('耗时（本次运行的全部尝试）：', ...timingLines(report), '', `命令：${report.command}`)
  return { subject, text: `${lines.join('\n')}\n` }
}

export function failureReport(report) {
  const { failed, rounds, session } = report
  const lastDecision = rounds.findLast(round => round.milestone === failed.milestone?.name)?.decision ?? null
  // Claude's verdict, else the runner's own "✗" line, else why the wrapper stopped.
  const cause = lastDecision?.rootCause ?? failed.message ?? report.reason ?? '未知原因'
  const resumeCommand = failed.milestone
    ? `run-milestones-auto ${continueSelection(report.scope.map(item => item.number), failed.milestone.number, report.restricted)}`
    : report.command
  const subject = `${report.mailTag ?? DEFAULT_MAIL_TAG} ${label(failed.milestone ? [failed.milestone] : report.scope)} ❌ 失败：${oneLine(cause)}`
  const lines = [
    failed.milestone
      ? `${failed.milestone.title}（${failed.milestone.rel}）没有完成，${rounds.length ? 'Claude 没能修好，' : ''}需要你处理。`
      : '里程碑驱动脚本在开始里程碑之前就失败了，需要你处理。',
    '',
    `根因：${cause}`,
  ]
  if (report.reason && report.reason !== cause) lines.push(`说明：${report.reason}`)
  if (failed.message && failed.message !== cause) lines.push(`驱动脚本报告：✗ ${failed.message}`)
  lines.push('')
  const userActions = lastDecision?.userActions ?? report.userActions ?? []
  lines.push('你需要做的：')
  if (userActions.length) userActions.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`))
  else lines.push('  按上面的原因和下面的日志修好，再按「修好后继续」的命令接着跑。')
  lines.push('')
  if (report.details) lines.push('详情：', ...report.details.split('\n').map(line => `  ${line}`), '')
  if (rounds.length) lines.push('Claude 已经做了：', ...roundLines(rounds), '')
  lines.push('日志：')
  if (failed.runnerLog) lines.push(`  驱动脚本：${failed.runnerLog}`)
  lines.push(`  耗时记录：${join(report.repoRoot, '.milestone-logs', 'timings.jsonl')}`, '')
  if (session) {
    lines.push(`接管 Claude 会话（会话 ID ${session.id}）：`)
    lines.push(report.handover
      ? `  手机：电脑上已经用 Remote Control 打开了这个会话，在 Claude App → Code 的会话列表里找「${session.title}」。电脑上那个终端窗口关掉后会话就离线了；看不到时在电脑上的会话里输入 /remote-control。`
      : `  手机：先在电脑上运行下面第二条命令，再到 Claude App → Code 的会话列表里找「${session.title}」。`)
    lines.push(`  电脑：在 ${report.repoRoot} 运行 claude --resume ${session.id}`)
    lines.push(`  电脑（同时开放给手机）：claude --resume ${session.id} --remote-control "${session.title}"`, '')
  }
  lines.push(`修好后继续：${resumeCommand}`)
  if (failed.milestone) lines.push('  （STATUS 已是 APPROVED 时直接重新验收；实现已完成、只差审查时加 --review；接着未完成的实现做加 --resume）')
  lines.push('')
  if (report.completed.length) {
    lines.push('本次已完成的里程碑：')
    for (const item of report.completed) lines.push(`  ${item.title}（${item.rel}）`)
    lines.push('')
  }
  if (report.commits.length) lines.push(...commitLines(report), '')
  lines.push('耗时（本次运行的全部尝试）：', ...timingLines(report), '', `命令：${report.command}`)
  return { subject, text: `${lines.join('\n')}\n` }
}

// ---- the loop ---------------------------------------------------------------

// Every side effect goes through `deps` (see createDeps below), so the tests
// drive this loop with fakes. Resolves { outcome: 'success' | 'failure' |
// 'interrupted', subject?, text?, handover? }.
export async function autoRun(options, deps) {
  const startedAt = deps.now()
  const all = deps.milestones()
  const scope = milestonesInScope(options.runnerArgs, all)
  const repos = [...new Set(scope.map(item => deps.repoOf(item)))]
  const startHeads = new Map(repos.map(cwd => [cwd, deps.head(cwd)]))
  const doneAtStart = new Set(scope.filter(item => deps.status(item) === 'done').map(item => item.name))
  const timingsMark = deps.timingsMark()
  const handoverPossible = options.handover && deps.canHandover()
  const rounds = []
  const sessions = new Map()
  let mode = null
  let pushRetried = false
  let lastRun = null

  const deliver = async (outcome, extra = {}) => {
    const failedName = extra.failed?.milestone?.name
    const session = failedName ? sessions.get(failedName) : null
    const liveSession = session?.started ? session : null
    const report = {
      command: deps.command, repoRoot: deps.repoRoot, mailTag: deps.mailTag, branch: deps.branch(), scope, rounds, startedAt, finishedAt: deps.now(),
      completed: scope.filter(item => !doneAtStart.has(item.name) && deps.status(item) === 'done'),
      commits: repos
        .map(cwd => ({ cwd, upstream: deps.upstreamName(cwd), lines: deps.commitsSince(cwd, startHeads.get(cwd)) }))
        .filter(entry => entry.lines.length),
      timings: summarizeTimings(deps.timingsSince(timingsMark)),
      session: liveSession, handover: Boolean(liveSession && handoverPossible), restricted: isRestricted(options.runnerArgs),
      ...extra,
    }
    const { subject, text } = outcome === 'success' ? successReport(report) : failureReport(report)
    deps.log(`\n${subject}\n\n${text}\n`)
    if (!deps.sendMail) {
      deps.log('（邮件通知未启用，没有发邮件。）\n')
    } else {
      try {
        await deps.sendMail(subject, text)
        deps.log('✉ 已发送邮件通知。\n')
      } catch (error) {
        deps.log(`⚠ 邮件发送失败：${error.message}\n`)
      }
    }
    return { outcome, subject, text, handover: report.handover ? liveSession : null }
  }

  for (;;) {
    lastRun = await deps.runRunner(runnerArgsFor(options.runnerArgs, mode))
    if (lastRun.interrupted || deps.interrupted()) return { outcome: 'interrupted' }
    const failure = lastRun.code === 0 ? null : parseFailure(lastRun.tail)
    if (!failure) {
      const pending = scope.filter(item => deps.status(item) !== 'done')
      if (pending.length) {
        return deliver('failure', { failed: { milestone: pending[0], message: null }, reason: `驱动脚本报告成功，但 ${pending.map(item => item.name).join('、')} 的 STATUS 在 HEAD 里不是 APPROVED。` })
      }
    }
    // Committed but not pushed: the runner's push failed (it stops right
    // there) or never happened. Push once more; on success carry on.
    const unpushed = repos.filter(cwd => !deps.isPushed(cwd))
    if (unpushed.length && (!failure || isPushFailure(failure.message))) {
      // The runner pushes only past its own --allow-main check, and so does this
      // retry: every repository is checked before the first one is pushed, so a
      // repository on master/main also keeps the others from being pushed halfway.
      const onMain = options.runnerArgs.includes('--allow-main')
        ? []
        : unpushed.map(cwd => ({ cwd, branch: deps.protectedBranch(cwd) })).filter(item => item.branch)
      if (onMain.length) {
        return deliver('failure', {
          failed: { milestone: null, message: null },
          reason: '里程碑已提交，但没有推送：有仓库在 master/main 分支上，没带 --allow-main 不会自动推送（其它仓库也不推，免得只推一半）。',
          details: [...onMain.map(item => `${item.cwd}：当前在 ${item.branch} 分支`), ...(failure ? [`驱动脚本报告：✗ ${failure.message}`] : [])].join('\n'),
          userActions: ['切到开发分支后重跑同一条命令；确实要推到 master/main 时，加 --allow-main 重跑。'],
        })
      }
      const failed = pushRetried ? unpushed.map(cwd => ({ cwd, ok: false, output: '已重试过一次推送' })) : unpushed.map(cwd => ({ cwd, ...deps.push(cwd) })).filter(result => !result.ok)
      pushRetried = true
      if (failed.length) {
        return deliver('failure', {
          failed: { milestone: null, message: failure?.message ?? null },
          reason: '里程碑已提交，但推送失败。',
          details: failed.map(result => `${result.cwd}：${result.output}`).join('\n'),
          userActions: ['检查网络和 git 凭据（远端有新提交时先 git pull --rebase），然后在仓库里运行 git push。'],
        })
      }
      deps.log('✓ 已补推送。\n')
      if (!failure) return deliver('success')
      mode = null
      continue
    }
    if (!failure) return deliver('success')

    const milestone = (failure.number && all.find(item => item.number === failure.number)) || deps.lastFailedMilestone(timingsMark, all)
    const runnerLog = milestone ? deps.runnerLog(milestone.name) : null
    const failed = { milestone, message: failure.message, runnerLog: runnerLog?.path ?? null }
    if (!milestone) {
      return deliver('failure', { failed, reason: '驱动脚本在开始里程碑之前就失败了（参数、环境或工具的问题），没有调用 Claude。' })
    }
    const previous = rounds.filter(round => round.milestone === milestone.name)
    if (previous.length >= options.fixRounds) {
      return deliver('failure', { failed, reason: options.fixRounds === 0 ? '自动修复已关闭（--fix-rounds 0）。' : `Claude 修复 ${previous.length} 轮后仍然失败。` })
    }

    let session = sessions.get(milestone.name)
    if (!session) {
      session = { id: deps.uuid(), title: `M${Number(milestone.number)} 待处理`, started: false }
      sessions.set(milestone.name, session)
    }
    const target = deps.targetOf(milestone)
    const context = {
      milestone, target, failure, runnerLog, repoRoot: deps.repoRoot, runnerPath: deps.runnerPath,
      ...(deps.fixRules ? deps.fixRules(target) : { protectedDocs: [], machineNotes: [] }),
      round: previous.length + 1, maxRounds: options.fixRounds, previous: previous.at(-1),
      runnerCommand: `run-milestones ${lastRun.args?.join(' ') ?? ''}`.trim(),
      statusPath: `${target.spec}/STATUS`, workingStatus: deps.workingStatus(milestone),
      attempts: deps.attemptsOf(milestone.name), tail: lastRun.tail.split(/\r?\n/u).slice(-60).join('\n'),
      gitStatus: deps.gitStatus(target.cwd),
    }
    const before = deps.fingerprint(milestone)
    const claudeStarted = deps.now()
    deps.log(`\n→ ${milestone.name} 失败，交给 Claude 分析修复（第 ${context.round}/${options.fixRounds} 轮，会话 ${session.id}）……\n`)
    const answer = await deps.runClaude({
      prompt: session.started ? followUpPrompt(context) : fixPrompt(context),
      sessionId: session.id, resume: session.started, name: `M${Number(milestone.number)} 自动修复`,
      milestone, addDirs: target.cross ? [target.cwd] : [], timeoutMs: options.claudeTimeoutMinutes * 60_000,
    })
    session.started ||= Boolean(answer.started)
    if (answer.sessionId) session.id = answer.sessionId
    const round = {
      milestone: milestone.name, number: context.round, durationMs: deps.now() - claudeStarted,
      decision: answer.decision ?? null, error: answer.error ?? null, logFile: answer.logFile ?? null, applied: null, note: null,
    }
    rounds.push(round)
    if (deps.interrupted()) return { outcome: 'interrupted' }
    if (answer.error) return deliver('failure', { failed, reason: `Claude 没有给出可用的结论：${answer.error}` })

    let next = answer.decision.next
    if (next === 'give-up') return deliver('failure', { failed })
    if (next === 'accept') {
      if (deps.fingerprint(milestone) !== before) {
        next = 'review'
        round.note = 'Claude 选择 accept，但这一轮里工作区的文件有改动，改按 review 处理，让审查员复查。'
      } else if (deps.workingStatus(milestone) !== 'APPROVED') {
        return deliver('failure', { failed, reason: `Claude 选择 accept，但 ${context.statusPath} 不是 APPROVED。` })
      }
    }
    if (next !== 'accept') deps.clearStatus(milestone)
    round.applied = next
    mode = next
    deps.log(`\n→ Claude 结论：${nextLabel[next]}。重新运行里程碑驱动脚本……\n`)
  }
}

// ---- real side effects ------------------------------------------------------

const children = new Map()
let interrupted = false
let handingOver = false

function gitOut(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

function readTimings() {
  if (!existsSync(timingsFile)) return []
  return readFileSync(timingsFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

// Fingerprint of everything uncommitted except STATUS files: tracked changes
// and the content of untracked, not ignored files.
function fingerprint(cwd) {
  const hash = createHash('sha256')
  hash.update(gitOut(['diff', 'HEAD', '--binary', '--', '.', ':(exclude,glob)specs/*/STATUS'], cwd) ?? '')
  const untracked = (gitOut(['ls-files', '--others', '--exclude-standard', '-z'], cwd) ?? '').split('\0')
    .filter(file => file && !/(^|\/)specs\/[^/]+\/STATUS$/u.test(file)).sort()
  for (const file of untracked) {
    hash.update(`\0${file}\0`)
    try { hash.update(readFileSync(join(cwd, file))) } catch { hash.update('?') }
  }
  return hash.digest('hex')
}

function track(child, kind) {
  children.set(child.pid, kind)
  child.on('close', () => children.delete(child.pid))
}

function runRunner(args) {
  process.stdout.write(`\n$ run-milestones ${args.join(' ')}\n`)
  return new Promise(resolvePromise => {
    let tail = ''
    let settled = false
    const finish = result => { if (!settled) { settled = true; resolvePromise({ args, tail, ...result }) } }
    const child = spawn(process.execPath, [runnerScript, ...args], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], env: process.env })
    track(child, 'runner')
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => { target.write(chunk); tail = (tail + chunk).slice(-64 * 1024) })
    }
    child.on('close', code => finish({ code: code ?? 1, interrupted: interrupted || code === 130 }))
    child.on('error', error => finish({ code: 1, tail: `✗ 无法启动驱动脚本：${error.message}` }))
  })
}

function runClaude({ prompt, sessionId, resume, name, milestone, addDirs, timeoutMs }) {
  mkdirSync(logsDir, { recursive: true })
  // Not "<milestone>-…": the runner takes the newest such log as the
  // interrupted run's log for --resume.
  const logFile = join(logsDir, `claude-${milestone.name}-${new Date().toISOString().replace(/[:.]/gu, '-')}.log`)
  writeFileSync(logFile, `# claude ${resume ? '--resume' : '--session-id'} ${sessionId}\n\n## Prompt\n\n${prompt}\n\n## stderr\n\n`)
  let bin
  try { bin = resolveClaudeBin() } catch (error) { return Promise.resolve({ error: error.message, started: false, logFile }) }
  process.stdout.write(`Claude 日志：${logFile}（最长 ${formatDuration(timeoutMs)}）\n`)
  return new Promise(resolvePromise => {
    let stdout = ''
    let started = false
    let timedOut = false
    let settled = false
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ started, logFile, ...result }) } }
    // Unix: its own process group, so killTree can signal the whole group.
    const child = spawn(bin, claudeArgs({ sessionId, resume, name, addDirs }), {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env: process.env,
    })
    child.on('spawn', () => { started = true })
    track(child, 'claude')
    const timer = setTimeout(() => { timedOut = true; void killTree(child.pid) }, timeoutMs)
    child.stdin.on('error', () => { /* exited without reading everything */ })
    child.stdin.end(prompt)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { process.stderr.write(chunk); appendFileSync(logFile, chunk) })
    child.on('close', code => {
      appendFileSync(logFile, `\n## stdout (exit ${code})\n\n${stdout}\n`)
      if (timedOut) return finish({ sessionId, error: `超过 ${formatDuration(timeoutMs)} 没有结束，已终止` })
      const parsed = parseClaudeOutput(stdout)
      finish({ ...parsed, sessionId: parsed.sessionId ?? sessionId, error: parsed.error ?? (code === 0 ? null : `claude 以退出码 ${code} 结束`) })
    })
    child.on('error', error => finish({ error: `无法启动 claude（${bin}）：${error.message}` }))
  })
}

function createDeps(mailConfig, command, config) {
  const repoOf = milestone => targetOf(milestone).cwd
  return {
    command, repoRoot: root, runnerPath: runnerScript, mailTag: `[${config.name}]`,
    // The target's own settings; a broken file there must not hide the failure being fixed.
    fixRules: target => {
      let targetConfig = null
      if (target.cross) { try { targetConfig = loadConfig(target.cwd) } catch { targetConfig = null } }
      return fixRules({ root, rootConfig: config, target, targetConfig })
    },
    now: () => Date.now(),
    uuid: () => randomUUID(),
    milestones: () => listMilestones().map(item => ({ ...item, title: milestoneTitle(readFileSync(join(item.dir, 'plan.md'), 'utf8'), item.name) })),
    targetOf, repoOf,
    status: milestone => statusOf(milestone),
    workingStatus: milestone => {
      const target = targetOf(milestone)
      const file = join(target.cwd, target.spec, 'STATUS')
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
    },
    // Back to what HEAD has (usually: no file), so the runner hands the
    // milestone to the agent again.
    clearStatus: milestone => {
      const target = targetOf(milestone)
      const file = join(target.cwd, target.spec, 'STATUS')
      if (!existsSync(file) || statusOf(milestone) === 'done') return
      const committed = gitOut(['show', `HEAD:${target.spec}/STATUS`], target.cwd)
      if (committed === null) unlinkSync(file)
      else writeFileSync(file, committed)
      process.stdout.write(`已清除 ${relative(root, file) || file} 里的 APPROVED，让 agent 重新接手。\n`)
    },
    fingerprint: milestone => fingerprint(repoOf(milestone)),
    head: cwd => gitOut(['rev-parse', 'HEAD'], cwd)?.trim() ?? null,
    isPushed: cwd => {
      const upstream = gitOut(['rev-parse', '@{u}'], cwd)?.trim()
      return Boolean(upstream) && upstream === gitOut(['rev-parse', 'HEAD'], cwd)?.trim()
    },
    upstreamName: cwd => gitOut(['rev-parse', '--abbrev-ref', '@{u}'], cwd)?.trim() ?? null,
    protectedBranch,
    branch: () => gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], root)?.trim() ?? '?',
    commitsSince: (cwd, from) => (from ? gitOut(['log', '--format=%h %s', `${from}..HEAD`], cwd) ?? '' : '').split('\n').filter(Boolean),
    push: cwd => {
      process.stdout.write(`\n$ git push（${cwd}）\n`)
      const result = spawnSync('git', ['push'], { cwd, encoding: 'utf8', windowsHide: true })
      return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || result.error?.message || '' }
    },
    gitStatus: cwd => (gitOut(['status', '--short', '--untracked-files=all'], cwd) ?? '').split('\n').slice(0, 100).join('\n'),
    timingsMark: () => readTimings().length,
    timingsSince: mark => readTimings().slice(mark),
    attemptsOf: name => readTimings().filter(entry => entry.milestone === name),
    lastFailedMilestone: (mark, milestones) => {
      const entry = readTimings().slice(mark).findLast(item => item.result !== 'committed')
      return entry ? milestones.find(item => item.name === entry.milestone) ?? null : null
    },
    runnerLog: name => {
      if (!existsSync(logsDir)) return null
      const file = readdirSync(logsDir).filter(item => item.startsWith(`${name}-`) && item.endsWith('.log')).sort().at(-1)
      return file ? { path: join(logsDir, file), bytes: statSync(join(logsDir, file)).size } : null
    },
    runRunner,
    runClaude,
    interrupted: () => interrupted,
    canHandover: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    sendMail: mailConfig ? (subject, text) => sendMail(mailConfig, { subject, text }) : null,
    log: text => process.stdout.write(text),
  }
}

// On Windows, Ctrl+C reaches every process on the console; on Unix the runner
// shares this process group. Either way the runner stops opencode and records
// the interrupted attempt itself, so wait for it; Claude is simply stopped.
function installInterruptHandler() {
  const handler = async signal => {
    if (handingOver) return
    if (interrupted) {
      await Promise.all([...children.keys()].map(pid => killTree(pid)))
      process.exit(130)
    }
    interrupted = true
    process.stderr.write(`\n收到 ${signal}：不再自动修复，也不发邮件；等驱动脚本收尾后退出。（再按一次 Ctrl+C 立即结束全部进程）\n`)
    for (const [pid, kind] of children) {
      if (kind === 'claude') void killTree(pid)
      else if (process.platform !== 'win32' && signal !== 'SIGINT') { try { process.kill(pid, signal) } catch { /* gone */ } }
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, handler)
}

function checkClaude() {
  try {
    const bin = resolveClaudeBin()
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (result.status !== 0) return `无法运行 ${bin} --version`
    if (!claudeVersionSupported(result.stdout)) return `Claude Code 版本过低（${result.stdout.trim()}），需要 ${MIN_CLAUDE_VERSION.join('.')} 或更高：claude update`
    // Exits non-zero when logged out, like a headless run would fail later.
    const auth = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (auth.status !== 0) return 'Claude Code 没有登录：先运行 claude auth login（选 claude.ai 订阅账号，手机接管要用它）'
    return null
  } catch (error) {
    return error.message
  }
}

function handover(session) {
  handingOver = true
  process.stdout.write([
    '',
    `接管：打开 Claude 会话 ${session.id}，并用 Remote Control 开放给手机（名称「${session.title}」）。`,
    `  手机：Claude App → Code → 会话列表里的「${session.title}」。这个窗口关掉后会话就离线了。`,
    '  手机上看不到时，在下面的会话里输入 /remote-control。',
    '',
  ].join('\n'))
  return new Promise(resolvePromise => {
    let bin
    try { bin = resolveClaudeBin() } catch (error) { process.stderr.write(`${error.message}\n`); resolvePromise(1); return }
    const child = spawn(bin, ['--resume', session.id, '--remote-control', session.title], { cwd: root, stdio: 'inherit' })
    child.on('close', code => resolvePromise(code ?? 1))
    child.on('error', error => { process.stderr.write(`无法启动 claude：${error.message}\n`); resolvePromise(1) })
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(USAGE); return }
  if (options.runnerArgs.some(arg => arg === '--dry-run' || arg === '--report')) {
    const result = spawnSync(process.execPath, [runnerScript, ...options.runnerArgs], { cwd: root, stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  let mailConfig = null
  try {
    mailConfig = loadMailConfig(options.notifyConfig)
    process.stdout.write(mailConfig
      ? `邮件通知：${mailConfig.to.join('、')}\n`
      : `邮件通知未启用：找不到 ${options.notifyConfig}（格式见 opencode-workflows 的 README「邮件通知」）。\n`)
  } catch (error) {
    process.stderr.write(`⚠ ${error.message}。本次不发邮件。\n`)
  }
  if (options.fixRounds > 0) {
    const problem = checkClaude()
    if (problem) process.stderr.write(`⚠ ${problem}。失败时将无法自动修复。\n`)
  }
  const config = loadConfig(root)
  installInterruptHandler()
  const command = `run-milestones-auto ${argv.join(' ')}`.trim()
  const result = await autoRun(options, createDeps(mailConfig, command, config))
  if (result.outcome === 'interrupted') process.exit(130)
  if (result.outcome === 'success') process.exit(0)
  if (result.handover) await handover(result.handover)
  process.exit(1)
}

if (isMain(import.meta.url)) {
  main().catch(error => { process.stderr.write(`\n✗ ${error.message}\n  用法：run-milestones-auto --help\n`); process.exit(1) })
}
