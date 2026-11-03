'use strict'

/**
 * LX Music 一起听中继服务端
 *
 * 只负责房间管理与消息转发，不存储任何音频数据。
 * 所有播放状态由房主客户端产生，服务端转发给房间内的其他成员。
 */

const http = require('http')
const https = require('https')
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const { handleAdminApi } = require('./admin')

const PORT = parseInt(process.env.PORT || '23333', 10)
const HOST = process.env.HOST || '0.0.0.0'
const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS || '16', 10)
const MAX_CHAT_LENGTH = 500
const MAX_ROOM_MESSAGES = 50
/** 歌词文本上限，普通 LRC 一般 5~30KB */
const MAX_LYRIC_LENGTH = 64 * 1024
const MAX_TRANSLATION_LENGTH = 32 * 1024
/** 允许的房间统一音质 */
// 音质白名单与 App 端 QUALITY_ORDER 对齐（1.22.17：补 hires / atmos / atmos_plus / master，
// 之前母带、全景声会被这里清洗成 null，网页版永远看不到音质徽标）
const QUALITIES = ['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'ape', 'wav']

/** 成员掉线后保留身份的时长，方便客户端自动重连恢复 */
const MEMBER_OFFLINE_TTL = 90 * 1000
/** 房间内没有任何在线成员后保留房间的时长 */
const EMPTY_ROOM_TTL = 2 * 60 * 1000
/** 房主掉线后等待重连的时间，超过后再转交房主 */
const HOST_TRANSFER_DELAY = 20 * 1000
/** 单条消息最大长度 */
const MAX_MESSAGE_SIZE = 256 * 1024
/** 单个连接的消息频率限制 */
const RATE_LIMIT_WINDOW = 10 * 1000
const RATE_LIMIT_COUNT = 120

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
// 与 App 端六平台对齐（bd 百度之前缺失，房主播百度源整条状态会被拒掉）
const SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'bd', 'local']
const WS_OPEN = 1

/** @type {Map<string, Room>} */
const rooms = new Map()

/**
 * @typedef {Object} Member
 * @property {string} id
 * @property {string} nickname
 * @property {string} token
 * @property {boolean} online
 * @property {number} joinedAt
 * @property {import('ws').WebSocket | null} ws
 * @property {ReturnType<typeof setTimeout> | null} offlineTimer
 */

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {string} name
 * @property {string} passwordHash
 * @property {string} hostId
 * @property {Map<string, Member>} members
 * @property {object | null} state
 * @property {Array<object>} messages
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {ReturnType<typeof setTimeout> | null} emptyTimer
 * @property {ReturnType<typeof setTimeout> | null} hostTransferTimer
 */

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const randomToken = () => crypto.randomBytes(16).toString('hex')
const now = () => Date.now()

const log = (...args) => {
  console.log(new Date().toISOString(), ...args)
}

function createRoomCode() {
  for (let i = 0; i < 50; i++) {
    let code = ''
    for (let j = 0; j < 6; j++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]
    if (!rooms.has(code)) return code
  }
  throw new Error('no room code available')
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLength)
}

function sanitizeClientId(value) {
  if (typeof value !== 'string') return ''
  return /^[a-zA-Z0-9_-]{6,64}$/.test(value) ? value : ''
}

function getRoomByCode(code) {
  return rooms.get(String(code || '').trim().toUpperCase())
}

function serializeMembers(room) {
  return [...room.members.values()]
    .sort((a, b) => {
      if (a.id === room.hostId) return -1
      if (b.id === room.hostId) return 1
      return a.joinedAt - b.joinedAt
    })
    .map(member => ({
      id: member.id,
      nickname: member.nickname,
      isHost: member.id === room.hostId,
      online: member.online,
      joinedAt: member.joinedAt,
    }))
}

function serializeRoom(room) {
  return {
    id: room.code,
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    members: serializeMembers(room),
    state: room.state,
    stateSourceId: room.stateSourceId || null,
    lyric: room.lyric || null,
    createdAt: room.createdAt,
  }
}

