'use strict'

/*
 * 특정 디스코드 채널에 마인크래프트 닉네임만 입력하면:
 *   1. 닉네임 형식 검사
 *   2. Mojang API로 실제 존재하는 계정인지 확인 (대소문자도 Mojang 응답으로 정규화)
 *   3. cyml-distro-worker에서 distribution.json을 읽어 해당 서버의 현재 화이트리스트를 가져옴
 *   4. 중복이 아니면 닉네임을 추가해서 PUT /whitelist/<SERVER_ID>로 저장
 * 슬래시 커맨드가 아니라 일반 메시지를 감지해야 해서(MESSAGE_CONTENT 인텐트),
 * Cloudflare Worker 같은 서버리스 환경이 아니라 상시 켜져 있는 프로세스가 필요하다.
 *
 * 이 디스코드 서버 하나 = SERVER_ID로 지정한 마크 서버 하나로 고정 매핑한다. 여러
 * 디스코드 서버/채널을 지원해야 하면 이 프로세스를 채널별로 하나씩 더 띄우면 된다.
 */

require('dotenv').config()
const { Client, GatewayIntentBits, Partials } = require('discord.js')

const {
    DISCORD_TOKEN,
    DISCORD_CHANNEL_ID,
    WORKER_BASE_URL,
    WHITELIST_KEY,
    SERVER_ID,
    COOLDOWN_SECONDS
} = process.env

for (const [name, value] of Object.entries({ DISCORD_TOKEN, DISCORD_CHANNEL_ID, WORKER_BASE_URL, WHITELIST_KEY, SERVER_ID })) {
    if (!value) {
        console.error(`환경변수 ${name}이 설정되지 않았습니다. .env.example을 참고해 .env를 채우세요.`)
        process.exit(1)
    }
}

const cooldownMs = (Number(COOLDOWN_SECONDS) || 10) * 1000
const MOJANG_USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/

// 같은 사람이 짧은 간격으로 여러 번 입력해 어뷰징하는 걸 막는 용도.
const lastAttemptAt = new Map()

// distribution.json 읽기 -> 화이트리스트 수정 -> 저장이 메시지마다 순서대로만 실행되게
// 직렬화한다. 동시에 여러 메시지가 들어와도 같은 GET 결과를 보고 서로 덮어쓰는 걸 막는다.
let writeQueue = Promise.resolve()
function serialize(fn) {
    const run = writeQueue.then(fn, fn)
    writeQueue = run.then(() => {}, () => {})
    return run
}

async function fetchMojangProfile(username) {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Mojang API 응답 오류: ${res.status}`)
    return res.json()
}

async function addToWhitelist(canonicalName) {
    const distRes = await fetch(`${WORKER_BASE_URL}/distribution.json`, { cache: 'no-store' })
    if (!distRes.ok) throw new Error(`distribution.json 조회 실패: ${distRes.status}`)
    const distribution = await distRes.json()
    const server = (distribution.servers || []).find(s => s.id === SERVER_ID)
    if (!server) throw new Error(`distribution.json에서 서버 id "${SERVER_ID}"를 찾을 수 없습니다.`)

    const current = server.whitelist || []
    if (current.some(n => n.toLowerCase() === canonicalName.toLowerCase())) {
        return { alreadyRegistered: true }
    }

    const whitelist = [...current, canonicalName]
    const putRes = await fetch(`${WORKER_BASE_URL}/whitelist/${encodeURIComponent(SERVER_ID)}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${WHITELIST_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ whitelist })
    })
    if (putRes.status === 403) throw new Error('이 WHITELIST_KEY는 SERVER_ID로 지정한 서버에 대한 권한이 없습니다.')
    if (!putRes.ok) throw new Error(`화이트리스트 저장 실패: ${putRes.status} ${await putRes.text().catch(() => '')}`)

    return { alreadyRegistered: false }
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
})

client.once('ready', () => {
    console.log(`로그인됨: ${client.user.tag} (채널 ${DISCORD_CHANNEL_ID} 감시, 서버 id "${SERVER_ID}")`)
})

client.on('messageCreate', async message => {
    if (message.author.bot) return
    if (message.channelId !== DISCORD_CHANNEL_ID) return

    const username = message.content.trim()
    if (!username) return

    const now = Date.now()
    const last = lastAttemptAt.get(message.author.id) || 0
    if (now - last < cooldownMs) {
        await message.react('⏳').catch(() => {})
        return
    }
    lastAttemptAt.set(message.author.id, now)

    if (!MOJANG_USERNAME_RE.test(username)) {
        await message.react('❌').catch(() => {})
        await message.reply('마인크래프트 닉네임 형식이 아닙니다. 영문/숫자/밑줄 3~16자로 다시 입력해주세요.').catch(() => {})
        return
    }

    let profile
    try {
        profile = await fetchMojangProfile(username)
    } catch (err) {
        console.error('Mojang API 조회 실패:', err)
        await message.react('⚠️').catch(() => {})
        await message.reply('모장 서버 확인에 실패했습니다. 잠시 후 다시 시도해주세요.').catch(() => {})
        return
    }

    if (!profile) {
        await message.react('❌').catch(() => {})
        await message.reply(`"${username}" 계정을 찾을 수 없습니다. 닉네임을 다시 확인해주세요.`).catch(() => {})
        return
    }

    try {
        const result = await serialize(() => addToWhitelist(profile.name))
        if (result.alreadyRegistered) {
            await message.react('ℹ️').catch(() => {})
            await message.reply(`"${profile.name}"님은 이미 화이트리스트에 등록되어 있습니다.`).catch(() => {})
        } else {
            await message.react('✅').catch(() => {})
            await message.reply(`"${profile.name}"님, 화이트리스트에 등록되었습니다.`).catch(() => {})
        }
    } catch (err) {
        console.error('화이트리스트 등록 실패:', err)
        await message.react('⚠️').catch(() => {})
        await message.reply('화이트리스트 등록 중 오류가 발생했습니다. 관리자에게 문의해주세요.').catch(() => {})
    }
})

process.on('unhandledRejection', err => console.error('처리되지 않은 오류:', err))

client.login(DISCORD_TOKEN)
