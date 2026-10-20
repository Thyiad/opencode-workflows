#!/usr/bin/env node
// From draft plans to committed code, unattended, for the selected milestones
// of the current repository (one, or several with --only/--from/--to):
//
//   1. refine-plan reviews every plan that still needs it, one after another
//      (refine-plan --only …). When one needs the user, refine-plan lets Claude
//      settle what it can, then mails and hands the Claude session over (see
//      refine-plan.mjs); the other plans are still reviewed.
//   2. each approved plan is committed (plan.md, the --also documents and
//      refine-report.md) in its repository, exactly as it was reviewed: a plan
//      edited afterwards, during the handover say, is left for the next run.
//   3. only when every plan in scope is ready, run-milestones-auto implements
//      them with the same selection: implement, review, accept, commit, push;
//      its failures are fixed by Claude, mailed and handed over as before.
// While any plan still needs the user, no code is written.
//
// Running the same command again carries on: an implemented milestone (STATUS
// APPROVED in HEAD) is skipped, a plan whose approved refine-report.md is
// committed and which has not changed since is not reviewed again, and a
// milestone whose STATUS exists (implemented, not yet committed) is left to
// run-milestones-auto, which re-runs acceptance.
//
//   refine-and-run specs/35-foo
//   refine-and-run --only 35,36
//   refine-and-run --from 35 --to 37 --dry-run
//
// The mails come from the two commands: refine-plan mails only when the user
// is needed (--no-success-mail), run-milestones-auto mails every outcome. This
// script mails only its own failure, a plan commit that git refused.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, loadConfig, repoRootOf } from './config.mjs'
import { DEFAULT_CONFIG_FILE, loadMailConfig, sendMail } from './notify-mail.mjs'
import { REPORT_FILE, documentsInScope, fileHash, locate, repoPath, reviewedRecord } from './refine-plan.mjs'
import { MILESTONE_NUMBER, listMilestones, milestoneTitle, parseNumberSpec, protectedBranch, selectMilestones, statusOf, targetOf } from './run-milestones.mjs'

const root = repoRootOf()
const here = dirname(fileURLToPath(import.meta.url))
const refineScript = join(here, 'refine-plan.mjs')
const autoScript = join(here, 'run-milestones-auto.mjs')

export const USAGE = `用法：refine-and-run <规格目录> [选项]
      refine-and-run --only <编号>[,<编号>|范围] [选项]
      refine-and-run --from <编号> [--to <编号>] [选项]

从初版 plan 一路到提交的代码，无人值守：
  1. refine-plan 逐个评审、完善选中的 plan。某个 plan 需要你处理时（失败、达到轮次上限、有「需人工决定」
     的问题），refine-plan 先交给 Claude 处理；还需要你就发邮件、在终端里打开 Claude 会话。其他 plan 照常评审。
  2. 评审通过的 plan 逐个提交（plan.md、--also 的文档和 refine-report.md）。
  3. 选中的 plan 全部就绪后，才用同样的选择跑 run-milestones-auto：实现、审查、验收、提交并推送；
     失败时 Claude 修复，修不好就发邮件、打开会话。
  还有 plan 需要你处理时，一行代码都不写。
处理好后重跑同一条命令（终端里会打印）：已实现的跳过，评审已通过并提交、之后没改过的 plan 不再评审。

选项：
  <规格目录>、--only、--from、--to   选择里程碑，同 run-milestones（--only 35、--only 35,36、--only 35-37,40、
                                      --from 35 --to 37；一起用时取交集）
  --skip-refine                 不评审，直接实现（plan 已经评审过）
  --dry-run                     只列出每个里程碑要做什么
  -h, --help                    显示本说明
只给 refine-plan：--max-rounds、--also、--accept-decisions
两边都给：--fix-rounds、--claude-timeout-minutes、--notify-config、--no-handover、
          --agent-timeout-hours、--stall-minutes、--stall-cpu-seconds
其余参数（--allow-main、--allow-dirty、--command-timeout-minutes、--resume、--review……）原样给 run-milestones-auto。

退出码：0 全部完成；还有 plan 需要你处理时是 refine-plan 的退出码（1 失败、3 未解决、4 待你决定）；
实现失败时是 run-milestones-auto 的（1）；130 手动中断。
`

