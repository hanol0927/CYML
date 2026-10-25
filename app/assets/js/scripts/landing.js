/**
 * Script for landing.ejs
 *
 * UI 리뉴얼 버전.
 *  - 기존 Helios/CYML 기능(실행, Java 탐색/다운로드, 파일 검증, 화이트리스트, onceFiles,
 *    서버별 배경, 서버/모장 상태, 뉴스 RSS, Discord RPC)은 그대로 유지한다.
 *  - 추가: 히어로 카드, 홈 서버 목록(서버별 핑), 뉴스 미리보기, 빠른 설정,
 *    서버별 액센트 컬러(배경 이미지에서 자동 추출 / distribution.json의 accent 필드).
 */
// Requirements
const { URL }                 = require('url')
// path는 uibinder.js가 이미 전역으로 선언함 (둘 다 같은 페이지에 <script>로 로드되어
// 전역 스코프를 공유함) — 여기서 다시 선언하면 'Identifier already declared'로 깨짐.
const fs                      = require('fs-extra')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile,
    mcVersionAtLeast
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ImageCache              = require('./assets/js/imagecache')
const ProcessBuilder          = require('./assets/js/processbuilder')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const server_selection_value  = document.getElementById('server_selection_value')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')

// distribution.json에 javaOptions가 없을 때 쓰는 기본값.
// 새 마크 버전이 새 Java를 요구하면 여기에 항목을 추가.
// tools/distro-builder의 동일 테이블과 값 맞출 것.
const JAVA_VERSION_TABLE = [
    { minMcVersion: '26.0',   supported: '>=25.x', suggestedMajor: 25 },
    { minMcVersion: '1.20.5', supported: '>=21.x', suggestedMajor: 21 },
    { minMcVersion: '1.17',   supported: '>=17.x', suggestedMajor: 17 },
    { minMcVersion: '0',      supported: '8.x',    suggestedMajor: 8 }
]

/**
 * distribution.json이 javaOptions를 명시했다면 그대로 존중하고,
 * 명시하지 않았다면 마크 버전 기준으로 정확한 Java 메이저 버전을 추론한다.
 * (helios-core의 기본 매핑은 1.20.5 이상을 전부 '>=21.x'로 뭉뚱그려서,
 * 이미 Java 21이 설치돼 있으면 26.x가 요구하는 Java 25를 새로 받지 않는 문제가 있었음)
 *
 * @param {Object} server DistroAPI가 반환하는 서버 객체
 * @returns {Object} effectiveJavaOptions
 */
function resolveEffectiveJavaOptions(server) {
    if (server.rawServer.javaOptions != null) {
        return server.effectiveJavaOptions
    }
    const entry = JAVA_VERSION_TABLE.find(e => mcVersionAtLeast(e.minMcVersion, server.rawServer.minecraftVersion))
    return {
        ...server.effectiveJavaOptions,
        supported: entry.supported,
        suggestedMajor: entry.suggestedMajor
    }
}

const SERVER_BACKGROUND_MAP = {
    'Sigwal-1.20.1': 2,    // 0.png
    'Iris-1.21.10': 1,      // 1.png
    'ddumon-26.1.2': 0,
    'Cupkemon-1.16.5': 3,
    'Nuketmon-1.16.5': 4,
    'Rush-1.21.10': 5,
    'ChaQ-1.20.1': 6,
    'Ssachon-1.21.1': 7,
    'chaennawizard-1.16.5': 8,
    'haru-1.21.4': 9,
    'chaenna-1.21.1': 10
    // 여기에 서버 추가
}

/**
 * (선택) 서버별 액센트 컬러 고정값. 비워두면 배경 이미지에서 자동 추출한다.
 * 우선순위: distribution.json의 rawServer.accent > 이 맵 > 배경 자동 추출 > 기본(에메랄드)
 * 예) 'Sigwal-1.20.1': '#34e39a'
 */
const SERVER_ACCENT_MAP = {
    // 'Iris-1.21.10': '#38d6ff',
}

/**
 * 서버 ID로 배경 번호 가져오기
 * @param {string} serverId 서버 ID
 * @returns {number} 배경 번호 (기본값: 0)
 */
function getBackgroundNumber(serverId) {
    const bgNum = SERVER_BACKGROUND_MAP[serverId]
    return bgNum !== undefined ? bgNum : 0
}

/* =====================================================================
 * UI Renewal : 공통 유틸
 * ===================================================================== */

const DEFAULT_ACCENT = { h: 152, s: 72, l: 52 }

