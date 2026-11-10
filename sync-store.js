'use strict'

/**
 * 三端同步存储（手机版 / 电脑版 / 网页版共用）
 *
 * 设计目标是「轻量增量」而不是备份：
 * - 以条目为最小单位（一个歌单、一个收藏列表、一个设置项），各自带 updatedAt；
 * - 合并规则是 LWW（last write wins）。时间戳相同则比较 deviceId 字符串，
 *   保证两端先后推送同一秒的修改时结果确定（都选字典序大的那台设备），
 *   不会出现「我推一次你推一次，最后来回翻转」。
 * - 删除用 tombstone（deleted=true）而不是从表里删掉，否则另一台设备
 *   下次拉取时看不到这条，会把自己本地的旧数据又推上去。
 *
 * 落盘：data/sync/<code>.json，写入走 tmp + rename，避免进程被杀时留下半个文件。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = process.env.SYNC_DATA_DIR || path.join(__dirname, 'data', 'sync')

/** 同步码：6~12 位大写字母数字，去掉容易看错的 0/O/1/I */
const CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/
/** 单条同步空间最大体积（歌单多、歌多的时候会比较大，但 8MB 足够几千首） */
const MAX_SPACE_BYTES = 8 * 1024 * 1024
const MAX_ITEMS = 400
const MAX_SETTINGS = 400
const MAX_ITEM_KEY = 200
const MAX_DEVICE_ID = 64

/** 每个同步空间的写队列，避免并发 push 互相覆盖 */
const writeQueues = new Map()
/** 内存缓存，减少频繁读盘（拉取时命中率很高） */
const cache = new Map()

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function spacePath(code) {
  return path.join(DATA_DIR, `${code}.json`)
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function normalizeCode(code) {
  const value = String(code || '').trim().toUpperCase()
  return CODE_RE.test(value) ? value : null
}

/** 生成同步码（避开 0/O/1/I） */
function generateCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length]
  return out
}

function generateSecret() {
  return crypto.randomBytes(18).toString('base64url')
}

/**
 * 读取同步空间。返回 null 表示不存在。
 * 损坏的 JSON 当作不存在处理，避免一个坏文件把整条链路卡死。
 */
function readSpace(code) {
  if (cache.has(code)) return cache.get(code)
  let raw
  try {
    raw = fs.readFileSync(spacePath(code), 'utf8')
  } catch {
    return null
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || !data.items) return null
  cache.set(code, data)
  return data
}

function writeSpace(code, data) {
  ensureDir()
  const target = spacePath(code)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, target)
  cache.set(code, data)
}

/** 串行化同一同步空间的写入 */
function enqueue(code, task) {
  const prev = writeQueues.get(code) || Promise.resolve()
  const next = prev.then(task, task)
  writeQueues.set(code, next.catch(() => {}))
  return next
}

function createSpace({ code, secret, deviceId, deviceName }) {
  let finalCode = normalizeCode(code)
  if (finalCode) {
    if (readSpace(finalCode)) {
      const err = new Error('code_exists')
      err.statusCode = 409
      throw err
    }
  } else {
    ensureDir()
    for (let i = 0; i < 20; i++) {
      const candidate = generateCode()
      if (!fs.existsSync(spacePath(candidate))) {
        finalCode = candidate
        break
      }
    }
    if (!finalCode) throw new Error('code_generate_failed')
  }

  const finalSecret = secret && String(secret).length >= 8 ? String(secret) : generateSecret()
  const now = Date.now()
  const space = {
    code: finalCode,
    secretHash: sha256(finalSecret),
    rev: 0,
    createdAt: now,
    updatedAt: now,
    lastDeviceId: String(deviceId || '').slice(0, MAX_DEVICE_ID),
    lastDeviceName: String(deviceName || '').slice(0, 80),
    items: {},
    settings: {},
  }
  writeSpace(finalCode, space)
  return { code: finalCode, secret: finalSecret, rev: 0 }
}