// Option → whether it takes a value.
const REFINE_ONLY = new Map([['--max-rounds', true], ['--also', true], ['--accept-decisions', false]])
const SHARED = new Map([
  ['--fix-rounds', true], ['--claude-timeout-minutes', true], ['--notify-config', true], ['--no-handover', false],
  ['--agent-timeout-hours', true], ['--stall-minutes', true], ['--stall-cpu-seconds', true],
])
// The options of run-milestones-auto and the runner that take a value; the others are flags.
const AUTO_VALUE = new Set(['--command-timeout-minutes'])

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { spec: null, only: null, from: null, to: null, skipRefine: false, dryRun: false, help: false,
    acceptDecisions: false, notifyConfig: DEFAULT_CONFIG_FILE, refineArgs: [], autoArgs: [], passArgs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return next
    }
    if (arg === '--only') options.only = value()
    else if (arg === '--from') options.from = value()
    else if (arg === '--to') options.to = value()
    else if (arg === '--skip-refine') { options.skipRefine = true; options.passArgs.push(arg) }
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (REFINE_ONLY.has(arg) || SHARED.has(arg)) {
      const pair = (REFINE_ONLY.get(arg) ?? SHARED.get(arg)) ? [arg, value()] : [arg]
      if (arg === '--notify-config') { options.notifyConfig = resolve(cwd, pair[1]); pair[1] = options.notifyConfig }
      if (arg === '--accept-decisions') options.acceptDecisions = true
      options.refineArgs.push(...pair)
      if (SHARED.has(arg)) options.autoArgs.push(...pair)
      options.passArgs.push(...pair)
    } else if (arg === '--push') { /* run-milestones-auto always pushes */ }
    else if (arg.startsWith('-')) {
      // run-milestones-auto's or the runner's; they check it. --resume and
      // --review are for this implementation run, not for the next one.
      const pair = AUTO_VALUE.has(arg) ? [arg, value()] : [arg]
      options.autoArgs.push(...pair)
      if (arg !== '--resume' && arg !== '--review') options.passArgs.push(...pair)
    } else if (options.spec === null) options.spec = arg
    else throw new Error(`只能给一个规格目录（多出：${arg}）`)
  }
  if (options.help) return options
  if (options.spec !== null) {
    if (options.only !== null || options.from !== null || options.to !== null) throw new Error('给了规格目录就不要再给 --only/--from/--to')
    const dir = resolve(cwd, options.spec)
    const number = /^(\d{2,})-/u.exec(basename(dir))?.[1]
    if (!number || repoPath(dir, root) !== `specs/${basename(dir)}`) throw new Error(`${options.spec} 不是本仓库 specs/ 下带编号的规格目录`)
    options.only = number
  }
  if (options.only === null && options.from === null && options.to === null) throw new Error('需要选择里程碑：给一个规格目录，或者 --only/--from/--to')
  for (const key of ['from', 'to']) {
    if (options[key] !== null && !MILESTONE_NUMBER.test(options[key])) throw new Error(`--${key} 需要两位或以上的数字，例如 03`)
  }
  if (options.only !== null) parseNumberSpec(options.only)
  if (options.from !== null && options.to !== null && Number(options.from) > Number(options.to)) throw new Error('--from 不能大于 --to')
  return options
}

// The selection as run-milestones takes it.
export const selectionArgs = options => [
  ...(options.only !== null ? ['--only', options.only] : []),
  ...(options.from !== null ? ['--from', options.from] : []),
  ...(options.to !== null ? ['--to', options.to] : []),
]

// The command that carries on: the same selection and options. Done
// milestones and committed approved plans are skipped then.
export function continueCommand(options) {
  return ['refine-and-run', ...selectionArgs(options), ...options.passArgs].map(arg => (/\s/u.test(arg) ? `"${arg}"` : arg)).join(' ')
}

// The "结论" row of a refine-report.md whose review approved and whose final check held.
export const APPROVED_REPORT = /^\| 结论 \| 第 \d+ 轮评审通过 \|/mu