function escapeHTML(str){
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function cssUrl(u){
    return String(u).replace(/["'\\()\s]/g, encodeURIComponent)
}

function isLaunchInProgress(){
    return launch_details.style.display === 'flex'
}

function iconSVG(name, cls = '', viewBox = '0 0 24 24'){
    return `<svg class="${cls}" viewBox="${viewBox}" aria-hidden="true"><use href="#${name}"/></svg>`
}

/**
 * '#34e39a' / 'rgb(…)' / 'hsl(…)' 를 {h,s,l}로 변환. 실패하면 null.
 */
function parseColorToHSL(input){
    if(typeof input !== 'string') return null
    const probe = document.createElement('span')
    probe.style.color = ''
    probe.style.color = input.trim()
    if(!probe.style.color) return null
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()
    const m = rgb.match(/\d+(\.\d+)?/g)
    if(!m || m.length < 3) return null
    return rgbToHsl(+m[0], +m[1], +m[2])
}

const rgbToHsl = ImageCache.rgbToHsl

/**
 * (폴백용) 이미 로드된 작은 이미지에서 강조색 추출. 보통은 ImageCache가 미리 계산해 둔 값을 쓴다.
 */
function extractAccentFromImage(img){
    try {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 36
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, 64, 36)
        return ImageCache.accentFromPixels(ctx.getImageData(0, 0, 64, 36).data)
    } catch(err) {
        loggerLanding.debug('Accent extraction skipped:', err.message)
        return null
    }
}

function applyAccent(hsl){
    const a = hsl || DEFAULT_ACCENT
    const root = document.documentElement.style
    root.setProperty('--ah', String(a.h))
    root.setProperty('--as', `${Math.min(Math.max(a.s, 45), 90)}%`)
    root.setProperty('--al', `${Math.min(Math.max(a.l, 48), 64)}%`)
}

/* ---------------------------------------------------------------------
 * 배경 레이어 (app.ejs #bgLayer)
 *  - 슬롯 2개를 opacity로 교차 전환 → GPU 합성만 사용해 전환 중 렉이 없음
 *  - 이미지는 표시 전에 decode()를 끝내 두므로 바뀌는 순간 끊기지 않음
 * --------------------------------------------------------------------- */
const LAST_BG_KEY = 'cyml.lastBackground'
let bgActiveSlot = 0
let backgroundRequestId = 0
let currentBackgroundSrc = null

function paintBackground(src, accent, fixedAccent){
    if(src === currentBackgroundSrc){
        applyAccent(fixedAccent || accent)
        return
    }
    const slots = document.querySelectorAll('#bgLayer .bgSlot')
    if(slots.length === 2){
        const next = slots[1 - bgActiveSlot]
        next.style.backgroundImage = `url("${cssUrl(src)}")`
        next.classList.add('show')
        slots[bgActiveSlot].classList.remove('show')
        bgActiveSlot = 1 - bgActiveSlot
    } else {
        document.body.style.backgroundImage = `url('${src}')`
    }
    currentBackgroundSrc = src
    document.documentElement.style.setProperty('--server-bg', `url("${cssUrl(src)}")`)
    applyAccent(fixedAccent || accent)
    try {
        localStorage.setItem(LAST_BG_KEY, JSON.stringify({ src, accent: fixedAccent || accent || null }))
    } catch(err) { /* ignore */ }
}

async function decodeImage(src){
    const img = new Image()
    img.decoding = 'async'
    img.src = src
    await img.decode()
    return img
}

applyAccent(DEFAULT_ACCENT)

// 실행 직후: 지난번 배경(디스크 캐시)을 배포 정보 로딩을 기다리지 않고 바로 표시
;(function restoreLastBackground(){
    try {
        const last = JSON.parse(localStorage.getItem(LAST_BG_KEY) || 'null')
        if(last == null || typeof last.src !== 'string') return
        if(last.src.startsWith('file:') && !fs.existsSync(require('url').fileURLToPath(last.src))) return
        paintBackground(last.src, last.accent, null)
    } catch(err) { /* ignore */ }
})()

/**
 * 서버별 배경화면 변경 함수.
 * distribution.json의 rawServer.background(원격 URL)가 있으면 그걸 우선 사용하고,
 * 없으면 기존 로컬 번들 이미지(SERVER_BACKGROUND_MAP)로 폴백한다.
 * 원격 URL을 쓰면 런처를 재배포하지 않아도 재시작/재접속 시 새 배경이 반영된다.
 * (리뉴얼) ImageCache로 축소·캐시된 파일을 우선 사용하고, 히어로 배경과 강조색도 함께 갱신한다.
 * @param {Object} serv DistroAPI가 반환하는 서버 객체
 */
async function changeServerBackground(serv) {
    if (!serv) {
        loggerLanding.info('No server selected, keeping default background')
        return
    }

    const remoteBackground = serv.rawServer.background
    const backgroundPath = remoteBackground != null
        ? remoteBackground
        : `assets/images/backgrounds/${getBackgroundNumber(serv.rawServer.id)}.png`

    const requestId = ++backgroundRequestId
    const fixedAccent = parseColorToHSL(serv.rawServer.accent) || parseColorToHSL(SERVER_ACCENT_MAP[serv.rawServer.id])
    if(fixedAccent){
        applyAccent(fixedAccent)
    }

    // 1) 캐시된(축소된) 파일이 있으면 즉시 사용
    let src = null, accent = null
    if(ImageCache.isCached(backgroundPath, 'bg')){
        src = ImageCache.src(backgroundPath, 'bg')
        accent = ImageCache.accent(backgroundPath)
        ImageCache.ensure(backgroundPath, 'bg').catch(() => {}) // 원격이면 오래됐을 때 백그라운드 갱신
    } else {
        // 2) 없으면 캐시를 만든 뒤 사용 (최초 1회)
        try {
            const r = await ImageCache.ensure(backgroundPath, 'bg')
            src = r.src
            accent = r.accent
        } catch(err) {
            loggerLanding.warn(`Background cache failed: ${backgroundPath}`, err.message)
        }
    }
    if(requestId !== backgroundRequestId) return // 더 최근 선택이 있으면 무시

    // 3) 디코딩까지 끝낸 뒤 교체 (교체 순간의 끊김 방지)
    try {
        const img = await decodeImage(src || backgroundPath)
        if(requestId !== backgroundRequestId) return
        if(src == null){
            src = backgroundPath
            accent = extractAccentFromImage(img)
        }
        paintBackground(src, accent, fixedAccent)
        loggerLanding.info(`Background: ${serv.rawServer.id} -> ${src}`)
    } catch(err) {
        if(requestId !== backgroundRequestId) return
        loggerLanding.warn(`Failed to load background: ${backgroundPath}, using default`)
        // 실패하면 기본 배경으로
        paintBackground('assets/images/backgrounds/0.png', null, fixedAccent)
    }
}

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
    document.getElementById('landingContainer').toggleAttribute('launching', loading)
}

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

/**
 * 선택된 계정이 서버의 화이트리스트에 등록되어 있는지 확인한다.
 * distribution.json에 whitelist 필드가 없거나 비어있으면 전체 허용(하위호환).
 * 런처 UI 게이트일 뿐이며, 마인크래프트 서버 자체의 접속 제어는 아니다.
 *
 * @param {Object} serv DistroAPI가 반환하는 서버 객체
 * @param {Object} authUser ConfigManager.getSelectedAccount()의 반환값
 * @returns {boolean}
 */
function isAccountWhitelisted(serv, authUser){
    const whitelist = serv != null ? serv.rawServer.whitelist : null
    if(!Array.isArray(whitelist) || whitelist.length === 0){
        return true
    }
    if(authUser == null || authUser.displayName == null){
        return false
    }
    return whitelist.some(n => n.toLowerCase() === authUser.displayName.toLowerCase())
}

/**
 * 현재 선택된 서버/계정 조합을 바탕으로 실행 버튼의 활성 여부와 문구를 갱신한다.
 * 서버 선택이 바뀔 때, 계정이 바뀔 때 모두 호출되어야 한다.
 *
 * @param {Object} serv DistroAPI가 반환하는 서버 객체 (null 가능)
 * @param {Object} authUser ConfigManager.getSelectedAccount()의 반환값
 */
function refreshLaunchEligibility(serv, authUser){
    const launchButton = document.getElementById('launch_button')
    const launchText = document.getElementById('launch_button_text')
    if(serv == null){
        setLaunchEnabled(false)
        launchButton.removeAttribute('locked')
        launchText.innerHTML = Lang.queryEJS('landing.launchButton')
        return
    }
    if(isAccountWhitelisted(serv, authUser)){
        setLaunchEnabled(true)
        launchButton.removeAttribute('locked')
        launchText.innerHTML = Lang.queryEJS('landing.launchButton')
    } else {
        setLaunchEnabled(false)
        launchButton.setAttribute('locked', '')
        launchText.innerHTML = Lang.queryJS('landing.launch.notWhitelisted')
    }
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        const effectiveJavaOptions = resolveEffectiveJavaOptions(server)
        if(jExe == null){
            await asyncSystemScan(effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

/**
 * 설정 화면의 특정 탭으로 바로 이동한다.
 * @param {string} rsc settings.ejs의 탭 id (예: 'settingsTabJava')
 */
async function openSettingsTab(rsc){
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        const navItem = document.querySelector(`.settingsNavItem[rSc="${rsc}"]`)
        if(navItem != null){
            settingsNavItemListener(navItem, false)
        }
    })
}

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button. (리뉴얼: '계정 관리' 버튼)
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    const statusText = document.getElementById('userStatusText')
    const accountType = document.getElementById('userAccountType')
    const avatar = document.getElementById('avatarContainer')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            avatar.style.backgroundImage = `url('https://mc-heads.net/avatar/${authUser.uuid}/128')`
        }
        statusText.innerHTML = Lang.queryJS('landingUi.online')
        accountType.innerHTML = authUser.type === 'microsoft'
            ? Lang.queryJS('landingUi.accountMicrosoft')
            : Lang.queryJS('landingUi.accountMojang')
        document.getElementById('profileCard').removeAttribute('noaccount')
    } else {
        avatar.style.backgroundImage = ''
        statusText.innerHTML = Lang.queryJS('landingUi.offline')
        accountType.innerHTML = Lang.queryJS('landingUi.accountNone')
        document.getElementById('profileCard').setAttribute('noaccount', '')
    }
    user_text.innerHTML = username

    // 계정이 바뀌면 화이트리스트 자격도 다시 평가한다.
    DistroAPI.getDistribution().then(distro => {
        refreshLaunchEligibility(distro.getServerById(ConfigManager.getSelectedServer()), authUser)
        renderLandingServerList()
    })
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }

    const serverId = serv != null ? serv.rawServer.id : null

    ConfigManager.setSelectedServer(serverId)
    ConfigManager.save()
    server_selection_value.innerHTML = serv != null ? serv.rawServer.name : Lang.queryJS('landing.selectedServer.noSelection')
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    refreshLaunchEligibility(serv, ConfigManager.getSelectedAccount())

    // ⭐ 배경화면 변경
    if (serv) {
        changeServerBackground(serv)
    }

    // (리뉴얼) 히어로/서버 목록/빠른 설정 갱신
    renderHero(serv)
    renderLandingServerList()
    refreshQuickSettings()
    warmServerImages()
}

