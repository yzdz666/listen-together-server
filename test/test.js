'use strict'

/**
 * 一起听服务端集成测试
 *
 * 用法：node test/test.js
 * 会自动在随机端口拉起 index.js，跑完全部用例后关闭进程。
 */

const assert = require('assert')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const PORT = 23400 + Math.floor(Math.random() * 200)
const URL = `ws://127.0.0.1:${PORT}`
const SERVER_ENTRY = path.join(__dirname, '..', 'index.js')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const connect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(URL)
  const inbox = []
  const waiters = []

  ws.on('message', data => {
    const msg = JSON.parse(data.toString())
    const index = waiters.findIndex(waiter => waiter.match(msg))
    if (index > -1) {
      const [waiter] = waiters.splice(index, 1)
      waiter.resolve(msg)
    } else {
      inbox.push(msg)
    }
  })

  ws.on('open', () => resolve({
    ws,
    send: msg => ws.send(JSON.stringify(msg)),
    next: (match, timeout = 3000) => {
      const found = inbox.findIndex(match)
      if (found > -1) return Promise.resolve(inbox.splice(found, 1)[0])
      return new Promise((res, rej) => {
        const waiter = { match, resolve: res }
        waiters.push(waiter)
        setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index === -1) return
          waiters.splice(index, 1)
          rej(new Error('timeout waiting for message'))
        }, timeout)
      })
    },
    close: () => ws.close(),
  }))
  ws.on('error', reject)
})

const ofType = type => msg => msg.type === type

const waitForHealthy = async(pid) => {
  for (let i = 0; i < 50; i++) {
    if (pid.exitCode != null) throw new Error(`server exited early with code ${pid.exitCode}`)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (res.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error('server did not become healthy in time')
}

const startServer = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => process.stdout.write(`[server] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`))
  child.on('error', reject)
  waitForHealthy(child).then(() => resolve(child), reject)
})

const music = {
  id: '123',
  source: 'kw',
  name: '测试歌曲',
  singer: '测试歌手',
  album: '专辑',
  interval: '03:30',
  picUrl: null,
  musicInfo: null,
}

