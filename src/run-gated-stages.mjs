#!/usr/bin/env node
// Runs milestones in stages, with an automatic security gate behind the stages
// that ask for one. The stages, the gates' checklists and the final checks come
// from a pipeline file (<pipelinesDir>/<name>.json of the current repository,
// scripts/pipelines by default, see config.mjs); nothing here is specific to one
// batch of milestones.
//
// Each stage is one `run-milestones-auto --only <range>` run (failures are
// still fixed by Claude and mailed as before). The gate follows when the stage
// succeeded:
//   1. `claude -p` reviews the stage's diff (base..HEAD in the stage's
//      repository) as an attacker against the pipeline's checklist, fixes
//      high/medium findings in the working tree and answers with a structured
//      list of findings.
//   2. What Claude changed is verified with the stage's acceptance commands, then
//      committed (`fix: …`) and pushed by this script. Claude never commits.
//   3. A new round starts with a fresh Claude session that knows nothing about
//      the fixes. The gate passes when a round finds nothing above `low`; after
//      --gate-rounds rounds it fails and the last session can be taken over
//      (`claude --resume <id>`).
// A passed gate is remembered in .milestone-logs/security-gates.json (keyed by
// pipeline, stage and the repository's HEAD), so running again does not review
// twice. A stage may name a `check`: dev servers are started, a script is run
// against them, the servers are stopped.
//
//   run-gated-stages --pipeline oauth                    # the default stages
//   run-gated-stages --pipeline oauth --stages cleanup
//   run-gated-stages --pipeline oauth --dry-run
//
// Pipeline file:
//   { "stages": [ { "name", "title", "milestones": "25-26", "default": true,
//                   "gate": "<key of gates>" | null, "check": "<key of checks>" | null,
//                   "commitScope": "M27-M30" | null } ],
//     "gates":  { "<key>": { "title", "focus": ["checklist item", …] } },
//     "checks": { "<key>": { "title", "script": "scripts/x.mjs",
//                            "servers": [ { "name", "command": ["pnpm", "dev:x"], "env": {}, "port": 10090 } ] } } }
//
// Everything not listed in --help is passed to run-milestones-auto.mjs.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, loadConfig, repoRootOf } from './config.mjs'
import { DEFAULT_CONFIG_FILE, loadMailConfig, sendMail } from './notify-mail.mjs'
import { claudeVersionSupported, resolveClaudeBin } from './run-milestones-auto.mjs'
import { acceptanceCommands, formatDuration, killTree, listMilestones, selectMilestones, targetOf } from './run-milestones.mjs'

// The repository this run works on (the current directory's), and the wrapper
// next to this file in the package.
const root = repoRootOf()
const autoScript = join(dirname(fileURLToPath(import.meta.url)), 'run-milestones-auto.mjs')
const logsDir = join(root, '.milestone-logs')
const gatesFile = join(logsDir, 'security-gates.json')

export const USAGE = `用法：run-gated-stages --pipeline <名称> [--stages a,b] [本脚本的参数] [run-milestones-auto 的参数]

按阶段跑里程碑；阶段之间可以有安全评审和收尾检查。阶段、检查清单、收尾检查写在
当前仓库的 <流水线目录>/<名称>.json；流水线目录默认 scripts/pipelines，可在 .opencode/workflows.json 的 pipelinesDir 里改。

本脚本的参数：
  --pipeline <名称|文件>  流水线（必填）
  --stages <a,b>          只跑这些阶段（按流水线里的顺序）；不写时跑标了 default 的阶段
  --gate-rounds <n>       安全评审最多几轮（默认 3；每轮都是新的 Claude 会话）
  --skip-gate             不做安全评审
  --skip-check            不做收尾检查
  --notify-config <文件>  邮件配置（默认 ~/.opencode-workflows/notify.env）
  --dry-run               只打印计划
  -h, --help              显示本说明
其余参数（--fix-rounds、--allow-dirty、--agent-timeout-hours……）原样传给 run-milestones-auto；
--only/--from/--to/--resume/--review 由阶段决定，不能传。
`