/**
 * 모든 서버의 아이콘·배경을 디스크 캐시에 미리 준비한다.
 * 화면이 다 뜬 뒤(약 2.5초 후) 조용히 시작해서 첫 화면 표시를 방해하지 않는다.
 */
let lastWarmAt = 0
function warmServerImages(){
    if(Date.now() - lastWarmAt < 60000) return
    lastWarmAt = Date.now()
    setTimeout(() => {
        DistroAPI.getDistribution().then(distro => {
            const items = (distro.servers || []).map(s => ({
                icon: s.rawServer.icon,
                background: s.rawServer.background != null
                    ? s.rawServer.background
                    : `assets/images/backgrounds/${getBackgroundNumber(s.rawServer.id)}.png`
            }))
            return ImageCache.warm(items)
        }).then(() => {
            renderLandingServerList() // 아이콘을 로컬 캐시 파일로 교체
        }).catch(err => loggerLanding.debug('Image warm failed', err))
    }, 2500)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_value.innerHTML = Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.currentTarget.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }

    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }

    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')
    let online = false

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max
        online = true
        if(serv != null){
            landingServerPing[serv.rawServer.id] = { online: servStat.players.online, max: servStat.players.max }
            updateServerPingCell(serv.rawServer.id)
        }

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    const wrapper = document.getElementById('server_status_wrapper')
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            wrapper.toggleAttribute('online', online)
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
        wrapper.toggleAttribute('online', online)
    }

}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 *
 * @param {boolean} launchAfter Whether we should begin to launch after scanning.
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)
        refreshQuickSettings()

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

