import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildMessage, dotStuff, encodeHeaderText, loadMailConfig, parseEnv, sendMail } from '../src/notify-mail.mjs'

const decodeWords = header => header.replace(/\r\n /gu, '')
  .replace(/=\?UTF-8\?B\?([^?]+)\?=/gu, (_, data) => Buffer.from(data, 'base64').toString('utf8'))

// A fake SMTP server speaking just enough of the protocol: AUTH LOGIN against
// fixed fake credentials, multi-line EHLO reply sent in pieces, DATA collected
// until the lone dot and un-stuffed.
async function startFakeSmtp({ user = 'robot@example.test', pass = 'fake-auth-code' } = {}) {
  const sessions = []
  const server = createServer(socket => {
    const session = { commands: [], data: null, rcpt: [] }
    sessions.push(session)
    let buffer = ''
    let state = 'command'
    let dataLines = []
    const reply = text => socket.write(`${text}\r\n`)
    reply('220 fake.test ESMTP ready')
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      for (let index = buffer.indexOf('\r\n'); index >= 0; index = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (state === 'data') {
          if (line === '.') {
            session.data = dataLines.join('\r\n')
            state = 'command'
            reply('250 queued')
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line)
          }
          continue
        }
        if (state === 'user') {
          session.user = Buffer.from(line, 'base64').toString('utf8')
          state = 'pass'
          reply('334 UGFzc3dvcmQ6')
          continue
        }
        if (state === 'pass') {
          state = 'command'
          const ok = session.user === user && Buffer.from(line, 'base64').toString('utf8') === pass
          reply(ok ? '235 Authentication successful' : '535 Login fail. Please use the authorization code.')
          continue
        }
        session.commands.push(line)
        if (/^EHLO /u.test(line)) {
          // Split mid-line to exercise reply buffering.
          socket.write('250-fake.test\r\n250-AU')
          setTimeout(() => socket.write('TH LOGIN PLAIN\r\n250 8BITMIME\r\n'), 5)
        } else if (line === 'AUTH LOGIN') {
          state = 'user'
          reply('334 VXNlcm5hbWU6')
        } else if (/^MAIL FROM:/u.test(line)) {
          reply('250 OK')
        } else if (/^RCPT TO:/u.test(line)) {
          session.rcpt.push(line.slice(9, -1))
          reply('250 OK')
        } else if (line === 'DATA') {
          state = 'data'
          dataLines = []
          reply('354 End data with <CR><LF>.<CR><LF>')
        } else if (line === 'QUIT') {
          reply('221 Bye')
          socket.end()
        } else {
          reply('502 Command not implemented')
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return {
    sessions,
    config: { host: '127.0.0.1', port, user, pass, from: user, fromName: '小七HARNESS', to: ['owner@example.test', 'second@example.test'] },
    connect: () => connect(port, '127.0.0.1'),
    close: () => new Promise(done => server.close(done)),
  }
}

test('a message goes through EHLO, AUTH LOGIN, RCPT for every recipient and DATA', async () => {
  const smtp = await startFakeSmtp()
  try {
    const subject = '[小七HARNESS] M22 ✅ 成功：DSH 升级到 0.2.0-rc.2，并关闭发往上游的会话数据'
    const text = '第一行\n.以点开头的一行\n最后一行'
    await sendMail(smtp.config, { subject, text }, { connect: smtp.connect })
    const [session] = smtp.sessions
    assert.match(session.commands[0], /^EHLO \S+$/u)
    assert.equal(session.user, 'robot@example.test')
    assert.deepEqual(session.rcpt, ['owner@example.test', 'second@example.test'])
    assert.ok(session.commands.includes('QUIT'))
    const [head, body] = session.data.split('\r\n\r\n')
    const headers = Object.fromEntries(head.replace(/\r\n /gu, ' ').split('\r\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]))
    assert.equal(decodeWords(headers.Subject.replace(/\?= =\?/gu, '?==?')), subject)
    assert.match(headers.From, /<robot@example\.test>$/u)
    assert.equal(headers.To, 'owner@example.test, second@example.test')
    assert.equal(headers['Content-Transfer-Encoding'], 'base64')
    assert.equal(Buffer.from(body.replace(/\r\n/gu, ''), 'base64').toString('utf8'), text.replace(/\n/gu, '\r\n'))
  } finally {
    await smtp.close()
  }
})

test('a rejected login fails with the server reply and never the password', async () => {
  const smtp = await startFakeSmtp({ pass: 'the-right-code' })
  try {
    await assert.rejects(
      sendMail({ ...smtp.config, pass: 'wrong-secret-code' }, { subject: 'x', text: 'y' }, { connect: smtp.connect }),
      error => {
        assert.match(error.message, /认证.*535 Login fail/u)
        assert.doesNotMatch(error.message, /wrong-secret-code|d3Jvbmctc2VjcmV0LWNvZGU/u)
        return true
      },
    )
    assert.equal(smtp.sessions[0].data, null)
  } finally {
    await smtp.close()
  }
})

test('a silent server times out instead of hanging', async () => {
  const server = createServer(() => {})
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const { port } = server.address()
    await assert.rejects(
      sendMail({ host: '127.0.0.1', port, user: 'a@b.test', pass: 'p', from: 'a@b.test', fromName: 'x', to: ['a@b.test'] },
        { subject: 's', text: 't' }, { connect: () => connect(port, '127.0.0.1'), timeoutMs: 300 }),
      /没有响应/u,
    )
  } finally {
    server.closeAllConnections?.()
    await new Promise(done => server.close(done))
  }
})

test('non-ASCII headers become encoded-words of at most 75 characters', () => {
  assert.equal(encodeHeaderText('plain ASCII'), 'plain ASCII')
  const subject = '[小七HARNESS] M22 ❌ 失败：验收命令失败，qiwi-dsh-backend 的 6 个符号链接测试在沙箱里 EPERM，需要在自己的终端重跑'
  const encoded = encodeHeaderText(subject)
  for (const word of encoded.split('\r\n ')) assert.ok(word.length <= 75, word)
  assert.equal(decodeWords(encoded), subject)
  assert.doesNotMatch(encodeHeaderText('a\r\nBcc: x@y'), /\r\nBcc/u)
})

test('dot-stuffing doubles leading dots and terminates the data', () => {
  assert.equal(dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c\r\n.\r\n')
  assert.equal(dotStuff('.x\r\n'), '..x\r\n.\r\n')
  const message = buildMessage({ from: 'a@b.test', fromName: 'Bot "1"', to: ['c@d.test'], subject: 's', text: 't', messageId: 'id@b.test', date: new Date(0) })
  assert.match(message, /^From: "Bot \\"1\\"" <a@b\.test>\r\n/u)
  assert.match(message, /\r\nDate: Thu, 01 Jan 1970 00:00:00 \+0000\r\n/u)
})

test('the settings file is optional, parsed without echoing values, and validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-mail-'))
  try {
    assert.equal(loadMailConfig(join(dir, 'missing.env')), null)
    const file = join(dir, 'notify.env')
    writeFileSync(file, '﻿# QQ 邮箱\r\nSMTP_USER=robot@example.test\r\nSMTP_PASS="fake code"\r\nMAIL_TO=a@example.test, b@example.test\r\n')
    assert.deepEqual(loadMailConfig(file), {
      host: 'smtp.qq.com', port: 465, user: 'robot@example.test', pass: 'fake code', from: 'robot@example.test',
      fromName: 'opencode-workflows', to: ['a@example.test', 'b@example.test'],
    })
    writeFileSync(file, 'SMTP_USER=robot@example.test\n')
    assert.throws(() => loadMailConfig(file), /缺少 SMTP_PASS/u)
    writeFileSync(file, 'SMTP_USER=robot@example.test\nSMTP_PASS secret-without-equals\n')
    assert.throws(() => loadMailConfig(file), error => /第 2 行/u.test(error.message) && !error.message.includes('secret'))
    writeFileSync(file, 'SMTP_USER=robot@example.test\nSMTP_PASS=x\nMAIL_TO=a@b.test\r\nBcc: c@d.test\n')
    assert.throws(() => loadMailConfig(file), /第 4 行/u)
    assert.deepEqual(parseEnv('A=1\n\n# c\nB = \'two words\'\n'), { A: '1', B: 'two words' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
