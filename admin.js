'use strict'

/**
 * 下载站管理后台 API
 *
 * 提供：登录鉴权、文件上传/删除、version.json 在线编辑。
 * 管理密码通过环境变量 ADMIN_PASSWORD 配置，未配置时使用内置默认值。
 * 所有写操作均需 Bearer Token（登录后颁发，24 小时有效）。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const WEB_DIR = path.join(__dirname, 'web')
const DOWNLOADS_DIR = path.join(WEB_DIR, 'downloads')
const VERSION_FILE = path.join(DOWNLOADS_DIR, 'version.json')

/**
 * 管理密码：必须通过环境变量 ADMIN_PASSWORD 提供。
 *
 * 早先这里内置了一个默认密码，为了让管理后台开箱可用；但这意味着密码会随
 * 代码进入公开仓库，任何人都能登录发布站、上传文件、篡改 version.json。
 * 现在改为未配置即关闭管理接口（返回 503），部署时自行注入环境变量。
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const ADMIN_ENABLED = ADMIN_PASSWORD.length > 0
/** Token 有效期 */
const TOKEN_TTL = 24 * 60 * 60 * 1000
/** 单文件上传上限 */
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024
/** 允许上传的扩展名 */
const ALLOWED_EXT = ['.apk', '.zip', '.json']
/** 请求体读取上限（略高于上传上限） */
const MAX_BODY_SIZE = MAX_UPLOAD_SIZE + 1024 * 1024

/**
 * Token 采用无状态 HMAC 签名（部署平台多实例共享内存不可靠，
 * 用管理密码派生密钥，密码更改后所有旧 token 自动失效）。
 */
const TOKEN_SECRET = crypto.createHash('sha256').update(`lxmod-admin:${ADMIN_PASSWORD}`).digest()

function signPayload(payload) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
}

function createToken() {
  const expires = Date.now() + TOKEN_TTL
  const payload = String(expires)
  return `${payload}.${signPayload(payload)}`
}

function verifyToken(token) {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!/^\d+$/.test(payload)) return false
  const expected = signPayload(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  return Number(payload) > Date.now()
}

const log = (...args) => {
  console.log(new Date().toISOString(), '[admin]', ...args)
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      size += chunk.length
      if (size > limit) {
        aborted = true
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
    req.on('error', (err) => { if (!aborted) reject(err) })
  })
}

/** 清洗文件名：仅保留basename与安全字符，防止路径穿越 */
function safeFileName(name) {
  const base = path.basename(String(name || ''))
  const cleaned = base.replace(/[^A-Za-z0-9._\-]/g, '_').replace(/^\.+/, '')
  return cleaned.slice(0, 120)
}

/**
 * 解析 multipart/form-data（按 boundary 分段，适合单/少量大文件上传）
 */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  if (!m) return []
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim())
  const parts = []
  let start = buffer.indexOf(boundary)
  while (start !== -1) {
    const end = buffer.indexOf(boundary, start + boundary.length)
    if (end === -1) break
    // 跳过 boundary 后的 CRLF，去掉段落结尾的 CRLF
    let part = buffer.slice(start + boundary.length + 2, end - 2)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString('utf8')
      const data = part.slice(headerEnd + 4)
      const nameMatch = /name="([^"]*)"/i.exec(headerText)
      const fileMatch = /filename="([^"]*)"/i.exec(headerText)
      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: fileMatch ? fileMatch[1] : '',
          data,
        })
      }
    }
    start = end
  }
  return parts
}

/**
 * 鉴权：优先 ?token=，其次 Authorization: Bearer。
 * 分享网关会改写 Authorization 头（注入自己的签名），因此 query 优先。
 */
function isAuthorized(req, url) {
  let token = ''
  if (url) {
    try { token = url.searchParams.get('token') || '' } catch {}
  }
  if (!token) {
    const header = req.headers.authorization || ''
    if (header.startsWith('Bearer ')) token = header.slice(7)
  }
  if (!token) return false
  return verifyToken(token)
}