// Keep reference to Minecraft Process
let proc
// 게임 프로세스가 살아 있는지 (자동 업데이트를 게임 종료 후로 미루는 데 사용)
let gameRunning = false
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

/**
 * distribution.json의 커스텀 필드 onceFiles(정식 modules[]가 아님, distro-builder가
 * "최초 1회만" 체크된 설정 파일을 여기 넣음)에 있는 파일을 확인한다. 로컬에 이미
 * 파일이 있으면(최초 설치 때 받은 것이든 플레이어가 직접 수정한 것이든) 절대 손대지
 * 않고, 없을 때만 받는다. FullRepair/DistributionIndexProcessor는 modules[]만 보기
 * 때문에 이 파일들의 존재 자체를 몰라서, 한 번 받힌 뒤엔 매 실행마다 해시 불일치로
 * 원본으로 덮어써지는 일이 없다.
 *
 * @param {Object} serv DistroAPI가 반환하는 서버 객체
 */
async function ensureOnceFiles(serv) {
    const onceFiles = serv.rawServer.onceFiles
    if(!Array.isArray(onceFiles) || onceFiles.length === 0) {
        return
    }
    const instanceDir = path.join(ConfigManager.getInstanceDirectory(), serv.rawServer.id)
    for(const entry of onceFiles) {
        const destPath = path.join(instanceDir, entry.path)
        if(await fs.pathExists(destPath)) {
            continue
        }
        loggerLanding.info(`최초 1회 설정 파일 다운로드: ${entry.path}`)
        try {
            await downloadFile(entry.url, destPath)
        } catch(err) {
            loggerLanding.error(`최초 1회 설정 파일 다운로드 실패: ${entry.path}`, err)
        }
    }
}

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
        if(!isAccountWhitelisted(serv, ConfigManager.getSelectedAccount())){
            loggerLanding.error('Selected account is not whitelisted for this server.')
            showLaunchFailure(Lang.queryJS('landing.launch.notWhitelistedTitle'), Lang.queryJS('landing.launch.notWhitelistedMessage'))
            return
        }
    }

    await ensureOnceFiles(serv)

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }


    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()
            gameRunning = true
            proc.on('close', () => {
                gameRunning = false
                if(typeof onGameProcessClosed === 'function'){
                    onGameProcessClosed()
                }
            })

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/* =====================================================================
 * UI Renewal : 히어로 카드
 * ===================================================================== */

/**
 * 선택된 서버 정보를 히어로 카드에 표시한다.
 * @param {Object} serv DistroAPI 서버 객체 (null 가능)
 */
function renderHero(serv){
    const titleEl = document.getElementById('heroTitle')
    const descEl = document.getElementById('heroDesc')
    const tagsEl = document.getElementById('heroTags')
    if(serv == null){
        titleEl.innerHTML = Lang.queryJS('landingUi.noServerTitle')
        descEl.innerHTML = Lang.queryJS('landingUi.noServerDesc')
        tagsEl.innerHTML = ''
        return
    }
    const raw = serv.rawServer
    titleEl.innerHTML = raw.name
    descEl.innerHTML = raw.description || ''

    const tags = []
    tags.push(`<span class="heroTag heroTagAccent">${iconSVG('i-bolt', 'tagIcon')}Minecraft ${escapeHTML(raw.minecraftVersion)}</span>`)
    if(raw.version){
        tags.push(`<span class="heroTag">v${escapeHTML(raw.version)}</span>`)
    }
    if(raw.mainServer){
        tags.push(`<span class="heroTag">${iconSVG('i-star', 'tagIcon')}${Lang.queryJS('landingUi.mainServer')}</span>`)
    }
    if(Array.isArray(raw.whitelist) && raw.whitelist.length > 0){
        tags.push(`<span class="heroTag">${iconSVG('i-lock', 'tagIcon')}${Lang.queryJS('landingUi.whitelist')}</span>`)
    }
    tagsEl.innerHTML = tags.join('')
}

