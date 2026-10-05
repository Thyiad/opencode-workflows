#!/usr/bin/env node
// Sends a plain-text email over SMTP with implicit TLS (smtps, port 465). Used
// by run-milestones-auto, run-gated-stages and refine-plan to report how an
// unattended run ended.
//
// Deliberately dependency-free, like the whole package: it installs with
// `npm link` and nothing else. Only what QQ Mail's server
// (smtp.qq.com:465, AUTH LOGIN) needs is implemented: no STARTTLS, no
// attachments, one text/plain UTF-8 body (base64).
//
// Settings live OUTSIDE every repository, in ~/.opencode-workflows/notify.env
// (%USERPROFILE%\.opencode-workflows\notify.env on Windows; the older
// ~/.qiwi-milestones/notify.env is still read when the new one does not
// exist), as KEY=VALUE lines:
//
//   SMTP_HOST=smtp.qq.com        optional, default smtp.qq.com
//   SMTP_PORT=465                optional, default 465 (implicit TLS)
//   SMTP_USER=you@qq.com         the sending account, also the From address
//   SMTP_PASS=<授权码>            QQ Mail's SMTP authorization code, not the QQ password
//   MAIL_TO=you@qq.com           optional, default SMTP_USER; several separated by commas
//   MAIL_FROM_NAME=HARNESS       optional sender name, default opencode-workflows
//
// The file is parsed into a plain object and handed to sendMail(); it never
// enters process.env, so no process the caller starts can read the password.
// Errors never contain it either: they quote the server's replies only.
//
//   opencode-workflows-mail --test                  # send a test email
//   opencode-workflows-mail --test --config <file>  # with another settings file
//   opencode-workflows-mail --help                  # usage, incl. how to get the 授权码
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { isMain } from './config.mjs'

const CONFIG_FILE = join(homedir(), '.opencode-workflows', 'notify.env')
const LEGACY_CONFIG_FILE = join(homedir(), '.qiwi-milestones', 'notify.env')
export const DEFAULT_CONFIG_FILE = existsSync(CONFIG_FILE) || !existsSync(LEGACY_CONFIG_FILE) ? CONFIG_FILE : LEGACY_CONFIG_FILE

const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/u

// KEY=VALUE lines; blank lines and # comments are skipped, one pair of
// surrounding quotes is removed. A malformed line is reported by number only,
// because it may hold the password.
export function parseEnv(text) {
  const values = {}
  text.replace(/^\uFEFF/u, '').split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (!match) throw new Error(`第 ${index + 1} 行不是 KEY=VALUE 格式`)
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/u, '$2')
  })
  return values
}

export function mailConfigFrom(values) {
  const missing = ['SMTP_USER', 'SMTP_PASS'].filter(key => !values[key])
  if (missing.length) throw new Error(`缺少 ${missing.join('、')}`)
  const port = Number(values.SMTP_PORT || 465)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('SMTP_PORT 不是有效端口')
  const to = (values.MAIL_TO || values.SMTP_USER).split(/[,;]/u).map(item => item.trim()).filter(Boolean)
  for (const address of [values.SMTP_USER, ...to]) {
    if (!ADDRESS.test(address)) throw new Error(`不是有效的邮箱地址：${address}`)
  }
  return { host: values.SMTP_HOST || 'smtp.qq.com', port, user: values.SMTP_USER, pass: values.SMTP_PASS, from: values.SMTP_USER, fromName: values.MAIL_FROM_NAME || 'opencode-workflows', to }
}