// The committed report approved exactly the current `documents` (plan.md and
// the --also files): a later edit, committed or not, or a document the review
// did not cover needs a new review. So do 需人工决定 items that were neither
// accepted then (--accept-decisions) nor now. `current(path)` is today's hash.
export function stillReviewed(reportText, documents, current, acceptDecisions = false) {
  const reviewed = reviewedRecord(reportText)
  return APPROVED_REPORT.test(reportText) && reviewed !== null
    && (reviewed.decisions === 0 || reviewed.accepted || acceptDecisions)
    && documents.every(path => path in reviewed.documents) && unchangedSince(reviewed.documents, current)
}

// The commit of an approved plan, scoped like the milestone's own commit
// (commitHeader in run-milestones.mjs). The subject starts with Chinese, so
// commitlint's subject-case holds whatever the title is.
export function planCommitMessage({ number, title, spec, cross }) {
  const subject = `完善 plan：${title.replace(/^M\d+[：:]\s*/u, '')}`
  return `${cross ? 'docs' : `docs(M${number})`}: ${subject}\n\n${spec}/plan.md 经 refine-plan 无人值守评审通过，记录见 ${spec}/${REPORT_FILE}。`
}

// What one milestone needs: 'skip' (implemented), 'refine' (review the plan
// first) or 'ready'. `state` is { status, statusFile, refined }.
export function stepsOf(state, options) {
  if (state.status === 'done') return 'skip'
  // refine-plan refuses a plan whose STATUS exists: the implementation is (nearly) done.
  if (state.statusFile) return 'ready'
  return options.skipRefine || state.refined ? 'ready' : 'refine'
}

// The documents a review left behind, unchanged since: `hashes` is the
// refine-plan results record's { path: hash }, `current(path)` today's hash.
export const unchangedSince = (hashes, current) => Object.entries(hashes).every(([path, hash]) => current(path) === hash)