const COMMON_RULES = [
  'You are reviewing code that an AI implementer wrote and another AI approved. Assume both missed something: read the code, do not trust the plan, the tests or the comments.',
  'Look for what an attacker can do: bypass, replay, forge, escalate, enumerate, leak. A finding needs a concrete attack path through THIS code, with file and line; "might be weak" is not a finding.',
  'Severity: `high` = authentication or authorization bypass, token/secret disclosure, code or request forgery, account takeover; `medium` = exploitable only with a precondition or with limited impact; `low` = hardening, defence in depth. Do not pad the list: no findings is a valid answer.',
]

export const GATE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '评审与处理经过（简体中文）' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string', description: '一句话（简体中文）' },
          location: { type: 'string', description: 'file:line' },
          attack: { type: 'string', description: '攻击路径（简体中文）' },
          status: { type: 'string', enum: ['fixed', 'open'], description: 'fixed = 已在工作区修好；open = 没有修（low 级别通常保持 open）' },
        },
        required: ['severity', 'title', 'location', 'attack', 'status'],
        additionalProperties: false,
      },
    },
    userActions: { type: 'array', items: { type: 'string' }, description: '需要用户做什么（简体中文）；不需要时为空数组' },
  },
  required: ['summary', 'findings', 'userActions'],
  additionalProperties: false,
}

export function validateGateAnswer(value) {
  if (!value || typeof value !== 'object') return '没有 structured_output'
  if (typeof value.summary !== 'string' || !value.summary.trim()) return 'summary 为空'
  if (!Array.isArray(value.findings)) return 'findings 不是数组'
  for (const finding of value.findings) {
    if (!['high', 'medium', 'low'].includes(finding?.severity)) return 'finding.severity 不是 high / medium / low'
    if (!['fixed', 'open'].includes(finding?.status)) return 'finding.status 不是 fixed / open'
    for (const key of ['title', 'location', 'attack']) if (typeof finding[key] !== 'string') return `finding.${key} 不是字符串`
  }
  if (!Array.isArray(value.userActions) || value.userActions.some(item => typeof item !== 'string')) return 'userActions 不是字符串数组'
  return null
}

// What the gate does with one round's answer: `pass` (nothing above low),
// `fail` (a high/medium finding Claude did not fix: it needs a person) or
// `again` (everything serious was fixed: verify, commit, review once more).
export function judgeRound(answer) {
  const serious = answer.findings.filter(item => item.severity !== 'low')
  if (!serious.length) return 'pass'
  return serious.some(item => item.status === 'open') ? 'fail' : 'again'
}

export function gatePrompt({ gate, repoName, base, round, maxRounds, verify, protectedDocs = [] }) {
  const protectedList = ['specs/**/plan.md', 'specs/00-conventions.md', ...protectedDocs].map(item => `\`${item}\``)
  return [
    `# Security review: ${gate.title}`,
    '',
    `You were started headless by \`run-gated-stages\` in the repository \`${repoName}\`. Nobody is watching and nobody will answer questions. Review the changes below, fix what you must, then give your structured answer. Write \`summary\`, \`title\`, \`attack\` and \`userActions\` in Simplified Chinese. This is review round ${round} of at most ${maxRounds}.`,
    '',
    '## Scope',
    '',
    `The code to review is \`git diff ${base}..HEAD\` (and the files it touches, read in full where needed). Start with \`git log --stat ${base}..HEAD\`. Everything outside this change is out of scope.`,
    '',
    '## How to review',
    '',
    ...COMMON_RULES.map(rule => `- ${rule}`),
    '',
    '## Checklist (the minimum; follow the code wherever it leads)',
    '',
    ...gate.focus.map(item => `- ${item}`),
    '',
    '## What to do with findings',
    '',
    '- `high` and `medium`: fix them in the working tree with the smallest change that closes the attack path, and add a test that fails without the fix. Then answer with `status: "fixed"`. If you cannot fix one safely (it needs a design decision, a credential or a change of the contract), leave it `open` and say in `userActions` what the user has to decide.',
    '- `low`: report only (`status: "open"`); do not change code for them.',
    '- Before answering, run the commands below for the code you changed and make sure they pass (the wrapper runs them again before it commits):',
    '',
    '```bash',
    ...verify,
    '```',
    '',
    '## Rules',
    '',
    '- Never `git commit`, `push`, `reset`, `checkout`/`restore`, `stash` or `clean`. The wrapper commits your changes.',
    `- Do not weaken, skip or delete tests; do not edit ${protectedList.slice(0, -1).join(', ')} or ${protectedList.at(-1)}.`,
    '- Do not start commands that never end (watch mode, dev servers). Do not close or restart the user\'s applications and do not change system or security settings of the machine.',
    '- Never copy secrets (keys, tokens, passwords, connection strings with passwords) into files or into your answer.',
    '',
  ].join('\n')
}