// null when the file does not exist: email is optional.
export function loadMailConfig(file = DEFAULT_CONFIG_FILE) {
  if (!existsSync(file)) return null
  try {
    return mailConfigFrom(parseEnv(readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(`邮件配置 ${file} 有误：${error.message}`)
  }
}

// RFC 2047: non-ASCII header text becomes UTF-8 base64 encoded-words of at
// most 75 characters (45 bytes -> 60 base64 characters + 12 of framing), split
// between characters and folded onto continuation lines.
export function encodeHeaderText(text) {
  const clean = String(text).replace(/[\r\n]+/gu, ' ')
  if (/^[\x20-\x7e]*$/u.test(clean)) return clean
  const words = []
  let chunk = ''
  for (const char of clean) {
    if (chunk && Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ')
}

function displayName(name) {
  return /^[\x20-\x7e]*$/u.test(name) ? `"${name.replace(/["\\]/gu, '\\$&')}"` : encodeHeaderText(name)
}

export function buildMessage({ from, fromName, to, subject, text, date = new Date(), messageId = null }) {
  const domain = from.split('@')[1]
  const id = messageId ?? `${Date.now()}.${randomBytes(8).toString('hex')}@${domain}`
  const body = Buffer.from(String(text).replace(/\r?\n/gu, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/gu, '$&\r\n')
  return [
    `From: ${displayName(fromName)} <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/u, '+0000')}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n')
}

// SMTP DATA: a line that starts with "." gets one more, and the message ends
// with a line holding a single ".".
export function dotStuff(message) {
  const stuffed = message.replace(/(^|\r\n)\./gu, '$1..')
  return `${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`
}

// Replies are one line "250 text", or several "250-text" lines closed by
// "250 text". Returns a function that resolves the next complete reply.
function replyReader(socket, timeoutMs) {
  let buffer = ''
  let lines = []
  const replies = []
  let waiter = null
  let failure = null
  const settle = () => {
    if (!waiter) return
    const current = waiter
    if (replies.length) { waiter = null; current.resolve(replies.shift()) } else if (failure) { waiter = null; current.reject(failure) }
  }
  const fail = error => { failure ??= error; settle() }
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/u, '')
      buffer = buffer.slice(index + 1)
      lines.push(line)
      if (/^\d{3}-/u.test(line)) continue
      replies.push({ code: /^\d{3}(?: |$)/u.test(line) ? Number(line.slice(0, 3)) : 0, text: lines.join('\n') })
      lines = []
    }
    settle()
  })
  socket.on('error', error => fail(new Error(`SMTP 连接出错：${error.message}`)))
  socket.on('close', () => fail(new Error('SMTP 服务器关闭了连接')))
  socket.setTimeout(timeoutMs, () => {
    fail(new Error(`SMTP 服务器 ${Math.round(timeoutMs / 1000)} 秒没有响应`))
    socket.destroy()
  })
  return () => new Promise((resolvePromise, reject) => { waiter = { resolve: resolvePromise, reject }; settle() })
}

function connectTls({ host, port }, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = tlsConnect({ host, port, servername: host, minVersion: 'TLSv1.2' })
    const onError = error => { clearTimeout(timer); reject(new Error(`无法连接 ${host}:${port}：${error.message}`)) }
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`连接 ${host}:${port} 超时`)) }, timeoutMs)
    socket.once('error', onError)
    socket.once('secureConnect', () => { clearTimeout(timer); socket.removeListener('error', onError); resolvePromise(socket) })
  })
}

const base64 = text => Buffer.from(text, 'utf8').toString('base64')

// `connect(config)` returns the connected socket (or a promise of it); tests
// replace the TLS connection with a plain one to a fake server.
export async function sendMail(config, { subject, text }, { connect = connectTls, timeoutMs = 30_000 } = {}) {
  const socket = await connect(config, timeoutMs)
  const read = replyReader(socket, timeoutMs)
  const expect = async (step, codes) => {
    const reply = await read()
    if (!codes.includes(reply.code)) throw new Error(`SMTP 失败（${step}）：${reply.text}`)
    return reply
  }
  // `line` may be a credential: it is written, never quoted in an error.
  const send = (line, step, codes) => { socket.write(`${line}\r\n`); return expect(step, codes) }
  const ehlo = hostname().replace(/[^A-Za-z0-9.-]/gu, '') || 'localhost'
  try {
    await expect('连接', [220])
    await send(`EHLO ${ehlo}`, 'EHLO', [250])
    await send('AUTH LOGIN', 'AUTH', [334])
    await send(base64(config.user), 'AUTH', [334])
    await send(base64(config.pass), '认证，检查 SMTP_USER 与授权码 SMTP_PASS', [235])
    await send(`MAIL FROM:<${config.from}>`, 'MAIL FROM', [250])
    for (const address of config.to) await send(`RCPT TO:<${address}>`, `收件人 ${address}`, [250, 251])
    await send('DATA', 'DATA', [354])
    socket.write(dotStuff(buildMessage({ ...config, subject, text })))
    await expect('投递', [250])
    // Delivered; a missing goodbye does not matter any more.
    await send('QUIT', 'QUIT', [221]).catch(() => {})
  } finally {
    socket.destroy()
  }
}

export const USAGE = `用法：opencode-workflows-mail --test [--config <文件>]

按邮件配置发一封测试邮件，确认 run-milestones-auto、run-gated-stages、refine-plan 的邮件通知能用。

邮件配置默认在 ${DEFAULT_CONFIG_FILE}（在所有仓库之外，不进 git），一行一个 KEY=VALUE：
  SMTP_USER=<QQ 号>@qq.com      发件账号，也是发件人地址
  SMTP_PASS=<授权码>            QQ 邮箱的 SMTP 授权码，不是 QQ 密码
  MAIL_TO=<收件地址>            可选，默认同 SMTP_USER；多个用逗号分隔
  SMTP_HOST=smtp.qq.com         可选，默认 smtp.qq.com
  SMTP_PORT=465                 可选，默认 465（SSL 直连）
  MAIL_FROM_NAME=<发件人名称>   可选，默认 opencode-workflows
以 # 开头的行是注释。

生成授权码：QQ 邮箱网页版 → 设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV 服务 →
开启「POP3/SMTP 服务」→ 按提示验证后生成授权码，填进 SMTP_PASS。
`

async function main() {
  const argv = process.argv.slice(2)
  let file = DEFAULT_CONFIG_FILE
  let test = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--test') test = true
    else if (argv[index] === '--config' && argv[index + 1]) file = resolve(argv[++index])
    else if (argv[index] === '-h' || argv[index] === '--help') { process.stdout.write(USAGE); return }
    else throw new Error(`未知参数：${argv[index]}\n\n${USAGE}`)
  }
  if (!test) { process.stdout.write(USAGE); return }
  const config = loadMailConfig(file)
  if (!config) throw new Error(`找不到邮件配置 ${file}，格式见 opencode-workflows-mail --help 或 opencode-workflows 的 README`)
  await sendMail(config, {
    subject: '[opencode-workflows] 邮件通知测试',
    text: `这是一封测试邮件：opencode-workflows 的邮件通知已配置好。\n\n发件账号：${config.user}\n配置文件：${file}\n发送时间：${new Date().toLocaleString('zh-CN')}\n`,
  })
  process.stdout.write(`✓ 测试邮件已发送到 ${config.to.join('、')}\n`)
}

if (isMain(import.meta.url)) {
  main().catch(error => { process.stderr.write(`✗ ${error.message}\n`); process.exit(1) })
}