function listFiles() {
  const files = []
  for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
    const full = path.join(DOWNLOADS_DIR, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    files.push({
      name,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

function readVersion() {
  return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
}

function normalizeDownload(download, version, origin, sharecode) {
  const result = {}
  const kinds = [
    ['arm64-v8a', `LXMusic-Mod-v${version}-arm64-v8a.apk`],
    ['universal', `LXMusic-Mod-v${version}-universal.apk`],
    ['backscreen', `LXMusic-Mod-v${version}-backscreen-arm64-v8a.apk`],
  ]
  for (const [key, fileName] of kinds) {
    const provided = download && typeof download[key] === 'string' ? download[key].trim() : ''
    result[key] = provided || `${origin}/downloads/${fileName}${sharecode ? `?sharecode=${sharecode}` : ''}`
  }
  return result
}

/**
 * 发布时间（北京时间 yyyy-MM-dd HH:mm）。
 * 下载页「更新于」直接读这个字段，没有就显示占位符，
 * 之前没有该字段导致页面一直停在写死的旧日期。
 */
function formatPublishDate(input) {
  const raw = String(input || '').trim()
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(raw)) return raw.replace('T', ' ')
  // 服务器多为 UTC，统一按东八区格式化
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * 源码地址规范化：统一存「文件名 / 完整 URL」，
 * 去掉可能带入的 /downloads/ 前缀——下载页和 App 会各自补前缀，带了就会变成 downloads/downloads/。
 */
function normalizeSource(source, version, origin, sharecode) {
  const raw = String(source || '').trim()
  if (!raw) return `lx-music-mod-src-v${version}.zip`
  if (/^https?:\/\//.test(raw)) return raw
  return raw.replace(/^\/downloads\//, '').replace(/^\/+/, '')
}

/**
 * 更新 version.json。
 * 版本号变化时，自动把旧版本的 desc 归档进 history 头部。
 */
function updateVersion(input, origin) {
  // 反代网关可能改写 Host 头为内部地址，调用方显式传入的 origin 优先
  const effectiveOrigin = String(input.origin || '').trim() || origin
  const current = readVersion()
  const version = String(input.version || '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('bad_version（格式需为 x.y.z）')
  }
  const next = { ...current }
  next.version = version
  const versionCode = parseInt(input.versionCode, 10)
  if (Number.isFinite(versionCode) && versionCode > 0) next.versionCode = versionCode

  if (input.desc != null) next.desc = String(input.desc).slice(0, 8000)

  if (version !== current.version && current.desc) {
    const archived = { version: current.version, desc: current.desc }
    next.history = [archived, ...(Array.isArray(current.history) ? current.history : [])]
      .filter((item, index, arr) => arr.findIndex(x => x.version === item.version) === index)
      .slice(0, 20)
  }

  const sharecode = String(input.sharecode || '').trim()
  next.download = normalizeDownload(input.download, version, effectiveOrigin, sharecode)
  if (input.source != null) {
    const source = normalizeSource(input.source, version, origin, sharecode)
    next.source = source
  }
  // 发布时间：每次保存都刷新（显式传入的 date 优先），下载页据此显示「更新于」
  next.date = formatPublishDate(input.date)
  if (input.notes != null && Array.isArray(input.notes)) {
    // 兼容旧字段，保留但不作为 App 更新来源
    next.notes = input.notes
  }

  fs.writeFileSync(VERSION_FILE, JSON.stringify(next, null, 2))
  return next
}

/**
 * 管理后台 API 路由入口。
 * @returns {boolean} 是否已处理该请求
 */
async function handleAdminApi(req, res, pathname) {
  // 管理后台页面（静态文件由 serveStatic 兜底，这里只做 /admin 重定向）
  if (pathname === '/admin') {
    res.writeHead(302, { Location: '/admin.html' })
    res.end()
    return true
  }

  if (!pathname.startsWith('/api/admin/')) return false
  const action = pathname.slice('/api/admin/'.length)

  // 未配置 ADMIN_PASSWORD 时，整组管理接口关闭。宁可后台不可用，也不要一个
  // 公开仓库里人尽皆知的密码。
  if (!ADMIN_ENABLED) {
    sendJson(res, 503, { ok: false, error: 'admin_not_configured' })
    return true
  }

  // 版本诊断（无鉴权，用于确认部署版本与网关传参情况）
  if (req.method === 'GET' && action === 'ping') {
    let queryEcho = {}
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      for (const [k, v] of u.searchParams) queryEcho[k] = v.slice(0, 20)
    } catch {}
    sendJson(res, 200, {
      ok: true,
      build: 'v4-origin',
      tokenTtl: TOKEN_TTL,
      hasAuthHeader: Boolean(req.headers.authorization),
      queryEcho,
    })
    return true
  }

  // ---- 登录（无需鉴权）----
  if (req.method === 'POST' && action === 'login') {
    let body = {}
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
    } catch {}
    const password = String(body.password || '')
    // 常量时间比较，避免时序侧信道
    const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest()
    const given = crypto.createHash('sha256').update(password).digest()
    if (crypto.timingSafeEqual(expected, given)) {
      log('login success')
      sendJson(res, 200, { ok: true, token: createToken() })
    } else {
      log('login failed')
      sendJson(res, 401, { ok: false, error: 'wrong_password' })
    }
    return true
  }

  // ---- 以下全部需要鉴权 ----
  let adminUrl
  try { adminUrl = new URL(req.url || '/', 'http://localhost') } catch { adminUrl = null }
  if (!isAuthorized(req, adminUrl)) {
    // 诊断字段：确认网关转发后服务端实际收到的凭证
    const header = req.headers.authorization || ''
    let qToken = ''
    try { qToken = adminUrl ? adminUrl.searchParams.get('token') || '' : '' } catch {}
    const probe = qToken || (header.startsWith('Bearer ') ? header.slice(7) : '')
    let dbg = { source: header.startsWith('Bearer ') ? 'header' : (qToken ? 'query' : 'none') }
    if (probe) {
      const dot = probe.lastIndexOf('.')
      dbg = {
        ...dbg,
        probeLen: probe.length,
        payloadOk: dot > 0 && /^\d+$/.test(probe.slice(0, dot)),
        sigPreview: dot > 0 ? probe.slice(dot + 1, dot + 9) : '',
      }
    }
    sendJson(res, 401, { ok: false, error: 'unauthorized', dbg })
    return true
  }

  try {
    if (req.method === 'GET' && action === 'files') {
      sendJson(res, 200, { ok: true, files: listFiles() })
      return true
    }

    if (req.method === 'POST' && action === 'upload') {
      const buffer = await readBody(req, MAX_BODY_SIZE)
      const parts = parseMultipart(buffer, req.headers['content-type'])
      const saved = []
      for (const part of parts) {
        if (!part.filename || part.data.length === 0) continue
        const name = safeFileName(part.filename)
        const ext = path.extname(name).toLowerCase()
        if (!ALLOWED_EXT.includes(ext)) {
          sendJson(res, 400, { ok: false, error: `bad_file_type: ${ext || '(none)'}，仅允许 ${ALLOWED_EXT.join(' / ')}` })
          return true
        }
        if (part.data.length > MAX_UPLOAD_SIZE) {
          sendJson(res, 400, { ok: false, error: 'file_too_large' })
          return true
        }
        fs.writeFileSync(path.join(DOWNLOADS_DIR, name), part.data)
        saved.push({ name, size: part.data.length })
        log('uploaded:', name, part.data.length, 'bytes')
      }
      if (!saved.length) {
        sendJson(res, 400, { ok: false, error: 'no_file' })
        return true
      }
      sendJson(res, 200, { ok: true, saved, files: listFiles() })
      return true
    }

    if (req.method === 'POST' && action === 'delete') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
      const name = safeFileName(body.name)
      if (!name) {
        sendJson(res, 400, { ok: false, error: 'bad_name' })
        return true
      }
      const target = path.join(DOWNLOADS_DIR, name)
      if (!fs.existsSync(target)) {
        sendJson(res, 404, { ok: false, error: 'not_found' })
        return true
      }
      fs.unlinkSync(target)
      log('deleted:', name)
      sendJson(res, 200, { ok: true, files: listFiles() })
      return true
    }

    if (req.method === 'GET' && action === 'version') {
      sendJson(res, 200, { ok: true, version: readVersion() })
      return true
    }

    if (req.method === 'POST' && action === 'version') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}')
      const origin = `https://${req.headers.host || 'localhost'}`
      const version = updateVersion(body, origin)
      log('version updated:', version.version)
      sendJson(res, 200, { ok: true, version })
      return true
    }

    sendJson(res, 404, { ok: false, error: 'unknown_admin_action' })
  } catch (err) {
    log('error:', err.message)
    const message = err.message === 'body_too_large' ? '文件超过上传上限' : err.message
    sendJson(res, 500, { ok: false, error: message })
  }
  return true
}

module.exports = { handleAdminApi }
