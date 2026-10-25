/**
 * ImageCache — 서버 아이콘 / 배경 이미지 디스크 캐시 (렌더러 프로세스 전용)
 *
 * 왜 필요한가
 *  - 기존 배경은 4096px PNG(약 10MB)를 매번 통째로 디코딩해서 첫 표시가 늦고 전환 시 버벅였다.
 *  - 원격(distribution.json) 아이콘/배경은 실행할 때마다 네트워크에서 다시 받았다.
 *
 * 하는 일
 *  - 배경: 최대 1920px WebP로 줄여 <런처 폴더>/cache/images 에 저장 (+ 강조색 미리 계산)
 *  - 아이콘: 최대 128px WebP로 저장
 *  - 다음 실행부터는 디스크의 작은 파일을 즉시 사용, 원격 이미지는 6시간마다 백그라운드로만 갱신
 *  - 실패하면 언제나 원본 URL로 폴백 (기능에는 영향 없음)
 */
const fs              = require('fs-extra')
const path            = require('path')
const crypto          = require('crypto')
const got             = require('got')
const { pathToFileURL, fileURLToPath } = require('url')
const { LoggerUtil }  = require('helios-core')
const ConfigManager   = require('./configmanager')

const logger = LoggerUtil.getLogger('ImageCache')

const CACHE_VERSION   = 2
const BG_MAX_WIDTH    = 1920
const ICON_MAX_SIZE   = 128
const REFRESH_AFTER   = 6 * 60 * 60 * 1000
const APP_DIR         = path.join(__dirname, '..', '..')
const APP_VERSION     = (() => { try { return require('@electron/remote').app.getVersion() } catch(e) { return '0' } })()

let cacheDir = null
let index = null
let saveTimer = null
const inflight = new Map()

function getCacheDir(){
    if(cacheDir == null){
        cacheDir = path.join(ConfigManager.getLauncherDirectory(), 'cache', 'images')
        fs.ensureDirSync(cacheDir)
    }
    return cacheDir
}

function getIndex(){
    if(index == null){
        try {
            index = fs.readJsonSync(path.join(getCacheDir(), 'index.json'))
            if(index.__v !== CACHE_VERSION) index = { __v: CACHE_VERSION }
        } catch(err) {
            index = { __v: CACHE_VERSION }
        }
    }
    return index
}

function saveIndexSoon(){
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
        fs.writeJson(path.join(getCacheDir(), 'index.json'), getIndex()).catch(err => logger.warn('Index save failed', err.message))
    }, 400)
}

function isRemote(url){
    return /^https?:\/\//i.test(url)
}

function keyOf(url, kind){
    const salt = isRemote(url) ? '' : APP_VERSION // 번들 이미지는 런처 버전이 바뀌면 다시 생성
    return crypto.createHash('sha1').update(`${kind}|${url}|${salt}`).digest('hex').substring(0, 20)
}

function entryFor(url, kind){
    if(typeof url !== 'string' || url.length === 0) return null
    const e = getIndex()[keyOf(url, kind)]
    if(e == null) return null
    const file = path.join(getCacheDir(), e.file)
    if(!fs.existsSync(file)) return null
    return { ...e, path: file }
}

/**
 * 캐시된 파일이 있으면 그 file:// URL, 없으면 원본 URL. (동기, 렌더 시점에 사용)
 */
exports.src = function(url, kind = 'icon'){
    try {
        const e = entryFor(url, kind)
        return e != null ? pathToFileURL(e.path).toString() : url
    } catch(err) {
        return url
    }
}

/**
 * 캐시된 배경의 강조색 {h,s,l} (없으면 null).
 */
exports.accent = function(url){
    try {
        const e = entryFor(url, 'bg')
        return e != null ? (e.accent || null) : null
    } catch(err) {
        return null
    }
}

exports.isCached = function(url, kind = 'icon'){
    try { return entryFor(url, kind) != null } catch(err) { return false }
}

async function readSource(url){
    if(isRemote(url)){
        return await got(url, { timeout: { request: 20000 }, retry: { limit: 1 } }).buffer()
    }
    let p = url
    if(/^file:/i.test(url)) p = fileURLToPath(url)
    else if(!path.isAbsolute(url)) p = path.join(APP_DIR, url)
    return await fs.readFile(p)
}