const run = async() => {
  const server = await startServer()
  const sockets = []
  try {
    // 1. 创建房间
    const host = await connect()
    sockets.push(host)
    host.send({ type: 'create', clientId: 'host_client_0001', nickname: '房主' })
    const hostRoom = await host.next(ofType('room'))
    assert.strictEqual(hostRoom.room.members.length, 1)
    assert.strictEqual(hostRoom.room.hostId, hostRoom.selfId)
    assert.ok(hostRoom.token, 'create should return a member token')
    const code = hostRoom.room.code
    assert.ok(/^[A-Z0-9]{6}$/.test(code), 'room code should be 6 characters')
    console.log('room created:', code)

    // 2. 成员加入
    const guest = await connect()
    sockets.push(guest)
    guest.send({ type: 'join', clientId: 'guest_client_001', nickname: '小明', code })
    const guestRoom = await guest.next(ofType('room'))
    assert.strictEqual(guestRoom.room.code, code)
    assert.strictEqual(guestRoom.room.members.length, 2)
    assert.strictEqual(guestRoom.room.hostId, hostRoom.selfId)
    const members = await host.next(ofType('members'))
    assert.strictEqual(members.members.length, 2)
    console.log('guest joined, members:', members.members.map(m => m.nickname).join(','))

    // 3. 房间空闲时成员可以成为播放源（网页建房、App 加入后播放的场景）
    guest.send({ type: 'state', state: { isPlaying: true, position: 0, playRate: 1, music: null } })
    const memberSource = await host.next(ofType('state'))
    assert.strictEqual(memberSource.sourceId, guestRoom.selfId)
    console.log('member becomes source when room idle')

    // 3b. 已有播放源时其他成员不能再抢
    guest.send({ type: 'state', state: { isPlaying: true, position: 0, playRate: 1, music: null } })
    // 自己是播放源 → 正常接受，且发送者会收到带自己 sourceId 的回显（App 端据此认领播放源身份）
    const selfEcho = await guest.next(msg => msg.type === 'state' && msg.from === guestRoom.selfId)
    assert.strictEqual(selfEcho.sourceId, guestRoom.selfId)
    console.log('source member re-broadcast ok, self echo received')

    // 4. 房主广播状态被转发（房主夺回播放源）
    // 播放源本人也会收到自己广播的回显（用于确认播放源身份），断言需按 from 过滤
    host.send({ type: 'state', state: { music, isPlaying: true, position: 12.5, playRate: 1 } })
    const relayed = await guest.next(msg => msg.type === 'state' && msg.from === hostRoom.selfId)
    assert.strictEqual(relayed.state.music.name, '测试歌曲')
    assert.strictEqual(relayed.state.position, 12.5)
    assert.strictEqual(relayed.from, hostRoom.selfId)
    assert.strictEqual(relayed.sourceId, hostRoom.selfId)
    console.log('state relayed:', relayed.state.music.name, relayed.state.position)

    // 5. 聊天
    guest.send({ type: 'chat', text: '  你好呀  ' })
    const chat = await host.next(msg => msg.type === 'chat' && msg.message.type === 'user')
    assert.strictEqual(chat.message.text, '你好呀')
    assert.strictEqual(chat.message.senderName, '小明')
    console.log('chat relayed:', chat.message.senderName, chat.message.text)

    // 6. 转交房主
    host.send({ type: 'transferHost', targetId: guestRoom.selfId })
    const transferred = await guest.next(msg => msg.type === 'members' && msg.hostId === guestRoom.selfId)
    assert.strictEqual(transferred.hostId, guestRoom.selfId)
    const sysMsg = await guest.next(msg => msg.type === 'chat' && msg.message.key === 'listen_together_system_host_changed')
    assert.strictEqual(sysMsg.message.params.name, '小明')
    console.log('host transferred:', sysMsg.message.text)

    // 7. 新房主可以广播状态
    guest.send({ type: 'state', state: { music, isPlaying: true, position: 30, playRate: 1 } })
    const relayed2 = await host.next(msg => msg.type === 'state' && msg.state.position === 30)
    assert.ok(relayed2)
    console.log('new host state relayed')

    // 8. 密码房间
    const host2 = await connect()
    sockets.push(host2)
    host2.send({ type: 'create', clientId: 'host_client_0002', nickname: '房主2', password: '1234' })
    const host2Room = await host2.next(ofType('room'))
    const guest2 = await connect()
    sockets.push(guest2)
    guest2.send({ type: 'join', clientId: 'guest_client_002', nickname: '小红', code: host2Room.room.code, password: '0000' })
    const pwdErr = await guest2.next(ofType('error'))
    assert.strictEqual(pwdErr.code, 'wrong_password')
    guest2.send({ type: 'join', clientId: 'guest_client_002', nickname: '小红', code: host2Room.room.code, password: '1234' })
    const okRoom = await guest2.next(ofType('room'))
    assert.strictEqual(okRoom.room.code, host2Room.room.code)
    console.log('password protected room ok')

    // 9. 主动退出
    guest2.send({ type: 'leave' })
    const afterLeave = await host2.next(msg => msg.type === 'members' && msg.members.length === 1)
    assert.strictEqual(afterLeave.members.length, 1)
    console.log('leave ok, members:', afterLeave.members.length)

    // 10. 断线后用 token 恢复身份（房主角色保留）
    const token = guestRoom.token
    guest.close()
    await delay(300)
    const guestBack = await connect()
    sockets.push(guestBack)
    guestBack.send({ type: 'join', clientId: 'guest_client_001', nickname: '小明', code, token })
    const backRoom = await guestBack.next(ofType('room'))
    assert.strictEqual(backRoom.selfId, guestRoom.selfId, 'should keep the same member id')
    assert.strictEqual(backRoom.room.hostId, guestRoom.selfId, 'should keep host role')
    console.log('reconnect with token ok, host kept:', backRoom.room.hostId === backRoom.selfId)

    // 11. 房间码不存在
    const stranger = await connect()
    sockets.push(stranger)
    stranger.send({ type: 'join', clientId: 'stranger_0001', nickname: '路人', code: 'ZZZZZZ' })
    const notFound = await stranger.next(ofType('error'))
    assert.strictEqual(notFound.code, 'room_not_found')
    console.log('unknown room rejected:', notFound.code)

    // 12. 心跳
    stranger.send({ type: 'ping', at: 123 })
    const pong = await stranger.next(ofType('pong'))
    assert.strictEqual(pong.at, 123)
    console.log('pong ok')

    // 13. 房间统一音质随状态下发
    // 注意：此时小明（guestBack）是房主，房主2 是另一个房间的，用原始 host/guest 已转交
    // 用房主2 的房间继续验证
    host2.send({ type: 'state', state: { music, isPlaying: true, position: 40, playRate: 1, quality: '320k' } })
    // guest2 已离开房间，host2 房间内没有其他在线成员，只验证服务端接收不报错
    await delay(100)
    console.log('quality state accepted')

    // 14. 歌词同步：房主推送 → 成员收到 → 后加入成员从 room 带回歌词
    const host3 = await connect()
    sockets.push(host3)
    host3.send({ type: 'create', clientId: 'host_client_0003', nickname: '歌住房主' })
    const host3Room = await host3.next(ofType('room'))
    const guest3 = await connect()
    sockets.push(guest3)
    guest3.send({ type: 'join', clientId: 'guest_client_003', nickname: '听歌人', code: host3Room.room.code })
    await guest3.next(ofType('room'))
    await host3.next(ofType('members'))

    guest3.send({ type: 'lyric', lyric: { musicId: '123', source: 'kw', name: '测试歌曲', singer: '测试歌手', lrc: '[00:01.00]测试' } })
    const lyricErr = await guest3.next(msg => msg.type === 'error' && msg.code === 'not_host')
    assert.strictEqual(lyricErr.code, 'not_host')
    console.log('non-host lyric rejected')

    host3.send({ type: 'lyric', lyric: { musicId: '123', source: 'kw', name: '测试歌曲', singer: '测试歌手', lrc: '[00:01.00]测试\n[00:02.00]歌词', tlrc: '' } })
    const lyric = await guest3.next(ofType('lyric'))
    assert.strictEqual(lyric.lyric.musicId, '123')
    assert.ok(lyric.lyric.lrc.includes('[00:02.00]歌词'))
    console.log('lyric relayed')

    const guest3b = await connect()
    sockets.push(guest3b)
    guest3b.send({ type: 'join', clientId: 'guest_client_004', nickname: '后来者', code: host3Room.room.code })
    const lateRoom = await guest3b.next(ofType('room'))
    assert.ok(lateRoom.room.lyric, 'late joiner should receive lyric in room payload')
    assert.strictEqual(lateRoom.room.lyric.musicId, '123')
    console.log('late joiner got lyric')

    // 15. 成员控制：seek 转给房主
    guest3b.send({ type: 'control', action: 'seek', position: 88.5 })
    const control = await host3.next(ofType('control'))
    assert.strictEqual(control.action, 'seek')
    assert.strictEqual(control.position, 88.5)
    assert.strictEqual(control.name, '后来者')
    guest3b.send({ type: 'control', action: 'pause' })
    const control2 = await host3.next(ofType('control'))
    assert.strictEqual(control2.action, 'pause')
    console.log('member control relayed to host')

    // 16. 非法控制指令
    guest3b.send({ type: 'control', action: 'destroy' })
    const ctlErr = await guest3b.next(ofType('error'))
    assert.strictEqual(ctlErr.code, 'bad_request')
    console.log('invalid control rejected')

    // 17. 成员播放源：网页建房场景 —— 房主不播放，成员播放歌曲，其他人跟随
    const host_4 = await connect()
    const member_4 = await connect()
    const watcher_4 = await connect()
    sockets.push(host_4, member_4, watcher_4)
    host_4.send({ type: 'create', nickname: '网页房主', clientId: 'host_4', roomName: '源测试' })
    const room4 = await host_4.next(ofType('room'))
    const code4 = room4.room.code
    member_4.send({ type: 'join', code: code4, nickname: 'App成员', clientId: 'member_4' })
    await member_4.next(ofType('room'))
    watcher_4.send({ type: 'join', code: code4, nickname: '旁听', clientId: 'watcher_4' })
    await watcher_4.next(ofType('room'))

    member_4.send({
      type: 'state',
      state: { music: { id: 'm1', source: 'kw', name: '成员的歌', singer: '歌手', interval: '03:00', album: '', picUrl: null, musicInfo: null, url: 'https://example.com/song.mp3' }, isPlaying: true, position: 5, playRate: 1, quality: '320k', sentAt: Date.now() },
    })
    const ms1 = await watcher_4.next(ofType('state'))
    assert.strictEqual(ms1.state.music.name, '成员的歌')
    assert.strictEqual(ms1.sourceId, 'member_4')
    const hostState = await host_4.next(ofType('state'))
    assert.strictEqual(hostState.state.music.name, '成员的歌')
    console.log('member becomes playback source, everyone follows')

    // 房主没播放时也可以推歌词（播放源成员）
    member_4.send({ type: 'lyric', lyric: { musicId: 'm1', source: 'kw', name: '成员的歌', singer: '歌手', lrc: '[00:01.00]成员歌词' } })
    const hostLyric = await host_4.next(ofType('lyric'))
    assert.strictEqual(hostLyric.lyric.lrc, '[00:01.00]成员歌词')
    console.log('source member lyric accepted')

    // 其他成员不能抢播放源
    watcher_4.send({ type: 'state', state: { music: { id: 'm2', source: 'kw', name: '抢歌', singer: 'x', interval: '03:00', album: '', picUrl: null, musicInfo: null }, isPlaying: true, position: 0, playRate: 1, sentAt: Date.now() } })
    let stolenRejected = false
    try {
      await host_4.next(msg => msg.type === 'state' && msg.state?.music?.name === '抢歌', 400)
    } catch {
      stolenRejected = true
    }
    assert.ok(stolenRejected, '播放源不能被其他成员抢占')
    console.log('source cannot be stolen')

    // 房主播放后夺回播放源（member_4 会先收到自己之前广播的回显，按歌名过滤）
    host_4.send({ type: 'state', state: { music: { id: 'm3', source: 'kw', name: '房主的歌', singer: 'x', interval: '03:00', album: '', picUrl: null, musicInfo: null }, isPlaying: true, position: 0, playRate: 1, quality: '320k', sentAt: Date.now() } })
    const hs1 = await member_4.next(msg => msg.type === 'state' && msg.state?.music?.name === '房主的歌')
    assert.strictEqual(hs1.state.music.name, '房主的歌')
    assert.strictEqual(hs1.sourceId, 'host_4')
    console.log('host takes source back')

    // 成员控制此时应转给房主（播放源）
    member_4.send({ type: 'control', action: 'pause' })
    const hostCtl = await host_4.next(ofType('control'))
    assert.strictEqual(hostCtl.action, 'pause')
    console.log('control routed to source (host)')

    // 播放源（房主）退出 → 状态清空，其他人收到空 state
    host_4.send({ type: 'leave' })
    const cleared = await watcher_4.next(msg => msg.type === 'state' && msg.state === null)
    assert.ok(true)
    console.log('source leave clears room state')

    console.log('\nALL TESTS PASSED')
  } finally {
    sockets.forEach(socket => socket.close())
    await delay(100)
    server.kill('SIGTERM')
  }
}

run().then(() => process.exit(0), err => {
  console.error('TEST FAILED:', err)
  process.exit(1)
})
