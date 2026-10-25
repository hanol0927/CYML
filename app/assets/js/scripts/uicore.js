/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $                              = require('jquery')
const {ipcRenderer, shell, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

// Log deprecation and process warnings.
process.traceProcessWarnings = true
process.traceDeprecation = true

// Disable eval function.
// eslint-disable-next-line
window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on('devtools-opened', () => {
    console.log('%cThe console is dark and full of terrors.', 'color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold')
    console.log('%cIf you\'ve been told to paste something here, you\'re being scammed.', 'font-size: 16px')
    console.log('%cUnless you know exactly what you\'re doing, close this window.', 'font-size: 16px')
})

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)

/* =====================================================================
 * 자동 업데이트 (GitHub Releases, electron-updater)
 *  1. 런처가 켜지면 바로 GitHub에서 상위 버전을 확인 (이후 30분마다 재확인)
 *  2. 있으면 백그라운드로 다운로드하며 상단 배너에 진행률 표시
 *  3. 다운로드가 끝나면 3초 카운트다운 후 조용히 설치하고 런처를 자동 재시작
 *     - 게임 실행/준비 중이면 설치를 미뤘다가 게임이 종료되는 순간 설치
 *     - 그 전에 런처를 닫아도 종료 시 설치됨 (autoInstallOnAppQuit)
 * ===================================================================== */

let updateReadyToInstall = false
let updateInstallScheduled = false
let updateBannerHideTimer = null

function setUpdateBanner(text, percent = null, busy = true){
    const banner = document.getElementById('updateBanner')
    if(banner == null) return
    clearTimeout(updateBannerHideTimer)
    document.getElementById('updateBannerText').innerHTML = text
    banner.toggleAttribute('nobar', percent == null)
    if(percent != null){
        document.getElementById('updateBannerBar').style.width = Math.max(0, Math.min(100, percent)) + '%'
    }
    banner.toggleAttribute('busy', busy)
    banner.setAttribute('show', '')
}

function hideUpdateBanner(delay = 0){
    clearTimeout(updateBannerHideTimer)
    updateBannerHideTimer = setTimeout(() => {
        const banner = document.getElementById('updateBanner')
        if(banner != null) banner.removeAttribute('show')
    }, delay)
}

/**
 * 게임이 실행 중이거나 실행 준비(파일 검증/다운로드) 중인지.
 * gameRunning / isLaunchInProgress 는 landing.js에 정의되어 있다.
 */
function isLauncherBusy(){
    const running = typeof gameRunning !== 'undefined' && gameRunning
    const launching = typeof isLaunchInProgress === 'function' && isLaunchInProgress()
    return running || launching
}

function tryAutoInstallUpdate(){
    if(isDev || !updateReadyToInstall || updateInstallScheduled){
        return
    }
    if(isLauncherBusy()){
        loggerAutoUpdater.info('Update ready, waiting for the game to close.')
        setUpdateBanner(Lang.queryJS('landingUi.updateWaitGame'), null, false)
        hideUpdateBanner(7000)
        return
    }
    updateInstallScheduled = true
    let sec = 3
    setUpdateBanner(Lang.queryJS('landingUi.updateRestarting', { sec }), 100, true)
    const countdown = setInterval(() => {
        sec--
        if(isLauncherBusy()){
            // 카운트다운 중에 게임 시작을 누른 경우 → 다시 게임 종료 후로 미룸
            clearInterval(countdown)
            updateInstallScheduled = false
            tryAutoInstallUpdate()
            return
        }
        if(sec <= 0){
            clearInterval(countdown)
            loggerAutoUpdater.info('Installing update and relaunching.')
            ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
        } else {
            setUpdateBanner(Lang.queryJS('landingUi.updateRestarting', { sec }), 100, true)
        }
    }, 1000)
}

/**
 * landing.js가 게임 프로세스 종료 시 호출한다.
 */
function onGameProcessClosed(){
    tryAutoInstallUpdate()
}

