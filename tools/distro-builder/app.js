'use strict'
/* global GitHubAPI, WorkerAPI, md5 */

// ---- 고정 기본값 (설정 패널에서 덮어쓸 수 있음, README 참고) ----
const DEFAULTS = {
    workerBaseUrl: 'https://cyml-distro-worker.chaenna02.workers.dev',
    ciOwner: 'hanol0927',
    ciRepo: 'distro-ci',
    ciWorkflowFile: 'generate-server.yml'
}

// Forge/NeoForge 자동 생성(GitHub Actions) 워크플로우를 실행할 브랜치. distro-ci 저장소는
// 항상 main 브랜치를 쓴다고 가정 — 이 값은 UI로 노출하지 않는다.
const CI_BRANCH = 'main'

// distribution.json에 javaOptions가 없을 때 쓰는 기본값과 동일한 테이블.
// app/assets/js/scripts/landing.js의 JAVA_VERSION_TABLE과 값을 맞출 것.
const JAVA_VERSION_TABLE = [
    { minMcVersion: '26.0',   supported: '>=25.x', suggestedMajor: 25 },
    { minMcVersion: '1.20.5', supported: '>=21.x', suggestedMajor: 21 },
    { minMcVersion: '1.17',   supported: '>=17.x', suggestedMajor: 17 },
    { minMcVersion: '0',      supported: '8.x',    suggestedMajor: 8 }
]

const MODULE_TYPES = ['ForgeMod', 'FabricMod', 'LiteMod', 'Library', 'File']
// distro-ci/merge-server.js의 LOADER_OWNED_TYPES와 동일하게 맞출 것 — 로더 교체 시
// 이 타입의 기존 모듈만 새 로더 모듈로 대체하고, 나머지(모드/설정 등)는 그대로 둔다.
const LOADER_OWNED_TYPES = new Set(['Forge', 'ForgeHosted', 'Fabric', 'VersionManifest', 'Library'])
// 90MB 넘는 파일은 WorkerAPI가 자동으로 멀티파트 업로드로 전환하므로(worker-api.js의
// MULTIPART_THRESHOLD_BYTES) 실패 걱정 없이 훨씬 큰 파일도 올라간다 — 이 값은 이제
// "느려질 수 있다"는 정보성 안내 기준일 뿐, 업로드 가능 여부의 한계가 아니다.
const LARGE_FILE_NOTICE_BYTES = 2 * 1024 * 1024 * 1024

function mcVersionAtLeast(desired, actual) {
    const des = desired.split('.')
    const act = (actual || '0').split('.')
    while (act.length < des.length) act.push('0')
    for (let i = 0; i < des.length; i++) {
        const d = parseInt(des[i], 10)
        const a = parseInt(act[i], 10) || 0
        if (a > d) return true
        if (a < d) return false
    }
    return true
}

function resolveJavaOptions(mcVersion) {
    const entry = JAVA_VERSION_TABLE.find(e => mcVersionAtLeast(e.minMcVersion, mcVersion))
    return { supported: entry.supported, suggestedMajor: entry.suggestedMajor }
}

// ---- Local settings / token persistence ----

const SETTINGS_KEY = 'distroBuilder.settings'
const TOKEN_KEY = 'distroBuilder.token'
const UPLOAD_SECRET_KEY = 'distroBuilder.uploadSecret'

function loadSettings() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}
    } catch (e) {
        return {}
    }
}