/* =====================================================================
 * UI Renewal : 홈 서버 목록 (+ 서버별 접속자 핑)
 * ===================================================================== */

// id -> { online, max } | null(오프라인) | undefined(확인 전)
const landingServerPing = {}
let landingPingInFlight = false

function pingCellHTML(id){
    const p = landingServerPing[id]
    if(p === undefined){
        return `<span class="lsBars" level="0"><i></i><i></i><i></i></span><span class="lsPingText muted">${Lang.queryJS('landingUi.pinging')}</span>`
    }
    if(p === null){
        return `<span class="lsBars" level="0" offline><i></i><i></i><i></i></span><span class="lsPingText muted">${Lang.queryJS('landingUi.offline')}</span>`
    }
    const ratio = p.max > 0 ? p.online / p.max : 0
    const level = ratio >= 0.66 ? 3 : ratio >= 0.25 ? 2 : 1
    return `<span class="lsBars" level="${level}"><i></i><i></i><i></i></span><span class="lsPingText"><b>${p.online}</b>/${p.max}</span>`
}

function updateServerPingCell(id){
    const row = document.querySelector(`#landingServerList .lsRow[servid="${CSS.escape(id)}"] .lsPing`)
    if(row != null){
        row.innerHTML = pingCellHTML(id)
    }
}

async function renderLandingServerList(){
    const listEl = document.getElementById('landingServerList')
    if(listEl == null) return
    let distro
    try {
        distro = await DistroAPI.getDistribution()
    } catch(err) {
        return
    }
    if(distro == null) return

    const selected = ConfigManager.getSelectedServer()
    const authUser = ConfigManager.getSelectedAccount()
    const servers = distro.servers || []
    document.getElementById('serverListCount').innerHTML = servers.length

    if(servers.length === 0){
        listEl.innerHTML = `<div class="emptyState">${iconSVG('i-server', 'emptyIcon')}<span>${Lang.queryJS('landingUi.noServers')}</span></div>`
        return
    }

    listEl.innerHTML = servers.map(serv => {
        const raw = serv.rawServer
        const eligible = isAccountWhitelisted(serv, authUser)
        const isSel = raw.id === selected
        const btnLabel = !eligible
            ? `${iconSVG('i-lock', 'lsBtnIcon')}${Lang.queryJS('landingUi.locked')}`
            : isSel ? `${iconSVG('i-check-circle', 'lsBtnIcon')}${Lang.queryJS('landingUi.selected')}` : Lang.queryJS('landingUi.select')
        return `<div class="lsRow" servid="${escapeHTML(raw.id)}" ${isSel ? 'selected' : ''} ${eligible ? '' : 'disabled'} tabindex="0">
            <div class="lsThumb">
                ${raw.icon ? `<img class="lsThumbImg" src="${escapeHTML(ImageCache.src(raw.icon, 'icon'))}" decoding="async" draggable="false"/>` : ''}
                <svg class="lsThumbFallback" viewBox="0 0 64 64"><use href="#i-logo"/></svg>
            </div>
            <div class="lsInfo">
                <div class="lsNameRow">
                    <span class="lsName">${raw.name}</span>
                    ${raw.mainServer ? `<span class="lsStar" title="${Lang.queryJS('settings.serverListing.mainServer')}">${iconSVG('i-star', '')}</span>` : ''}
                </div>
                <span class="lsDesc">${raw.description || ''}</span>
                <div class="lsTags">
                    <span class="lsTag">${escapeHTML(raw.minecraftVersion)}</span>
                    ${raw.version ? `<span class="lsTag dim">v${escapeHTML(raw.version)}</span>` : ''}
                    ${eligible ? '' : `<span class="lsTag danger">${Lang.queryJS('settings.serverListing.notWhitelisted')}</span>`}
                </div>
            </div>
            <div class="lsSide">
                <div class="lsPing">${pingCellHTML(raw.id)}</div>
                <button class="lsSelectBtn" ${(!eligible || isSel) ? 'disabled' : ''}>${btnLabel}</button>
            </div>
        </div>`
    }).join('')

    // 아이콘 로드 실패 시 벡터 로고로 대체 (CSP 때문에 inline onerror 사용 불가)
    listEl.querySelectorAll('.lsThumbImg').forEach(img => {
        img.addEventListener('error', () => img.remove(), { once: true })
    })

    listEl.querySelectorAll('.lsRow').forEach(row => {
        const select = () => selectServerFromLanding(row.getAttribute('servid'))
        row.addEventListener('click', select)
        row.addEventListener('keydown', e => {
            if(e.key === 'Enter' || e.key === ' '){
                e.preventDefault()
                select()
            }
        })
    })

    // 처음 그릴 때 한 번 핑
    if(servers.some(s => landingServerPing[s.rawServer.id] === undefined)){
        refreshLandingServerPings()
    }
}

