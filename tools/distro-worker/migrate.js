'use strict'

// 기존 GitHub(ddumon의 distribution.json + 서버별 GitHub Pages 자산 저장소)에 있는 데이터를
// 새 Cloudflare Worker(R2)로 1회 복사하는 스크립트. GitHub 쪽은 읽기만 하고 절대 쓰지/지우지
// 않는다 — 순수 추가(additive) 작업이라 여러 번 다시 실행해도 안전하다(같은 R2 key를
// 덮어쓰는 방식).
//
// 사용법:
//   GITHUB_DISTRO_RAW_URL=https://raw.githubusercontent.com/hanol0927/ddumon/main/distribution.json \
//   WORKER_BASE_URL=https://cyml-distro-worker.<subdomain>.workers.dev \
//   UPLOAD_SECRET=<wrangler secret put에서 설정한 값> \
//   node migrate.js

const GITHUB_DISTRO_RAW_URL = process.env.GITHUB_DISTRO_RAW_URL
const WORKER_BASE_URL = (process.env.WORKER_BASE_URL || '').replace(/\/$/, '')
const UPLOAD_SECRET = process.env.UPLOAD_SECRET

if (!GITHUB_DISTRO_RAW_URL || !WORKER_BASE_URL || !UPLOAD_SECRET) {
    console.error('GITHUB_DISTRO_RAW_URL, WORKER_BASE_URL, UPLOAD_SECRET 환경변수가 모두 필요합니다.')
    process.exit(1)
}

// 이 호스트로 시작하는 URL만 이관 대상으로 삼는다. Fabric 라이브러리 등 업스트림 Maven
// URL(maven.fabricmc.net 등)은 distro-builder가 의도적으로 재호스팅하지 않으므로 건드리지 않는다.
const GITHUB_PAGES_HOST_SUFFIX = '.github.io'

function shouldMigrate(url) {
    if (typeof url !== 'string' || url === '') return false
    try {
        const u = new URL(url)
        return u.hostname.endsWith(GITHUB_PAGES_HOST_SUFFIX)
    } catch (e) {
        return false
    }
}

// https://<repo>.github.io/<owner-repo-name>/<rest...> -> <rest...>
// 첫 path segment는 "서버별 자산 저장소 이름"이었던 부분 — R2는 버킷 하나뿐이라 그 segment를 뺀
// 나머지를 그대로 R2 key로 재사용한다 (distro-builder가 쓰던 servers/<id>/... 구조를 보존).
function deriveKey(url) {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) throw new Error(`예상치 못한 URL 경로 구조: ${url}`)
    return parts.slice(1).map(decodeURIComponent).join('/')
}

async function fetchBytes(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`GET 실패 (${res.status}): ${url}`)
    return Buffer.from(await res.arrayBuffer())
}

async function uploadToWorker(key, bytes) {
    const res = await fetch(`${WORKER_BASE_URL}/files/${key.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${UPLOAD_SECRET}` },
        body: bytes
    })
    if (!res.ok) throw new Error(`업로드 실패 (${res.status}): ${key} - ${await res.text().catch(() => '')}`)
}

// HEAD 응답의 Content-Length는 Node의 fetch(undici)가 항상 그대로 넘겨주지 않는 걸
// 확인해서(작은 파일에서 실측됨), GET으로 실제 바이트 수를 받아 비교하는 방식으로 검증한다.
async function verifyUpload(key, expectedSize) {
    const res = await fetch(`${WORKER_BASE_URL}/files/${key.split('/').map(encodeURIComponent).join('/')}`)
    if (!res.ok) throw new Error(`검증 실패 (GET ${res.status}): ${key}`)
    const len = (await res.arrayBuffer()).byteLength
    if (len !== expectedSize) {
        throw new Error(`검증 실패 (크기 불일치): ${key} 원본 ${expectedSize} bytes, 업로드본 ${len} bytes`)
    }
}

// distribution.json 안에서 이관 대상 URL이 들어있는 모든 위치를 모은다.
// 각 항목은 { get, set } 클로저로 표현 — 원본 객체를 직접 들고 있지 않아도 되게 한다.
function collectUrlRefs(distribution) {
    const refs = []
    const pushIfMigratable = (obj, key) => {
        if (shouldMigrate(obj[key])) refs.push({ get: () => obj[key], set: v => { obj[key] = v } })
    }

    function walkModules(modules) {
        if (!Array.isArray(modules)) return
        for (const mod of modules) {
            if (mod.artifact) pushIfMigratable(mod.artifact, 'url')
            if (Array.isArray(mod.subModules)) walkModules(mod.subModules)
        }
    }

    for (const server of distribution.servers || []) {
        pushIfMigratable(server, 'icon')
        pushIfMigratable(server, 'background')
        walkModules(server.modules)
        for (const entry of server.onceFiles || []) {
            pushIfMigratable(entry, 'url')
        }
    }

    return refs
}

async function main() {
    console.log(`distribution.json 조회 중: ${GITHUB_DISTRO_RAW_URL}`)
    const distroRes = await fetch(GITHUB_DISTRO_RAW_URL)
    if (!distroRes.ok) throw new Error(`distribution.json 조회 실패: ${distroRes.status}`)
    const distribution = await distroRes.json()

    const refs = collectUrlRefs(distribution)
    console.log(`이관 대상 파일 ${refs.length}개 발견`)

    let done = 0
    let totalBytes = 0
    for (const ref of refs) {
        const url = ref.get()
        const key = deriveKey(url)
        process.stdout.write(`[${done + 1}/${refs.length}] ${key} ... `)
        const bytes = await fetchBytes(url)
        await uploadToWorker(key, bytes)
        await verifyUpload(key, bytes.length)
        ref.set(`${WORKER_BASE_URL}/files/${key}`)
        totalBytes += bytes.length
        done++
        console.log(`완료 (${bytes.length} bytes)`)
    }

    console.log(`\n모든 파일 이관 완료: ${done}개, 총 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
    console.log('distribution.json 업로드 중...')

    const putRes = await fetch(`${WORKER_BASE_URL}/distribution.json`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${UPLOAD_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(distribution, null, 2)
    })
    if (!putRes.ok) throw new Error(`distribution.json 업로드 실패: ${putRes.status} ${await putRes.text().catch(() => '')}`)

    console.log(`완료! 새 distribution.json: ${WORKER_BASE_URL}/distribution.json`)
    console.log('GitHub 쪽 데이터는 전혀 건드리지 않았습니다 — 그대로 남아있습니다.')
}

main().catch(err => {
    console.error(`\n마이그레이션 실패: ${err.message}`)
    console.error('distribution.json은 아직 Worker에 쓰지 않았습니다 — 안전하게 중단되었습니다. 문제를 고친 뒤 다시 실행하세요(이미 업로드된 파일은 재업로드되어도 안전합니다).')
    process.exit(1)
})