function saveSettingsToStorage(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

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

// GitHub PAT — Forge/NeoForge 자동 생성(GitHub Actions) 전용.
function getToken() {
    return getStoredSecret(TOKEN_KEY)
}

function setToken(token, persist) {
    setStoredSecret(TOKEN_KEY, token, persist)
}

// Cloudflare Worker 업로드 시크릿 — distribution.json/자산 파일 배포용.
function getUploadSecret() {
    return getStoredSecret(UPLOAD_SECRET_KEY)
}

function setUploadSecret(secret, persist) {
    setStoredSecret(UPLOAD_SECRET_KEY, secret, persist)
}

// ---- DOM helpers ----

const $ = id => document.getElementById(id)

function log(message) {
    const el = $('deployLog')
    const line = document.createElement('div')
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
    el.appendChild(line)
    el.scrollTop = el.scrollHeight
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sanitizeMavenPart(name) {
    return (name || 'mod').toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

// ---- App state ----

const state = {
    distribution: null,
    distributionEtag: null,
    editingServerId: null,
    existingModules: [], // [{ module, remove }]
    existingOnceFiles: [], // [{ entry, remove }] - serv.onceFiles 항목 (최초 1회 적용 설정 파일)
    newMods: [],          // [{ file, name, type, required }]
    newConfigs: [],       // [{ file, path, forceEveryLaunch, section }] - section: 'config' | 'root'
    backgroundFile: null,
    iconFile: null
}

function currentSettings() {
    return {
        workerBaseUrl: $('workerBaseUrl').value.trim().replace(/\/$/, ''),
        uploadSecret: $('uploadSecret').value.trim(),
        ciOwner: $('ciOwner').value.trim() || DEFAULTS.ciOwner,
        ciRepo: $('ciRepo').value.trim() || DEFAULTS.ciRepo,
        ciWorkflowFile: $('ciWorkflowFile').value.trim() || DEFAULTS.ciWorkflowFile
    }
}

function initSettingsUI() {
    const saved = loadSettings()
    $('workerBaseUrl').value = saved.workerBaseUrl || DEFAULTS.workerBaseUrl
    $('ciOwner').value = saved.ciOwner || DEFAULTS.ciOwner
    $('ciRepo').value = saved.ciRepo || DEFAULTS.ciRepo
    $('ciWorkflowFile').value = saved.ciWorkflowFile || DEFAULTS.ciWorkflowFile
    $('uploadSecret').value = getUploadSecret()
    $('uploadSecretPersist').checked = !!localStorage.getItem(UPLOAD_SECRET_KEY)
    $('ghToken').value = getToken()
    $('ghTokenPersist').checked = !!localStorage.getItem(TOKEN_KEY)

    $('saveSettingsBtn').addEventListener('click', () => {
        saveSettingsToStorage(currentSettings())
        setUploadSecret($('uploadSecret').value.trim(), $('uploadSecretPersist').checked)
        setToken($('ghToken').value.trim(), $('ghTokenPersist').checked)
        $('settingsStatus').textContent = '저장됨'
        setTimeout(() => { $('settingsStatus').textContent = '' }, 2000)
    })
}

// ---- Existing distribution.json ----

async function fetchDistribution() {
    const { workerBaseUrl } = currentSettings()
    if (!workerBaseUrl) throw new Error('먼저 Worker 기본 URL을 입력하고 저장하세요.')
    return WorkerAPI.getDistribution(workerBaseUrl)
}

async function refreshServerPicker() {
    $('serverLoadStatus').textContent = '불러오는 중..'
    try {
        const { distribution, etag } = await fetchDistribution()
        distribution.servers = distribution.servers || []
        state.distribution = distribution
        state.distributionEtag = etag
        const select = $('existingServerSelect')
        const previousValue = select.value
        select.innerHTML = '<option value="">-- 새 서버 만들기 --</option>'
        for (const serv of distribution.servers) {
            const opt = document.createElement('option')
            opt.value = serv.id
            opt.textContent = `${serv.name} (${serv.id})`
            select.appendChild(opt)
        }
        if (previousValue && distribution.servers.some(s => s.id === previousValue)) {
            select.value = previousValue
        }
        $('serverLoadStatus').textContent = `distribution.json 불러옴 (서버 ${distribution.servers.length}개)`
        renderWlKeyServerCheckboxes()
    } catch (err) {
        console.error(err)
        $('serverLoadStatus').textContent = `불러오기 실패: ${err.message}`
    }
}

// ---- 화이트리스트 키 관리 ----

function renderWlKeyServerCheckboxes() {
    const container = $('wlKeyServerList')
    const servers = (state.distribution && state.distribution.servers) || []
    if (servers.length === 0) {
        container.className = 'hint'
        container.textContent = '서버 목록 없음 — 먼저 distribution.json을 불러오세요.'
        return
    }
    container.className = ''
    container.innerHTML = ''
    for (const serv of servers) {
        const row = document.createElement('div')
        row.className = 'checkboxRow'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.value = serv.id
        cb.id = `wlKeyServer_${serv.id}`
        const label = document.createElement('label')
        label.htmlFor = cb.id
        label.textContent = `${serv.name} (${serv.id})`
        row.appendChild(cb)
        row.appendChild(label)
        container.appendChild(row)
    }
}

async function createWlKey() {
    const { workerBaseUrl, uploadSecret } = currentSettings()
    if (!workerBaseUrl || !uploadSecret) {
        alert('먼저 Worker 기본 URL과 업로드 시크릿을 입력하고 저장하세요.')
        return
    }
    const serverIds = Array.from($('wlKeyServerList').querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value)
    if (serverIds.length === 0) {
        alert('권한을 줄 서버를 하나 이상 선택하세요.')
        return
    }
    const label = $('wlKeyLabel').value.trim()
    $('wlKeyCreateBtn').disabled = true
    try {
        const result = await WorkerAPI.createWhitelistKey(workerBaseUrl, uploadSecret, label, serverIds)
        $('wlKeyNewResult').innerHTML =
            '<p class="warning">이 키는 지금만 표시됩니다 — 다시 조회할 수 없으니 지금 복사해서 전달하세요.</p>' +
            `<div class="keyBox">${result.key}</div>` +
            `<p class="hint">권한 서버: ${result.serverIds.join(', ')}</p>`
        $('wlKeyLabel').value = ''
        $('wlKeyServerList').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false })
        await refreshWlKeyList()
    } catch (err) {
        console.error(err)
        alert(`키 생성 실패: ${err.message}`)
    } finally {
        $('wlKeyCreateBtn').disabled = false
    }
}

async function refreshWlKeyList() {
    const { workerBaseUrl, uploadSecret } = currentSettings()
    if (!workerBaseUrl || !uploadSecret) {
        alert('먼저 Worker 기본 URL과 업로드 시크릿을 입력하고 저장하세요.')
        return
    }
    const container = $('wlKeyList')
    container.className = 'hint'
    container.textContent = '불러오는 중..'
    try {
        const { keys } = await WorkerAPI.listWhitelistKeys(workerBaseUrl, uploadSecret)
        if (keys.length === 0) {
            container.textContent = '발급된 키가 없습니다.'
            return
        }
        container.className = ''
        container.innerHTML = ''
        for (const k of keys) {
            const row = document.createElement('div')
            row.className = 'keyRow'
            const meta = document.createElement('div')
            meta.className = 'keyMeta'
            meta.textContent = `${k.label || '(이름 없음)'} — ${k.serverIds.join(', ')} · ${new Date(k.createdAt).toLocaleString()}`
            const delBtn = document.createElement('button')
            delBtn.className = 'removeBtn'
            delBtn.textContent = '삭제'
            delBtn.addEventListener('click', async () => {
                if (!confirm(`"${k.label || k.id}" 키를 삭제할까요? 이 키를 가진 사람은 더 이상 화이트리스트를 편집할 수 없게 됩니다.`)) return
                delBtn.disabled = true
                try {
                    await WorkerAPI.deleteWhitelistKey(workerBaseUrl, uploadSecret, k.id)
                    await refreshWlKeyList()
                } catch (err) {
                    alert(`삭제 실패: ${err.message}`)
                    delBtn.disabled = false
                }
            })
            row.appendChild(meta)
            row.appendChild(delBtn)
            container.appendChild(row)
        }
    } catch (err) {
        console.error(err)
        container.textContent = `불러오기 실패: ${err.message}`
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function loaderGenLog(message) {
    const el = $('loaderGenLog')
    const line = document.createElement('div')
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
    el.appendChild(line)
    el.scrollTop = el.scrollHeight
}

/**
 * "GitHub Actions로 생성 시작" 버튼 핸들러. Forge/NeoForge는 브라우저에서 직접 만들
 * 수 없어서(JVM 필요), 별도 워크플로우 저장소의 GitHub Actions를 워크플로우
 * dispatch로 실행시키고 완료를 폴링한다. 워크플로우 자체가 ddumon/distribution.json에
 * 이 서버 하나만 안전하게 upsert하도록 돼 있다고 가정한다(tools/distro-ci 참고).
 * 이 저장소 환경에서 실제로 실행해보지 못한 실험적 기능 — 실패하면 forgePasteBlock의
 * 수동 붙여넣기로 우회할 수 있다.
 */
async function startForgeLoaderGeneration() {
    const token = getToken()
    if (!token) {
        alert('먼저 GitHub 토큰을 입력하고 저장하세요.')
        return
    }
    const serverId = $('serverId').value.trim()
    const mcVersion = $('serverMcVersion').value.trim()
    const loaderType = $('forgeLoaderType').value
    const loaderVersion = $('forgeLoaderVersion').value.trim()
    if (!serverId || !mcVersion || !loaderVersion) {
        alert('서버 id, 마인크래프트 버전, 로더 버전을 모두 입력하세요.')
        return
    }

    const { ciOwner, ciRepo, ciWorkflowFile } = currentSettings()
    $('generateLoaderBtn').disabled = true
    $('loaderGenStatus').textContent = '시작하는 중..'
    $('loaderGenLog').innerHTML = ''

    try {
        const sinceMs = Date.now() - 5000 // 브라우저/서버 시계 오차 대비 약간 여유
        loaderGenLog(`워크플로우 실행 요청 중.. (${ciRepo}/${ciWorkflowFile})`)
        await GitHubAPI.dispatchWorkflow(token, ciOwner, ciRepo, ciWorkflowFile, CI_BRANCH, {
            serverId, mcVersion, loaderType, loaderVersion
        })

        loaderGenLog('실행 확인 중..')
        let run = null
        for (let i = 0; i < 15 && run == null; i++) {
            await sleep(2000)
            run = await GitHubAPI.findRunSince(token, ciOwner, ciRepo, ciWorkflowFile, sinceMs)
        }
        if (run == null) {
            throw new Error('워크플로우 실행을 찾지 못했습니다. 저장소/파일명 설정과, 그 저장소에 워크플로우가 실제로 등록됐는지 확인하세요.')
        }
        loaderGenLog(`실행 확인됨: ${run.html_url}`)

        let status = run.status
        while (status !== 'completed') {
            await sleep(5000)
            run = await GitHubAPI.getWorkflowRun(token, ciOwner, ciRepo, run.id)
            status = run.status
            $('loaderGenStatus').textContent = status
        }

        if (run.conclusion !== 'success') {
            loaderGenLog(`실패(${run.conclusion}). 로그: ${run.html_url}`)
            loaderGenLog('자동화가 막히면 "JSON 직접 붙여넣기"로 우회하세요.')
            return
        }

        loaderGenLog('성공! distribution.json에 반영됐습니다. 불러오는 중..')
        await refreshServerPicker()
        $('existingServerSelect').value = serverId
        loadServerIntoForm(serverId)
        loaderGenLog('완료 — 이제 이름/설명/화이트리스트/배경화면 등을 채우고 "GitHub에 배포"를 누르면 됩니다.')
    } catch (err) {
        console.error(err)
        loaderGenLog(`오류: ${err.message}`)
    } finally {
        $('generateLoaderBtn').disabled = false
        $('loaderGenStatus').textContent = ''
    }
}

function resetFormForNewServer() {
    state.editingServerId = null
    state.existingModules = []
    state.existingOnceFiles = []
    ;['serverId', 'serverName', 'serverDescription', 'serverAddress', 'serverMcVersion'].forEach(id => { $(id).value = '' })
    $('serverId').disabled = false
    $('serverAutoconnect').checked = false
    $('serverMainServer').checked = false
    $('backgroundCurrentUrl').value = ''
    $('backgroundPreview').style.display = 'none'
    state.backgroundFile = null
    $('iconCurrentUrl').value = ''
    $('iconPreview').style.display = 'none'
    state.iconFile = null
    $('javaOptionsManual').checked = false
    $('loaderTypeSection').style.display = ''
    $('loaderReplaceRow').style.display = 'none'
    $('loaderReplaceCheck').checked = false
    $('loaderTypeFields').style.display = ''
    $('importedLoaderJson').value = ''
    renderExistingModules()
    updateJavaPreview()
}

function loadServerIntoForm(serverId) {
    const serv = (state.distribution.servers || []).find(s => s.id === serverId)
    if (serv == null) {
        resetFormForNewServer()
        return
    }
    state.editingServerId = serverId
    state.existingModules = (serv.modules || []).map(m => ({ module: m, remove: false }))
    state.existingOnceFiles = (serv.onceFiles || []).map(o => ({ entry: o, remove: false }))

    $('serverId').value = serv.id
    // 기존 서버의 id는 여기서 바꾸지 않는다 — 바뀌면 런처의 선택 서버/자바 경로 저장 키가 끊어짐.
    $('serverId').disabled = true
    $('serverName').value = serv.name || ''
    $('serverDescription').value = serv.description || ''
    $('serverAddress').value = serv.address || ''
    $('serverMcVersion').value = serv.minecraftVersion || ''
    $('serverAutoconnect').checked = !!serv.autoconnect
    $('serverMainServer').checked = !!serv.mainServer
    state.backgroundFile = null
    $('backgroundCurrentUrl').value = serv.background || ''
    if (serv.background) {
        $('backgroundPreview').src = serv.background
        $('backgroundPreview').style.display = ''
    } else {
        $('backgroundPreview').style.display = 'none'
    }
    state.iconFile = null
    $('iconCurrentUrl').value = serv.icon || ''
    if (serv.icon) {
        $('iconPreview').src = serv.icon
        $('iconPreview').style.display = ''
    } else {
        $('iconPreview').style.display = 'none'
    }
    // 기존 서버 편집 중엔 기본적으로 로더 모듈을 재생성하지 않는다 — 명시적으로
    // "로더 교체" 체크박스를 켜야만 아래 로더 필드가 나타난다(loaderReplaceCheck 참고).
    $('loaderTypeSection').style.display = ''
    $('loaderReplaceRow').style.display = ''
    $('loaderReplaceCheck').checked = false
    $('loaderTypeFields').style.display = 'none'
    $('importedLoaderJson').value = ''

    if (serv.javaOptions != null) {
        $('javaOptionsManual').checked = true
        $('javaSupported').value = serv.javaOptions.supported || ''
        $('javaSuggestedMajor').value = serv.javaOptions.suggestedMajor || ''
    } else {
        $('javaOptionsManual').checked = false
    }

    renderExistingModules()
    updateJavaPreview()
}

function renderExistingModules() {
    const container = $('existingModulesList')
    container.innerHTML = ''
    if (state.existingModules.length === 0 && state.existingOnceFiles.length === 0) {
        container.innerHTML = '<p class="hint">기존 모듈 없음</p>'
        return
    }

    const removableRows = []
    const lockedRows = []
    state.existingModules.forEach((entry, idx) => {
        if (LOADER_OWNED_TYPES.has(entry.module.type)) {
            lockedRows.push({ entry, idx })
        } else {
            removableRows.push({ entry, idx })
        }
    })

    if (removableRows.length > 0) {
        const heading = document.createElement('p')
        heading.className = 'hint'
        heading.textContent = '모드 / 설정 파일 — 체크하고 배포하면 distribution.json에서 삭제됩니다.'
        container.appendChild(heading)
        for (const { entry, idx } of removableRows) {
            const row = document.createElement('label')
            row.className = 'moduleRow'
            row.innerHTML = `
                <input type="checkbox" ${entry.remove ? 'checked' : ''}>
                <span class="moduleType">${entry.module.type}</span>
                <span class="moduleName" style="${entry.remove ? 'text-decoration:line-through;color:var(--muted);' : ''}">${entry.module.name || entry.module.id}</span>
                <span class="hint">${entry.remove ? '삭제 예정' : '삭제'}</span>
            `
            row.querySelector('input').addEventListener('change', e => {
                state.existingModules[idx].remove = e.target.checked
                renderExistingModules()
            })
            container.appendChild(row)
        }
    }

    if (lockedRows.length > 0) {
        const heading = document.createElement('p')
        heading.className = 'hint'
        heading.textContent = '로더 / 라이브러리 핵심 모듈 — 여기서는 지울 수 없습니다. 교체하려면 위 "3-1. 로더"의 교체 체크박스를 쓰세요.'
        container.appendChild(heading)
        for (const { entry } of lockedRows) {
            const row = document.createElement('div')
            row.className = 'moduleRow'
            row.innerHTML = `
                <span class="moduleType">${entry.module.type}</span>
                <span class="moduleName">${entry.module.name || entry.module.id}</span>
            `
            container.appendChild(row)
        }
    }

    if (state.existingOnceFiles.length > 0) {
        const heading = document.createElement('p')
        heading.className = 'hint'
        heading.textContent = '설정 파일 (최초 1회 적용, onceFiles) — 체크하고 배포하면 distribution.json에서 삭제됩니다.'
        container.appendChild(heading)
        state.existingOnceFiles.forEach((entry, idx) => {
            const row = document.createElement('label')
            row.className = 'moduleRow'
            row.innerHTML = `
                <input type="checkbox" ${entry.remove ? 'checked' : ''}>
                <span class="moduleType">File</span>
                <span class="moduleName" style="${entry.remove ? 'text-decoration:line-through;color:var(--muted);' : ''}">${entry.entry.path}</span>
                <span class="hint">${entry.remove ? '삭제 예정' : '삭제'}</span>
            `
            row.querySelector('input').addEventListener('change', e => {
                state.existingOnceFiles[idx].remove = e.target.checked
                renderExistingModules()
            })
            container.appendChild(row)
        })
    }
}

// ---- Java options preview ----

function updateJavaPreview() {
    const manual = $('javaOptionsManual').checked
    $('javaSupported').disabled = !manual
    $('javaSuggestedMajor').disabled = !manual
    if (!manual) {
        const resolved = resolveJavaOptions($('serverMcVersion').value.trim())
        $('javaSupported').value = resolved.supported
        $('javaSuggestedMajor').value = resolved.suggestedMajor
    }
}

// ---- 로더 선택 UI ----

function updateLoaderTypeBlocks() {
    const loaderType = $('loaderType').value
    $('fabricLoaderBlock').style.display = loaderType === 'fabric' ? '' : 'none'
    $('forgeAutoBlock').style.display = loaderType === 'forge-auto' ? '' : 'none'
    $('forgePasteBlock').style.display = loaderType === 'forge-paste' ? '' : 'none'
    if (loaderType === 'fabric') {
        refreshFabricLoaderVersions()
    }
}

async function refreshFabricLoaderVersions() {
    if ($('loaderType').value !== 'fabric') return
    const mcVersion = $('serverMcVersion').value.trim()
    const select = $('fabricLoaderVersion')
    select.innerHTML = ''
    if (!mcVersion) return
    try {
        const versions = await fetchFabricLoaderVersions(mcVersion)
        for (const v of versions) {
            const opt = document.createElement('option')
            opt.value = v.loader.version
            opt.textContent = v.loader.version + (v.loader.stable ? ' (stable)' : '')
            select.appendChild(opt)
        }
        const stableIdx = versions.findIndex(v => v.loader.stable)
        if (stableIdx >= 0) select.selectedIndex = stableIdx
    } catch (err) {
        console.error(err)
    }
}

// ---- File drop zones ----

function setupDropzone(zoneId, inputId, onFiles) {
    const zone = $(zoneId)
    const input = $(inputId)
    zone.addEventListener('click', () => input.click())
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover') })
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
    zone.addEventListener('drop', e => {
        e.preventDefault()
        zone.classList.remove('dragover')
        onFiles(Array.from(e.dataTransfer.files))
    })
    input.addEventListener('change', () => {
        onFiles(Array.from(input.files))
        input.value = ''
    })
}

// ---- Folder-aware file collection (드래그앤드롭 폴더/하위폴더 재귀 탐색) ----

function readAllDirectoryEntries(reader) {
    return new Promise((resolve, reject) => {
        const entries = []
        function readBatch() {
            // Chrome은 한 번의 readEntries 호출당 최대 100개만 반환하므로 빈 배열이
            // 나올 때까지 반복 호출해야 폴더 안의 모든 항목을 다 읽을 수 있다.
            reader.readEntries(batch => {
                if (batch.length === 0) {
                    resolve(entries)
                } else {
                    entries.push(...batch)
                    readBatch()
                }
            }, reject)
        }
        readBatch()
    })
}

function readEntryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject))
}