// The loop. Every side effect goes through `deps`, so the tests drive it with fakes:
//   scope()                         the selected milestones
//   state(milestone)                { status: 'done' | 'approved-uncommitted' | 'pending', statusFile, refined }
//   refine(milestones, continueCommand)  { code, records }: refine-plan --only <these>, and its --results-file
//   commitPlan(milestone, record)   { ok, changed?, message }
//   implement()                     run-milestones-auto's exit code, with the same selection
//   protectedBranches(scope)        [{ cwd, branch }]: the repositories involved that are on master/main
//   unpushed(scope)                 the repositories involved whose HEAD is not on their upstream
//   interrupted(), log(text), mailFailure(subject, text)
// Resolves { code, phase?, pending? }.
export async function refineAndRun(options, deps) {
  const scope = deps.scope()
  if (scope.length === 0) { deps.log('没有匹配的里程碑。\n'); return { code: 1 } }
  const carryOn = continueCommand(options)
  // A stop that neither refine-plan nor run-milestones-auto mails: unattended,
  // the user would never hear of it otherwise.
  const stop = async (result, subject, reason) => {
    const text = `${reason}\n\n处理好后继续：${carryOn}\n`
    deps.log(`\n■ ${text}`)
    await deps.mailFailure(`${subject}（${selectionArgs(options).join(' ')}）`, text)
    return result
  }
  // run-milestones refuses master/main without --allow-main: refuse before a
  // plan is committed there, not after.
  if (!options.autoArgs.includes('--allow-main')) {
    const onMain = deps.protectedBranches(scope)
    if (onMain.length > 0) {
      return stop({ code: 1, phase: 'branch' }, '❌ 没有开始：在 master/main 分支上',
        `${onMain.map(item => `${item.cwd} 在 ${item.branch} 分支上`).join('；')}：不带 --allow-main 不会在这里提交 plan，也不会实现。切到开发分支后重跑；确实要在 master/main 上做时加 --allow-main。`)
    }
  }
  const steps = scope.map(milestone => ({ milestone, step: stepsOf(deps.state(milestone), options) }))
  for (const { milestone, step } of steps) if (step === 'skip') deps.log(`✓ ${milestone.rel} 已实现，跳过。\n`)

  const toRefine = steps.filter(item => item.step === 'refine').map(item => item.milestone)
  if (toRefine.length > 0) {
    deps.log(`\n━━ 评审 ${toRefine.length} 个 plan：${toRefine.map(item => item.rel).join('、')} ━━\n`)
    const { code, records = [] } = await deps.refine(toRefine, carryOn)
    if (deps.interrupted()) return { code: 130, phase: 'refine' }
    const pending = []
    for (const milestone of toRefine) {
      const record = records.find(item => item.label === milestone.rel)
      if (record?.result !== 'approved') { pending.push(milestone); continue }
      const commit = deps.commitPlan(milestone, record)
      if (!commit.ok) {
        const text = `${milestone.rel} 的 plan 评审通过了，但提交失败：\n\n${commit.message}\n\n还没有开始写代码。处理好后：${carryOn}\n`
        deps.log(`\n✗ ${text}`)
        await deps.mailFailure(`❌ ${milestone.title ?? milestone.rel}：plan 提交失败`, text)
        return { code: 1, phase: 'commit' }
      }
      if (commit.changed) pending.push(milestone)
      deps.log(`${commit.message}\n`)
    }
    if (code !== 0) {
      // refine-plan has mailed what each plan needs.
      deps.log(`\n■ 还有 plan 需要你处理：${(pending.length ? pending : toRefine).map(item => item.rel).join('、')}。没有开始写代码。处理好后：${carryOn}\n`)
      return { code, phase: 'refine', pending }
    }
    if (pending.length > 0) {
      // Every review passed, so refine-plan sent nothing (--no-success-mail).
      return stop({ code: 1, phase: 'refine', pending }, '⏸ plan 评审后又改过，没有开始写代码',
        `${pending.map(item => item.rel).join('、')} 的 plan 评审通过后又改过，没有提交。没有开始写代码；重跑会重新评审。`)
    }
  }
  if (steps.every(item => item.step === 'skip')) {
    // Committed by an earlier run whose push failed: run-milestones-auto pushes them.
    const unpushed = deps.unpushed(scope)
    if (unpushed.length === 0) { deps.log('\n✓ 选中的里程碑都已实现并推送。\n'); return { code: 0 } }
    deps.log(`\n━━ 选中的里程碑都已实现，但还有没推送的提交（${unpushed.join('、')}），交给 run-milestones-auto 推送 ━━\n`)
  } else {
    // Once more, right before the code: this run's reviews may have changed a
    // document an earlier approval covered (a shared --also file).
    const stale = steps.filter(item => item.step !== 'skip' && stepsOf(deps.state(item.milestone), options) === 'refine').map(item => item.milestone)
    if (stale.length > 0) {
      return stop({ code: 1, phase: 'stale', pending: stale }, '⏸ plan 评审已失效，没有开始写代码',
        `${stale.map(item => item.rel).join('、')} 的 plan 已经不是评审通过的版本了（本轮其他评审改了它的文档）。没有开始写代码；重跑会重新评审。`)
    }
    deps.log(`\n━━ plan 全部就绪，开始实现：${steps.filter(item => item.step !== 'skip').map(item => item.milestone.rel).join('、')} ━━\n`)
  }
  const code = await deps.implement()
  if (deps.interrupted()) return { code: 130, phase: 'implement' }
  if (code !== 0) {
    deps.log(`\n■ 实现没有全部完成（run-milestones-auto 退出码 ${code}）。处理好后：${carryOn}\n`)
    return { code, phase: 'implement' }
  }
  deps.log('\n✓ 全部完成。\n')
  return { code: 0 }
}

// ---- real side effects ------------------------------------------------------

let interrupted = false
const children = new Set()

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function runChild(script, args) {
  process.stdout.write(`\n$ ${basename(script, '.mjs')} ${args.map(arg => (/\s/u.test(arg) ? `"${arg}"` : arg)).join(' ')}\n`)
  return new Promise(resolvePromise => {
    // In this terminal: the child's handover opens an interactive Claude session here.
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env: process.env })
    children.add(child)
    child.on('close', code => { children.delete(child); resolvePromise(code ?? 1) })
    child.on('error', error => { children.delete(child); process.stderr.write(`无法启动 ${script}：${error.message}\n`); resolvePromise(1) })
  })
}

// --also paths are relative to the plan's repository, as refine-plan takes
// them (prepare() there), whatever the current directory.
export const alsoOf = (options, repo) => options.refineArgs
  .flatMap((arg, index) => (arg === '--also' ? options.refineArgs[index + 1].split(',') : []))
  .map(item => item.trim()).filter(Boolean).map(path => repoPath(path, repo)).filter(Boolean)