async function selectServerFromLanding(id){
    if(id == null || id === ConfigManager.getSelectedServer()) return
    if(isLaunchInProgress()){
        showLandingToast(Lang.queryJS('landingUi.launchingBlocked'))
        return
    }
    const distro = await DistroAPI.getDistribution()
    const serv = distro.getServerById(id)
    if(serv == null || !isAccountWhitelisted(serv, ConfigManager.getSelectedAccount())){
        return
    }
    updateSelectedServer(serv)
    refreshServerStatus(true)
}

async function refreshLandingServerPings(){
    if(landingPingInFlight) return
    landingPingInFlight = true
    try {
        const distro = await DistroAPI.getDistribution()
        await Promise.allSettled((distro.servers || []).map(async serv => {
            const id = serv.rawServer.id
            try {
                const st = await getServerStatus(47, serv.hostname, serv.port)
                landingServerPing[id] = { online: st.players.online, max: st.players.max }
            } catch(err) {
                landingServerPing[id] = null
            }
            updateServerPingCell(id)
        }))
    } finally {
        landingPingInFlight = false
    }
}

// 서버 목록 핑도 5분마다 갱신 (선택 서버 상태와 같은 주기)
let landingServerPingListener = setInterval(() => refreshLandingServerPings(), 300000)

document.getElementById('serverListRefresh').onclick = e => {
    e.currentTarget.blur()
    const btn = e.currentTarget
    btn.setAttribute('spinning', '')
    Object.keys(landingServerPing).forEach(k => { landingServerPing[k] = undefined })
    // distribution.json을 원격에서 다시 받아온다 — 화이트리스트/서버 설정/아이콘/배경화면이
    // distro-builder에서 바뀐 뒤 런처를 재시작하지 않아도 반영되도록 한다.
    DistroAPI.refreshDistributionOrFallback().then(distro => {
        onDistroRefresh(distro)
        return refreshLandingServerPings()
    }).catch(err => {
        loggerLanding.warn('distribution.json 새로고침 실패, 기존 목록을 다시 그립니다.', err)
        return renderLandingServerList().then(() => refreshLandingServerPings())
    }).finally(() => {
        setTimeout(() => btn.removeAttribute('spinning'), 600)
    })
}

/* =====================================================================
 * UI Renewal : 빠른 설정 / 사이드바 / 토스트
 * ===================================================================== */

function formatRAM(val){
    if(val == null) return '—'
    const m = String(val).match(/^([\d.]+)\s*([GMgm])?/)
    if(!m) return String(val)
    return `${m[1]} ${(m[2] || 'G').toUpperCase() === 'G' ? 'GB' : 'MB'}`
}

function refreshQuickSettings(){
    const id = ConfigManager.getSelectedServer()
    let mem = null, javaExec = null
    try {
        if(id != null){
            mem = ConfigManager.getMaxRAM(id)
            javaExec = ConfigManager.getJavaExecutable(id)
        }
    } catch(err) {
        // javaConfig가 아직 생성되지 않은 서버 (ensureJavaSettings 전)
    }
    document.getElementById('qsMemory').innerHTML = formatRAM(mem)
    document.getElementById('qsResolution').innerHTML = ConfigManager.getFullscreen()
        ? Lang.queryJS('landingUi.fullscreen')
        : `${ConfigManager.getGameWidth()} × ${ConfigManager.getGameHeight()}`
    document.getElementById('qsJava').innerHTML = javaExec != null
        ? Lang.queryJS('landingUi.javaSet')
        : Lang.queryJS('landingUi.javaAuto')
    document.getElementById('qsMods').innerHTML = Lang.queryJS('landingUi.manage')
}

document.querySelectorAll('#quickSettingsList .qsRow').forEach(row => {
    row.onclick = async e => {
        e.currentTarget.blur()
        await openSettingsTab(row.getAttribute('data-tab'))
    }
})

// 설정 화면에서 돌아올 때 빠른 설정 값이 최신이 되도록, 랜딩이 다시 보일 때마다 갱신
let landingWasVisible = false
new MutationObserver(() => {
    const visible = document.getElementById('landingContainer').style.display !== 'none'
    if(visible && !landingWasVisible){
        refreshQuickSettings()
    }
    landingWasVisible = visible
}).observe(document.getElementById('landingContainer'), { attributes: true, attributeFilter: ['style'] })

// 사이드바 : 서버 버튼 → 기존 서버 선택 오버레이
document.getElementById('navServerButton').onclick = async e => {
    e.currentTarget.blur()
    if(isLaunchInProgress()){
        showLandingToast(Lang.queryJS('landingUi.launchingBlocked'))
        return
    }
    await toggleServerSelection(true)
}

// 사이드바 : 홈 버튼 → 뉴스가 열려 있으면 닫기
document.getElementById('navHomeButton').onclick = e => {
    e.currentTarget.blur()
    if(newsActive){
        document.getElementById('newsButton').click()
    }
}

function setNavActive(which){
    // 뉴스는 사이드바가 아니라 홈의 뉴스 카드에서 연다. 뉴스가 열려 있으면 '홈'을 눌러 돌아올 수 있게 강조 해제.
    document.getElementById('navHomeButton').toggleAttribute('active', which === 'home')
}

