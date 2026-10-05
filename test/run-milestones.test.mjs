import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acceptanceCommands, continueSelection, listMilestones, milestoneTitle, parseNumberSpec, selectMilestones } from '../src/run-milestones.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('--only takes numbers, lists and ranges', () => {
  assert.deepEqual(parseNumberSpec('23'), ['23'])
  assert.deepEqual(parseNumberSpec('23,24'), ['23', '24'])
  assert.deepEqual(parseNumberSpec('29,23-25,24'), ['23', '24', '25', '29'])
  assert.deepEqual(parseNumberSpec('101,98-100'), ['98', '99', '100', '101'], 'past 99, ordered as numbers')
  for (const bad of ['', '2', '23,', '23-', '23-2x', '26-24', 'abc']) assert.throws(() => parseNumberSpec(bad), /--only/u, bad)
})

test('--only, --from and --to narrow the same list', () => {
  const all = ['21', '22', '23', '24', '25', '26'].map(number => ({ number }))
  const pick = options => selectMilestones(all, options).map(item => item.number)
  assert.deepEqual(pick({}), ['21', '22', '23', '24', '25', '26'])
  assert.deepEqual(pick({ only: '23,25' }), ['23', '25'])
  assert.deepEqual(pick({ from: '24' }), ['24', '25', '26'])
  assert.deepEqual(pick({ from: '22', to: '24' }), ['22', '23', '24'])
  assert.deepEqual(pick({ to: '22' }), ['21', '22'])
  assert.deepEqual(pick({ only: '21-26', from: '23', to: '25' }), ['23', '24', '25'])
  assert.deepEqual(pick({ only: '30' }), [])
})

test('the continue hint stays inside a restricted selection', () => {
  assert.equal(continueSelection(['23', '24', '25'], '24', false), '--from 24')
  assert.equal(continueSelection(['23', '25', '27'], '25', true), '--only 25,27')
  assert.equal(continueSelection(['23', '24'], '24', true), '--only 24')
})

test('acceptance parsing stops at the closing fence and skips comments', () => {
  const text = '# M9：x\n\n## 验收命令\n\n```bash\n# note\npnpm install\n\nnode scripts/ci.mjs\n```\n\n```bash\nnot-this\n```\n'
  assert.deepEqual(acceptanceCommands(text), ['pnpm install', 'node scripts/ci.mjs'])
})

