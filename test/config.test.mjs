import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMain, loadConfig, missingEnv, repoRootOf } from '../src/config.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-config-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return realpathSync(dir)
}

test('the repository is the git top level of the current directory', () => {
  const repo = tempRepo()
  try {
    mkdirSync(join(repo, 'specs/01-x'), { recursive: true })
    assert.equal(repoRootOf(join(repo, 'specs/01-x')), repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('settings: defaults without a file, values and validation with one', () => {
  const repo = tempRepo()
  try {
    const defaults = loadConfig(repo)
    assert.equal(defaults.name, repo.split('/').at(-1))
    assert.deepEqual([defaults.requiredEnv, defaults.protectedDocs, defaults.machineNotes], [{}, [], []])
    assert.equal(defaults.pipelinesDir, join(repo, 'scripts', 'pipelines'))

    mkdirSync(join(repo, '.opencode'))
    writeFileSync(join(repo, '.opencode/workflows.json'), JSON.stringify({
      name: 'HARNESS', requiredEnv: { DB_URL: '测试库' }, protectedDocs: ['docs/API.md'], machineNotes: ['慢'], pipelinesDir: 'ops/pipelines',
    }))
    const config = loadConfig(repo)
    assert.equal(config.name, 'HARNESS')
    assert.equal(config.pipelinesDir, join(repo, 'ops/pipelines'))
    assert.deepEqual(missingEnv(config, {}), ['DB_URL（测试库）'])
    assert.deepEqual(missingEnv(config, { DB_URL: 'x' }), [])

    writeFileSync(join(repo, '.opencode/workflows.json'), JSON.stringify({ requiredEnv: ['DB_URL'], machineNotes: 'x' }))
    assert.throws(() => loadConfig(repo), /requiredEnv 必须是 \{ 变量名: 说明 \}；machineNotes 必须是字符串数组/u)
    writeFileSync(join(repo, '.opencode/workflows.json'), '{ nope')
    assert.throws(() => loadConfig(repo), /不是合法的 JSON/u)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a command started through an npm link symlink still runs its main', { skip: process.platform === 'win32' ? 'npm uses .cmd shims on Windows' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-link-'))
  try {
    const link = join(dir, 'refine-plan')
    symlinkSync(join(packageRoot, 'src', 'refine-plan.mjs'), link)
    assert.equal(isMain(pathToFileURL(join(packageRoot, 'src', 'refine-plan.mjs')).href, link), true)
    assert.equal(isMain(pathToFileURL(join(packageRoot, 'src', 'run-milestones.mjs')).href, link), false)
    const help = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /^用法：refine-plan /u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-milestones works on the repository of the current directory', () => {
  const repo = tempRepo()
  try {
    mkdirSync(join(repo, 'specs/01-first'), { recursive: true })
    mkdirSync(join(repo, 'specs/oauth-old'), { recursive: true })
    writeFileSync(join(repo, 'specs/01-first/plan.md'), '# M1：第一个\n\n## 验收命令\n\n```bash\nnode --version\n```\n')
    writeFileSync(join(repo, 'specs/oauth-old/plan.md'), '# 没有编号\n')
    execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    const result = spawnSync(process.execPath, [join(packageRoot, 'src', 'run-milestones.mjs'), '--dry-run'], { cwd: join(repo, 'specs'), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /01-first {2}· 待执行/u)
    assert.doesNotMatch(result.stdout, /oauth-old/u)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