function send(client, message) {
  const ws = client.ws
  if (!ws || ws.readyState !== WS_OPEN) return
  try {
    ws.send(JSON.stringify(message))
  } catch (err) {
    log('send message failed:', err.message)
  }
}

function sendError(client, code, message = code) {
  send(client, { type: 'error', code, message })
}

function broadcast(room, message, exceptId) {
  const payload = JSON.stringify(message)
  for (const member of room.members.values()) {
    if (!member.online || !member.ws || member.id === exceptId) continue
    if (member.ws.readyState !== WS_OPEN) continue
    try {
      member.ws.send(payload)
    } catch (err) {
      log('broadcast failed:', err.message)
    }
  }
}

function addSystemMessage(room, key, params, fallbackText) {
  const message = {
    id: `sys_${now()}_${crypto.randomBytes(3).toString('hex')}`,
    type: 'system',
    senderId: '',
    senderName: '',
    text: fallbackText,
    key,
    params,
    at: now(),
  }
  room.messages.push(message)
  if (room.messages.length > MAX_ROOM_MESSAGES) room.messages.splice(0, room.messages.length - MAX_ROOM_MESSAGES)
  broadcast(room, { type: 'chat', message })
}

function broadcastMembers(room) {
  broadcast(room, {
    type: 'members',
    members: serializeMembers(room),
    hostId: room.hostId,
  })
}

function pickNextHost(room) {
  let next = null
  for (const member of room.members.values()) {
    if (!member.online) continue
    if (!next || member.joinedAt < next.joinedAt) next = member
  }
  return next
}

function transferHost(room, member) {
  if (!member) return
  const prevHostId = room.hostId
  room.hostId = member.id
  room.updatedAt = now()
  // 播放源原来是旧房主时，跟着移到新房主，避免残留指向已离任的人
  if (room.stateSourceId === prevHostId) room.stateSourceId = member.id
  broadcastMembers(room)
  addSystemMessage(room, 'listen_together_system_host_changed', { name: member.nickname }, `${member.nickname} 成为了新房主`)
}

function clearEmptyTimer(room) {
  if (!room.emptyTimer) return
  clearTimeout(room.emptyTimer)
  room.emptyTimer = null
}

function clearHostTransferTimer(room) {
  if (!room.hostTransferTimer) return
  clearTimeout(room.hostTransferTimer)
  room.hostTransferTimer = null
}

/**
 * 房主掉线后先等待一段时间，期间保留房主身份，方便客户端自动重连
 */
function scheduleHostTransfer(room, offlineHost) {
  clearHostTransferTimer(room)
  room.hostTransferTimer = setTimeout(() => {
    room.hostTransferTimer = null
    if (room.hostId !== offlineHost.id) return
    const member = room.members.get(offlineHost.id)
    if (member?.online) return
    const nextHost = pickNextHost(room)
    if (nextHost) transferHost(room, nextHost, `${nextHost.nickname} 成为了新房主`)
  }, HOST_TRANSFER_DELAY)
}

function scheduleRoomCleanup(room) {
  clearEmptyTimer(room)
  const hasOnline = [...room.members.values()].some(member => member.online)
  if (hasOnline) return
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null
    const stillEmpty = ![...room.members.values()].some(member => member.online)
    if (stillEmpty) {
      rooms.delete(room.code)
      log(`room ${room.code} closed (empty)`)
    }
  }, EMPTY_ROOM_TTL)
}

function removeMember(room, memberId, notify = false) {
  const member = room.members.get(memberId)
  if (!member) return
  if (member.offlineTimer) {
    clearTimeout(member.offlineTimer)
    member.offlineTimer = null
  }
  if (room.hostId === memberId) clearHostTransferTimer(room)
  room.members.delete(memberId)
  room.updatedAt = now()
  clearSourceState(room, memberId)

  if (room.hostId === memberId) {
    const nextHost = pickNextHost(room)
    if (nextHost) transferHost(room, nextHost)
  }
  broadcastMembers(room)
  if (notify) {
    addSystemMessage(room, 'listen_together_system_leave', { name: member.nickname }, `${member.nickname} 离开了房间`)
  }
  scheduleRoomCleanup(room)
}

