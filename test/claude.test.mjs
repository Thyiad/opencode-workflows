import assert from 'node:assert/strict'
import test from 'node:test'
import { HANDOVER_PROMPT, claudeArgs, decisionSchema, handoverArgs, parseClaudeOutput, sessionLines } from '../src/claude.mjs'

const answer = next => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: 's-1',
  structured_output: { next, rootCause: '根因', summary: '经过', actionsTaken: [], userActions: [] },
})

test('each command has its own set of answers', () => {
  assert.equal(parseClaudeOutput(answer('rerun'), ['rerun', 'give-up']).decision.next, 'rerun')
  assert.match(parseClaudeOutput(answer('accept'), ['rerun', 'give-up']).error, /next 不是 rerun \/ give-up 之一/u)
  const args = claudeArgs({ sessionId: 's-1', resume: false, name: 'M35 plan 自动处理', schema: decisionSchema(['rerun', 'give-up']) })
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.next.enum, ['rerun', 'give-up'])
  assert.deepEqual(args.slice(-4), ['--session-id', 's-1', '--name', 'M35 plan 自动处理'])
})

test('the takeover lines: already open here, or how to open it', () => {
  const session = { id: 's-1', title: 'M35 plan 待处理' }
  assert.match(sessionLines({ session, handedOver: true, cwd: '/repo' }).join('\n'), /电脑上已经用 Remote Control 打开了这个会话/u)
  const lines = sessionLines({ session, handedOver: false, cwd: '/repo' }).join('\n')
  assert.match(lines, /先在电脑上运行下面第二条命令/u)
  assert.match(lines, /在 \/repo 运行 claude --resume s-1/u)
  assert.match(lines, /claude --resume s-1 --remote-control "M35 plan 待处理"/u)
})

test('the reopened session starts by asking for what the user has to decide', () => {
  const args = handoverArgs({ id: 's-1', title: 'M35 plan 待处理' })
  assert.deepEqual(args, ['--resume', 's-1', '--remote-control', 'M35 plan 待处理', HANDOVER_PROMPT])
  assert.match(HANDOVER_PROMPT, /需要我决定或处理的问题/u)
})
