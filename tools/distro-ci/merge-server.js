'use strict'

/*
 * generate-server.yml의 마지막 단계에서 실행된다.
 *
 * NeoNebula가 방금 만든(이번 실행 한정, 서버 하나짜리) distribution.json에서 그
 * 서버 객체 하나만 꺼내서:
 *   1. 그 서버가 참조하는 실제 바이너리 파일들을 distro-worker(Cloudflare Worker
 *      + R2)에 업로드 (tools/distro-builder/worker-api.js와 동일한 프로토콜)
 *   2. distro-worker의 distribution.json을 다시 불러와 그 서버 id만 안전하게
 *      upsert (다른 서버, 그리고 distro-builder가 관리하는 whitelist/background/
 *      icon/onceFiles/모드 모듈은 절대 건드리지 않음)
 *
 * 예전에는 ddumon(GitHub 저장소)의 distribution.json을 GitHub Contents API로
 * 직접 수정하고, 자산은 서버별 GitHub Pages 저장소에 커밋했다. distro-builder가
 * distro-worker(R2) 기반으로 옮겨가면서(app/assets/js/distromanager.js의
 * REMOTE_DISTRO_URL 참고) 그 방식으로 쓴 결과는 이제 런처가 읽는 곳과 달라져
 * 더 이상 반영되지 않는다 — 그래서 이 스크립트도 같은 Worker를 쓰도록 옮겼다.
 *
 * ⚠️ NeoNebula의 ROOT 디렉터리 내부 레이아웃을 문서만으로 완전히 확인하지
 * 못했다. locateGeneratedDistribution()의 경로 가정이 이 스크립트에서 가장
 * 깨지기 쉬운 지점 — 처음 안 맞으면 워크플로우 로그에 찍히는 ROOT 파일 목록을
 * 보고 조정해야 한다.
 *
 * Node 20 기준(전역 fetch 사용), 외부 npm 의존성 없음.
 */

const fs = require('fs')
const path = require('path')

const {
    WORKER_BASE_URL,
    UPLOAD_SECRET,
    BASE_URL,
    SERVER_ID,
    MC_VERSION,
    ROOT_DIR
} = process.env

// distribution.json에서 "로더가 소유한" 모듈 타입 — NeoNebula가 새로 생성해준
// 서버에는 이 타입들만 들어있다고 가정한다(모드/설정 파일은 없음). 기존 서버를
// 다시 생성(로더 버전 업데이트)한 경우, 이 타입들만 새 것으로 교체하고 나머지
// (ForgeMod/FabricMod/File 등, distro-builder가 관리)는 그대로 둔다.
// tools/distro-builder/app.js의 LOADER_OWNED_TYPES와 동일하게 맞출 것.
const LOADER_OWNED_TYPES = new Set(['Forge', 'ForgeHosted', 'Fabric', 'VersionManifest', 'Library'])

// worker-api.js의 값과 동일하게 맞출 것.
const MULTIPART_THRESHOLD_BYTES = 80 * 1024 * 1024
const MULTIPART_CHUNK_BYTES = 40 * 1024 * 1024

function required(name, value) {
    if (!value) throw new Error(`환경변수 ${name}가 없습니다.`)
    return value
}

// ---- distro-worker(R2) API — tools/distro-builder/worker-api.js와 동일한 프로토콜 ----

function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/')
}

async function getDistribution(workerBaseUrl) {
    const res = await fetch(`${workerBaseUrl}/distribution.json`, { cache: 'no-store' })
    if (res.status === 404) return { distribution: { version: '1.0.0', servers: [] }, etag: null }
    if (!res.ok) throw new Error(`distribution.json 조회 실패: ${res.status} ${await res.text().catch(() => '')}`)
    const etag = res.headers.get('ETag')
    return { distribution: await res.json(), etag }
}

