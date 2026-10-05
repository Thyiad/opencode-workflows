// The repository a command works on, and that repository's settings.
//
// Every command works on the git repository of the current directory, not on
// the repository this package lives in, so one global install serves every
// repository that has the opencode workflows set up (.opencode/commands and
// .opencode/agents). What differs between those repositories is read from
// .opencode/workflows.json (optional; opencode ignores the file):
//
//   {
//     "name": "HARNESS",                  // mail tag and sender name; default: the directory name
//     "requiredEnv": {                    // variables a milestone run needs, with a hint for each
//       "HARNESS_TEST_MONGODB_URI": "本机 MongoDB 的管理员连接串，见 specs/00-conventions.md 3.2"
//     },
//     "protectedDocs": ["docs/BUSINESS-API.md"],   // never edited by the unattended Claude fixer,
//                                                  // besides specs/**/plan.md and specs/00-conventions.md
//     "machineNotes": ["…"],              // facts about this machine for the unattended Claude fixer
//     "pipelinesDir": "scripts/pipelines" // where run-gated-stages finds <name>.json
//   }
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const CONFIG_FILE = join('.opencode', 'workflows.json')

// The top level of the git repository containing `dir`, or `dir` itself when it
// is not in one (the command then reports what is missing).
export function repoRootOf(dir = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  const top = result.status === 0 ? result.stdout.trim() : resolve(dir)
  try { return realpathSync(top) } catch { return top }
}

const STRING_LIST = value => Array.isArray(value) && value.every(item => typeof item === 'string')

export function loadConfig(repo) {
  const file = join(repo, CONFIG_FILE)
  let raw = {}
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { throw new Error(`${file} 不是合法的 JSON：${error.message}`) }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} 的顶层必须是对象`)
  }
  const problems = []
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.trim() === '')) problems.push('name 必须是非空字符串')
  if (raw.requiredEnv !== undefined && (raw.requiredEnv === null || typeof raw.requiredEnv !== 'object' || Array.isArray(raw.requiredEnv)
    || !Object.values(raw.requiredEnv).every(hint => typeof hint === 'string'))) problems.push('requiredEnv 必须是 { 变量名: 说明 }')
  for (const key of ['protectedDocs', 'machineNotes']) if (raw[key] !== undefined && !STRING_LIST(raw[key])) problems.push(`${key} 必须是字符串数组`)
  if (raw.pipelinesDir !== undefined && typeof raw.pipelinesDir !== 'string') problems.push('pipelinesDir 必须是字符串')
  if (problems.length > 0) throw new Error(`${file} 有误：${problems.join('；')}`)
  return {
    file,
    name: raw.name ?? basename(repo),
    requiredEnv: raw.requiredEnv ?? {},
    protectedDocs: raw.protectedDocs ?? [],
    machineNotes: raw.machineNotes ?? [],
    pipelinesDir: join(repo, raw.pipelinesDir ?? join('scripts', 'pipelines')),
  }
}

// The required variables that are not set, as "NAME（hint）" lines.
export function missingEnv(config, env = process.env) {
  return Object.entries(config.requiredEnv).filter(([name]) => !env[name]).map(([name, hint]) => `${name}（${hint}）`)
}

// Whether the module at `importMetaUrl` is the program being run. A global
// command installed by `npm link` is a symlink to the file, so both sides are
// compared with symlinks resolved.
export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try { return realpathSync(argv1) === realpathSync(new URL(importMetaUrl)) } catch { return false }
}
