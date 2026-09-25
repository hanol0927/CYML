'use strict'
/* global WorkerAPI */

const DEFAULT_WORKER_BASE_URL = 'https://cyml-distro-worker.chaenna02.workers.dev'

const WORKER_URL_KEY = 'whitelistApp.workerBaseUrl'
const KEY_KEY = 'whitelistApp.key'

const $ = id => document.getElementById(id)

function getStoredSecret(key) {
    return sessionStorage.getItem(key) || localStorage.getItem(key) || ''
}

function setStoredSecret(key, value, persist) {
    sessionStorage.removeItem(key)
    localStorage.removeItem(key)
    if (value) {
        (persist ? localStorage : sessionStorage).setItem(key, value)
    }
}

function currentWorkerBaseUrl() {
    return $('workerBaseUrl').value.trim().replace(/\/$/, '') || DEFAULT_WORKER_BASE_URL
}

async function connect() {
    const workerBaseUrl = currentWorkerBaseUrl()
    const key = $('whitelistKey').value.trim()
    if (!key) {
        alert('화이트리스트 키를 입력하세요.')
        return
    }

    localStorage.setItem(WORKER_URL_KEY, workerBaseUrl)
    setStoredSecret(KEY_KEY, key, $('keyPersist').checked)

    $('connectStatus').textContent = '확인하는 중..'
    $('serverCards').innerHTML = ''
    try {
        const auth = await WorkerAPI.getWhitelistAuth(workerBaseUrl, key)
        const { distribution } = await WorkerAPI.getDistribution(workerBaseUrl)
        const servers = (distribution.servers || []).filter(s => auth.serverIds.includes(s.id))

        $('connectStatus').textContent =
            `연결됨 (${auth.label || '이름 없는 키'}) — 편집 가능한 서버 ${servers.length}개`

        if (servers.length === 0) {
            $('serverCards').innerHTML = '<p class="hint">이 키에 권한이 부여된 서버가 없습니다. 발급한 관리자에게 문의하세요.</p>'
            return
        }

        for (const serv of servers) {
            $('serverCards').appendChild(buildServerCard(workerBaseUrl, key, serv))
        }
    } catch (err) {
        console.error(err)
        $('connectStatus').textContent = `연결 실패: ${err.message}`
    }
}

function buildServerCard(workerBaseUrl, key, serv) {
    const section = document.createElement('section')
    section.className = 'panel'

    const h2 = document.createElement('h2')
    h2.textContent = `${serv.name} (${serv.id})`
    section.appendChild(h2)

    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = '한 줄에 닉네임 하나씩. 비워두면 전체 허용. (런처 UI에서만 적용되며, 마인크래프트 서버 접속 자체는 막지 않습니다.)'
    section.appendChild(hint)

    const textarea = document.createElement('textarea')
    textarea.value = (serv.whitelist || []).join('\n')
    textarea.placeholder = '닉네임1\n닉네임2'
    section.appendChild(textarea)

    const p = document.createElement('p')
    p.style.marginTop = '10px'
    const saveBtn = document.createElement('button')
    saveBtn.textContent = '저장'
    const status = document.createElement('span')
    status.className = 'hint'
    status.style.marginLeft = '8px'
    p.appendChild(saveBtn)
    p.appendChild(status)
    section.appendChild(p)

    saveBtn.addEventListener('click', async () => {
        const whitelist = textarea.value.split('\n').map(s => s.trim()).filter(Boolean)
        saveBtn.disabled = true
        status.textContent = '저장하는 중..'
        try {
            await WorkerAPI.putServerWhitelist(workerBaseUrl, key, serv.id, whitelist)
            status.textContent = `저장됨 (${new Date().toLocaleTimeString()})`
        } catch (err) {
            console.error(err)
            status.textContent = `저장 실패: ${err.message}`
        } finally {
            saveBtn.disabled = false
        }
    })

    return section
}

document.addEventListener('DOMContentLoaded', () => {
    $('workerBaseUrl').value = localStorage.getItem(WORKER_URL_KEY) || DEFAULT_WORKER_BASE_URL
    $('whitelistKey').value = getStoredSecret(KEY_KEY)
    $('keyPersist').checked = !!localStorage.getItem(KEY_KEY)

    $('connectBtn').addEventListener('click', connect)

    if ($('whitelistKey').value) connect()
})