function rgbToHsl(r, g, b){
    r /= 255; g /= 255; b /= 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0, s = 0
    const l = (max + min) / 2
    if(max !== min){
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        switch(max){
            case r: h = (g - b) / d + (g < b ? 6 : 0); break
            case g: h = (b - r) / d + 2; break
            default: h = (r - g) / d + 4
        }
        h *= 60
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}
exports.rgbToHsl = rgbToHsl

/**
 * 채도 가중 색상 히스토그램으로 대표 강조색 계산. imageData: Uint8ClampedArray(RGBA)
 */
function accentFromPixels(data){
    const buckets = new Array(36).fill(0)
    for(let i = 0; i < data.length; i += 4){
        const { h, s, l } = rgbToHsl(data[i], data[i+1], data[i+2])
        if(s < 30 || l < 18 || l > 82) continue
        buckets[Math.floor(h / 10) % 36] += (s / 100) * (1 - Math.abs(l - 50) / 50)
    }
    let best = -1, bestVal = 0
    for(let i = 0; i < 36; i++){
        const v = buckets[i] + 0.5 * (buckets[(i + 35) % 36] + buckets[(i + 1) % 36])
        if(v > bestVal){ bestVal = v; best = i }
    }
    if(best < 0 || bestVal < 1.5) return null
    return { h: best * 10 + 5, s: 78, l: 58 }
}
exports.accentFromPixels = accentFromPixels

/**
 * 버퍼를 디코딩 → 축소 → WebP 인코딩. (createImageBitmap은 메인 스레드를 막지 않음)
 */
async function optimize(buf, kind){
    const src = await createImageBitmap(new Blob([buf]))
    const limit = kind === 'bg' ? BG_MAX_WIDTH : ICON_MAX_SIZE
    const scale = kind === 'bg'
        ? Math.min(1, limit / src.width)
        : Math.min(1, limit / Math.max(src.width, src.height))
    const w = Math.max(1, Math.round(src.width * scale))
    const h = Math.max(1, Math.round(src.height * scale))
    const bmp = scale < 1
        ? await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
        : src

    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d').drawImage(bmp, 0, 0)
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: kind === 'bg' ? 0.86 : 0.92 })

    let accent = null
    if(kind === 'bg'){
        const small = new OffscreenCanvas(64, 36)
        const sctx = small.getContext('2d', { willReadFrequently: true })
        sctx.drawImage(bmp, 0, 0, 64, 36)
        accent = accentFromPixels(sctx.getImageData(0, 0, 64, 36).data)
    }
    if(bmp !== src) bmp.close()
    src.close()
    return { buffer: Buffer.from(await out.arrayBuffer()), ext: 'webp', accent }
}

async function build(url, kind){
    const key = keyOf(url, kind)
    const raw = await readSource(url)
    const hash = crypto.createHash('sha1').update(raw).digest('hex').substring(0, 10)

    const prev = getIndex()[key]
    if(prev != null && prev.hash === hash && fs.existsSync(path.join(getCacheDir(), prev.file))){
        prev.fetchedAt = Date.now() // 내용이 같으면 시간만 갱신
        saveIndexSoon()
        return { ...prev, path: path.join(getCacheDir(), prev.file) }
    }

    let result
    if(/\.gif(\?|$)/i.test(url)){
        result = { buffer: raw, ext: 'gif', accent: null } // 움짤은 변환하지 않음
    } else {
        try {
            result = await optimize(raw, kind)
        } catch(err) {
            logger.warn(`Optimize failed (${url}), storing original.`, err.message)
            result = { buffer: raw, ext: (path.extname(url.split('?')[0]).substring(1) || 'img'), accent: null }
        }
    }

    const file = `${key}-${hash}.${result.ext}`
    const target = path.join(getCacheDir(), file)
    await fs.writeFile(target + '.tmp', result.buffer)
    await fs.move(target + '.tmp', target, { overwrite: true })

    if(prev != null && prev.file !== file){
        fs.remove(path.join(getCacheDir(), prev.file)).catch(() => {})
    }
    const entry = { file, hash, accent: result.accent, fetchedAt: Date.now() }
    getIndex()[key] = entry
    saveIndexSoon()
    return { ...entry, path: target }
}

/**
 * 캐시를 보장한다. 이미 있으면 즉시 반환하고, 원격 이미지가 오래됐으면 백그라운드에서 갱신.
 * @returns {Promise<{src:string, accent:Object|null}>}
 */
exports.ensure = function(url, kind = 'icon'){
    if(typeof url !== 'string' || url.length === 0){
        return Promise.reject(new Error('No url'))
    }
    const key = keyOf(url, kind)
    const existing = entryFor(url, kind)
    if(existing != null){
        if(isRemote(url) && Date.now() - (existing.fetchedAt || 0) > REFRESH_AFTER && !inflight.has(key)){
            const p = build(url, kind).catch(err => logger.debug('Background refresh failed', err.message)).finally(() => inflight.delete(key))
            inflight.set(key, p)
        }
        return Promise.resolve({ src: pathToFileURL(existing.path).toString(), accent: existing.accent || null })
    }
    if(!inflight.has(key)){
        inflight.set(key, build(url, kind).finally(() => inflight.delete(key)))
    }
    return inflight.get(key).then(e => ({ src: pathToFileURL(e.path).toString(), accent: e.accent || null }))
}

/**
 * 모든 서버의 아이콘(먼저)과 배경을 미리 캐시. 동시 2개씩, 실패는 무시.
 * @param {Array<{icon:string, background:string}>} items
 */
exports.warm = async function(items){
    const jobs = []
    for(const it of items){ if(it.icon) jobs.push([it.icon, 'icon']) }
    for(const it of items){ if(it.background) jobs.push([it.background, 'bg']) }
    let i = 0
    const worker = async () => {
        while(i < jobs.length){
            const [url, kind] = jobs[i++]
            try { await exports.ensure(url, kind) } catch(err) { logger.debug(`Warm failed: ${url}`, err.message) }
        }
    }
    await Promise.all([worker(), worker()])
}