// ---- Claude -------------------------------------------------------------------

export function gateClaudeArgs({ sessionId, name }) {
  return [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(GATE_SCHEMA),
    '--permission-mode', 'auto', '--permission-prompts', 'none',
    '--session-id', sessionId, '--name', name,
  ]
}

export function parseGateOutput(stdout) {
  const text = String(stdout).trim()
  let parsed = null
  for (const candidate of [text, ...text.split(/\r?\n/u).reverse()]) {
    if (!candidate.startsWith('{')) continue
    try { parsed = JSON.parse(candidate); break } catch { /* try the next candidate */ }
  }
  if (!parsed) return { error: `Claude 没有输出可解析的 JSON：${text.slice(0, 200) || '（空）'}` }
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    return { error: `Claude ${parsed.subtype && parsed.subtype !== 'success' ? `以 ${parsed.subtype} 结束` : '报错'}：${String(parsed.result ?? parsed.errors ?? '').slice(0, 300)}` }
  }
  const problem = validateGateAnswer(parsed.structured_output)
  return problem ? { error: `Claude 的结论格式不对：${problem}` } : { answer: parsed.structured_output }
}

function gitOut(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

// The commit that added `<spec>/STATUS` is the milestone's own commit; the
// stage's diff starts at its parent.
export function stageBase(repo, firstSpec) {
  const sha = (gitOut(['log', '--diff-filter=A', '--format=%H', '--', `${firstSpec}/STATUS`], repo) ?? '').split('\n').filter(Boolean).at(-1)
  return sha ? `${sha}^` : null
}

function runClaude({ prompt, sessionId, name, cwd, timeoutMs, logFile }) {
  writeFileSync(logFile, `# claude --session-id ${sessionId} (cwd ${cwd})\n\n## Prompt\n\n${prompt}\n\n## stderr\n\n`)
  let bin
  try { bin = resolveClaudeBin() } catch (error) { return Promise.resolve({ error: error.message }) }
  process.stdout.write(`Claude 日志：${logFile}（最长 ${formatDuration(timeoutMs)}）\n`)
  return new Promise(resolvePromise => {
    let stdout = ''
    let timedOut = false
    let settled = false
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(result) } }
    const child = spawn(bin, gateClaudeArgs({ sessionId, name }), { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env: process.env })
    const timer = setTimeout(() => { timedOut = true; void killTree(child.pid) }, timeoutMs)
    child.stdin.on('error', () => { /* exited without reading everything */ })
    child.stdin.end(prompt)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { process.stderr.write(chunk); appendFileSync(logFile, chunk) })
    child.on('close', code => {
      appendFileSync(logFile, `\n## stdout (exit ${code})\n\n${stdout}\n`)
      if (timedOut) return finish({ error: `超过 ${formatDuration(timeoutMs)} 没有结束，已终止` })
      const parsed = parseGateOutput(stdout)
      finish(parsed.error || code === 0 ? parsed : { error: `claude 以退出码 ${code} 结束` })
    })
    child.on('error', error => finish({ error: `无法启动 claude（${bin}）：${error.message}` }))
  })
}

// ---- the gate -----------------------------------------------------------------

const SEVERITY = { high: '高', medium: '中', low: '低' }

export function gateReport({ gate, repoName, base, rounds, outcome, reason }) {
  const lines = [`# 安全评审：${gate.title}`, '', `仓库：${repoName}，范围：${base}..HEAD`, `结果：${outcome === 'pass' ? '通过' : `未通过：${reason}`}`, '']
  for (const round of rounds) {
    lines.push(`## 第 ${round.number} 轮（会话 ${round.sessionId}）`, '')
    if (round.error) { lines.push(`Claude 没有给出可用的结论：${round.error}`, ''); continue }
    lines.push(round.answer.summary, '')
    if (!round.answer.findings.length) lines.push('没有发现。', '')
    for (const item of round.answer.findings) lines.push(`- [${SEVERITY[item.severity]}] ${item.title}（${item.location}）${item.status === 'fixed' ? '已修复' : '未修'}：${item.attack}`)
    if (round.answer.findings.length) lines.push('')
    if (round.committed) lines.push(`修复提交：${round.committed}`, '')
    if (round.answer.userActions.length) lines.push('需要你做：', ...round.answer.userActions.map(item => `- ${item}`), '')
  }
  return lines.join('\n')
}