function markMemberOffline(room, member) {
  member.online = false
  member.ws = null
  room.updatedAt = now()
  if (member.offlineTimer) clearTimeout(member.offlineTimer)
  member.offlineTimer = setTimeout(() => {
    member.offlineTimer = null
    const current = room.members.get(member.id)
    if (!current || current.online) return
    removeMember(room, member.id, true)
  }, MEMBER_OFFLINE_TTL)

  if (room.hostId === member.id) scheduleHostTransfer(room, member)
  clearSourceState(room, member.id)
  broadcastMembers(room)
  scheduleRoomCleanup(room)
}

/**
 * 播放源成员离开时清空房间播放状态，其他端回到「等待播放」；
 * 房主重新开始播放后自然接管
 */
function clearSourceState(room, memberId) {
  if (room.stateSourceId !== memberId) return
  room.stateSourceId = null
  room.state = null
  room.updatedAt = now()
  broadcast(room, { type: 'state', state: null, from: '', sourceId: '' })
}

function normalizeState(input) {
  if (!input || typeof input !== 'object') return null

  let music = null
  if (input.music != null) {
    if (typeof input.music !== 'object') return null
    const source = String(input.music.source || '')
    if (!SOURCES.includes(source)) return null
    const id = sanitizeText(input.music.id, 200)
    const name = sanitizeText(input.music.name, 200)
    if (!id || !name) return null
    music = {
      id,
      source,
      name,
      singer: sanitizeText(input.music.singer, 200),
      album: sanitizeText(input.music.album, 200),
      interval: typeof input.music.interval === 'string' ? sanitizeText(input.music.interval, 20) : null,
      picUrl: typeof input.music.picUrl === 'string' ? sanitizeText(input.music.picUrl, 2048) : null,
      musicInfo: source === 'local' ? null : (input.music.musicInfo && typeof input.music.musicInfo === 'object' ? input.music.musicInfo : null),
      // 房主当前歌曲的音频直链，网页版用它直接播放；只允许 http(s)，避免 javascript: 之类的注入
      url: typeof input.music.url === 'string' && /^https?:\/\//i.test(input.music.url)
        ? sanitizeText(input.music.url, 4096)
        : null,
    }
  }

  const position = Number(input.position)
  const playRate = Number(input.playRate)
  const quality = typeof input.quality === 'string' && QUALITIES.includes(input.quality) ? input.quality : null

  return {
    music,
    isPlaying: Boolean(input.isPlaying),
    position: Number.isFinite(position) ? Math.max(0, Math.min(position, 24 * 60 * 60)) : 0,
    playRate: Number.isFinite(playRate) ? Math.max(0.25, Math.min(playRate, 4)) : 1,
    quality,
    sentAt: now(),
  }
}

/**
 * 校验房主推送的歌词
 */
function normalizeLyric(input) {
  if (!input || typeof input !== 'object') return null
  const source = String(input.source || '')
  if (!SOURCES.includes(source)) return null
  const musicId = sanitizeText(input.musicId, 200)
  if (!musicId) return null
  const lrc = typeof input.lrc === 'string' ? input.lrc.slice(0, MAX_LYRIC_LENGTH) : ''
  return {
    musicId,
    source,
    name: sanitizeText(input.name, 200),
    singer: sanitizeText(input.singer, 200),
    lrc,
    tlrc: typeof input.tlrc === 'string' ? input.tlrc.slice(0, MAX_TRANSLATION_LENGTH) : '',
    rlrc: typeof input.rlrc === 'string' ? input.rlrc.slice(0, MAX_TRANSLATION_LENGTH) : '',
    at: now(),
  }
}