// Commits one approved plan from refine-plan's results record ({ repo, spec,
// hashes }): exactly the reviewed files, and only while they are still the
// reviewed version. Whatever else is staged stays staged and out of the commit.
// Resolves { ok, changed?, message }.
export function commitReviewed({ repo, spec, hashes, number, label, cross }) {
  if (!unchangedSince(hashes, path => fileHash(join(repo, path)))) {
    return { ok: true, changed: true, message: `${label} 的 plan 评审之后又改过，没有提交，下次运行时重新评审。` }
  }
  // A reviewed document that is gone was deleted by the review: commit the
  // deletion too, whether it is staged already (no longer in the index, still
  // in HEAD) or not. git add takes only paths on disk or in the index; git
  // commit --only takes the staged deletions as well. A never-tracked missing
  // path is left out.
  const known = (args, path) => git([...args, path], repo).status === 0
  const toAdd = Object.keys(hashes).filter(path => existsSync(join(repo, path)) || known(['ls-files', '--error-unmatch', '--'], path))
  const paths = Object.keys(hashes).filter(path => toAdd.includes(path) || known(['cat-file', '-e'], `HEAD:${path}`))
  if (paths.length === 0) return { ok: false, message: `${label} 的评审记录里没有能提交的文件。` }
  // Never `git add -A --` without paths: that stages everything.
  const add = toAdd.length > 0 ? git(['add', '-A', '--', ...toAdd], repo) : { status: 0 }
  if (add.status !== 0) return { ok: false, message: `git add 失败（${repo}）：${add.stderr.trim()}` }
  if (git(['diff', '--cached', '--quiet', '--', ...paths], repo).status === 0) return { ok: true, message: `${label} 的 plan 没有改动，不用提交。` }
  const title = milestoneTitle(readFileSync(join(repo, spec, 'plan.md'), 'utf8'), basename(spec))
  const commit = git(['commit', '-q', '-m', planCommitMessage({ number, title, spec, cross }), '--only', '--', ...paths], repo)
  if (commit.status !== 0) return { ok: false, message: `git commit 失败（${repo}）：${`${commit.stdout}${commit.stderr}`.trim()}` }
  return { ok: true, message: `✓ 已提交评审通过的 plan（${repo}）：${git(['log', '--oneline', '-1'], repo).stdout.trim()}` }
}

// This repository and the targets of cross-repository placeholders.
const reposOf = scope => [...new Set([realpathSync(root), ...scope.map(milestone => realpathSync(targetOf(milestone).cwd))])]

function createDeps(options, mailConfig) {
  return {
    scope: () => (existsSync(join(root, 'specs')) ? selectMilestones(listMilestones(), options) : [])
      .filter(item => existsSync(join(item.dir, 'plan.md')))
      .map(item => ({ ...item, title: milestoneTitle(readFileSync(join(item.dir, 'plan.md'), 'utf8'), item.name) })),
    state: milestone => {
      // A placeholder stands for its target.
      const { repo, spec } = locate(milestone.dir, root)
      const documents = [...documentsInScope(spec, alsoOf(options, repo)), `${spec}/${REPORT_FILE}`]
      const report = git(['show', `HEAD:${spec}/${REPORT_FILE}`], repo)
      const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', `${spec}/`, ...documents], repo).stdout.trim()
      return {
        status: statusOf(milestone), statusFile: existsSync(join(repo, spec, 'STATUS')),
        refined: report.status === 0 && !dirty
          && stillReviewed(report.stdout, documents.filter(path => path !== `${spec}/${REPORT_FILE}`), path => fileHash(join(repo, path)), options.acceptDecisions),
      }
    },
    refine: async (milestones, command) => {
      const resultsFile = join(tmpdir(), `refine-and-run-${process.pid}-${Date.now()}.json`)
      const code = await runChild(refineScript, ['--only', milestones.map(item => item.number).join(','), ...options.refineArgs,
        '--no-success-mail', '--continue-command', command, '--results-file', resultsFile])
      let records = []
      try { records = JSON.parse(readFileSync(resultsFile, 'utf8')) } catch { /* refine-plan stopped before its results */ }
      rmSync(resultsFile, { force: true })
      return { code, records }
    },
    commitPlan: (milestone, record) => commitReviewed({ ...record, number: milestone.number, label: milestone.rel, cross: record.repo !== realpathSync(root) }),
    implement: () => runChild(autoScript, [...selectionArgs(options), ...options.autoArgs]),
    protectedBranches: scope => reposOf(scope).map(cwd => ({ cwd, branch: protectedBranch(cwd) })).filter(item => item.branch),
    // As run-milestones-auto sees it: no upstream counts as not pushed.
    unpushed: scope => reposOf(scope).filter(cwd => {
      const upstream = git(['rev-parse', '@{u}'], cwd)
      return upstream.status !== 0 || upstream.stdout.trim() !== git(['rev-parse', 'HEAD'], cwd).stdout.trim()
    }),
    interrupted: () => interrupted,
    log: text => process.stdout.write(text),
    mailFailure: async (subject, text) => {
      if (!mailConfig) return
      try { await sendMail(mailConfig, { subject: `[${loadConfig(root).name}] ${subject}`, text }) } catch (error) { process.stderr.write(`⚠ 邮件发送失败：${error.message}\n`) }
    },
  }
}