// deps: uuid(), claude(prompt, name, sessionId) -> { answer } | { error },
// dirty() -> boolean, verify() -> null | the failed command,
// commit(round) -> { ok, sha?, output? }, log(text).
export async function runGate({ gate, repoName, base, verify, maxRounds, deps, protectedDocs = [] }) {
  const rounds = []
  const finish = (outcome, reason) => ({ outcome, reason, rounds, report: gateReport({ gate, repoName, base, rounds, outcome, reason }) })
  for (let number = 1; number <= maxRounds; number += 1) {
    const sessionId = deps.uuid()
    deps.log(`\n→ 安全评审第 ${number}/${maxRounds} 轮（${gate.title}，会话 ${sessionId}）……\n`)
    const result = await deps.claude(gatePrompt({ gate, repoName, base, round: number, maxRounds, verify, protectedDocs }), `安全评审 ${gate.title} 第 ${number} 轮`, sessionId)
    const round = { number, sessionId, answer: result.answer ?? null, error: result.error ?? null, committed: null }
    rounds.push(round)
    if (result.error) return finish('fail', `第 ${number} 轮 Claude 没有给出可用的结论：${result.error}`)
    // Whatever Claude changed must pass the acceptance commands before it is committed.
    if (deps.dirty()) {
      const failed = deps.verify()
      if (failed) return finish('fail', `Claude 的修复没有通过验收命令「${failed}」（改动留在工作区，没有提交）`)
      const commit = deps.commit(number)
      if (!commit.ok) return finish('fail', `提交修复失败：${commit.output}`)
      round.committed = commit.sha
    }
    const verdict = judgeRound(result.answer)
    if (verdict === 'pass') return finish('pass')
    if (verdict === 'fail') return finish('fail', '有高/中危发现 Claude 没有修，见「需要你做」')
  }
  return finish('fail', `评审 ${maxRounds} 轮后仍有新的高/中危发现`)
}

// ---- pipeline file ------------------------------------------------------------

export function validatePipeline(pipeline) {
  const problems = []
  if (!pipeline || !Array.isArray(pipeline.stages) || !pipeline.stages.length) return ['stages 不是非空数组']
  const names = new Set()
  for (const stage of pipeline.stages) {
    const where = `阶段 ${stage?.name ?? '?'}`
    if (!stage?.name || typeof stage.name !== 'string') problems.push('有阶段没有 name')
    else if (names.has(stage.name)) problems.push(`${where} 重名`)
    else names.add(stage.name)
    if (typeof stage?.title !== 'string') problems.push(`${where} 没有 title`)
    if (typeof stage?.milestones !== 'string' || !/^\d{2,}(-\d{2,})?(,\d{2,}(-\d{2,})?)*$/u.test(stage.milestones)) problems.push(`${where} 的 milestones 不是 --only 的写法（如 25-26）`)
    if (stage?.gate && !pipeline.gates?.[stage.gate]) problems.push(`${where} 的 gate「${stage.gate}」不在 gates 里`)
    if (stage?.check && !pipeline.checks?.[stage.check]) problems.push(`${where} 的 check「${stage.check}」不在 checks 里`)
  }
  for (const [key, gate] of Object.entries(pipeline.gates ?? {})) {
    if (typeof gate?.title !== 'string') problems.push(`gate ${key} 没有 title`)
    if (!Array.isArray(gate?.focus) || !gate.focus.length || gate.focus.some(item => typeof item !== 'string')) problems.push(`gate ${key} 的 focus 要是非空的字符串数组`)
  }
  for (const [key, check] of Object.entries(pipeline.checks ?? {})) {
    if (typeof check?.script !== 'string') problems.push(`check ${key} 没有 script`)
    for (const server of check?.servers ?? []) {
      if (!Array.isArray(server?.command) || !server.command.length || !Number.isInteger(server?.port)) problems.push(`check ${key} 的服务 ${server?.name ?? '?'} 需要 command 数组和整数 port`)
    }
  }
  return problems
}

