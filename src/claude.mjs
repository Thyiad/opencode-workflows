// Headless Claude Code for the unattended commands: find the CLI, run one
// `claude -p` round with a structured answer, and hand a session over to the
// user with Remote Control. run-milestones-auto.mjs fixes failed milestones
// with it, refine-plan.mjs failed plan reviews.
//
// Claude: the `claude` CLI, Claude Code 2.1.259 or later (--permission-prompts),
// logged in; handing over needs a claude.ai subscription login (Remote Control
// does not work with an API key). On Windows claude.exe is started directly
// (npm's claude.cmd shim is followed to it) rather than through cmd.exe as the
// runners do for opencode: the --json-schema argument is JSON, and
// windowsShellCommand rightly refuses quotes. CLAUDE_BIN overrides the lookup.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatDuration, killTree } from './run-milestones.mjs'

export const MIN_CLAUDE_VERSION = [2, 1, 259]

// The answer every round gives: what the wrapper does next (one of `nexts`)
// and the text it mails to the user.
export function decisionSchema(nexts) {
  return {
    type: 'object',
    properties: {
      next: { type: 'string', enum: nexts },
      rootCause: { type: 'string', description: '一句话根因（简体中文）' },
      summary: { type: 'string', description: '分析与处理经过（简体中文）' },
      actionsTaken: { type: 'array', items: { type: 'string' }, description: '已经做了什么，每项一句（简体中文）' },
      userActions: { type: 'array', items: { type: 'string' }, description: '需要用户做什么，每项一句（简体中文）；不需要时为空数组' },
    },
    required: ['next', 'rootCause', 'summary', 'actionsTaken', 'userActions'],
    additionalProperties: false,
  }
}

export function validateDecision(value, nexts) {
  if (!value || typeof value !== 'object') return '没有 structured_output'
  if (!nexts.includes(value.next)) return `next 不是 ${nexts.join(' / ')} 之一`
  for (const key of ['rootCause', 'summary']) if (typeof value[key] !== 'string' || !value[key].trim()) return `${key} 为空`
  for (const key of ['actionsTaken', 'userActions']) {
    if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string')) return `${key} 不是字符串数组`
  }
  return null
}

// `claude -p --output-format json` prints one result object:
// { type: 'result', subtype, is_error, result, session_id, structured_output, total_cost_usd, … }
export function parseClaudeOutput(stdout, nexts) {
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
  const problem = validateDecision(parsed.structured_output, nexts)
  if (problem) return { sessionId, costUsd, error: `Claude 的结论格式不对：${problem}` }
  return { sessionId, costUsd, decision: parsed.structured_output }
}

export function claudeArgs({ sessionId, resume, name, addDirs = [], schema }) {
  return [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
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

// Why Claude cannot run here, or null.
export function checkClaude() {
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

// One headless round in `cwd`. The prompt, stderr and stdout go to `logFile`.
// `onChild` sees the process, so the caller's Ctrl+C handling can stop it.
// Resolves { started, logFile, sessionId?, decision?, costUsd?, error? }.
export function runClaude({ prompt, sessionId, resume, name, addDirs = [], timeoutMs, cwd, logFile, nexts, onChild = () => {} }) {
  mkdirSync(dirname(logFile), { recursive: true })
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
    const child = spawn(bin, claudeArgs({ sessionId, resume, name, addDirs, schema: decisionSchema(nexts) }), {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env: process.env,
    })
    child.on('spawn', () => { started = true })
    onChild(child)
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
      const parsed = parseClaudeOutput(stdout, nexts)
      finish({ ...parsed, sessionId: parsed.sessionId ?? sessionId, error: parsed.error ?? (code === 0 ? null : `claude 以退出码 ${code} 结束`) })
    })
    child.on('error', error => finish({ error: `无法启动 claude（${bin}）：${error.message}` }))
  })
}

// Only in a terminal: the session is reopened there, interactively.
export const canHandover = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

// Reopens `session` ({ id, title }) in this terminal with Remote Control, so
// the user takes over here or from the Claude app. Resolves claude's exit code.
export function handover(session, cwd) {
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
    const child = spawn(bin, ['--resume', session.id, '--remote-control', session.title], { cwd, stdio: 'inherit' })
    child.on('close', code => resolvePromise(code ?? 1))
    child.on('error', error => { process.stderr.write(`无法启动 claude：${error.message}\n`); resolvePromise(1) })
  })
}

// The lines a failure mail ends with: how to open the session, here or on the phone.
export function sessionLines({ session, handedOver, cwd }) {
  return [
    `接管 Claude 会话（会话 ID ${session.id}）：`,
    handedOver
      ? `  手机：电脑上已经用 Remote Control 打开了这个会话，在 Claude App → Code 的会话列表里找「${session.title}」。电脑上那个终端窗口关掉后会话就离线了；看不到时在电脑上的会话里输入 /remote-control。`
      : `  手机：先在电脑上运行下面第二条命令，再到 Claude App → Code 的会话列表里找「${session.title}」。`,
    `  电脑：在 ${cwd} 运行 claude --resume ${session.id}`,
    `  电脑（同时开放给手机）：claude --resume ${session.id} --remote-control "${session.title}"`,
  ]
}
