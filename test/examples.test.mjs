// examples/.opencode is the template a new repository starts from: it must work
// with the commands of this package as it is.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { expandCommand, splitFrontmatter } from '../src/run-milestones.mjs'

const examples = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples')
const read = path => readFileSync(join(examples, '.opencode', path), 'utf8')
const strip = text => text.split('\n').filter(line => !/^(description|model):|^# Keep identical/u.test(line)).join('\n')

test('every example agent names a model and denies everything it does not allow', () => {
  for (const file of readdirSync(join(examples, '.opencode', 'agents'))) {
    const text = read(`agents/${file}`)
    assert.match(splitFrontmatter(text).fields.model ?? '', /^[\w-]+\/[\w.-]+#\w+$/u, file)
    assert.match(text, /^permissions:\n {2}- \{ action: "\*", resource: "\*", effect: deny \}/mu, `${file}: the catch-all deny comes first`)
  }
})

test('implement-plan: the command expands for the runner and names the implementer', () => {
  const command = expandCommand(read('commands/implement-plan.md'), 'specs/01-foo')
  assert.equal(command.agent, 'implementer')
  assert.match(command.prompt, /specs\/01-foo\/plan\.md/u)
  assert.match(read('agents/implementer.md'), /STATUS/u)
  for (const agent of ['reviewer', 'reviewer-fallback']) assert.match(read('agents/implementer.md'), new RegExp(`action: subagent, resource: ${agent}, effect: allow`, 'u'))
})

test('the reviewers stay read-only and the fallbacks copies of their primaries', () => {
  for (const [primary, fallback] of [['reviewer', 'reviewer-fallback'], ['plan-reviewer', 'plan-reviewer-fallback']]) {
    assert.equal(strip(read(`agents/${fallback}.md`)), strip(read(`agents/${primary}.md`)), fallback)
    assert.doesNotMatch(read(`agents/${primary}.md`), /action: (edit|subagent)[^\n]*effect: allow/u, primary)
  }
})

test('the example settings are valid', () => {
  const config = loadConfig(examples)
  assert.equal(config.name, 'MYAPP')
  assert.deepEqual(Object.keys(config.requiredEnv), ['MYAPP_TEST_DATABASE_URL'])
})