async function putDistribution(workerBaseUrl, secret, distribution, etag) {
    const headers = { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' }
    if (etag) headers['If-Match'] = etag
    const res = await fetch(`${workerBaseUrl}/distribution.json`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(distribution, null, 2)
    })
    if (res.status === 412) {
        const detail = await res.json().catch(() => null)
        const debugSuffix = detail ? ` (보낸 값: ${detail.sentIfMatch}, 서버 현재 값: ${detail.currentEtag})` : ''
        throw new Error(`distribution.json이 그 사이 다른 곳에서 변경되었습니다. 워크플로우를 다시 실행하세요.${debugSuffix}`)
    }
    if (!res.ok) throw new Error(`distribution.json 업로드 실패: ${res.status} ${await res.text().catch(() => '')}`)
    return res.json()
}

async function putSingleShot(workerBaseUrl, secret, p, bytes) {
    const res = await fetch(`${workerBaseUrl}/files/${encodePath(p)}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${secret}` },
        body: bytes
    })
    if (!res.ok) throw new Error(`업로드 실패 (${p}): ${res.status} ${await res.text().catch(() => '')}`)
    return res.json()
}

async function putMultipart(workerBaseUrl, secret, p, bytes) {
    const encoded = encodePath(p)
    const authHeaders = { 'Authorization': `Bearer ${secret}` }
    const base = `${workerBaseUrl}/files/${encoded}`

    const createRes = await fetch(`${base}?mpu=create`, { method: 'POST', headers: authHeaders })
    if (!createRes.ok) throw new Error(`멀티파트 업로드 시작 실패 (${p}): ${createRes.status} ${await createRes.text().catch(() => '')}`)
    const { uploadId } = await createRes.json()

    const totalParts = Math.ceil(bytes.length / MULTIPART_CHUNK_BYTES)
    const parts = []
    try {
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            const start = (partNumber - 1) * MULTIPART_CHUNK_BYTES
            const end = Math.min(start + MULTIPART_CHUNK_BYTES, bytes.length)
            const chunk = bytes.subarray(start, end)
            const partRes = await fetch(`${base}?mpu=uploadpart&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, {
                method: 'PUT',
                headers: authHeaders,
                body: chunk
            })
            if (!partRes.ok) throw new Error(`멀티파트 조각 업로드 실패 (${p}, part ${partNumber}/${totalParts}): ${partRes.status} ${await partRes.text().catch(() => '')}`)
            const { etag } = await partRes.json()
            parts.push({ partNumber, etag })
            console.log(`    (멀티파트) ${p}: 조각 ${partNumber}/${totalParts}`)
        }
    } catch (err) {
        await fetch(`${base}?mpu=abort&uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST', headers: authHeaders }).catch(() => {})
        throw err
    }

    const completeRes = await fetch(`${base}?mpu=complete&uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
        body: JSON.stringify({ parts })
    })
    if (!completeRes.ok) throw new Error(`멀티파트 업로드 완료 실패 (${p}): ${completeRes.status} ${await completeRes.text().catch(() => '')}`)
    return completeRes.json()
}

async function uploadFile(workerBaseUrl, secret, p, bytes) {
    if (bytes.length > MULTIPART_THRESHOLD_BYTES) {
        return putMultipart(workerBaseUrl, secret, p, bytes)
    }
    return putSingleShot(workerBaseUrl, secret, p, bytes)
}

// ---- NeoNebula 생성물 탐색 ----

/**
 * generate distro가 만든 distribution.json을 ROOT 밑에서 찾는다. 정확한 파일명/
 * 위치를 문서로 100% 확인하지 못해서, 가장 유력한 위치부터 순서대로 시도한다.
 */
function locateGeneratedDistribution(rootDir) {
    const candidates = [
        path.join(rootDir, 'distribution.json'),
        path.join(rootDir, 'meta', 'distribution.json')
    ]
    for (const c of candidates) {
        if (fs.existsSync(c)) return c
    }
    // 못 찾으면 ROOT 전체에서 이름이 distribution*.json인 첫 파일을 재귀 탐색.
    const found = findFileRecursive(rootDir, /^distribution.*\.json$/i)
    if (found) return found

    // 후보 경로가 전부 빗나갔다 — 다음에 또 헤매지 않도록 ROOT 전체 트리를
    // 워크플로우 로그에 그대로 찍어서, 이 실행의 로그만 보고 바로
    // locateGeneratedDistribution()의 후보 경로를 고칠 수 있게 한다.
    const tree = []
    listAllFilesRecursive(rootDir, tree, 0)
    console.error(`ROOT(${rootDir}) 아래 실제 파일 목록:`)
    console.error(tree.length > 0 ? tree.join('\n') : '  (비어 있음 — ROOT 아래에 파일이 하나도 없습니다. generate server/generate distro 단계 로그를 확인하세요.)')
    throw new Error(`ROOT(${rootDir})에서 생성된 distribution.json을 찾지 못했습니다. NeoNebula의 출력 경로가 예상과 다른 것 같습니다 — 바로 위에 찍힌 ROOT 파일 목록을 참고해 locateGeneratedDistribution()의 후보 경로를 맞추세요.`)
}

function listAllFilesRecursive(dir, out, depth) {
    if (depth > 8) return // 안전장치: 비정상적으로 깊은 트리로 로그가 무한히 커지는 것 방지
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
        out.push(`  (읽기 실패: ${dir} - ${err.message})`)
        return
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            out.push(`  [dir]  ${full}`)
            listAllFilesRecursive(full, out, depth + 1)
        } else {
            out.push(`  [file] ${full}`)
        }
    }
}

function findFileRecursive(dir, pattern) {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
        return null
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            const found = findFileRecursive(full, pattern)
            if (found) return found
        } else if (pattern.test(entry.name)) {
            return full
        }
    }
    return null
}

/**
 * artifact.url(BASE_URL로 시작)을 ROOT_DIR 밑의 실제 로컬 파일 경로로 변환한다.
 * BASE_URL은 generate-server.yml이 NeoNebula의 .env에 써준 값과 동일해야 하며
 * (이번엔 "<WORKER_BASE_URL>/files/servers/<serverId>/forge/" 형태), NeoNebula가
 * "ROOT의 내용물이 이 URL로 서빙된다"는 전제로 artifact.url을 생성한다는 것을
 * 그대로 따른 것 — 실제로 안 맞으면 이 함수를 조정해야 한다.
 */
function urlToLocalPath(url) {
    if (!url.startsWith(BASE_URL)) return null
    const relative = url.slice(BASE_URL.length).replace(/^\/+/, '')
    return path.join(ROOT_DIR, relative)
}

function collectModuleFiles(modules, out) {
    for (const mod of modules) {
        if (mod.artifact && mod.artifact.url) {
            const localPath = urlToLocalPath(mod.artifact.url)
            if (localPath && fs.existsSync(localPath)) {
                out.push({ url: mod.artifact.url, localPath })
            } else {
                console.warn(`  경고: 로컬 파일을 못 찾음 (${mod.id}): ${mod.artifact.url}`)
            }
        }
        if (Array.isArray(mod.subModules) && mod.subModules.length > 0) {
            collectModuleFiles(mod.subModules, out)
        }
    }
}

function stripLoaderOwnedModules(modules) {
    return (modules || []).filter(m => !LOADER_OWNED_TYPES.has(m.type))
}

async function main() {
    required('WORKER_BASE_URL', WORKER_BASE_URL)
    required('UPLOAD_SECRET', UPLOAD_SECRET)
    required('BASE_URL', BASE_URL)
    required('SERVER_ID', SERVER_ID)
    required('ROOT_DIR', ROOT_DIR)
    const workerBaseUrl = WORKER_BASE_URL.replace(/\/$/, '')
    // R2에 저장할 때 쓰는 key는 "<workerBaseUrl>/files/" 접두사를 뗀 나머지 부분.
    const filesPrefix = `${workerBaseUrl}/files/`

    const generatedPath = locateGeneratedDistribution(ROOT_DIR)
    console.log(`생성된 distribution.json: ${generatedPath}`)
    const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'))
    const generatedServers = generated.servers || []
    const newServer = generatedServers.find(s => s.id === SERVER_ID) || generatedServers[0]
    if (newServer == null) {
        throw new Error('생성된 distribution.json에 서버가 하나도 없습니다.')
    }
    console.log(`대상 서버: ${newServer.id} (모듈 ${(newServer.modules || []).length}개)`)

    // 1) 이 서버가 참조하는 실제 바이너리 파일들을 distro-worker(R2)에 업로드.
    const filesToUpload = []
    collectModuleFiles(newServer.modules || [], filesToUpload)
    if (filesToUpload.length > 0) {
        console.log(`distro-worker에 파일 ${filesToUpload.length}개 업로드 중..`)
        for (const f of filesToUpload) {
            if (!f.url.startsWith(filesPrefix)) {
                throw new Error(`artifact.url이 예상한 접두사(${filesPrefix})로 시작하지 않습니다: ${f.url}`)
            }
            const r2Path = f.url.slice(filesPrefix.length)
            const bytes = fs.readFileSync(f.localPath)
            await uploadFile(workerBaseUrl, UPLOAD_SECRET, r2Path, bytes)
            console.log(`  업로드 완료: ${r2Path}`)
        }
        console.log('자산 업로드 완료.')
    } else {
        console.warn('업로드할 자산 파일이 하나도 없습니다 — urlToLocalPath 매핑을 확인하세요.')
    }

    // 2) distro-worker의 distribution.json에 이 서버 하나만 안전하게 upsert.
    // (실패 안전성: 자산 업로드를 distribution.json 갱신보다 먼저 수행 — distro-builder의
    //  app.js와 동일한 순서. 자산 없는 채로 distribution.json이 먼저 배포되는 걸 피한다.)
    console.log('distro-worker에서 distribution.json 불러오는 중..')
    const { distribution, etag } = await getDistribution(workerBaseUrl)
    distribution.servers = distribution.servers || []

    const existingIdx = distribution.servers.findIndex(s => s.id === SERVER_ID)
    if (existingIdx >= 0) {
        const existing = distribution.servers[existingIdx]
        // 로더 모듈만 새 것으로 교체하고, distro-builder가 관리하는 나머지
        // (ForgeMod/FabricMod/File 모듈, whitelist/background/icon/onceFiles)는 그대로 유지.
        const keptModules = stripLoaderOwnedModules(existing.modules)
        const loaderModules = (newServer.modules || []).filter(m => LOADER_OWNED_TYPES.has(m.type))
        distribution.servers[existingIdx] = Object.assign({}, existing, {
            minecraftVersion: MC_VERSION || existing.minecraftVersion,
            modules: [...loaderModules, ...keptModules]
        })
        console.log(`기존 서버 ${SERVER_ID}의 로더 모듈만 교체했습니다.`)
    } else {
        // 새 서버 — 최소한의 정보만 채워서 만들고, 나머지(이름/설명/화이트리스트 등)는
        // distro-builder 웹 도구에서 이어서 채우도록 한다.
        distribution.servers.push({
            id: SERVER_ID,
            name: SERVER_ID,
            description: '',
            icon: '',
            version: '1.0.0',
            address: '',
            minecraftVersion: newServer.minecraftVersion || MC_VERSION || '',
            autoconnect: false,
            modules: newServer.modules || []
        })
        console.log(`새 서버 ${SERVER_ID}를 추가했습니다. distro-builder에서 이름/설명/주소 등을 마저 채워주세요.`)
    }

    const parts = (distribution.version || '1.0.0').split('.')
    const last = parseInt(parts[parts.length - 1], 10)
    parts[parts.length - 1] = String(isNaN(last) ? 1 : last + 1)
    distribution.version = parts.join('.')

    await putDistribution(workerBaseUrl, UPLOAD_SECRET, distribution, etag)
    console.log('distribution.json 업로드 완료.')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