// 개별 파일/폴더 읽기 실패(잠긴 파일, OneDrive "온라인 전용" 플레이스홀더 등)를
// 콘솔 경고로만 남기면 사용자 눈에는 그냥 "드래그해도 아무 반응 없음"으로만 보인다
// (실제로 겪은 제보). skipped에 실패한 이름을 모아서 드롭존 옆에 눈에 띄게 표시한다.
async function collectFilesFromEntry(entry, out, skipped) {
    if (entry.isFile) {
        try {
            const file = await readEntryFile(entry)
            out.push({ file, relativePath: entry.fullPath.replace(/^\//, '') })
        } catch (err) {
            skipped.push(entry.fullPath || entry.name)
            console.warn(`"${entry.fullPath || entry.name}" 파일을 읽지 못해 건너뜁니다.`, err)
        }
    } else if (entry.isDirectory) {
        let entries
        try {
            entries = await readAllDirectoryEntries(entry.createReader())
        } catch (err) {
            skipped.push(entry.fullPath || entry.name)
            console.warn(`"${entry.fullPath || entry.name}" 폴더를 읽지 못해 건너뜁니다.`, err)
            return
        }
        for (const child of entries) {
            await collectFilesFromEntry(child, out, skipped)
        }
    }
}

function plainFilesFromDataTransfer(dataTransfer) {
    return Array.from(dataTransfer.files).map(file => ({ file, relativePath: file.name }))
}

// { entries, skipped } 형태로 반환한다 — skipped는 읽기 실패한 파일/폴더 이름 목록
// (호출자가 드롭존 옆에 표시해서 "반응 없음"처럼 보이지 않게 한다).
async function collectFilesFromDataTransfer(dataTransfer) {
    const items = dataTransfer.items
    if (items == null || items.length === 0) {
        return { entries: plainFilesFromDataTransfer(dataTransfer), skipped: [] }
    }
    const fsEntries = []
    for (const item of items) {
        // webkitGetAsEntry()는 특정 드래그 항목(잠긴 파일, 일부 클라우드 동기화
        // 플레이스홀더 등)에서 예외를 던지는 경우가 있다. map()으로 한 번에 처리하면
        // 항목 하나의 예외가 전체 드롭을 조용히 무효화시키므로 항목별로 감싼다.
        try {
            const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
            if (entry != null) fsEntries.push(entry)
        } catch (err) {
            console.warn('드래그한 항목 하나를 인식하지 못해 건너뜁니다.', err)
        }
    }
    if (fsEntries.length === 0) {
        return { entries: plainFilesFromDataTransfer(dataTransfer), skipped: [] }
    }
    const out = []
    const skipped = []
    for (const entry of fsEntries) {
        try {
            await collectFilesFromEntry(entry, out, skipped)
        } catch (err) {
            skipped.push(entry.fullPath || entry.name)
            console.warn(`"${entry.fullPath || entry.name}" 항목을 읽지 못해 건너뜁니다.`, err)
        }
    }
    if (out.length === 0 && skipped.length === 0) {
        // 엔트리 인식 자체는 됐지만 결과적으로 아무것도 못 얻은 경우(예: 빈 폴더) —
        // 최소한 평범한 파일 목록으로라도 폴백한다.
        return { entries: plainFilesFromDataTransfer(dataTransfer), skipped: [] }
    }
    return { entries: out, skipped }
}

function entriesFromFolderInput(fileList) {
    // webkitdirectory로 선택한 폴더의 각 File은 webkitRelativePath에 "폴더명/하위경로"가 담겨 있다.
    return Array.from(fileList).map(file => ({ file, relativePath: file.webkitRelativePath || file.name }))
}

function entriesFromPlainInput(fileList) {
    return Array.from(fileList).map(file => ({ file, relativePath: file.name }))
}

function setupFolderAwareDropzone(zoneId, inputId, folderInputId, folderBtnId, onEntries, onSkipped) {
    const zone = $(zoneId)
    const input = $(inputId)
    const folderInput = $(folderInputId)
    const folderBtn = $(folderBtnId)
    zone.addEventListener('click', () => input.click())
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover') })
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
    zone.addEventListener('drop', async e => {
        e.preventDefault()
        zone.classList.remove('dragover')
        const dataTransfer = e.dataTransfer
        let result
        try {
            result = await collectFilesFromDataTransfer(dataTransfer)
        } catch (err) {
            // 예상 못한 오류로 폴더 탐색 자체가 실패해도 드롭이 완전히 무반응으로
            // 보이지 않도록, 최소한 평범한 파일 목록으로라도 폴백한다.
            console.warn('드래그된 파일을 처리하는 중 오류가 발생해 일반 파일 목록으로 대체합니다.', err)
            result = { entries: plainFilesFromDataTransfer(dataTransfer), skipped: [] }
        }
        onEntries(result.entries)
        if (onSkipped) onSkipped(result.skipped)
    })
    input.addEventListener('change', () => {
        onEntries(entriesFromPlainInput(input.files))
        input.value = ''
    })
    folderBtn.addEventListener('click', () => folderInput.click())
    folderInput.addEventListener('change', () => {
        onEntries(entriesFromFolderInput(folderInput.files))
        folderInput.value = ''
    })
}

function addBackgroundFile(files) {
    const file = files[0]
    if (file == null) return
    state.backgroundFile = file
    $('backgroundPreview').src = URL.createObjectURL(file)
    $('backgroundPreview').style.display = ''
}

function addIconFile(files) {
    const file = files[0]
    if (file == null) return
    state.iconFile = file
    $('iconPreview').src = URL.createObjectURL(file)
    $('iconPreview').style.display = ''
}

function addModFiles(files) {
    for (const file of files) {
        state.newMods.push({ file, name: file.name, type: 'ForgeMod', required: true, replacesModuleIdx: null })
    }
    renderNewMods()
}

function renderNewMods() {
    const container = $('modsList')
    container.innerHTML = ''
    const replaceOptions = state.existingModules
        .map((entry, i) => `<option value="${i}">${entry.module.name || entry.module.id}</option>`)
        .join('')
    state.newMods.forEach((entry, idx) => {
        const row = document.createElement('div')
        row.className = 'fileRow'
        row.innerHTML = `
            <span class="fileName">${entry.file.name}</span>
            <span class="fileSize">${formatBytes(entry.file.size)}</span>
            <select class="modTypeSelect">
                ${MODULE_TYPES.map(t => `<option value="${t}" ${t === entry.type ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <label><input type="checkbox" class="modRequiredCheck" ${entry.required ? 'checked' : ''}> 필수</label>
            <select class="modReplaceSelect" title="이 파일이 대체하는 기존 모듈">
                <option value="">대체 안 함</option>
                ${replaceOptions}
            </select>
            <button type="button" class="removeBtn">삭제</button>
        `
        row.querySelector('.modTypeSelect').addEventListener('change', e => { state.newMods[idx].type = e.target.value })
        row.querySelector('.modRequiredCheck').addEventListener('change', e => { state.newMods[idx].required = e.target.checked })
        row.querySelector('.modReplaceSelect').addEventListener('change', e => {
            state.newMods[idx].replacesModuleIdx = e.target.value === '' ? null : parseInt(e.target.value, 10)
        })
        row.querySelector('.removeBtn').addEventListener('click', () => { state.newMods.splice(idx, 1); renderNewMods() })
        container.appendChild(row)
    })
    $('modsWarning').textContent = state.newMods.some(m => m.file.size > LARGE_FILE_NOTICE_BYTES)
        ? '2GB가 넘는 파일이 있습니다. 자동으로 여러 조각으로 나눠 업로드하지만(멀티파트) 네트워크 상황에 따라 시간이 오래 걸릴 수 있습니다.'
        : ''
}

function showDropSkippedWarning(warningElId, skipped) {
    const el = $(warningElId)
    if (!skipped || skipped.length === 0) {
        el.textContent = ''
        return
    }
    el.textContent =
        `${skipped.length}개 항목을 읽지 못해 건너뛰었습니다: ${skipped.join(', ')} ` +
        '(잠긴 파일이거나 OneDrive 등 클라우드 동기화의 "온라인 전용" 플레이스홀더 파일일 수 있습니다 — 파일을 완전히 내려받은 뒤 다시 시도하세요.)'
}

function addConfigEntries(entries, section) {
    const basePrefix = section === 'root' ? '' : 'config'
    for (const { file, relativePath } of entries) {
        const path = basePrefix ? `${basePrefix}/${relativePath}` : relativePath
        state.newConfigs.push({ file, path, forceEveryLaunch: false, section })
    }
    renderNewConfigs()
}

function renderNewConfigs() {
    const configContainer = $('configsList')
    const rootContainer = $('rootFilesList')
    configContainer.innerHTML = ''
    rootContainer.innerHTML = ''
    state.newConfigs.forEach((entry, idx) => {
        const container = entry.section === 'root' ? rootContainer : configContainer
        const row = document.createElement('div')
        row.className = 'fileRow'
        row.innerHTML = `
            <span class="fileName">${entry.file.name}</span>
            <span class="fileSize">${formatBytes(entry.file.size)}</span>
            <input type="text" class="configPathInput" value="${entry.path}">
            <label><input type="checkbox" class="configForceCheck" ${entry.forceEveryLaunch ? 'checked' : ''}> 매번 강제 적용</label>
            <button type="button" class="removeBtn">삭제</button>
        `
        row.querySelector('.configPathInput').addEventListener('input', e => { state.newConfigs[idx].path = e.target.value })
        row.querySelector('.configForceCheck').addEventListener('change', e => { state.newConfigs[idx].forceEveryLaunch = e.target.checked })
        row.querySelector('.removeBtn').addEventListener('click', () => { state.newConfigs.splice(idx, 1); renderNewConfigs() })
        container.appendChild(row)
    })
}

// ---- Hashing / encoding ----

function readFileAsBytes(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(new Uint8Array(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(file)
    })
}

function hashAndEncodeBytes(bytes) {
    return {
        size: bytes.length,
        md5: md5.hexFromBytes(bytes),
        bytes
    }
}

async function hashAndEncode(file) {
    return hashAndEncodeBytes(await readFileAsBytes(file))
}

async function fetchBytes(url) {
    const res = await fetch(url)
    if (!res.ok) {
        throw new Error(`파일을 받아오지 못했습니다: ${url} (HTTP ${res.status})`)
    }
    return new Uint8Array(await res.arrayBuffer())
}

// "group:artifact:version[:classifier]" -> 메이븐 저장소 상대 경로
function mavenNameToPath(name) {
    const [group, artifact, version, classifier] = name.split(':')
    const groupPath = group.replace(/\./g, '/')
    const fileName = classifier != null
        ? `${artifact}-${version}-${classifier}.jar`
        : `${artifact}-${version}.jar`
    return `${groupPath}/${artifact}/${version}/${fileName}`
}

// ---- Fabric 자동 생성 (Mojang/Fabric 공개 API, CORS 허용 확인됨 — JVM 불필요) ----

async function fetchFabricLoaderVersions(mcVersion) {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`)
    if (!res.ok) return []
    return res.json()
}

/**
 * Fabric 서버의 로더 모듈 트리를 브라우저에서 완전히 조립한다.
 * profile/json 응답 자체는 요청마다 시간 정보가 바뀌어서(캐시 불안정) fabricmc.net에
 * 직접 링크하지 않고 받아온 그대로(재직렬화 없이) 자산 저장소에 재호스팅한다.
 * 나머지 라이브러리/로더 jar는 maven.fabricmc.net URL을 그대로 참조한다.
 *
 * @returns {Promise<{modules: Array, assetFiles: Array}>}
 */
async function buildFabricModules(mcVersion, loaderVersion, serverFolder, assetBaseUrl) {
    log(`Fabric 프로필 조회 중: ${mcVersion} / ${loaderVersion}`)
    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
    const profileBytes = await fetchBytes(profileUrl)
    const profile = JSON.parse(new TextDecoder('utf-8').decode(profileBytes))

    const assetFiles = []
    const subModules = []
    let fabricLoaderModule = null

    const profileEncoded = hashAndEncodeBytes(profileBytes)
    const profilePath = `${serverFolder}/fabric/${profile.id}.json`
    assetFiles.push({ path: profilePath, bytes: profileEncoded.bytes })
    subModules.push({
        id: profile.id,
        name: 'Fabric Loader (version.json)',
        type: 'VersionManifest',
        artifact: { size: profileEncoded.size, MD5: profileEncoded.md5, url: `${assetBaseUrl}/${profilePath}` }
    })

    for (const lib of profile.libraries) {
        const libUrl = lib.url + mavenNameToPath(lib.name)
        if (lib.name.startsWith('net.fabricmc:fabric-loader:')) {
            log(`fabric-loader jar 해시 계산 중: ${lib.name}`)
            const { size, md5: hash } = hashAndEncodeBytes(await fetchBytes(libUrl))
            fabricLoaderModule = {
                id: lib.name,
                name: `Fabric Loader ${loaderVersion}`,
                type: 'Fabric',
                artifact: { size, MD5: hash, url: libUrl }
            }
            continue
        }
        let size = lib.size
        let hash = lib.md5
        if (size == null || hash == null) {
            log(`${lib.name} 해시 계산 중 (메타에 없음): intermediary 등`)
            const encoded = hashAndEncodeBytes(await fetchBytes(libUrl))
            size = encoded.size
            hash = encoded.md5
        }
        subModules.push({
            id: lib.name,
            name: lib.name,
            type: 'Library',
            artifact: { size, MD5: hash, url: libUrl }
        })
    }

    if (fabricLoaderModule == null) {
        throw new Error('Fabric 프로필에서 fabric-loader 항목을 찾지 못했습니다.')
    }
    fabricLoaderModule.subModules = subModules
    return { modules: [fabricLoaderModule], assetFiles }
}

// ---- Forge/NeoForge 버전 정보(version.json) 붙여넣기 ----

// distro-ci(NeoNebula)나 실제 Forge 인스톨러가 만든 원본 Mojang/Forge 스키마
// version.json인지 판별한다. 주의: Mojang 스키마도 최상위에 "type" 필드가 있다
// (release/snapshot 같은 릴리스 채널 값) — Helios 모듈의 "type"(ForgeHosted 등)과
// 이름만 같고 뜻이 다르므로 이 필드로는 구분하면 안 된다. Helios 모듈에는 항상
// 있는 최상위 "artifact" 필드의 유무 + Mojang 스키마 고유 필드(libraries/mainClass)
// 조합으로만 판별한다.
function looksLikeRawForgeVersionJson(parsed) {
    return !Array.isArray(parsed)
        && parsed.artifact == null
        && typeof parsed.id === 'string'
        && Array.isArray(parsed.libraries)
        && typeof parsed.mainClass === 'string'
}

/**
 * 실제 Forge 인스톨러(또는 NeoNebula)가 만든 원본 version.json을 붙여넣었을 때 쓴다.
 * 기존 ForgeHosted 모듈의 Library 서브모듈(jar 파일들 — processbuilder.js의
 * classpathArg가 여기서만 읽는다)은 이미 정상이므로 그대로 재사용하고,
 * VersionManifest 서브모듈(arguments.jvm 등 JVM 실행 인자 — processbuilder.js의
 * _constructJVMArguments113이 여기서만 읽는다)만 새로 올린 JSON으로 교체한다.
 * OptiFine처럼 module-path/add-opens 같은 정확한 실행 인자에 민감한 모드 때문에
 * distro-ci가 재구성한 version.json 대신 원본을 그대로 써야 할 때 쓴다.
 */
function buildForgeModulesFromPastedVersionJson(rawText, parsed, serverFolder, assetBaseUrl) {
    const existingParent = state.existingModules
        .map(e => e.module)
        .find(m => m.type === 'ForgeHosted' || m.type === 'Forge')
    if (existingParent == null) {
        throw new Error(
            '기존 서버에 ForgeHosted/Forge 모듈이 없습니다. 이 붙여넣기는 이미 ' +
            'distro-ci 등으로 로더 라이브러리(jar)가 만들어져 있는 기존 서버의 ' +
            'version.json만 교체할 때만 쓸 수 있습니다. 새 서버는 "자동 생성" 또는 ' +
            '완전한 모듈 JSON(배열) 붙여넣기를 쓰세요.'
        )
    }

    const bytes = new TextEncoder().encode(rawText)
    const encoded = hashAndEncodeBytes(bytes)
    const versionJsonPath = `${serverFolder}/forge/${parsed.id}.json`
    const assetFiles = [{ path: versionJsonPath, bytes: encoded.bytes }]

    const versionManifestSubModule = {
        id: parsed.id,
        name: 'Minecraft Forge (version.json)',
        type: 'VersionManifest',
        artifact: { size: encoded.size, MD5: encoded.md5, url: `${assetBaseUrl}/${versionJsonPath}` }
    }

    const keptSubModules = (existingParent.subModules || [])
        .filter(sm => sm.type !== 'VersionManifest')

    const newParent = {
        ...existingParent,
        subModules: [versionManifestSubModule, ...keptSubModules]
    }

    log(`기존 ForgeHosted 모듈("${existingParent.name || existingParent.id}")의 라이브러리 ${keptSubModules.length}개는 그대로 두고, version.json만 교체합니다.`)

    return { modules: [newParent], assetFiles }
}

// ---- Deploy pipeline ----

function bumpVersion(version) {
    const parts = (version || '1.0.0').split('.')
    const last = parseInt(parts[parts.length - 1], 10)
    parts[parts.length - 1] = String(isNaN(last) ? 1 : last + 1)
    return parts.join('.')
}

async function deploy() {
    const { workerBaseUrl, uploadSecret } = currentSettings()
    if (!workerBaseUrl) {
        alert('먼저 Worker 기본 URL을 입력하고 저장하세요.')
        return
    }
    if (!uploadSecret) {
        alert('먼저 업로드 시크릿을 입력하고 저장하세요.')
        return
    }
    const serverId = $('serverId').value.trim()
    if (!serverId) {
        alert('서버 id를 입력하세요.')
        return
    }
    // R2는 버킷 하나뿐이라 서버별 저장소 구분이 필요 없다 — servers/<id>/... 경로만으로 충분.
    // 참고: "/assets"는 Cloudflare workers.dev 엣지에서 예약된 경로라 Worker에 도달하지
    // 못하고 막히므로(1042 오류) "/files"를 쓴다 — src/worker.js와 이름을 맞출 것.
    const assetBaseUrl = `${workerBaseUrl}/files`

    const replacingLoader = state.editingServerId != null && $('loaderReplaceCheck').checked
    if (replacingLoader) {
        const ok = confirm(
            `"${state.editingServerId}" 서버의 로더/라이브러리 모듈을 새로 교체합니다.\n` +
            '기존 로더 모듈은 삭제되고 아래에서 새로 만든 것으로 대체됩니다. 계속할까요?'
        )
        if (!ok) return
    }

    $('deployBtn').disabled = true
    $('deployLog').innerHTML = ''

    try {
        log('시작합니다..')

        const assetFiles = [] // { path, bytes }
        const modModules = []
        const configModules = []
        const newOnceFiles = [] // { path, url, size, MD5 } - modules[] 밖의 커스텀 필드
        const serverFolder = `servers/${serverId}`

        // 새 서버를 만들 때, 또는 기존 서버에서 "로더 교체" 체크박스를 명시적으로 켰을
        // 때만 로더 모듈을 조립한다. 그 외 기존 서버 편집 중에는 이미 있는 로더 모듈
        // (remainingExisting을 통해 유지됨)을 절대 재생성/덮어쓰지 않는다.
        // Forge·NeoForge "자동 생성"은 별도의 GitHub Actions 버튼으로 처리되므로 여기선 다루지 않는다.
        let loaderModules = []
        if (state.editingServerId == null || replacingLoader) {
            const loaderType = $('loaderType').value
            const mcVersion = $('serverMcVersion').value.trim()
            if (loaderType === 'fabric') {
                const fabricLoaderVersion = $('fabricLoaderVersion').value
                if (!fabricLoaderVersion) {
                    throw new Error('Fabric 로더 버전을 선택하세요.')
                }
                const built = await buildFabricModules(mcVersion, fabricLoaderVersion, serverFolder, assetBaseUrl)
                loaderModules = built.modules
                assetFiles.push(...built.assetFiles)
            } else if (loaderType === 'forge-paste') {
                const raw = $('importedLoaderJson').value.trim()
                if (raw) {
                    const parsed = JSON.parse(raw)
                    if (looksLikeRawForgeVersionJson(parsed)) {
                        // Forge 인스톨러(또는 NeoNebula)가 만든 원본 version.json
                        // (Mojang 스키마) — 기존 라이브러리 모듈을 재사용하고
                        // VersionManifest 서브모듈만 교체한다.
                        const built = buildForgeModulesFromPastedVersionJson(raw, parsed, serverFolder, assetBaseUrl)
                        loaderModules = built.modules
                        assetFiles.push(...built.assetFiles)
                    } else {
                        // 이미 Helios 모듈 스키마(type/artifact)로 되어있는 JSON.
                        loaderModules = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.modules) ? parsed.modules : [parsed])
                        for (const m of loaderModules) {
                            if (m.type == null || m.artifact == null) {
                                throw new Error('붙여넣은 JSON에 type/artifact가 없는 항목이 있습니다.')
                            }
                        }
                    }
                }
            }
        }

        for (const mod of state.newMods) {
            log(`해시 계산 중: ${mod.file.name}`)
            const { size, md5: hash, bytes } = await hashAndEncode(mod.file)
            const path = `${serverFolder}/mods/${mod.file.name}`
            assetFiles.push({ path, bytes })
            modModules.push({
                id: `generated.${mod.type.toLowerCase()}:${sanitizeMavenPart(mod.name)}:1.0.0@jar`,
                name: mod.name,
                type: mod.type,
                required: { value: mod.required, def: mod.required },
                artifact: { size, MD5: hash, url: `${assetBaseUrl}/${path}` }
            })
        }

        for (const cfg of state.newConfigs) {
            log(`해시 계산 중: ${cfg.file.name}`)
            const { size, md5: hash, bytes } = await hashAndEncode(cfg.file)
            const path = `${serverFolder}/files/${cfg.path}`
            assetFiles.push({ path, bytes })
            if (cfg.forceEveryLaunch) {
                configModules.push({
                    id: cfg.file.name,
                    name: cfg.file.name,
                    type: 'File',
                    artifact: { size, MD5: hash, url: `${assetBaseUrl}/${path}`, path: cfg.path }
                })
            } else {
                // 최초 1회만: modules[]가 아니라 onceFiles[]에 넣어서 FullRepair가
                // 존재 자체를 모르게 한다 (landing.js의 ensureOnceFiles가 처리).
                newOnceFiles.push({ path: cfg.path, url: `${assetBaseUrl}/${path}`, size, MD5: hash })
            }
        }

        let backgroundUrl = $('backgroundCurrentUrl').value.trim() || undefined
        if (state.backgroundFile != null) {
            log(`배경화면 업로드 준비: ${state.backgroundFile.name}`)
            const { bytes } = await hashAndEncode(state.backgroundFile)
            const ext = state.backgroundFile.name.split('.').pop() || 'png'
            const path = `${serverFolder}/background.${ext}`
            assetFiles.push({ path, bytes })
            backgroundUrl = `${assetBaseUrl}/${path}`
        }

        let iconUrl = $('iconCurrentUrl').value.trim() || undefined
        if (state.iconFile != null) {
            log(`아이콘 업로드 준비: ${state.iconFile.name}`)
            const { bytes } = await hashAndEncode(state.iconFile)
            const ext = state.iconFile.name.split('.').pop() || 'png'
            const path = `${serverFolder}/icon.${ext}`
            assetFiles.push({ path, bytes })
            iconUrl = `${assetBaseUrl}/${path}`
        }

        // 자산 업로드를 distribution.json 갱신보다 먼저 수행한다.
        // (실패 안전성: 자산이 존재하지 않는 채로 distribution.json이 먼저 배포되어
        //  실사용자의 런처가 깨지는 상황을 피하기 위함)
        if (assetFiles.length > 0) {
            log(`Worker에 파일 ${assetFiles.length}개 업로드 중..`)
            await WorkerAPI.uploadFilesSequential(
                workerBaseUrl, uploadSecret, assetFiles,
                (done, total) => log(`  업로드 ${done}/${total}`),
                (path, part, totalParts) => log(`    (멀티파트) ${path}: 조각 ${part}/${totalParts}`)
            )
            log('자산 업로드 완료.')
        } else {
            log('새로 추가된 자산 파일 없음, 건너뜀.')
        }

        log('distribution.json 다시 불러오는 중.. (동시 편집 충돌 방지)')
        const { distribution, etag } = await fetchDistribution()
        distribution.servers = distribution.servers || []

        const manualJava = $('javaOptionsManual').checked
        const javaOptions = manualJava
            ? { supported: $('javaSupported').value.trim(), suggestedMajor: parseInt($('javaSuggestedMajor').value, 10) }
            : undefined // 비워두면 런처가 JAVA_VERSION_TABLE로 자동 판단

        // 새 모드 업로드에서 "대체" 지정한 기존 모듈은 체크박스로 지운 것과 동일하게 제외.
        const replacedIdxs = new Set(state.newMods.map(m => m.replacesModuleIdx).filter(i => i != null))
        const remainingExisting = state.existingModules
            .filter((e, i) => !e.remove && !replacedIdxs.has(i))
            // 로더 교체 중이면 기존 로더 소유 모듈(Fabric/Forge/Library 등)은 위에서
            // 새로 만든 loaderModules로 완전히 대체한다 — 중복 방지.
            .filter(e => !(replacingLoader && LOADER_OWNED_TYPES.has(e.module.type)))
            .map(e => e.module)
        const modules = [...loaderModules, ...remainingExisting, ...modModules, ...configModules]

        const existingServer = distribution.servers.find(s => s.id === serverId)

        // 같은 path는 새 걸로 교체(중복 방지), 체크박스로 지운 것은 제외, 나머지 기존 onceFiles는 유지.
        const removedOnceFilePaths = new Set(
            state.existingOnceFiles.filter(e => e.remove).map(e => e.entry.path)
        )
        const mergedOnceFiles = [
            ...(existingServer && Array.isArray(existingServer.onceFiles)
                ? existingServer.onceFiles.filter(e => !newOnceFiles.some(n => n.path === e.path) && !removedOnceFilePaths.has(e.path))
                : []),
            ...newOnceFiles
        ]

        const serverObj = Object.assign({}, existingServer, {
            id: serverId,
            name: $('serverName').value.trim(),
            description: $('serverDescription').value.trim(),
            icon: iconUrl,
            version: bumpVersion(existingServer ? existingServer.version : '1.0.0'),
            address: $('serverAddress').value.trim(),
            minecraftVersion: $('serverMcVersion').value.trim(),
            autoconnect: $('serverAutoconnect').checked,
            mainServer: $('serverMainServer').checked || undefined,
            modules,
            // whitelist는 여기서 절대 건드리지 않는다 — whitelist.html의 위임 키로만 편집되며,
            // existingServer에서 그대로 spread되어 유지된다. 여기서 값을 설정하면(빈 배열이든
            // undefined든) 위임 키로 설정해둔 화이트리스트가 배포할 때마다 덮어써진다.
            background: backgroundUrl,
            onceFiles: mergedOnceFiles.length > 0 ? mergedOnceFiles : undefined
        })
        if (manualJava) {
            serverObj.javaOptions = javaOptions
        } else {
            delete serverObj.javaOptions
        }

        const idx = distribution.servers.findIndex(s => s.id === serverId)
        if (idx >= 0) distribution.servers[idx] = serverObj
        else distribution.servers.push(serverObj)
        distribution.version = bumpVersion(distribution.version)

        log('distribution.json 업로드 중..')
        await WorkerAPI.putDistribution(workerBaseUrl, uploadSecret, distribution, etag)

        log('완료! distribution.json과 자산이 배포되었습니다.')
        log(`${workerBaseUrl}/distribution.json`)

        state.newMods = []
        state.newConfigs = []
        state.backgroundFile = null
        state.iconFile = null
        renderNewMods()
        renderNewConfigs()
        await refreshServerPicker()
    } catch (err) {
        console.error(err)
        log(`오류 발생: ${err.message}`)
        if (err.status === 412) {
            log('distribution.json이 그 사이 다른 곳에서 변경된 것 같습니다. 다시 시도해주세요.')
        }
    } finally {
        $('deployBtn').disabled = false
    }
}

/**
 * "선택한 서버 삭제" 버튼 핸들러. distribution.json의 servers[] 배열에서 해당
 * 서버 항목만 제거하고 다시 업로드한다. R2에 이미 올라간 해당 서버의 파일들
 * (servers/<id>/... 하위 jar/설정 등)은 지우지 않는다 — worker에 삭제 API가
 * 없고, distribution.json에서만 빠지면 런처가 더 이상 참조하지 않으므로 굳이
 * 지울 필요가 없다(용량이 아깝다면 R2 대시보드에서 수동으로 정리).
 */
async function deleteSelectedServer() {
    const { workerBaseUrl, uploadSecret } = currentSettings()
    if (!workerBaseUrl) {
        alert('먼저 Worker 기본 URL을 입력하고 저장하세요.')
        return
    }
    if (!uploadSecret) {
        alert('먼저 업로드 시크릿을 입력하고 저장하세요.')
        return
    }
    const serverId = $('existingServerSelect').value
    if (!serverId) {
        alert('삭제할 서버를 먼저 선택하세요.')
        return
    }
    const ok = confirm(`"${serverId}" 서버를 distribution.json에서 완전히 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)
    if (!ok) return

    $('deleteServerBtn').disabled = true
    $('serverLoadStatus').textContent = '삭제하는 중..'
    try {
        const { distribution, etag } = await fetchDistribution()
        distribution.servers = distribution.servers || []
        const idx = distribution.servers.findIndex(s => s.id === serverId)
        if (idx === -1) {
            throw new Error('그 사이 distribution.json에서 이미 삭제된 것 같습니다.')
        }
        distribution.servers.splice(idx, 1)
        distribution.version = bumpVersion(distribution.version)

        await WorkerAPI.putDistribution(workerBaseUrl, uploadSecret, distribution, etag)

        $('serverLoadStatus').textContent = `"${serverId}" 서버를 삭제했습니다.`
        resetFormForNewServer()
        await refreshServerPicker()
    } catch (err) {
        console.error(err)
        $('serverLoadStatus').textContent = `삭제 실패: ${err.message}`
        if (err.status === 412) {
            $('serverLoadStatus').textContent += ' (distribution.json이 그 사이 변경됨 — 새로고침 후 다시 시도하세요)'
        }
    } finally {
        $('deleteServerBtn').disabled = !$('existingServerSelect').value
    }
}

// ---- Wire up ----

document.addEventListener('DOMContentLoaded', () => {
    initSettingsUI()

    $('existingServerSelect').addEventListener('change', e => {
        $('deleteServerBtn').disabled = !e.target.value
        if (e.target.value) loadServerIntoForm(e.target.value)
        else resetFormForNewServer()
    })
    $('loadServerBtn').addEventListener('click', refreshServerPicker)
    $('deleteServerBtn').addEventListener('click', deleteSelectedServer)

    $('serverMcVersion').addEventListener('input', updateJavaPreview)
    $('javaOptionsManual').addEventListener('change', updateJavaPreview)
    updateJavaPreview()

    $('loaderType').addEventListener('change', updateLoaderTypeBlocks)
    updateLoaderTypeBlocks()
    $('serverMcVersion').addEventListener('change', refreshFabricLoaderVersions)
    $('loaderReplaceCheck').addEventListener('change', e => {
        $('loaderTypeFields').style.display = e.target.checked ? '' : 'none'
    })

    setupDropzone('modsDropzone', 'modsFileInput', addModFiles)
    setupFolderAwareDropzone('configsDropzone', 'configsFileInput', 'configsFolderInput', 'configsFolderBtn',
        entries => addConfigEntries(entries, 'config'),
        skipped => showDropSkippedWarning('configsDropWarning', skipped))
    setupFolderAwareDropzone('rootFilesDropzone', 'rootFilesFileInput', 'rootFilesFolderInput', 'rootFilesFolderBtn',
        entries => addConfigEntries(entries, 'root'),
        skipped => showDropSkippedWarning('rootFilesDropWarning', skipped))
    setupDropzone('backgroundDropzone', 'backgroundFileInput', addBackgroundFile)
    setupDropzone('iconDropzone', 'iconFileInput', addIconFile)

    $('deployBtn').addEventListener('click', deploy)
    $('generateLoaderBtn').addEventListener('click', startForgeLoaderGeneration)

    $('wlKeyCreateBtn').addEventListener('click', createWlKey)
    $('wlKeyListRefreshBtn').addEventListener('click', refreshWlKeyList)

    resetFormForNewServer()
    if (currentSettings().workerBaseUrl) {
        refreshServerPicker()
    }
})