/** 校验 code + secret，返回空间对象（不存在/密码错都返回 null，不给探测空间是否存在的机会） */
function authSpace(code, secret) {
  const normalized = normalizeCode(code)
  if (!normalized) return null
  const space = readSpace(normalized)
  if (!space) return null
  if (!safeEqual(space.secretHash, sha256(String(secret || '')))) return null
  return space
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const key = String(raw.key || '').slice(0, MAX_ITEM_KEY)
  if (!key) return null
  const updatedAt = Number(raw.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
  return {
    key,
    kind: String(raw.kind || 'list').slice(0, 24),
    id: String(raw.id || '').slice(0, 120),
    name: String(raw.name || '').slice(0, 200),
    data: raw.data === undefined ? null : raw.data,
    updatedAt: Math.floor(updatedAt),
    deviceId: String(raw.deviceId || '').slice(0, MAX_DEVICE_ID),
    deleted: raw.deleted === true,
  }
}

function normalizeSetting(entry) {
  if (!entry || typeof entry !== 'object') return null
  const updatedAt = Number(entry.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
  return {
    value: entry.value === undefined ? null : entry.value,
    updatedAt: Math.floor(updatedAt),
    deviceId: String(entry.deviceId || '').slice(0, MAX_DEVICE_ID),
  }
}

/** 版本号相同时用 deviceId 决定胜负，保证合并结果可复现 */
function wins(incoming, current) {
  if (!current) return true
  if (incoming.updatedAt > current.updatedAt) return true
  if (incoming.updatedAt < current.updatedAt) return false
  return String(incoming.deviceId) > String(current.deviceId)
}

/**
 * 推送：只把「比服务端新」的条目写进去，返回服务端当前的全量状态。
 *
 * 返回全量而不是只返回冲突项，客户端才能一次拿到最新的全局视图；
 * 数据量是歌单级别（几百 KB），不值得为了省流量做成复杂的差量协议。
 */
function pushSpace(code, secret, payload) {
  const space = authSpace(code, secret)
  if (!space) {
    const err = new Error('auth_failed')
    err.statusCode = 401
    throw err
  }
  const deviceId = String(payload.deviceId || '').slice(0, MAX_DEVICE_ID)

  return enqueue(space.code, async() => {
    // 排队期间可能已被其它请求改过，重新读一次
    const current = readSpace(space.code) || space
    /**
     * 在副本上合并，校验通过后才写回。
     *
     * readSpace 返回的是内存缓存里的同一个对象引用；如果直接往上写，一旦
     * 后面的体积校验失败抛异常，超大条目已经挂在缓存对象上，这个同步空间
     * 之后每次推送都会报 space_too_large —— 明明没写盘，却永久坏掉，
     * 只能等进程重启把缓存清掉。
     */
    const merged = { ...current, items: { ...current.items }, settings: { ...current.settings } }
    let applied = 0
    let skipped = 0

    const items = Array.isArray(payload.items) ? payload.items.slice(0, MAX_ITEMS) : []
    for (const raw of items) {
      const item = normalizeItem(raw)
      if (!item) {
        skipped++
        continue
      }
      if (wins(item, merged.items[item.key])) {
        merged.items[item.key] = item
        applied++
      } else skipped++
    }

    const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {}
    for (const [key, entry] of Object.entries(settings).slice(0, MAX_SETTINGS)) {
      const normalizedKey = String(key).slice(0, MAX_ITEM_KEY)
      const setting = normalizeSetting(entry)
      if (!setting) {
        skipped++
        continue
      }
      if (wins(setting, merged.settings[normalizedKey])) {
        merged.settings[normalizedKey] = setting
        applied++
      } else skipped++
    }

    const beforeBytes = Buffer.byteLength(JSON.stringify(merged))
    if (beforeBytes > MAX_SPACE_BYTES) {
      const err = new Error('space_too_large')
      err.statusCode = 413
      throw err
    }

    const now = Date.now()
    merged.updatedAt = now
    if (applied > 0) merged.rev = Number(merged.rev || 0) + 1
    merged.lastDeviceId = deviceId
    merged.lastDeviceName = String(payload.deviceName || '').slice(0, 80)
    writeSpace(merged.code, merged)

    return {
      rev: merged.rev,
      updatedAt: merged.updatedAt,
      applied,
      skipped,
      items: merged.items,
      settings: merged.settings,
      serverTime: now,
    }
  })
}

/** 拉取全量（since 仅用于客户端判断是否有变化，服务端总是返回全量） */
function pullSpace(code, secret) {
  const space = authSpace(code, secret)
  if (!space) {
    const err = new Error('auth_failed')
    err.statusCode = 401
    throw err
  }
  return {
    rev: Number(space.rev || 0),
    updatedAt: space.updatedAt,
    items: space.items,
    settings: space.settings,
    serverTime: Date.now(),
  }
}

/** 只读统计，给管理后台和客户端「同步空间信息」用 */
function statSpace(code, secret) {
  const space = authSpace(code, secret)
  if (!space) {
    const err = new Error('auth_failed')
    err.statusCode = 401
    throw err
  }
  const items = Object.values(space.items)
  return {
    code: space.code,
    rev: Number(space.rev || 0),
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    deviceName: space.lastDeviceName || '',
    lists: items.filter(item => item.kind === 'list' && !item.deleted).length,
    favorites: items.filter(item => item.kind === 'favorite' && !item.deleted).length,
    songs: items.reduce((total, item) => {
      if (item.deleted || !Array.isArray(item.data && item.data.list)) return total
      return total + item.data.list.length
    }, 0),
    settings: Object.keys(space.settings || {}).length,
    bytes: Buffer.byteLength(JSON.stringify(space)),
  }
}

module.exports = {
  CODE_RE,
  MAX_SPACE_BYTES,
  normalizeCode,
  createSpace,
  pushSpace,
  pullSpace,
  statSpace,
  generateCode,
  generateSecret,
}