export function loadPipeline(nameOrFile) {
  const file = /[\\/]|\.json$/u.test(nameOrFile) ? resolve(nameOrFile) : join(loadConfig(root).pipelinesDir, `${nameOrFile}.json`)
  if (!existsSync(file)) throw new Error(`找不到流水线文件：${file}`)
  const pipeline = JSON.parse(readFileSync(file, 'utf8'))
  const problems = validatePipeline(pipeline)
  if (problems.length) throw new Error(`${file} 有问题：\n  ${problems.join('\n  ')}`)
  return pipeline
}

export function parseArgs(argv) {
  const options = { pipeline: null, stages: null, gateRounds: 3, skipGate: false, skipCheck: false, dryRun: false, help: false, notifyConfig: DEFAULT_CONFIG_FILE, passthrough: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => { if (argv[index + 1] === undefined) throw new Error(`${arg} 需要一个值`); return argv[++index] }
    if (arg === '--pipeline') options.pipeline = value()
    else if (arg === '--stages') options.stages = value().split(',').map(item => item.trim()).filter(Boolean)
    else if (arg === '--gate-rounds') options.gateRounds = Number(value())
    else if (arg === '--skip-gate') options.skipGate = true
    else if (arg === '--skip-check') options.skipCheck = true
    else if (arg === '--notify-config') options.notifyConfig = resolve(value())
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (['--only', '--from', '--to', '--resume', '--review'].includes(arg)) throw new Error(`${arg} 由阶段决定，不能传给流水线；要精确控制请直接用 run-milestones-auto.mjs`)
    else options.passthrough.push(arg)
  }
  if (!Number.isInteger(options.gateRounds) || options.gateRounds < 1) throw new Error('--gate-rounds 需要正整数')
  return options
}

// The stages to run, in the pipeline's order: --stages, else those marked default.
export function selectStages(pipeline, requested) {
  if (requested) {
    for (const name of requested) if (!pipeline.stages.some(stage => stage.name === name)) throw new Error(`未知阶段：${name}（可选：${pipeline.stages.map(stage => stage.name).join('、')}）`)
    return pipeline.stages.filter(stage => requested.includes(stage.name))
  }
  const defaults = pipeline.stages.filter(stage => stage.default)
  if (!defaults.length) throw new Error('流水线里没有标 default 的阶段，请用 --stages 指定')
  return defaults
}

export function stagePlan(stage, milestones = listMilestones()) {
  const scope = selectMilestones(milestones, { only: stage.milestones })
  if (!scope.length) throw new Error(`阶段 ${stage.name} 找不到里程碑 ${stage.milestones}`)
  const first = targetOf(scope[0])
  return { ...stage, scope, repo: first.cwd, firstSpec: first.spec }
}

export function commitSubject(plan, round) {
  return plan.commitScope ? `fix(${plan.commitScope}): 安全评审修复（第 ${round} 轮）` : `fix: 安全评审修复（第 ${round} 轮）`
}

// ---- final check --------------------------------------------------------------

export function waitForPort(port, { host = '127.0.0.1', timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = connect({ port, host })
      socket.once('connect', () => { socket.destroy(); resolvePromise() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`等了 ${formatDuration(timeoutMs)}，端口 ${port} 还没起来`))
        else setTimeout(attempt, 500)
      })
    }
    attempt()
  })
}

// Starts the check's servers (waiting for each port), runs its script, stops
// the servers. Resolves null on success, else the problem.
async function runCheck(check) {
  const script = join(root, check.script)
  if (!existsSync(script)) return `找不到 ${check.script}`
  const started = []
  try {
    for (const server of check.servers ?? []) {
      process.stdout.write(`\n$ ${server.command.join(' ')}（${server.name}，等待端口 ${server.port}）\n`)
      const [command, ...args] = server.command
      const child = spawn(process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command, args, {
        cwd: root, stdio: 'ignore', env: { ...process.env, ...server.env }, detached: process.platform !== 'win32', shell: process.platform === 'win32',
      })
      started.push(child)
      await waitForPort(server.port)
    }
    const result = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit', timeout: 30 * 60_000 })
    return result.status === 0 ? null : `${check.script} 以退出码 ${result.status} 结束（有 FAIL）`
  } catch (error) {
    return error.message
  } finally {
    await Promise.all(started.map(child => killTree(child.pid)))
  }
}

