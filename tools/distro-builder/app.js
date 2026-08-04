'use strict'
/* global GitHubAPI, md5 */

// ---- 고정 기본값 (설정 패널에서 덮어쓸 수 있음, README 참고) ----
const DEFAULTS = {
    owner: 'hanol0927',
    distroRepo: 'ddumon',
    assetRepo: 'hanol0927.github.io',
    branch: 'main'
}

// distribution.json에 javaOptions가 없을 때 쓰는 기본값과 동일한 테이블.
// app/assets/js/scripts/landing.js의 JAVA_VERSION_TABLE과 값을 맞출 것.
const JAVA_VERSION_TABLE = [
    { minMcVersion: '26.0',   supported: '>=25.x', suggestedMajor: 25 },
    { minMcVersion: '1.20.5', supported: '>=21.x', suggestedMajor: 21 },
    { minMcVersion: '1.17',   supported: '>=17.x', suggestedMajor: 17 },
    { minMcVersion: '0',      supported: '8.x',    suggestedMajor: 8 }
]

const MODULE_TYPES = ['ForgeMod', 'FabricMod', 'LiteMod', 'Library', 'File']
const MAX_SAFE_UPLOAD_BYTES = 25 * 1024 * 1024

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

function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''
}

function setToken(token, persist) {
    sessionStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TOKEN_KEY)
    if (token) {
        (persist ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
    }
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
    distributionSha: null,
    editingServerId: null,
    existingModules: [], // [{ module, remove }]
    newMods: [],          // [{ file, name, type, required }]
    newConfigs: [],       // [{ file, path }]
    backgroundFile: null
}

function currentSettings() {
    return {
        owner: $('ghOwner').value.trim() || DEFAULTS.owner,
        distroRepo: $('ghDistroRepo').value.trim() || DEFAULTS.distroRepo,
        assetRepo: $('ghAssetRepo').value.trim() || DEFAULTS.assetRepo,
        branch: $('ghBranch').value.trim() || DEFAULTS.branch,
        assetBaseUrl: $('assetBaseUrl').value.trim().replace(/\/$/, '')
    }
}

function initSettingsUI() {
    const saved = loadSettings()
    $('ghOwner').value = saved.owner || DEFAULTS.owner
    $('ghDistroRepo').value = saved.distroRepo || DEFAULTS.distroRepo
    $('ghAssetRepo').value = saved.assetRepo || DEFAULTS.assetRepo
    $('ghBranch').value = saved.branch || DEFAULTS.branch
    $('assetBaseUrl').value = saved.assetBaseUrl || `https://${saved.owner || DEFAULTS.owner}.github.io`
    $('ghToken').value = getToken()
    $('ghTokenPersist').checked = !!localStorage.getItem(TOKEN_KEY)

    $('ghOwner').addEventListener('change', () => {
        if (!$('assetBaseUrl').dataset.userEdited) {
            $('assetBaseUrl').value = `https://${$('ghOwner').value.trim() || DEFAULTS.owner}.github.io`
        }
    })
    $('assetBaseUrl').addEventListener('input', () => {
        $('assetBaseUrl').dataset.userEdited = 'true'
    })

    $('saveSettingsBtn').addEventListener('click', () => {
        saveSettingsToStorage(currentSettings())
        setToken($('ghToken').value.trim(), $('ghTokenPersist').checked)
        $('settingsStatus').textContent = '저장됨'
        setTimeout(() => { $('settingsStatus').textContent = '' }, 2000)
    })
}

// ---- Existing distribution.json ----

async function fetchDistribution() {
    const { owner, distroRepo, branch } = currentSettings()
    const token = getToken()
    if (!token) throw new Error('먼저 GitHub 토큰을 입력하고 저장하세요.')
    const file = await GitHubAPI.getFile(token, owner, distroRepo, 'distribution.json', branch)
    if (file == null) {
        return { distribution: { version: '1.0.0', servers: [] }, sha: null }
    }
    return { distribution: JSON.parse(file.content), sha: file.sha }
}

async function refreshServerPicker() {
    $('serverLoadStatus').textContent = '불러오는 중..'
    try {
        const { distribution, sha } = await fetchDistribution()
        distribution.servers = distribution.servers || []
        state.distribution = distribution
        state.distributionSha = sha
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
    } catch (err) {
        console.error(err)
        $('serverLoadStatus').textContent = `불러오기 실패: ${err.message}`
    }
}