// Initialize auto updates in production environments.
let updateCheckListener
let pendingUpdateVersion = null
if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'checking-for-update':
                loggerAutoUpdater.info('Checking for update..')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
                break
            case 'update-available':
                loggerAutoUpdater.info('New update available', info.version)
                pendingUpdateVersion = info.version

                if(process.platform === 'darwin'){
                    info.darwindownload = `https://github.com/hanol0927/CYML/releases/download/v${info.version}/MRS-Launcher-setup-${info.version}${process.arch === 'arm64' ? '-arm64' : '-x64'}.dmg`
                    showUpdateUI(info)
                } else {
                    setUpdateBanner(Lang.queryJS('landingUi.updateDownloading', { version: info.version, percent: 0 }), 0, true)
                }

                populateSettingsUpdateInformation(info)
                break
            case 'download-progress':
                if(info != null && info.percent != null){
                    const percent = Math.floor(info.percent)
                    setUpdateBanner(Lang.queryJS('landingUi.updateDownloading', { version: pendingUpdateVersion || '', percent }), percent, true)
                }
                break
            case 'update-downloaded':
                loggerAutoUpdater.info('Update ' + info.version + ' ready to be installed.')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), false, () => {
                    if(!isDev){
                        ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
                    }
                })
                showUpdateUI(info)
                updateReadyToInstall = true
                tryAutoInstallUpdate()
                break
            case 'update-not-available':
                loggerAutoUpdater.info('No new update found.')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'))
                break
            case 'ready':
                updateCheckListener = setInterval(() => {
                    // 이미 받은 업데이트가 설치 대기 중이면 다시 확인할 필요 없음
                    if(!updateReadyToInstall){
                        ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                    }
                }, 1800000)
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                break
            case 'realerror':
                if(!updateReadyToInstall){
                    hideUpdateBanner()
                }
                if(info != null && info.code != null){
                    if(info.code === 'ERR_UPDATER_INVALID_RELEASE_FEED'){
                        loggerAutoUpdater.info('No suitable releases found.')
                    } else if(info.code === 'ERR_XML_MISSED_ELEMENT'){
                        loggerAutoUpdater.info('No releases found.')
                    } else {
                        loggerAutoUpdater.error('Error during update check..', info)
                        loggerAutoUpdater.debug('Error Code:', info.code)
                    }
                }
                break
            default:
                loggerAutoUpdater.info('Unknown argument', arg)
                break
        }
    })
}

/**
 * Send a notification to the main process changing the value of
 * allowPrerelease. If we are running a prerelease version, then
 * this will always be set to true, regardless of the current value
 * of val.
 *
 * @param {boolean} val The new allow prerelease value.
 */
function changeAllowPrerelease(val){
    ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', val)
}

function showUpdateUI(info){
    //TODO Make this message a bit more informative `${info.version}`
    document.getElementById('image_seal_container').setAttribute('update', true)
    document.getElementById('image_seal_container').onclick = () => {
        /*setOverlayContent('Update Available', 'A new update for the launcher is available. Would you like to install now?', 'Install', 'Later')
        setOverlayHandler(() => {
            if(!isDev){
                ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
            } else {
                console.error('Cannot install updates in development environment.')
                toggleOverlay(false)
            }
        })
        setDismissHandler(() => {
            toggleOverlay(false)
        })
        toggleOverlay(true, true)*/
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            settingsNavItemListener(document.getElementById('settingsNavUpdate'), false)
        })
    }
}

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

document.addEventListener('readystatechange', function () {
    if (document.readyState === 'interactive'){
        loggerUICore.info('UICore Initializing..')

        // Bind close button.
        Array.from(document.getElementsByClassName('fCb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.close()
            })
        })

        // Bind restore down button.
        Array.from(document.getElementsByClassName('fRb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                if(window.isMaximized()){
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                document.activeElement.blur()
            })
        })

        // Bind minimize button.
        Array.from(document.getElementsByClassName('fMb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.minimize()
                document.activeElement.blur()
            })
        })

        // Remove focus from social media buttons once they're clicked.
        Array.from(document.getElementsByClassName('mediaURL')).map(val => {
            val.addEventListener('click', e => {
                document.activeElement.blur()
            })
        })

    }

}, false)

/**
 * Open web links in the user's default browser.
 */
$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    shell.openExternal(this.href)
})

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code.
 */
document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})