function handleCreate(client, message) {
  if (client.room) return sendError(client, 'already_in_room')

  const nickname = sanitizeText(message.nickname, 20)
  if (!nickname) return sendError(client, 'bad_request')

  const clientId = sanitizeClientId(message.clientId) || `lt_${crypto.randomBytes(8).toString('hex')}`
  const password = typeof message.password === 'string' ? message.password.trim().slice(0, 32) : ''
  const roomName = sanitizeText(message.roomName, 30) || `${nickname} 的房间`

  const room = {
    code: createRoomCode(),
    name: roomName,
    passwordHash: password ? sha256(password) : '',
    hostId: clientId,
    members: new Map(),
    state: null,
    /** 当前播放状态的来源成员：null 表示房主是播放源，否则为该成员 id */
    stateSourceId: null,
    lyric: null,
    messages: [],
    createdAt: now(),
    updatedAt: now(),
    emptyTimer: null,
    hostTransferTimer: null,
  }

  const member = {
    id: clientId,
    nickname,
    token: randomToken(),
    online: true,
    joinedAt: now(),
    ws: client.ws,
    offlineTimer: null,
  }
  room.members.set(clientId, member)
  rooms.set(room.code, room)

  client.room = room
  client.memberId = clientId

  send(client, {
    type: 'room',
    room: serializeRoom(room),
    selfId: clientId,
    token: member.token,
  })
  log(`room ${room.code} created by ${nickname} (${clientId})`)
}

function handleJoin(client, message) {
  const room = getRoomByCode(message.code)
  if (!room) return sendError(client, 'room_not_found')

  if (client.room && client.room !== room) detachClient(client, true)

  const password = typeof message.password === 'string' ? message.password : ''
  if (room.passwordHash && sha256(password) !== room.passwordHash) {
    return sendError(client, 'wrong_password')
  }

  const nickname = sanitizeText(message.nickname, 20) || 'Guest'
  let clientId = sanitizeClientId(message.clientId) || `lt_${crypto.randomBytes(8).toString('hex')}`
  const token = typeof message.token === 'string' ? message.token : ''

  let member = room.members.get(clientId)
  if (member && (!token || member.token !== token)) {
    // 客户端 id 冲突但不持有凭证，分配一个新的 id
    clientId = `lt_${crypto.randomBytes(8).toString('hex')}`
    member = undefined
  }

  const isNewMember = !member
  if (isNewMember) {
    if (room.members.size >= MAX_MEMBERS) return sendError(client, 'room_full')
    member = {
      id: clientId,
      nickname,
      token: randomToken(),
      online: true,
      joinedAt: now(),
      ws: client.ws,
      offlineTimer: null,
    }
    room.members.set(clientId, member)
  } else {
    if (member.offlineTimer) {
      clearTimeout(member.offlineTimer)
      member.offlineTimer = null
    }
    member.online = true
    member.ws = client.ws
    if (nickname) member.nickname = nickname
  }

  room.updatedAt = now()
  client.room = room
  client.memberId = clientId
  clearEmptyTimer(room)

  if (!room.members.has(room.hostId)) room.hostId = clientId
  if (room.hostId === clientId) clearHostTransferTimer(room)

  send(client, {
    type: 'room',
    room: serializeRoom(room),
    selfId: clientId,
    token: member.token,
  })

  for (const historyMessage of room.messages.slice(-20)) {
    send(client, { type: 'chat', message: historyMessage })
  }

  broadcastMembers(room)
  if (isNewMember) {
    if (member.id === room.hostId) {
      addSystemMessage(room, 'listen_together_system_created', { name: member.nickname }, `${member.nickname} 创建了房间`)
    } else {
      addSystemMessage(room, 'listen_together_system_join', { name: member.nickname }, `${member.nickname} 加入了房间`)
    }
  } else {
    addSystemMessage(room, 'listen_together_system_back', { name: member.nickname }, `${member.nickname} 回到了房间`)
  }

  log(`room ${room.code} joined by ${member.nickname} (${clientId}), members=${room.members.size}`)
}

function handleState(client, message) {
  const room = client.room
  if (!room) return
  const isHost = room.hostId === client.memberId
  /**
   * 播放源规则：
   * - 房主随时可以广播（房主权威）
   * - 成员只有在「房间还没有播放状态」或「自己已经是播放源」时才能成为播放源，
   *   典型场景：网页端建房，App 加入后播放歌曲，网页端跟 App 互通歌曲/歌词/音频
   */
  if (!isHost && room.state && room.stateSourceId !== client.memberId) return

  const state = normalizeState(message.state)
  if (!state) return sendError(client, 'bad_request')

  room.state = state
  room.stateSourceId = client.memberId
  room.updatedAt = now()

  // 不排除发送者：播放源本人也需要这条消息里的 sourceId 来确认自己的播放源身份
  // （客户端对来自自己的 state 只更新播放源标记，不会重复应用播放状态）
  broadcast(room, { type: 'state', state, from: client.memberId, sourceId: room.stateSourceId })
}

