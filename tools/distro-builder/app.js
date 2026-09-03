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
const MAX_SAFE_UPLOAD_BYTES = 90 * 1024 * 1024

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
    newMods: [],          // [{ file, name, type, required }]
    newConfigs: [],       // [{ file, path }]
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
    } catch (err) {
        console.error(err)
        $('serverLoadStatus').textContent = `불러오기 실패: ${err.message}`
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
    const assetRepo = $('forgeCiAssetRepo').value.trim()
    if (!serverId || !mcVersion || !loaderVersion || !assetRepo) {
        alert('서버 id, GitHub 자산 저장소, 마인크래프트 버전, 로더 버전을 모두 입력하세요.')
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
            serverId, mcVersion, loaderType, loaderVersion, assetRepo
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
    ;['serverId', 'serverName', 'serverDescription', 'serverAddress', 'serverMcVersion', 'forgeCiAssetRepo'].forEach(id => { $(id).value = '' })
    $('serverId').disabled = false
    $('serverAutoconnect').checked = false
    $('serverMainServer').checked = false
    $('whitelistTextarea').value = ''
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

    $('serverId').value = serv.id
    // 기존 서버의 id는 여기서 바꾸지 않는다 — 바뀌면 런처의 선택 서버/자바 경로 저장 키가 끊어짐.
    $('serverId').disabled = true
    $('serverName').value = serv.name || ''
    $('serverDescription').value = serv.description || ''
    // Forge/NeoForge 자동 생성(GitHub Actions) 전용 필드라 서버를 바꿀 때마다 비워서
    // 다른 서버의 자산 저장소 이름이 실수로 남아있지 않게 한다 — 그 기능을 쓸 때만 입력.
    $('forgeCiAssetRepo').value = ''
    $('serverAddress').value = serv.address || ''
    $('serverMcVersion').value = serv.minecraftVersion || ''
    $('serverAutoconnect').checked = !!serv.autoconnect
    $('serverMainServer').checked = !!serv.mainServer
    $('whitelistTextarea').value = (serv.whitelist || []).join('\n')
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
    if (state.existingModules.length === 0) {
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
    $('modsWarning').textContent = state.newMods.some(m => m.file.size > MAX_SAFE_UPLOAD_BYTES)
        ? '90MB가 넘는 파일이 있습니다. Cloudflare Workers 요청 본문 한도(요금제에 따라 100MB 내외)를 초과해 실패할 수 있습니다.'
        : ''
}

function addConfigFiles(files) {
    for (const file of files) {
        state.newConfigs.push({ file, path: `config/${file.name}`, forceEveryLaunch: false })
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
                    loaderModules = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.modules) ? parsed.modules : [parsed])
                    for (const m of loaderModules) {
                        if (m.type == null || m.artifact == null) {
                            throw new Error('붙여넣은 JSON에 type/artifact가 없는 항목이 있습니다.')
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
                (done, total) => log(`  업로드 ${done}/${total}`)
            )
            log('자산 업로드 완료.')
        } else {
            log('새로 추가된 자산 파일 없음, 건너뜀.')
        }

        log('distribution.json 다시 불러오는 중.. (동시 편집 충돌 방지)')
        const { distribution, etag } = await fetchDistribution()
        distribution.servers = distribution.servers || []

        const whitelist = $('whitelistTextarea').value
            .split('\n').map(s => s.trim()).filter(s => s.length > 0)

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

        // 같은 path는 새 걸로 교체(중복 방지), 나머지 기존 onceFiles는 유지.
        const mergedOnceFiles = [
            ...(existingServer && Array.isArray(existingServer.onceFiles)
                ? existingServer.onceFiles.filter(e => !newOnceFiles.some(n => n.path === e.path))
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
            whitelist: whitelist.length > 0 ? whitelist : undefined,
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

    $('loaderType').addEventListener('change', updateLoaderTypeBlocks)
    updateLoaderTypeBlocks()
    $('serverMcVersion').addEventListener('change', refreshFabricLoaderVersions)
    $('loaderReplaceCheck').addEventListener('change', e => {
        $('loaderTypeFields').style.display = e.target.checked ? '' : 'none'
    })

    setupDropzone('modsDropzone', 'modsFileInput', addModFiles)
    setupDropzone('configsDropzone', 'configsFileInput', addConfigFiles)
    setupDropzone('backgroundDropzone', 'backgroundFileInput', addBackgroundFile)
    setupDropzone('iconDropzone', 'iconFileInput', addIconFile)

    $('deployBtn').addEventListener('click', deploy)
    $('generateLoaderBtn').addEventListener('click', startForgeLoaderGeneration)

    resetFormForNewServer()
    if (currentSettings().workerBaseUrl) {
        refreshServerPicker()
    }
})