// Tracked changes outside the selected plans and the --also documents would
// stop run-milestones after the reviews: refuse them before the first hour is spent.
export function dirtyOutside(paths, scope, also) {
  return paths.filter(path => !also.includes(path) && !scope.some(item => path.startsWith(`${item.rel}/`)))
}

function trackedChanges() {
  return git(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=no'], root).stdout.split('\0').filter(Boolean).map(entry => entry.slice(3))
}

function dryRun(options, deps) {
  const scope = deps.scope()
  if (scope.length === 0) { process.stdout.write('没有匹配的里程碑。\n'); return 1 }
  const what = { skip: '已实现，跳过', refine: '评审 plan，通过后提交', ready: '不用评审（plan 已评审并提交，或 STATUS 已存在，或 --skip-refine）' }
  const steps = scope.map(milestone => stepsOf(deps.state(milestone), options))
  scope.forEach((milestone, index) => process.stdout.write(`${milestone.rel}（${milestone.title}）：${what[steps[index]]}\n`))
  const onMain = options.autoArgs.includes('--allow-main') ? [] : deps.protectedBranches(scope)
  for (const item of onMain) process.stdout.write(`⚠ ${item.cwd} 在 ${item.branch} 分支上：不带 --allow-main 时会直接拒绝。\n`)
  if (steps.every(step => step === 'skip')) return 0
  process.stdout.write(`\n${steps.includes('refine') ? '全部评审通过后，' : ''}实现：run-milestones-auto ${[...selectionArgs(options), ...options.autoArgs].join(' ')}\n`)
  return 0
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) { process.stderr.write(`\n✗ ${error.message}\n  用法：refine-and-run --help\n`); process.exit(1) }
  if (options.help) { process.stdout.write(USAGE); return }
  let mailConfig = null
  try { mailConfig = loadMailConfig(options.notifyConfig) } catch (error) { process.stderr.write(`⚠ ${error.message}。本次不发邮件。\n`) }
  const deps = createDeps(options, mailConfig)
  if (options.dryRun) process.exit(dryRun(options, deps))
  // --resume/--review carry on with uncommitted work on purpose.
  if (!['--allow-dirty', '--resume', '--review'].some(flag => options.autoArgs.includes(flag))) {
    const dirty = dirtyOutside(trackedChanges(), deps.scope(), alsoOf(options, realpathSync(root)))
    if (dirty.length) {
      process.stderr.write(`\n✗ 工作区有未提交的改动，实现时 run-milestones 会拒绝开始：\n${dirty.map(path => `  ${path}`).join('\n')}\n  先处理掉；确认属于本次里程碑时加 --allow-dirty。\n`)
      process.exit(1)
    }
  }
  // Ctrl+C reaches the children too (same console / process group): they stop
  // and record their state; this run only waits for them and goes no further.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (interrupted) process.exit(130)
      interrupted = true
      if (process.platform !== 'win32' && signal !== 'SIGINT') for (const child of children) { try { child.kill(signal) } catch { /* gone */ } }
    })
  }
  const result = await refineAndRun(options, deps)
  process.exit(result.code)
}

if (isMain(import.meta.url)) {
  main().catch(error => { process.stderr.write(`\n✗ ${error.message}\n  用法：refine-and-run --help\n`); process.exit(1) })
}