test('acceptance commands come from the bash block of their own section only', () => {
  const section = body => `# M9：x\n\n## 验收命令\n\n${body}\n`
  const bash = lines => section(`\`\`\`bash\n${lines.join('\n')}\n\`\`\``)

  // Lines that look like headings inside the block are shell comments, not the next section.
  assert.deepEqual(acceptanceCommands(bash(['## 装依赖', 'pnpm install', '# 测试', 'pnpm test'])), ['pnpm install', 'pnpm test'])
  // A block of another language in front of it is passed over; the next section does not matter after the block.
  assert.deepEqual(acceptanceCommands(`${section('```text\nignored\n```\n\n```bash\npnpm test\n```')}\n## 回滚\n\n\`\`\`bash\ngit reset --hard\n\`\`\`\n`), ['pnpm test'])
  // Setup and command on one line is one self-contained command.
  assert.deepEqual(
    acceptanceCommands(bash(['cd qiwi-dsh-backend && pnpm test', 'export A=1; pnpm test', 'FOO=1 node scripts/ci.mjs', './scripts/x.sh', 'cdk synth'])),
    ['cd qiwi-dsh-backend && pnpm test', 'export A=1; pnpm test', 'FOO=1 node scripts/ci.mjs', './scripts/x.sh', 'cdk synth'],
  )

  assert.throws(() => acceptanceCommands('# M9：x\n'), /没有「## 验收命令」一节/u)
  // The section ends at the next heading: a block in a later section is not the acceptance block.
  assert.throws(() => acceptanceCommands(section('无需命令。\n\n## 回滚\n\n```bash\ngit reset --hard\n```')), /没有 ```bash 代码块/u)
  assert.throws(() => acceptanceCommands(section('```text\npnpm test\n```')), /没有 ```bash 代码块/u)
  // A heading may be indented by up to three spaces and still ends the section; four make it code.
  for (const heading of ['  ## 回滚', '   ## 回滚', '##', ' # 其他']) {
    assert.throws(() => acceptanceCommands(section(`无需命令。\n\n${heading}\n\n\`\`\`bash\ngit reset --hard\n\`\`\``)), /没有 ```bash 代码块/u, JSON.stringify(heading))
  }
  assert.deepEqual(acceptanceCommands(section('    ## 缩进了四格，是代码，不是标题\n\n```bash\npnpm test\n```')), ['pnpm test'])
  // Nothing to run is not a pass.
  assert.throws(() => acceptanceCommands(bash([])), /空的/u)
  assert.throws(() => acceptanceCommands(bash(['# 只有注释', ''])), /空的/u)
  assert.throws(() => acceptanceCommands(section('```bash\npnpm test\n')), /没有结束/u)
})

test('acceptance lines that cannot run on their own in a shell are refused', () => {
  const bash = lines => `## 验收命令\n\n\`\`\`bash\n${lines.join('\n')}\n\`\`\`\n`
  assert.throws(() => acceptanceCommands(bash(['pnpm test \\', '  --run'])), /续行/u)
  assert.throws(() => acceptanceCommands(bash(["cat <<'EOF'", 'x', 'EOF'])), /heredoc/u)
  assert.throws(() => acceptanceCommands(bash(['cat <<-EOF', 'x', 'EOF'])), /heredoc/u)
  // Every line gets a shell of its own, so these would set up nothing for the lines after them.
  for (const line of ['export HARNESS_TEST_MONGODB_URI=mongodb://x', 'cd qiwi-dsh-backend', 'set -e', 'source .env', '. ./env.sh', 'unset A']) {
    assert.throws(() => acceptanceCommands(bash([line, 'pnpm test'])), /单独成行/u, line)
  }
  // A separator inside quotes, behind a backslash or in a comment does not join anything:
  // the next line would still not see the variable.
  for (const line of [
    'export FLAG="yes&no"', "export FLAG='a;b'", 'export FLAG=a\\;b', 'export FLAG=1 # then; later | more',
    'export MONGODB_URI="mongodb://localhost:27017/test?replicaSet=rs0&retryWrites=true"',
    "cd 'a|b'", 'export A=a#b\\;c',
    // A separator with no command after it joins nothing either: the end of the line or a comment follows.
    'export FLAG=1; # 仅设置变量', 'cd desktop;', 'set -e;', 'export A=1 &', 'export A=1 ;;', 'cd x ; # a ; b', 'export A=1;#note',
    // Where the line cannot be read reliably it is refused too: ask for a script instead.
    'export A="$(echo "x;y")"', 'export A=$(cd x; pwd)', 'export A=`a;b`', "export A=$'a;b'", 'export A=${B:-x;y}', 'export A="unterminated; quote',
  ]) {
    assert.throws(() => acceptanceCommands(bash([line, 'pnpm test'])), /单独成行/u, line)
  }
  // Real separators, even next to quoted ones, make it one command line.
  assert.deepEqual(
    acceptanceCommands(bash([
      'export A=1; pnpm test', 'export A=1 && pnpm test', 'export A=1 || pnpm test', 'export A=1 | cat', 'export A=1 & pnpm test',
      'export MONGODB_URI="mongodb://h/db?a=1&b=2" && pnpm test', "cd 'a;b' && pnpm test", 'cd "a b";pnpm test',
      'export A=a\\;b && pnpm test', 'export A=1 2>&1 && pnpm test', 'cd x &>/dev/null; pnpm test',
      'export A=1; pnpm test # 说明; 还有一句', 'export A=1 &&   pnpm test', 'cd x;pnpm test',
    ])),
    [
      'export A=1; pnpm test', 'export A=1 && pnpm test', 'export A=1 || pnpm test', 'export A=1 | cat', 'export A=1 & pnpm test',
      'export MONGODB_URI="mongodb://h/db?a=1&b=2" && pnpm test', "cd 'a;b' && pnpm test", 'cd "a b";pnpm test',
      'export A=a\\;b && pnpm test', 'export A=1 2>&1 && pnpm test', 'cd x &>/dev/null; pnpm test',
      'export A=1; pnpm test # 说明; 还有一句', 'export A=1 &&   pnpm test', 'cd x;pnpm test',
    ],
  )
  // Here-strings and shifts are not heredocs.
  assert.deepEqual(
    acceptanceCommands(bash(['node -e "process.exit(1 << 2 ? 0 : 1)"', 'bash -c "cat <<< hi"'])),
    ['node -e "process.exit(1 << 2 ? 0 : 1)"', 'bash -c "cat <<< hi"'],
  )
})

test('durations read naturally in Chinese', async () => {
  const { formatDuration } = await import('../src/run-milestones.mjs')
  assert.equal(formatDuration(42_000), '42 秒')
  assert.equal(formatDuration(5 * 60_000 + 3_000), '5 分 3 秒')
  assert.equal(formatDuration(2 * 3_600_000 + 15 * 60_000), '2 小时 15 分')
})

test('timings add up every attempt per milestone, failed ones included', async () => {
  const { summarizeTimings } = await import('../src/run-milestones.mjs')
  const { rows, total } = summarizeTimings([
    { milestone: '01-backend-core', agentMs: 1000, acceptanceMs: 200, totalMs: 1300, result: 'failed' },
    { milestone: '02-backend-content', agentMs: 5000, acceptanceMs: 500, totalMs: 5600, result: 'committed' },
    { milestone: '01-backend-core', agentMs: 3000, acceptanceMs: 400, totalMs: 3500, result: 'committed' },
  ])
  assert.deepEqual(rows.map(row => [row.milestone, row.attempts, row.totalMs, row.result]), [
    ['01-backend-core', 2, 4800, 'committed'],
    ['02-backend-content', 1, 5600, 'committed'],
  ])
  assert.equal(total, 10_400)
})

test('a command that outlives its timeout is killed with its whole process group', {
  skip: process.platform === 'win32',
}, async () => {
  const { run } = await import('../src/run-milestones.mjs')
  const started = Date.now()
  const result = await run('sh -c "sleep 30 & sleep 30"', [], { shell: true, timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 15_000)
})

test('cross-repository placeholders point at a spec in another repository', async () => {
  const { crossRepoTarget } = await import('../src/run-milestones.mjs')
  assert.equal(crossRepoTarget('# M1：x\n'), null)
  const target = crossRepoTarget('# M10：x\n<!-- milestone-repo: ../OPOC -->\n<!-- milestone-spec: specs/harness-api/ -->\n')
  // Resolved against the repository root, whatever the current directory is.
  assert.equal(target.repo, resolve(repositoryRoot, '..', 'OPOC'))
  assert.equal(target.spec, 'specs/harness-api')
  assert.throws(() => crossRepoTarget('<!-- milestone-repo: ../OPOC -->'), /milestone-spec/u)
})

test('the implement-plan command expands into an agent, a model and a prompt', async () => {
  const { expandCommand, splitFrontmatter } = await import('../src/run-milestones.mjs')
  const text = '---\ndescription: Implement a plan.md\nagent: implementer\n---\n\nThe approved plan is:\n\n$ARGUMENTS/plan.md\n'
  const command = expandCommand(text, 'specs/04-admin')
  assert.equal(command.agent, 'implementer')
  assert.match(command.prompt, /specs\/04-admin\/plan\.md/u)
  assert.doesNotMatch(command.prompt, /\$ARGUMENTS|^---/u)
  // The runner passes the agent's own model, which `opencode run --agent` would ignore.
  const agent = '---\ndescription: x\nmode: primary\nmodel: deepseek/deepseek-flash#high\n---\nYou implement.\n'
  assert.match(command.model ?? splitFrontmatter(agent).fields.model, /^[\w.-]+\/\S+$/u)
})
test('command expansion follows OpenCode: model, quoting and appended arguments', async () => {
  const { expandCommand, splitFrontmatter } = await import('../src/run-milestones.mjs')
  const withModel = expandCommand('---\r\ndescription: x\r\nagent: "a"\r\nmodel: p/m#high\r\npermissions:\r\n  - { action: read }\r\n---\r\nDo $ARGUMENTS, then $ARGUMENTS.\r\n', 'it')
  assert.deepEqual(withModel, { agent: 'a', model: 'p/m#high', prompt: 'Do it, then it.\r\n' })
  assert.deepEqual(expandCommand('Fix it.\n', 'specs/x'), { agent: null, model: null, prompt: 'Fix it.\n\nspecs/x\n' })
  assert.deepEqual(splitFrontmatter('---\nmodel: # none\n---\nbody').fields, {})
})

test('the unattended note keeps long commands in the foreground and the response open', async () => {
  const { unattendedNote } = await import('../src/run-milestones.mjs')
  const note = unattendedNote()
  assert.match(note, /`timeout` of 3600000/u)
  assert.match(note, /Do not start commands with `background: true`/u)
  assert.match(note, /do not end your response while it is still running/u)
  assert.match(note, /reviewer/u)
})

test('opencode below the verified v2 release is rejected', async () => {
  const { opencodeVersionSupported } = await import('../src/run-milestones.mjs')
  for (const output of ['2.0.18', 'opencode v2.0.18\n', '2.1.0', '3.0.0']) assert.equal(opencodeVersionSupported(output), true, output)
  for (const output of ['2.0.17', '1.18.15', '', 'unknown']) assert.equal(opencodeVersionSupported(output), false, output)
})

test('a prompt reaches the command on stdin, through cmd.exe on Windows too', async () => {
  const { run, windowsShellCommand } = await import('../src/run-milestones.mjs')
  const prompt = 'line one\n"quoted" 100% line two\n'
  // The expected text travels as base64: cmd.exe arguments cannot carry quotes, % or newlines.
  const expected = Buffer.from(prompt).toString('base64')
  const script = `let s = ''; process.stdin.on('data', d => { s += d }).on('end', () => process.exit(s === Buffer.from('${expected}', 'base64').toString() ? 0 : 7))`
  const result = process.platform === 'win32'
    ? await run(windowsShellCommand(process.execPath, ['-e', script]), [], { shell: true, input: prompt, timeoutMs: 10_000 })
    : await run(process.execPath, ['-e', script], { input: prompt, timeoutMs: 10_000 })
  assert.equal(result.code, 0)
})

test('ps CPU times of every shape are parsed into seconds', async () => {
  const { parseCpuTime } = await import('../src/run-milestones.mjs')
  assert.equal(parseCpuTime('0:00.25'), 0.25)
  assert.equal(parseCpuTime('12:03.50'), 723.5)
  assert.equal(parseCpuTime('01:02:03'), 3723)
  assert.equal(parseCpuTime('2-01:00:00'), 176_400)
  assert.equal(parseCpuTime('garbage'), 0)
})

test('an unreadable process table is an error, never an empty table', {
  skip: process.platform === 'win32',
}, async () => {
  const { processTable } = await import('../src/run-milestones.mjs')
  const ps = result => () => result
  assert.throws(() => processTable(ps({ status: 1, stdout: '', stderr: 'ps: operation not permitted\n' })), /无法读取进程表：ps: operation not permitted/u)
  assert.throws(() => processTable(ps({ status: null, stdout: null, stderr: null, error: new Error('spawn ps ENOENT') })), /无法读取进程表：spawn ps ENOENT/u)
  assert.throws(() => processTable(ps({ status: 1, stdout: '', stderr: '' })), /ps 以退出码 1 结束/u)
  // ps always lists itself: nothing at all means the answer is not to be trusted.
  assert.throws(() => processTable(ps({ status: 0, stdout: '' })), /没有列出任何进程/u)
  const rows = processTable(ps({ status: 0, stdout: '  10     1    10  0:01.50 /bin/zsh -c pnpm test\n  11    10    10  0:00.25 node x.js\n' }))
  assert.deepEqual(rows.map(row => [row.pid, row.ppid, row.pgid, row.cpu, row.command]), [
    [10, 1, 10, 1.5, '/bin/zsh -c pnpm test'], [11, 10, 10, 0.25, 'node x.js'],
  ])
})

test('a process tree is still killed when the process table cannot be read', {
  skip: process.platform === 'win32',
}, async () => {
  const { killTree } = await import('../src/run-milestones.mjs')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const closed = new Promise(done => child.on('close', done))
  await killTree(child.pid, 2_000, () => { throw new Error('ps is blocked') })
  await closed
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('a subtree follows parent links through several levels', async () => {
  const { subtree } = await import('../src/run-milestones.mjs')
  const rows = [
    { pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 },
  ]
  assert.deepEqual(subtree(rows, 10).map(row => row.pid).sort(), [10, 11, 12])
  assert.deepEqual(subtree(rows, 99), [])
})

test('Unix agent units follow the standalone server and shells that exec their command', async () => {
  const { unixAgentUnits } = await import('../src/run-milestones.mjs')
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, command: 'opencode run --standalone' },
    { pid: 11, ppid: 10, pgid: 11, command: '/tools/opencode serve --stdio --port 0' },
    { pid: 12, ppid: 11, pgid: 12, command: '/bin/zsh -c pnpm test' },
    { pid: 13, ppid: 12, pgid: 12, command: 'node pnpm.cjs test' },
    { pid: 14, ppid: 13, pgid: 12, command: 'sh -c vitest run' },
    // zsh execs the final command: the PID/group survives but its name changes.
    { pid: 15, ppid: 11, pgid: 15, command: 'node scripts/test.mjs desktop' },
    { pid: 16, ppid: 15, pgid: 15, command: 'node --test desktop/test.cjs' },
    { pid: 17, ppid: 11, pgid: 11, command: 'node typescript-language-server.js' },
    { pid: 20, ppid: 1, pgid: 20, command: 'sh -c unrelated' },
  ]
  const units = unixAgentUnits(rows, 10)
  assert.deepEqual(units.map(unit => unit.pid), [12, 15])
  assert.deepEqual(units[0].processes.map(row => row.pid), [12, 13, 14])
  assert.deepEqual(units[1].processes.map(row => row.pid), [15, 16])
})

test('Unix watchdog kills an exec-replaced tool below a standalone server without killing the agent', {
  skip: process.platform === 'win32',
}, async () => {
  const { run, processTable } = await import('../src/run-milestones.mjs')
  const marker = `agent-tool-stall-${process.pid}-${Date.now()}`
  const tool = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${marker}'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const server = `
    process.title = 'opencode serve --stdio';
    const child = require('node:child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(`exec ${quote(process.execPath)} -e ${quote(tool)}`)}], { detached: true, stdio: 'ignore' });
    child.on('close', code => process.exit(code === 0 ? 9 : 0));
  `
  const agent = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { detached: true, stdio: 'ignore' });
    child.on('close', code => process.exit(code ?? 1));
  `
  const result = await run(process.execPath, ['-e', agent], {
    watch: 'agent', timeoutMs: 10_000,
    stall: { windowMs: 1_500, minCpuSeconds: 5, pollMs: 200 },
  })
  assert.equal(result.timedOut, false)
  assert.equal(result.stalls, 1)
  assert.equal(result.code, 0, 'the agent should receive the tool failure and exit normally')
  assert.equal(processTable().some(row => row.command.includes(marker)), false)
})

test('the stall detector flags idle trees, including ones that churn short-lived children', async () => {
  const { createStallDetector } = await import('../src/run-milestones.mjs')
  const minute = 60_000
  const unit = (pid, processes) => [{ pid, command: `sh -c test-${pid}`, processes }]

  // Busy: CPU keeps growing, never flagged.
  const busy = createStallDetector({ windowMs: 10 * minute, minCpuSeconds: 10 })
  for (let t = 0; t <= 30; t += 1) assert.deepEqual(busy(t * minute, unit(1, [{ pid: 1, cpu: t * 5 }])), [])

  // Idle: flat CPU is flagged once the window has passed, and only once.
  const idle = createStallDetector({ windowMs: 10 * minute, minCpuSeconds: 10 })
  const flagged = []
  for (let t = 0; t <= 15; t += 1) flagged.push(...idle(t * minute, unit(2, [{ pid: 2, cpu: 1 }])))
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].pid, 2)

  // Deadlocked test: a new child every 2 minutes burns 1s then exits. The
  // live CPU total goes up and down, but the cumulative growth stays small.
  const churn = createStallDetector({ windowMs: 10 * minute, minCpuSeconds: 10 })
  const hits = []
  for (let t = 0; t <= 12; t += 1) {
    const child = 100 + Math.floor(t / 2)
    hits.push(...churn(t * minute, unit(3, [{ pid: 3, cpu: 0.5 }, { pid: child, cpu: 1 }])))
  }
  assert.equal(hits.length, 1)

  // A command that finished is forgotten.
  assert.deepEqual(idle(16 * minute, []), [])
})

test('the watchdog kills a stuck command and its separately grouped children', {
  skip: process.platform === 'win32',
}, async () => {
  const { run, processTable } = await import('../src/run-milestones.mjs')
  const marker = `stall-marker-${process.pid}-${Date.now()}`
  // The inner sleep runs in its own process group, like the agent's commands.
  const command = `node -e "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${marker}'], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000)"`
  const started = Date.now()
  const pending = run(command, [], { shell: true, watch: 'command', stall: { windowMs: 1_500, minCpuSeconds: 5, pollMs: 200 } })
  await new Promise(done => setTimeout(done, 800))
  assert.equal(processTable().some(row => row.command.includes(marker)), true, 'grandchild should be running before the watchdog fires')
  const result = await pending
  assert.equal(result.stalls, 1)
  assert.notEqual(result.code, 0)
  assert.ok(Date.now() - started < 15_000)
  assert.ok(result.stalls === 1)
  await new Promise(done => setTimeout(done, 500))
  assert.equal(processTable().some(row => row.command.includes(marker)), false)
})

test('Windows process table includes parent links and CPU time', {
  skip: process.platform !== 'win32',
}, async () => {
  const { processTable } = await import('../src/run-milestones.mjs')
  const self = processTable().find(row => row.pid === process.pid)
  assert.ok(self)
  assert.ok(self.ppid > 0)
  assert.ok(Number.isFinite(self.cpu))
})

test('Windows CLI launch preserves spaces in the executable path and arguments', {
  skip: process.platform !== 'win32',
}, async () => {
  const { run, windowsShellCommand } = await import('../src/run-milestones.mjs')
  const command = windowsShellCommand(process.execPath, [
    '-e', "process.exit(process.argv[1] === 'path with spaces' ? 0 : 7)", 'path with spaces',
  ])
  const result = await run(command, [], { shell: true, timeoutMs: 5_000 })
  assert.equal(result.code, 0)
  assert.throws(() => windowsShellCommand('opencode', ['%PATH%']), /不支持的字符/u)
})

test('Windows timeout kills a detached grandchild too', {
  skip: process.platform !== 'win32',
}, async () => {
  const { run, processTable } = await import('../src/run-milestones.mjs')
  const marker = `milestone-timeout-${process.pid}-${Date.now()}`
  const command = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${marker}'], { detached: true, stdio: 'ignore', windowsHide: true }); setInterval(() => {}, 1000)`
  const started = Date.now()
  const pending = run(process.execPath, ['-e', command], { timeoutMs: 6_000 })
  let foundGrandchild = false
  while (Date.now() - started < 5_000) {
    const matching = processTable().filter(row => row.command.includes(marker))
    if (matching.length >= 2) { foundGrandchild = true; break }
    await new Promise(done => setTimeout(done, 100))
  }
  const result = await pending
  assert.equal(foundGrandchild, true, 'the detached grandchild should start before timeout')
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 15_000)
  await new Promise(done => setTimeout(done, 500))
  assert.equal(processTable().some(row => row.command.includes(marker)), false)
})

test('Windows watchdog detects an idle command and kills its tree', {
  skip: process.platform !== 'win32',
}, async () => {
  const { run, processTable } = await import('../src/run-milestones.mjs')
  const marker = `milestone-stall-${process.pid}-${Date.now()}`
  const command = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${marker}'], { detached: true, stdio: 'ignore', windowsHide: true }); setInterval(() => {}, 1000)`
  const started = Date.now()
  const result = await run(process.execPath, ['-e', command], {
    watch: 'command',
    stall: { windowMs: 1_500, minCpuSeconds: 5, pollMs: 500 },
  })
  assert.equal(result.stalls, 1)
  assert.notEqual(result.code, 0)
  assert.ok(Date.now() - started < 15_000)
  await new Promise(done => setTimeout(done, 500))
  assert.equal(processTable().some(row => row.command.includes(marker)), false)
})

test('Windows agent watchdog watches a command shell without timing out the agent', {
  skip: process.platform !== 'win32',
}, async () => {
  const { run } = await import('../src/run-milestones.mjs')
  const agent = "const child = require('node:child_process').spawn('cmd.exe', ['/d', '/s', '/c', 'ping -n 30 127.0.0.1 >NUL'], { stdio: 'ignore', windowsHide: true }); child.on('close', code => process.exit(code === 0 ? 0 : 1))"
  const result = await run(process.execPath, ['-e', agent], {
    watch: 'agent',
    timeoutMs: 10_000,
    stall: { windowMs: 1_500, minCpuSeconds: 5, pollMs: 500 },
  })
  assert.equal(result.timedOut, false)
  assert.equal(result.stalls, 1)
  assert.notEqual(result.code, 0)
})

test('Windows shell recognition reads only the executable, including Git Bash', async () => {
  const { isWindowsShellCommand } = await import('../src/run-milestones.mjs')
  for (const command of [
    'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "pnpm test"',
    '"D:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -c "pnpm test"',
    'powershell.exe -NoProfile -Command Get-Date',
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c ls',
    'bash -c "sleep 1"',
    'cmd',
  ]) assert.equal(isWindowsShellCommand(command), true, command)
  for (const command of [
    '"D:\\Program Files\\nodejs\\node.exe" D:\\tools\\bash.exe',
    'node scripts/cmd.js',
    '"C:\\tools\\opencode.exe" run --standalone --agent implementer',
    'C:\\WINDOWS\\system32\\conhost.exe 0xffffffff -ForceV1',
    '',
  ]) assert.equal(isWindowsShellCommand(command), false, command)
})

test('Windows agent units are the outermost shells under the agent', async () => {
  const { windowsShellUnits } = await import('../src/run-milestones.mjs')
  const rows = [
    { pid: 10, ppid: 1, cpu: 0, command: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""opencode" "run""' },
    { pid: 11, ppid: 10, cpu: 0, command: '"C:\\tools\\opencode.exe" run' },
    { pid: 12, ppid: 11, cpu: 0, command: '"D:\\Git\\usr\\bin\\bash.exe" -c "pnpm test"' },
    { pid: 13, ppid: 12, cpu: 0, command: '"D:\\nodejs\\node.exe" pnpm.cjs test' },
    // pnpm runs the script through another cmd: part of unit 12, not a unit.
    { pid: 14, ppid: 13, cpu: 0, command: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vitest run' },
    { pid: 15, ppid: 14, cpu: 0, command: '"D:\\nodejs\\node.exe" vitest.mjs run' },
    { pid: 16, ppid: 11, cpu: 0, command: 'powershell.exe -NoProfile -Command Get-ChildItem' },
    // Outside the agent tree.
    { pid: 20, ppid: 1, cpu: 0, command: 'powershell.exe -NoProfile -EncodedCommand AAAA' },
  ]
  const units = windowsShellUnits(rows, 10)
  assert.deepEqual(units.map(unit => unit.pid).sort(), [12, 16])
  assert.deepEqual(units.find(unit => unit.pid === 12).processes.map(row => row.pid).sort(), [12, 13, 14, 15])
})

test('the watchdog tolerates a few failed process-table reads before ending the command', async () => {
  const { run, PROCESS_TABLE_FAILURE_LIMIT } = await import('../src/run-milestones.mjs')
  let reads = 0
  const flaky = await run(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
    watch: 'command',
    stall: { windowMs: 60_000, minCpuSeconds: 0, pollMs: 200, readUnits: () => {
      reads += 1
      if (reads % 2 === 1) throw new Error('临时失败')
      return []
    } },
  })
  assert.equal(flaky.code, 0)
  assert.equal(flaky.stalls, 0)

  const started = Date.now()
  const broken = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    watch: 'command',
    timeoutMs: 20_000,
    stall: { windowMs: 60_000, minCpuSeconds: 0, pollMs: 200, readUnits: () => { throw new Error('一直失败') } },
  })
  assert.equal(broken.timedOut, false)
  assert.equal(broken.stalls, 1)
  assert.notEqual(broken.code, 0)
  assert.ok(Date.now() - started < 10_000, `ended after ${PROCESS_TABLE_FAILURE_LIMIT} failed reads`)
})

test('--resume tells the agent the working tree is its own unfinished work', async () => {
  const { resumeNote } = await import('../src/run-milestones.mjs')
  const note = resumeNote({
    spec: 'specs/16-meetings-cloud',
    changes: ' M qiwi-dsh-backend/src/app.ts\n?? desktop/meeting-uploads.cjs\n',
    previousLog: '/repo/.milestone-logs/16-meetings-cloud-old.log',
  })
  assert.match(note, /specs\/16-meetings-cloud was interrupted/u)
  assert.match(note, / M qiwi-dsh-backend\/src\/app\.ts\n\?\? desktop\/meeting-uploads\.cjs\n```/u)
  assert.match(note, /16-meetings-cloud-old\.log/u)
  assert.match(note, /Do not start over/u)
  assert.doesNotMatch(resumeNote({ spec: 'specs/16', changes: 'M a', previousLog: null }), /previous run's log/u)
})

test('--review sends the agent straight to the independent review', async () => {
  const { resumeNote } = await import('../src/run-milestones.mjs')
  const note = resumeNote({
    spec: 'specs/21-maintenance',
    changes: ' M qiwi-dsh-backend/src/app.ts\n',
    previousLog: '/repo/.milestone-logs/21-maintenance-old.log',
    review: true,
  })
  assert.match(note, /specs\/21-maintenance was interrupted/u)
  assert.match(note, /21-maintenance-old\.log/u)
  assert.match(note, /start directly with the independent review/u)
  assert.match(note, /do not re-run the acceptance commands first/u)
  assert.doesNotMatch(note, /Before writing code, review these changes/u)
})

test('--resume and --review apply to the first milestone that needs the agent, not to those after it', async () => {
  const { resumeMode } = await import('../src/run-milestones.mjs')
  const dirty = ' M qiwi-dsh-backend/src/app.ts\n'
  const mode = (first, review, changes) => resumeMode({ first, review, changes })
  // The first milestone with unfinished work resumes; with --review it also starts at the review.
  assert.deepEqual(mode(true, false, dirty), { resuming: true, review: false, missingChanges: false })
  assert.deepEqual(mode(true, true, dirty), { resuming: true, review: true, missingChanges: false })
  // Nothing to resume or review in it: fine for --resume, an error for --review.
  assert.deepEqual(mode(true, false, ''), { resuming: false, review: false, missingChanges: false })
  assert.deepEqual(mode(true, true, ''), { resuming: false, review: false, missingChanges: true })
  // `--from NN --review`: once the first milestone is committed, the next one starts fresh
  // on a clean tree instead of failing for want of changes to review.
  assert.deepEqual(mode(false, true, ''), { resuming: false, review: false, missingChanges: false })
  assert.deepEqual(mode(false, true, dirty), { resuming: false, review: false, missingChanges: false })
})

// A repository on `branch` with a bare remote it has not been pushed to. Not a
// clone: cloning an empty repository already writes the branch's tracking
// configuration. The settings are local, so that the developer's own git
// configuration (signing, push.autoSetupRemote, ...) cannot change the outcome.
function scratchRepository(directory, name, branch) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const remote = join(directory, `${name}-remote.git`)
  const work = join(directory, name)
  mkdirSync(remote)
  mkdirSync(work)
  git(remote, 'init', '-q', '--bare')
  git(work, 'init', '-q')
  git(work, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
  git(work, 'remote', 'add', 'origin', remote)
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['push.default', 'simple'], ['push.autoSetupRemote', 'false']]) git(work, 'config', key, value)
  const commit = text => {
    writeFileSync(join(work, 'a.txt'), text)
    git(work, 'add', 'a.txt')
    git(work, 'commit', '-q', '-m', text)
  }
  return { work, remote, git: (...args) => git(work, ...args), commit }
}

test('--push catches up on commits an earlier push left behind', async () => {
  const { pushPending, unpushedCommits } = await import('../src/run-milestones.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'run-milestones-push-'))
  try {
    const { work, remote, git, commit } = scratchRepository(directory, 'work', 'dev')
    commit('one')
    // A branch without an upstream cannot be compared; pushing it is left to git, which says why it fails.
    assert.equal(unpushedCommits(work), null)
    assert.throws(() => pushPending([work]), /git push 失败/u)
    git('push', '-q', '-u', 'origin', 'HEAD')
    assert.equal(unpushedCommits(work), 0)
    assert.deepEqual(pushPending([work]), [])

    // The commit of a milestone whose push failed: a later run pushes it, once per repository.
    commit('two')
    assert.equal(unpushedCommits(work), 1)
    assert.deepEqual(pushPending([work, work]), [work])
    assert.equal(unpushedCommits(work), 0)

    // A push that fails names the repository and keeps the start the wrapper looks for;
    // a checkout that is not there is not an error.
    commit('three')
    rmSync(remote, { recursive: true, force: true })
    assert.throws(() => pushPending([work]), error => error.message.startsWith('git push 失败') && error.message.includes(`仓库 ${work}`))
    assert.deepEqual(pushPending([join(directory, 'missing')]), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('--push leaves master and main alone without --allow-main, in every repository, before pushing any', async () => {
  const { protectedBranch, pushPending, unpushedCommits } = await import('../src/run-milestones.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'run-milestones-protected-'))
  // One commit pushed, one not.
  const ahead = (name, branch) => {
    const repository = scratchRepository(directory, name, branch)
    repository.commit('one')
    repository.git('push', '-q', '-u', 'origin', 'HEAD')
    repository.commit('two')
    return repository.work
  }
  try {
    const feature = ahead('feature', 'dev')
    const trunk = ahead('trunk', 'main')
    const legacy = ahead('legacy', 'master')
    assert.equal(protectedBranch(feature), null)
    assert.equal(protectedBranch(trunk), 'main')
    assert.equal(protectedBranch(legacy), 'master')

    // A finished cross-repository milestone is skipped before the runner's branch check,
    // so the push makes that check itself, and before anything is pushed.
    assert.throws(() => pushPending([feature, trunk, legacy]), error => error.message.includes(trunk)
      && error.message.includes('当前在 main 分支') && error.message.includes('--allow-main'))
    // It must not look like a failed push, which the wrapper pushes again on its own.
    assert.throws(() => pushPending([trunk]), error => !error.message.startsWith('git push'))
    for (const work of [feature, trunk, legacy]) assert.equal(unpushedCommits(work), 1, work)

    // A protected branch with nothing to push is fine, and --allow-main pushes them all.
    assert.deepEqual(pushPending([feature], {}), [feature])
    assert.deepEqual(pushPending([trunk, legacy], { allowMain: true }), [trunk, legacy])
    assert.deepEqual(pushPending([feature, trunk, legacy]), [])
    for (const work of [feature, trunk, legacy]) assert.equal(unpushedCommits(work), 0, work)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a push failure is worded so that the wrapper pushes again, a refusal so that it does not', async () => {
  const { pushFailureMessage } = await import('../src/run-milestones.mjs')
  const { isPushFailure, parseFailure } = await import('../src/run-milestones-auto.mjs')
  const reported = error => parseFailure(`$ ...\n✗ ${pushFailureMessage(error, '01-first 已提交')}\n`).message
  const failed = reported(new Error('git push 失败：fatal: unable to access\nfatal: Could not read from remote repository.（仓库 /repo）'))
  assert.equal(isPushFailure(failed), true)
  assert.match(failed, /^git push 失败：/u)
  assert.equal(isPushFailure(reported(new Error('/repo 当前在 main 分支，不推送。请先切到开发分支，或加 --allow-main。'))), false)
  assert.match(pushFailureMessage(new Error('x'), '01-first 已提交'), /01-first 已提交；解决后带 --push 重新运行，会补推。$/u)
})

test('milestone numbers go past 99: three digits are listed, ordered and selected as numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'milestones-'))
  try {
    for (const name of ['100-c', '05-a', '99-b', '101-d', 'oauth-x', '7-short']) mkdirSync(join(dir, name))
    const milestones = listMilestones(dir)
    assert.deepEqual(milestones.map(item => [item.number, item.name]), [['05', '05-a'], ['99', '99-b'], ['100', '100-c'], ['101', '101-d']])
    assert.deepEqual(selectMilestones(milestones, { from: '99', to: '100' }).map(item => item.name), ['99-b', '100-c'])
    assert.deepEqual(selectMilestones(milestones, { only: '05,101' }).map(item => item.name), ['05-a', '101-d'])
    assert.equal(continueSelection(['99', '100', '101'], '100', true), '--only 100,101')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('milestone commit subjects pass commitlint\'s subject-case: no upper-case first letter', async () => {
  const { commitHeader } = await import('../src/run-milestones.mjs')
  assert.equal(commitHeader({ number: '35', title: 'M35：品牌层——产品名与 logo' }), 'feat(M35): 品牌层——产品名与 logo')
  assert.equal(commitHeader({ number: '01', title: 'M01：OAuth 客户端学校范围' }), 'feat(M01): oauth 客户端学校范围')
  assert.equal(commitHeader({ number: '25', title: 'M25：OPOC 实现标准 OAuth 2.0', cross: true }), 'feat: opoc 实现标准 OAuth 2.0')
  assert.equal(commitHeader({ number: '07', title: '专项：统计接口' }), 'feat(M07): 专项：统计接口')
  for (const title of ['M01：OAuth 客户端学校范围', 'M12：Admin UI', 'M3: Plain title']) {
    assert.doesNotMatch(commitHeader({ number: '01', title }).replace(/^[^:]+: /u, ''), /^[A-Z]/u, title)
  }
})