function resetFormForNewServer() {
    state.editingServerId = null
    state.existingModules = []
    ;['serverId', 'serverName', 'serverDescription', 'serverIcon', 'serverAddress', 'serverMcVersion'].forEach(id => { $(id).value = '' })
    $('serverId').disabled = false
    $('serverAutoconnect').checked = false
    $('serverMainServer').checked = false
    $('whitelistTextarea').value = ''
    $('backgroundCurrentUrl').value = ''
    $('backgroundPreview').style.display = 'none'
    $('javaOptionsManual').checked = false
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

    $('serverId').value = serv.id
    // 기존 서버의 id는 여기서 바꾸지 않는다 — 바뀌면 런처의 선택 서버/자바 경로 저장 키가 끊어짐.
    $('serverId').disabled = true
    $('serverName').value = serv.name || ''
    $('serverDescription').value = serv.description || ''
    $('serverIcon').value = serv.icon || ''
    $('serverAddress').value = serv.address || ''
    $('serverMcVersion').value = serv.minecraftVersion || ''
    $('serverAutoconnect').checked = !!serv.autoconnect
    $('serverMainServer').checked = !!serv.mainServer
    $('whitelistTextarea').value = (serv.whitelist || []).join('\n')
    $('backgroundCurrentUrl').value = serv.background || ''
    if (serv.background) {
        $('backgroundPreview').src = serv.background
        $('backgroundPreview').style.display = ''
    } else {
        $('backgroundPreview').style.display = 'none'
    }

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
    if (state.existingModules.length === 0) {
        container.innerHTML = '<p class="hint">기존 모듈 없음</p>'
        return
    }
    state.existingModules.forEach((entry, idx) => {
        const row = document.createElement('label')
        row.className = 'moduleRow'
        row.innerHTML = `
            <input type="checkbox" ${entry.remove ? 'checked' : ''}>
            <span class="moduleType">${entry.module.type}</span>
            <span class="moduleName">${entry.module.name || entry.module.id}</span>
        `
        row.querySelector('input').addEventListener('change', e => {
            state.existingModules[idx].remove = e.target.checked
        })
        container.appendChild(row)
    })
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

function addModFiles(files) {
    for (const file of files) {
        state.newMods.push({ file, name: file.name, type: 'ForgeMod', required: true })
    }
    renderNewMods()
}

function renderNewMods() {
    const container = $('modsList')
    container.innerHTML = ''
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
            <button type="button" class="removeBtn">삭제</button>
        `
        row.querySelector('.modTypeSelect').addEventListener('change', e => { state.newMods[idx].type = e.target.value })
        row.querySelector('.modRequiredCheck').addEventListener('change', e => { state.newMods[idx].required = e.target.checked })
        row.querySelector('.removeBtn').addEventListener('click', () => { state.newMods.splice(idx, 1); renderNewMods() })
        container.appendChild(row)
    })
    $('modsWarning').textContent = state.newMods.some(m => m.file.size > MAX_SAFE_UPLOAD_BYTES)
        ? '25MB가 넘는 파일이 있습니다. GitHub API 업로드 한도(약 25~30MB)를 초과해 실패할 수 있습니다.'
        : ''
}

function addConfigFiles(files) {
    for (const file of files) {
        state.newConfigs.push({ file, path: `config/${file.name}` })
    }
    renderNewConfigs()
}

function renderNewConfigs() {
    const container = $('configsList')
    container.innerHTML = ''
    state.newConfigs.forEach((entry, idx) => {
        const row = document.createElement('div')
        row.className = 'fileRow'
        row.innerHTML = `
            <span class="fileName">${entry.file.name}</span>
            <span class="fileSize">${formatBytes(entry.file.size)}</span>
            <input type="text" class="configPathInput" value="${entry.path}">
            <button type="button" class="removeBtn">삭제</button>
        `
        row.querySelector('.configPathInput').addEventListener('input', e => { state.newConfigs[idx].path = e.target.value })
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

function bytesToBase64(bytes) {
    const CHUNK = 8192
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}

async function hashAndEncode(file) {
    const bytes = await readFileAsBytes(file)
    return {
        size: bytes.length,
        md5: md5.hexFromBytes(bytes),
        base64: bytesToBase64(bytes)
    }
}

// ---- Deploy pipeline ----

function bumpVersion(version) {
    const parts = (version || '1.0.0').split('.')
    const last = parseInt(parts[parts.length - 1], 10)
    parts[parts.length - 1] = String(isNaN(last) ? 1 : last + 1)
    return parts.join('.')
}

async function deploy() {
    const token = getToken()
    if (!token) {
        alert('먼저 GitHub 토큰을 입력하고 저장하세요.')
        return
    }
    const { owner, distroRepo, assetRepo, branch, assetBaseUrl } = currentSettings()
    const serverId = $('serverId').value.trim()
    if (!serverId) {
        alert('서버 id를 입력하세요.')
        return
    }

    $('deployBtn').disabled = true
    $('deployLog').innerHTML = ''

    try {
        log('시작합니다..')

        const assetFiles = [] // { path, base64Content }
        const modModules = []
        const configModules = []
        const serverFolder = `${serverId}/servers/${serverId}`

        for (const mod of state.newMods) {
            log(`해시 계산 중: ${mod.file.name}`)
            const { size, md5: hash, base64 } = await hashAndEncode(mod.file)
            const path = `${serverFolder}/mods/${mod.file.name}`
            assetFiles.push({ path, base64Content: base64 })
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
            const { size, md5: hash, base64 } = await hashAndEncode(cfg.file)
            const path = `${serverFolder}/files/${cfg.path}`
            assetFiles.push({ path, base64Content: base64 })
            configModules.push({
                id: cfg.file.name,
                name: cfg.file.name,
                type: 'File',
                artifact: { size, MD5: hash, url: `${assetBaseUrl}/${path}`, path: cfg.path }
            })
        }

        let backgroundUrl = $('backgroundCurrentUrl').value.trim() || undefined
        if (state.backgroundFile != null) {
            log(`배경화면 업로드 준비: ${state.backgroundFile.name}`)
            const { base64 } = await hashAndEncode(state.backgroundFile)
            const ext = state.backgroundFile.name.split('.').pop() || 'png'
            const path = `${serverFolder}/background.${ext}`
            assetFiles.push({ path, base64Content: base64 })
            backgroundUrl = `${assetBaseUrl}/${path}`
        }

        // 자산 커밋을 distribution.json 갱신보다 먼저 수행한다.
        // (실패 안전성: 자산이 존재하지 않는 채로 distribution.json이 먼저 배포되어
        //  실사용자의 런처가 깨지는 상황을 피하기 위함)
        if (assetFiles.length > 0) {
            log(`자산 저장소(${assetRepo})에 파일 ${assetFiles.length}개 커밋 중..`)
            await GitHubAPI.commitFilesBatch(
                token, owner, assetRepo, branch, assetFiles,
                `distro-builder: update assets for ${serverId}`,
                (done, total) => log(`  blob 업로드 ${done}/${total}`)
            )
            log('자산 커밋 완료.')
        } else {
            log('새로 추가된 자산 파일 없음, 건너뜀.')
        }

        log('distribution.json 다시 불러오는 중.. (동시 편집 충돌 방지)')
        const { distribution, sha } = await fetchDistribution()
        distribution.servers = distribution.servers || []

        const whitelist = $('whitelistTextarea').value
            .split('\n').map(s => s.trim()).filter(s => s.length > 0)

        const manualJava = $('javaOptionsManual').checked
        const javaOptions = manualJava
            ? { supported: $('javaSupported').value.trim(), suggestedMajor: parseInt($('javaSuggestedMajor').value, 10) }
            : undefined // 비워두면 런처가 JAVA_VERSION_TABLE로 자동 판단

        const remainingExisting = state.existingModules.filter(e => !e.remove).map(e => e.module)
        const modules = [...remainingExisting, ...modModules, ...configModules]

        const existingServer = distribution.servers.find(s => s.id === serverId)

        const serverObj = Object.assign({}, existingServer, {
            id: serverId,
            name: $('serverName').value.trim(),
            description: $('serverDescription').value.trim(),
            icon: $('serverIcon').value.trim(),
            version: bumpVersion(existingServer ? existingServer.version : '1.0.0'),
            address: $('serverAddress').value.trim(),
            minecraftVersion: $('serverMcVersion').value.trim(),
            autoconnect: $('serverAutoconnect').checked,
            mainServer: $('serverMainServer').checked || undefined,
            modules,
            whitelist: whitelist.length > 0 ? whitelist : undefined,
            background: backgroundUrl
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

        log('distribution.json 커밋 중..')
        await GitHubAPI.putFile(
            token, owner, distroRepo, 'distribution.json',
            JSON.stringify(distribution, null, 2),
            `distro-builder: update ${serverId}`,
            sha, branch
        )

        log('완료! distribution.json과 자산이 배포되었습니다.')
        log(`https://raw.githubusercontent.com/${owner}/${distroRepo}/${branch}/distribution.json`)

        state.newMods = []
        state.newConfigs = []
        state.backgroundFile = null
        renderNewMods()
        renderNewConfigs()
        await refreshServerPicker()
    } catch (err) {
        console.error(err)
        log(`오류 발생: ${err.message}`)
        if (err.status === 409) {
            log('distribution.json이 그 사이 다른 곳에서 변경된 것 같습니다. 다시 시도해주세요.')
        }
    } finally {
        $('deployBtn').disabled = false
    }
}

// ---- Wire up ----

document.addEventListener('DOMContentLoaded', () => {
    initSettingsUI()

    $('existingServerSelect').addEventListener('change', e => {
        if (e.target.value) loadServerIntoForm(e.target.value)
        else resetFormForNewServer()
    })
    $('loadServerBtn').addEventListener('click', refreshServerPicker)

    $('serverMcVersion').addEventListener('input', updateJavaPreview)
    $('javaOptionsManual').addEventListener('change', updateJavaPreview)
    updateJavaPreview()

    setupDropzone('modsDropzone', 'modsFileInput', addModFiles)
    setupDropzone('configsDropzone', 'configsFileInput', addConfigFiles)

    $('backgroundFileInput').addEventListener('change', e => {
        const file = e.target.files[0]
        if (file == null) return
        state.backgroundFile = file
        $('backgroundPreview').src = URL.createObjectURL(file)
        $('backgroundPreview').style.display = ''
        e.target.value = ''
    })

    $('deployBtn').addEventListener('click', deploy)

    resetFormForNewServer()
    if (getToken()) {
        refreshServerPicker()
    }
})