function handleChat(client, message) {
  const room = client.room
  if (!room) return
  const member = room.members.get(client.memberId)
  if (!member) return

  const text = sanitizeText(message.text, MAX_CHAT_LENGTH)
  if (!text) return

  const chatMessage = {
    id: `msg_${now()}_${crypto.randomBytes(3).toString('hex')}`,
    type: 'user',
    senderId: member.id,
    senderName: member.nickname,
    text,
    at: now(),
  }
  room.messages.push(chatMessage)
  if (room.messages.length > MAX_ROOM_MESSAGES) room.messages.splice(0, room.messages.length - MAX_ROOM_MESSAGES)
  broadcast(room, { type: 'chat', message: chatMessage })
}

/**
 * 房主推送当前歌词，服务端保存一份，后加入的成员也能拿到
 */
function handleLyric(client, message) {
  const room = client.room
  if (!room) return
  // 房主或当前播放源成员都可以推歌词
  if (room.hostId !== client.memberId && room.stateSourceId !== client.memberId) return sendError(client, 'not_host')

  const lyric = normalizeLyric(message.lyric)
  if (!lyric) return sendError(client, 'bad_request')

  room.lyric = lyric
  // 同 state：不排除发送者，播放源本人据此确认身份（客户端对来自自己的歌词会忽略应用）
  broadcast(room, { type: 'lyric', lyric, from: client.memberId })
}

/**
 * 成员发起播放控制（播放 / 暂停 / 拖动进度），转给房主执行
 */
function handleControl(client, message) {
  const room = client.room
  if (!room) return
  const member = room.members.get(client.memberId)
  if (!member) return
  // 房主自己不需要转发
  if (room.hostId === member.id) return

  const action = String(message.action || '')
  if (!['play', 'pause', 'seek'].includes(action)) return sendError(client, 'bad_request')

  let position
  if (action === 'seek') {
    position = Number(message.position)
    if (!Number.isFinite(position) || position < 0 || position > 24 * 60 * 60) return sendError(client, 'bad_request')
    position = Math.round(position * 10) / 10
  }

  // 控制指令交给当前播放源执行（通常是房主；播放源是成员时交给该成员）
  const sourceId = room.stateSourceId || room.hostId
  if (sourceId === member.id) return
  const target = room.members.get(sourceId)
  if (!target || !target.online || !target.ws) return
  send({ ws: target.ws }, {
    type: 'control',
    action,
    position,
    from: member.id,
    name: member.nickname,
  })
}

function handleTransferHost(client, message) {
  const room = client.room
  if (!room) return
  if (room.hostId !== client.memberId) return sendError(client, 'not_host')

  const target = room.members.get(String(message.targetId || ''))
  if (!target || !target.online) return sendError(client, 'bad_request')

  transferHost(room, target)
  log(`room ${room.code} host transferred to ${target.id}`)
}

function detachClient(client, removeImmediately = false) {
  const room = client.room
  if (!room) return
  client.room = null
  const member = room.members.get(client.memberId)
  if (!member) return
  member.ws = null
  if (removeImmediately) {
    removeMember(room, member.id, true)
    log(`room ${room.code} member left: ${member.nickname} (${member.id})`)
  } else {
    markMemberOffline(room, member)
    log(`room ${room.code} member offline: ${member.nickname} (${member.id})`)
  }
}