// 사이드바 : 폴더 버튼 → 선택한 서버의 게임 폴더(인스턴스 디렉터리) 열기
document.getElementById('navFolderButton').onclick = async e => {
    e.currentTarget.blur()
    const serverId = ConfigManager.getSelectedServer()
    if(serverId == null){
        showLandingToast(Lang.queryJS('landingUi.folderNoServer'))
        return
    }
    const dir = path.join(ConfigManager.getInstanceDirectory(), serverId)
    try {
        await fs.ensureDir(dir) // 아직 한 번도 실행하지 않은 서버도 폴더를 만들어서 연다
        const err = await shell.openPath(dir)
        if(err){
            loggerLanding.warn('Unable to open instance folder:', err)
            showLandingToast(Lang.queryJS('landingUi.folderOpenFailed'))
        }
    } catch(err) {
        loggerLanding.error('Unable to open instance folder.', err)
        showLandingToast(Lang.queryJS('landingUi.folderOpenFailed'))
    }
}

// 폴더 버튼에 마우스를 올리면 실제 경로가 보이도록
document.getElementById('navFolderButton').addEventListener('mouseenter', e => {
    const id = ConfigManager.getSelectedServer()
    e.currentTarget.title = id != null ? path.join(ConfigManager.getInstanceDirectory(), id) : ''
})

// 런처 버전 표시
try {
    document.getElementById('launcherVersion').innerHTML = 'v' + remote.app.getVersion()
} catch(err) {
    loggerLanding.debug('Unable to resolve app version.')
}

// 주소가 비어있는('#') 외부 링크 아이콘은 숨김 → _custom.toml에 URL을 넣으면 자동 노출
;(function hideEmptyMediaLinks(){
    let visible = 0
    document.querySelectorAll('#externalMedia .mediaURL').forEach(a => {
        const href = (a.getAttribute('href') || '').trim()
        if(href === '' || href === '#'){
            a.parentElement.style.display = 'none'
        } else {
            visible++
        }
    })
    if(visible === 0){
        document.getElementById('externalMedia').style.display = 'none'
    }
})()

let landingToastTimer = null
function showLandingToast(msg){
    let toast = document.getElementById('landingToast')
    if(toast == null){
        toast = document.createElement('div')
        toast.id = 'landingToast'
        document.getElementById('landingContainer').appendChild(toast)
    }
    toast.innerHTML = msg
    toast.setAttribute('show', '')
    clearTimeout(landingToastTimer)
    landingToastTimer = setTimeout(() => toast.removeAttribute('show'), 2600)
}

refreshQuickSettings()

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')

// News slide caches.
let newsActive = false
let newsGlideCount = 0

/**
 * Show the news UI via a slide animation.
 * (리뉴얼) 사이드바는 그대로 두고, 대시보드 ↔ 뉴스 뷰를 전환한다.
 *
 * @param {boolean} up True to slide up, otherwise false.
 */
function slide_(up){
    const landingContainer = document.getElementById('landingContainer')

    newsGlideCount++

    if(up){
        landingContainer.setAttribute('news', '')
    } else {
        landingContainer.removeAttribute('news')
    }
    setNavActive(up ? 'news' : 'home')
    setTimeout(() => {
        newsGlideCount--
    }, 600)
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
        $('#landingServerList .lsRow').attr('tabindex', '0')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #landingSidebar, #landingSidebar *').removeAttr('tabindex')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

// 뉴스 뷰의 '홈으로' 버튼
document.getElementById('newsBackButton').onclick = e => {
    e.currentTarget.blur()
    if(newsActive){
        document.getElementById('newsButton').click()
    }
}

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 *
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)
    renderNewsPreview('loading')

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)
        renderNewsPreview('failed')

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)
        renderNewsPreview('none')

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.rawDate || lN.date)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){

                // Compare Content
                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)

            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        renderNewsPreview('ok')
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI. (리뉴얼) ESC로 뉴스 닫기.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        if(e.key === 'Escape' && !isOverlayVisible() && getCurrentView() === VIEWS.landing){
            document.getElementById('newsButton').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp' && !isOverlayVisible()){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 *
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index){
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = 'by ' + articleObject.author
    newsArticleAuthor.parentElement.style.display = articleObject.author ? '' : 'none'
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleComments.style.display = articleObject.comments ? '' : 'none'
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)
}

/* =====================================================================
 * UI Renewal : 홈 뉴스 미리보기 카드
 * ===================================================================== */

function articleThumbnail(article){
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(article.content || '')
    return m ? m[1] : null
}

function articleSnippet(article, max = 70){
    try {
        const text = new DOMParser().parseFromString(article.content || '', 'text/html').body.textContent || ''
        const t = text.replace(/\s+/g, ' ').trim()
        return t.length > max ? t.slice(0, max) + '…' : t
    } catch(err) {
        return ''
    }
}

function openNewsArticle(i){
    if(newsArr == null || newsArr[i] == null) return
    displayArticle(newsArr[i], i + 1)
    if(!newsActive){
        document.getElementById('newsButton').click()
    }
}

/**
 * @param {'loading'|'failed'|'none'|'ok'} state
 */