// ---- main ---------------------------------------------------------------------

function runAuto(range, passthrough) {
  const args = [autoScript, '--only', range, ...passthrough]
  process.stdout.write(`\n$ run-milestones-auto ${args.slice(1).join(' ')}\n`)
  return spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status ?? 1
}

const tracked = repo => (gitOut(['status', '--porcelain', '--untracked-files=no'], repo) ?? '').trim()
const readGates = () => { try { return JSON.parse(readFileSync(gatesFile, 'utf8')) } catch { return {} } }

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(USAGE); return }
  if (!options.pipeline) throw new Error('需要 --pipeline <名称>（见 --help）')
  const pipeline = loadPipeline(options.pipeline)
  const pipelineName = /[\\/]/u.test(options.pipeline) ? options.pipeline : options.pipeline.replace(/\.json$/u, '')
  const plans = selectStages(pipeline, options.stages).map(stage => stagePlan(stage))
  process.stdout.write(`流水线 ${pipelineName}：${plans.map(plan => `${plan.name}（${plan.milestones}）`).join(' → ')}\n`)
  if (options.dryRun) {
    for (const plan of plans) {
      process.stdout.write(`  ${plan.name}：${plan.title}；仓库 ${plan.repo}${plan.gate && !options.skipGate ? `；安全评审（${pipeline.gates[plan.gate].title}）` : ''}${plan.check && !options.skipCheck ? `；收尾检查（${pipeline.checks[plan.check].title ?? plan.check}）` : ''}\n`)
    }
    return
  }
  const repos = new Set([root, ...plans.flatMap(plan => plan.scope.map(item => targetOf(item).cwd))])
  const dirty = [...repos].filter(repo => tracked(repo))
  if (dirty.length && !options.passthrough.includes('--allow-dirty')) {
    throw new Error(`这些仓库有未提交的改动，里程碑驱动脚本会拒绝开始：\n  ${dirty.join('\n  ')}\n先提交或处理掉；确认改动属于要继续的里程碑时加 --allow-dirty。`)
  }
  let mailConfig = null
  try { mailConfig = loadMailConfig(options.notifyConfig) } catch (error) { process.stderr.write(`⚠ ${error.message}。本次不发邮件。\n`) }
  const notify = async (subject, text) => {
    if (!mailConfig) return
    try { await sendMail(mailConfig, { subject: `[${loadConfig(root).name}] ${subject}`, text }) } catch (error) { process.stderr.write(`⚠ 邮件发送失败：${error.message}\n`) }
  }
  if (!options.skipGate && plans.some(plan => plan.gate)) {
    const version = spawnSync(resolveClaudeBin(), ['--version'], { encoding: 'utf8', timeout: 30_000 })
    if (version.status !== 0 || !claudeVersionSupported(version.stdout)) throw new Error('安全评审需要可用的 Claude Code（≥ 2.1.259，已登录）；或加 --skip-gate')
  }
  mkdirSync(logsDir, { recursive: true })
  const startedAt = Date.now()

  for (const plan of plans) {
    process.stdout.write(`\n===== 阶段 ${plan.name}：${plan.title} =====\n`)
    const code = runAuto(plan.milestones, options.passthrough)
    if (code !== 0) {
      process.stdout.write(`\n✗ 阶段 ${plan.name} 没有完成（退出码 ${code}）。原因见上面的输出和邮件；修好后重新运行同一条命令，已完成的里程碑会跳过。\n`)
      process.exit(code)
    }

    if (plan.gate && !options.skipGate) {
      const gate = pipeline.gates[plan.gate]
      const key = `${pipelineName}/${plan.name}`
      const head = gitOut(['rev-parse', 'HEAD'], plan.repo)?.trim()
      if (readGates()[key] === head) {
        process.stdout.write(`\n安全评审：${plan.name} 在 ${head?.slice(0, 8)} 上已经通过，跳过。\n`)
      } else {
        const base = stageBase(plan.repo, plan.firstSpec)
        if (!base) { process.stdout.write(`\n✗ 找不到 ${plan.firstSpec}/STATUS 的提交，无法确定评审范围。\n`); process.exit(1) }
        const verify = [...new Set(plan.scope.flatMap(item => acceptanceCommands(readFileSync(join(item.dir, 'plan.md'), 'utf8'))))]
        const repoName = plan.repo === root ? `${basename(root)}（本仓库）` : plan.repo
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        const logFile = join(logsDir, `security-gate-${plan.name}-${stamp}.log`)
        const result = await runGate({
          protectedDocs: loadConfig(plan.repo).protectedDocs,
          gate, repoName, base, verify, maxRounds: options.gateRounds,
          deps: {
            uuid: () => randomUUID(),
            log: text => process.stdout.write(text),
            claude: (prompt, name, sessionId) => runClaude({ prompt, name, sessionId, cwd: plan.repo, timeoutMs: 60 * 60_000, logFile }),
            dirty: () => Boolean((gitOut(['status', '--porcelain'], plan.repo) ?? '').trim()),
            verify: () => {
              for (const command of verify) {
                process.stdout.write(`\n$ ${command}\n`)
                if (spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', timeout: 45 * 60_000 }).status !== 0) return command
              }
              return null
            },
            commit: number => {
              const add = spawnSync('git', ['add', '-A', '--', '.'], { cwd: plan.repo, encoding: 'utf8' })
              const commit = add.status === 0
                ? spawnSync('git', ['commit', '-q', '-m', `${commitSubject(plan, number)}\n\n由 run-gated-stages 的安全评审自动修复，已通过阶段验收命令。`], { cwd: plan.repo, encoding: 'utf8' })
                : add
              if (commit.status !== 0) return { ok: false, output: `${commit.stdout ?? ''}${commit.stderr ?? ''}`.trim() }
              const push = spawnSync('git', ['push'], { cwd: plan.repo, encoding: 'utf8' })
              if (push.status !== 0) return { ok: false, output: `已提交但推送失败：${push.stderr}` }
              return { ok: true, sha: (gitOut(['rev-parse', '--short', 'HEAD'], plan.repo) ?? '').trim() }
            },
          },
        })
        const reportFile = join(logsDir, `security-gate-${plan.name}-${stamp}.md`)
        writeFileSync(reportFile, result.report)
        process.stdout.write(`\n${result.report}\n评审报告：${reportFile}\n`)
        if (result.outcome !== 'pass') {
          const last = result.rounds.at(-1)
          const takeover = `接管：cd ${plan.repo} && claude --resume ${last?.sessionId}`
          await notify(`安全评审 ${plan.name} ❌ ${result.reason}`, `${result.report}\n${takeover}\n修好并提交后重新运行流水线（同一条命令）。\n`)
          process.stdout.write(`\n✗ 安全评审没有通过：${result.reason}\n  ${takeover}\n  修好并提交后重新运行同一条流水线命令。\n`)
          process.exit(1)
        }
        writeFileSync(gatesFile, JSON.stringify({ ...readGates(), [key]: gitOut(['rev-parse', 'HEAD'], plan.repo)?.trim() }, null, 2))
        await notify(`安全评审 ${plan.name} ✅ 通过`, result.report)
      }
    }

    if (plan.check && !options.skipCheck) {
      const check = pipeline.checks[plan.check]
      process.stdout.write(`\n----- 收尾检查：${check.title ?? plan.check} -----\n`)
      const problem = await runCheck(check)
      if (problem) {
        await notify(`收尾检查 ${plan.name} ❌`, `${problem}\n修好后重新运行同一条流水线命令（里程碑与已通过的安全评审会跳过）。\n`)
        process.stdout.write(`\n✗ 收尾检查没有通过：${problem}\n`)
        process.exit(1)
      }
      process.stdout.write('✓ 收尾检查通过。\n')
    }
  }
  const text = `流水线 ${pipelineName} 完成：${plans.map(plan => plan.name).join(' → ')}，用时 ${formatDuration(Date.now() - startedAt)}。\n`
  process.stdout.write(`\n${text}`)
  await notify(`流水线 ✅ ${pipelineName}`, text)
}

if (isMain(import.meta.url)) {
  main().catch(error => { process.stderr.write(`\n✗ ${error.message}\n`); process.exit(1) })
}