function handleMessage(client, raw) {
  if (raw.length > MAX_MESSAGE_SIZE) return sendError(client, 'bad_request')

  let message
  try {
    message = JSON.parse(raw)
  } catch (err) {
    return sendError(client, 'bad_request')
  }
  if (!message || typeof message.type !== 'string') return sendError(client, 'bad_request')

  // 简单频率限制
  const timestamp = now()
  client.messageTimes = client.messageTimes.filter(time => timestamp - time < RATE_LIMIT_WINDOW)
  if (client.messageTimes.length >= RATE_LIMIT_COUNT) return sendError(client, 'rate_limited')
  client.messageTimes.push(timestamp)

  switch (message.type) {
    case 'ping':
      send(client, { type: 'pong', at: Number(message.at) || 0, serverTime: now() })
      break
    case 'create':
      handleCreate(client, message)
      break
    case 'join':
      handleJoin(client, message)
      break
    case 'leave':
      detachClient(client, true)
      break
    case 'state':
      handleState(client, message)
      break
    case 'chat':
      handleChat(client, message)
      break
    case 'lyric':
      handleLyric(client, message)
      break
    case 'control':
      handleControl(client, message)
      break
    case 'transferHost':
      handleTransferHost(client, message)
      break
    default:
      sendError(client, 'bad_request')
  }
}

const WEB_DIR = path.join(__dirname, 'web')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function roomSummary(room) {
  let online = 0
  for (const member of room.members.values()) if (member.online) online++
  const host = room.members.get(room.hostId)
  return {
    code: room.code,
    name: room.name,
    hostName: host ? host.nickname : '',
    members: room.members.size,
    online,
    hasPassword: Boolean(room.passwordHash),
    createdAt: room.createdAt,
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const target = path.join(WEB_DIR, rel)
  // 防目录穿越
  if (!target.startsWith(WEB_DIR)) return false
  let stat
  try {
    stat = fs.statSync(target)
  } catch (err) {
    return false
  }
  if (!stat.isFile()) return false

  const ext = path.extname(target).toLowerCase()
  // html 与 json（version.json 等）不允许缓存：发布后页面必须立刻看到新版本与时间；apk/zip 等静态资产可缓存 1 小时
  const cacheable = ext === '.apk' || ext === '.zip' || ext === '.png' || ext === '.jpg' || ext === '.ico' || ext === '.mp3'
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    // 支持 Range：浏览器播放 / 拖动音频进度需要
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-store',
  }

  const range = req.headers.range
  if (range) {
    const matched = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!matched) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return true
    }
    let start
    let end
    if (matched[1] === '') {
      // bytes=-500 表示最后 500 字节
      const suffix = Number(matched[2] || 0)
      start = Math.max(0, stat.size - suffix)
      end = stat.size - 1
    } else {
      start = Number(matched[1])
      end = matched[2] ? Math.min(Number(matched[2]), stat.size - 1) : stat.size - 1
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return true
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    })
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    fs.createReadStream(target, { start, end }).pipe(res)
    return true
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  fs.createReadStream(target).pipe(res)
  return true
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
    return
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    res.end()
    return
  }

  // 下载站管理后台（/admin 页面重定向 + /api/admin/* 接口，内部自带鉴权）
  if (pathname === '/admin' || pathname.startsWith('/api/admin/')) {
    void handleAdminApi(req, res, pathname)
    return
  }

  if (pathname === '/health' || pathname === '/status' || pathname === '/api/health') {
    const roomList = [...rooms.values()]
    sendJson(res, 200, {
      ok: true,
      uptime: Math.floor(process.uptime()),
      rooms: roomList.length,
      members: roomList.reduce((total, room) => total + room.members.size, 0),
    })
    return
  }

  // 网页版对接用的接口
  if (pathname === '/api/info') {
    sendJson(res, 200, {
      ok: true,
      name: 'lx-listen-together',
      version: 2,
      maxMembers: MAX_MEMBERS,
      maxChatLength: MAX_CHAT_LENGTH,
      web: '/',
      websocket: '与 HTTP 同端口，直接使用 ws:// 或 wss://',
    })
    return
  }

  if (pathname === '/api/rooms') {
    sendJson(res, 200, {
      ok: true,
      rooms: [...rooms.values()].map(roomSummary),
    })
    return
  }

  const roomMatch = /^\/api\/room\/([A-Za-z0-9]{6})$/.exec(pathname)
  if (roomMatch) {
    const room = getRoomByCode(roomMatch[1])
    if (!room) return sendJson(res, 404, { ok: false, error: 'room_not_found' })
    sendJson(res, 200, { ok: true, room: serializeRoom(room) })
    return
  }

  if (pathname === '/' || pathname === '/web' || pathname.startsWith('/web/')) {
    const rel = pathname === '/' || pathname === '/web' ? '/index.html' : pathname.slice(4)
    if (serveStatic(req, res, rel)) return
  }

  // 音频代理：https 页面不能直接播 http 音频（浏览器混合内容拦截），同源转发解决；
  // 支持 Range 透传，网页版拖动进度 / 断点续播不受影响
  if (pathname === '/audioproxy') {
    handleAudioProxy(req, res, url)
    return
  }

  if (serveStatic(req, res, pathname)) return

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end([
    'LX Music Listen Together Server',
    '',
    '网页版: GET /',
    '健康检查: GET /health',
    '房间列表: GET /api/rooms',
    '房间信息: GET /api/room/<code>',
    '接口信息: GET /api/info',
    `WebSocket: ws://<your-ip>:${PORT}`,
  ].join('\n'))
})

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_SIZE })