function renderNewsPreview(state){
    const body = document.getElementById('newsPreviewBody')
    if(body == null) return

    if(state === 'loading'){
        body.innerHTML = `<div class="npSkeleton"><div class="skel skelHero"></div><div class="skel skelLine"></div><div class="skel skelLine short"></div></div>`
        return
    }
    if(state === 'failed' || state === 'none'){
        body.innerHTML = `<div class="emptyState">
            ${iconSVG('i-news', 'emptyIcon')}
            <span>${Lang.queryJS(state === 'failed' ? 'landingUi.newsFailed' : 'landingUi.newsNone')}</span>
            ${state === 'failed' ? `<button class="ghostButton" id="newsPreviewRetry">${iconSVG('i-refresh', '')}${Lang.queryJS('landingUi.newsRetry')}</button>` : ''}
        </div>`
        const retry = document.getElementById('newsPreviewRetry')
        if(retry != null){
            retry.onclick = () => {
                $('#newsErrorFailed').hide()
                $('#newsErrorLoading').show()
                initNews()
            }
        }
        return
    }

    const featured = newsArr[0]
    const thumb = articleThumbnail(featured)
    const rest = newsArr.slice(1, 3)
    body.innerHTML = `
        <button class="npFeatured" data-index="0" ${thumb ? '' : 'nothumb'}>
            <div class="npFeaturedBg" ${thumb ? `style="background-image:url('${cssUrl(thumb)}')"` : ''}></div>
            <div class="npFeaturedShade"></div>
            <div class="npFeaturedContent">
                <span class="npBadge">${Lang.queryJS('landingUi.newsLatest')}</span>
                <span class="npTitle">${escapeHTML(featured.title)}</span>
                <span class="npSnippet">${escapeHTML(articleSnippet(featured))}</span>
                <span class="npDate">${escapeHTML(featured.date)}</span>
            </div>
        </button>
        ${rest.map((a, i) => `
        <button class="npRow" data-index="${i + 1}">
            <span class="npRowDot"></span>
            <span class="npRowText">
                <span class="npRowTitle">${escapeHTML(a.title)}</span>
                <span class="npRowDate">${escapeHTML(a.date)}</span>
            </span>
            ${iconSVG('i-chev-right', 'npRowChevron')}
        </button>`).join('')}
    `
    body.querySelectorAll('[data-index]').forEach(el => {
        el.onclick = e => {
            e.currentTarget.blur()
            openNewsArticle(parseInt(el.getAttribute('data-index')))
        }
    })
}

/**
 * distribution.json 최상위 news[] 필드(서버에 종속되지 않는 전체 공통 뉴스, distro-builder의
 * "1-3. 뉴스 관리"에서 등록/삭제)를 articleObject 배열로 변환한다. RSS 기사와 같은 모양으로
 * 맞춰서 아래쪽 정렬/표시/신규 여부 판단 로직을 그대로 재사용할 수 있게 한다.
 *
 * @param {Array|undefined} newsEntries distribution.json의 news 배열.
 * @returns {Array} articleObject 배열 (없으면 빈 배열).
 */
function loadCustomNews(newsEntries){
    if(!Array.isArray(newsEntries) || newsEntries.length === 0) return []
    return newsEntries.map(entry => {
        const rawDate = entry.date || new Date().toISOString()
        const date = new Date(rawDate).toLocaleDateString('ko-KR', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        const link = entry.link || '#'
        const content = escapeHTML(entry.content || '').replace(/\n/g, '<br>')
        return {
            link,
            title: escapeHTML(entry.title || ''),
            date,
            rawDate,
            author: escapeHTML(entry.author || ''),
            content,
            comments: '',
            commentsLink: link
        }
    })
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 *
 * @param {string} newsFeed RSS 피드 URL.
 * @returns {Promise.<Array|null>} articleObject 배열, 실패 시 null.
 */
function loadRssNews(newsFeed){
    return new Promise((resolve) => {

        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date. (리뉴얼: 한국어 날짜 표기, 캐시 비교용 원본은 rawDate로 보관)
                    const rawDate = el.find('pubDate').text()
                    const date = new Date(rawDate).toLocaleDateString('ko-KR', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Fix relative links in content.
                    let content = el.find('content\\:encoded').text() || el.find('description').text()
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            rawDate,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve(articles)
            },
            timeout: 2500
        }).catch(() => {
            resolve(null)
        })
    })
}

/**
 * 뉴스 정보를 불러온다. distribution.json의 news[](서버에 종속되지 않는 전체 공통,
 * distro-builder에서 등록/삭제) + rss(기존 RSS 피드) 둘 다 있으면 합쳐서 최신순으로 보여준다.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    const customArticles = loadCustomNews(distroData.rawDistribution.news)

    const newsFeed = distroData.rawDistribution.rss
    if(!newsFeed){
        loggerLanding.debug('No RSS feed provided.')
        return customArticles.length > 0 ? { articles: customArticles } : { articles: null }
    }

    const rssArticles = await loadRssNews(newsFeed)

    if(rssArticles == null && customArticles.length === 0){
        return { articles: null }
    }

    const articles = [...customArticles, ...(rssArticles || [])]
        .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate))

    return { articles }
}
