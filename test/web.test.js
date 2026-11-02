/* 网页版一起听端到端测试：无头 Chrome 打开页面，模拟房主端推送状态 */
const puppeteer = require('/tmp/node_modules/puppeteer-core')
const WebSocket = require('/workspace/lx-music-mobile/listen-together-server/node_modules/ws')

const BASE = process.env.BASE || 'http://127.0.0.1:23333'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  console.log('ok -', msg)
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(BASE, { waitUntil: 'networkidle2' })
  assert(await page.$('#entry') !== null, '页面加载出入口表单')

  // 房主端（node）先建房
  const host = new WebSocket(BASE.replace('http', 'ws'))
  const hostMsgs = []
  await new Promise((res, rej) => {
    host.on('open', res)
    host.on('error', rej)
  })
  host.on('message', d => hostMsgs.push(JSON.parse(d.toString())))
  host.send(JSON.stringify({ type: 'create', clientId: 'web_test_host', nickname: '房主端' }))
  await sleep(400)
  const roomMsg = hostMsgs.find(m => m.type === 'room')
  assert(!!roomMsg, '房主端创建房间成功')
  const code = roomMsg.room.code
  console.log('   房间码', code)

  // 网页端加入
  await page.type('#nickname', '网页观众')
  await page.type('#code', code)
  await page.click('#btnJoin')
  await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('roomCode').textContent), { timeout: 8000 })
  assert(true, '网页端加入房间并显示房间码')

  const memberText = await page.$eval('#members', el => el.textContent)
  assert(memberText.includes('房主端') && memberText.includes('网页观众'), '成员列表含双方')

  // 房主推送播放状态
  host.send(JSON.stringify({
    type: 'state',
    state: {
      music: { id: 'm1', name: '测试歌曲', singer: '测试歌手', source: 'kw', picUrl: null, interval: '03:30' },
      isPlaying: true,
      position: 30,
      playRate: 1,
      sentAt: Date.now(),
    },
  }))
  await sleep(600)
  const npTitle = await page.$eval('#npTitle', el => el.textContent)
  assert(npTitle === '测试歌曲', '网页端同步到歌名：' + npTitle)
  const npSub = await page.$eval('#npSub', el => el.textContent)
  assert(npSub.includes('测试歌手'), '网页端同步到歌手')
  const now = await page.$eval('#now', el => el.textContent)
  assert(/^00:(3[0-9]|[45][0-9])$/.test(now), '进度在走：' + now)

  // 房主推送歌词，网页端应显示当前句
  host.send(JSON.stringify({
    type: 'lyric',
    lyric: { musicId: 'm1', source: 'kw', name: '测试歌曲', singer: '测试歌手', lrc: '[00:01.00]第一句\n[00:29.00]第二句\n[01:00.00]第三句', tlrc: '', rlrc: '' },
  }))
  await sleep(800)
  const lyricText = await page.$eval('#npLyric', el => el.textContent)
  assert(lyricText === '第二句', '网页端同步歌词当前句：' + lyricText)

  // 网页端发聊天，房主端应收到
  const before = hostMsgs.length
  await page.type('#chatInput', '网页端报到')
  await page.click('#btnSend')
  await sleep(600)
  const chatMsg = hostMsgs.slice(before).find(m => m.type === 'chat' && m.message.type === 'user')
  assert(!!chatMsg && chatMsg.message.text === '网页端报到', '网页端聊天送达房主端')

  // 房主端发聊天，网页端应显示
  host.send(JSON.stringify({ type: 'chat', text: '房主端回复' }))
  await sleep(600)
  const chatHtml = await page.$eval('#chat', el => el.textContent)
  assert(chatHtml.includes('房主端回复'), '房主端聊天显示在网页端')

  // 房间信息接口
  const apiRoom = await page.evaluate(async (c) => (await fetch('/api/room/' + c)).json(), code)
  assert(apiRoom.ok && apiRoom.room.code === code, 'HTTP 接口 /api/room/:code 可用')
  const apiRooms = await page.evaluate(async () => (await fetch('/api/rooms')).json())
  assert(apiRooms.ok && apiRooms.rooms.some(r => r.code), 'HTTP 接口 /api/rooms 可用')

  assert(errors.length === 0, '无 JS 报错' + (errors.length ? '：' + errors.join(' | ') : ''))

  host.close()
  await browser.close()
  console.log('\nWEB TESTS PASSED')
})().catch(async (err) => {
  console.error('\nWEB TESTS FAILED:', err.message)
  process.exit(1)
})