/**
 * 音频代理：/audioproxy?url=<encoded>
 * 把音源返回的 http(s) 音频从本服务同源转发给网页版，
 * 避免 https 页面播 http 音频被浏览器拦截。Range 请求原样透传。
 */
function handleAudioProxy(req, res, requestUrl) {
  const raw = String(requestUrl.searchParams.get('url') || '').trim()
  let first
  try { first = new URL(raw) } catch { first = null }
  if (!first || !/^https?:$/.test(first.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('bad url')
    return
  }
  const headers = {}
  // Range / Referer 透传：部分音源校验 Range 起点，音乐直链也可能要求带 Referer
  if (req.headers.range) headers.Range = req.headers.range
  headers['User-Agent'] = req.headers['user-agent'] || 'lx-music-mobile/1.22.17'
  // 音源直链普遍 301/302 跳 CDN，最多跟 3 跳
  const fetchOnce = (target, redirects) => {
    const client = target.protocol === 'https:' ? https : http
    const upstream = client.get(target, { headers }, (up) => {
      if ([301, 302, 303, 307, 308].includes(up.statusCode || 0) && up.headers.location && redirects < 3) {
        up.resume()
        try {
          const next = new URL(up.headers.location, target)
          if (!/^https?:$/.test(next.protocol)) throw new Error('bad redirect')
          return fetchOnce(next, redirects + 1)
        } catch {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('bad redirect')
        }
      }
      const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']
      const out = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
      for (const k of pass) if (up.headers[k] != null) out[k] = up.headers[k]
      res.writeHead(up.statusCode || 502, out)
      up.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('upstream error')
    })
  }
  fetchOnce(first, 0)
}

wss.on('connection', (ws) => {
  const client = {
    ws,
    room: null,
    memberId: '',
    messageTimes: [],
    alive: true,
  }

  ws.__ltClient = client
  ws.on('pong', () => { client.alive = true })
  ws.on('message', (data) => {
    handleMessage(client, typeof data === 'string' ? data : data.toString())
  })
  ws.on('close', () => {
    detachClient(client)
  })
  ws.on('error', (err) => {
    log('websocket error:', err.message)
  })
})

// 服务端心跳，清理僵死连接
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    const client = ws.__ltClient
    if (!client || !client.alive) {
      ws.terminate()
      return
    }
    client.alive = false
    try {
      ws.ping()
    } catch (err) {
      log('ping failed:', err.message)
    }
  })
}, 30 * 1000)

server.listen(PORT, HOST, () => {
  log(`Listen Together server listening on ${HOST}:${PORT}`)
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) log(`  LAN: ws://${net.address}:${PORT}`)
    }
  }
})

const shutdown = () => {
  log('shutting down...')
  clearInterval(heartbeat)
  for (const room of rooms.values()) {
    if (room.emptyTimer) clearTimeout(room.emptyTimer)
    if (room.hostTransferTimer) clearTimeout(room.hostTransferTimer)
    for (const member of room.members.values()) {
      if (member.offlineTimer) clearTimeout(member.offlineTimer)
    }
  }
  wss.close(() => {
    server.close(() => process.exit(0))
  })
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
