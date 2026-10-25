'use strict'

// distribution.json + 서버 자산 파일(모드/설정/배경/아이콘 등)을 R2에서 서빙/업로드하는
// Cloudflare Worker. GitHub Git Data API의 base64-in-JSON 방식이 가진 ~25-30MB 실질 업로드
// 한도를 대체한다 — 여기서는 요청 본문을 그대로 스트리밍해 R2에 저장하므로 base64 오버헤드가
// 없다. 다만 Cloudflare Workers 자체의 "요청 하나"당 본문 한도(요금제별로 100~200MiB 선)는
// 여전히 있어서, 그보다 큰 파일(최대 2GB 이상)은 아래 멀티파트 업로드 라우트로 여러 조각을
// 나눠 보낸다 — 각 조각은 Workers 요청 본문 한도 밑이지만, R2에 합쳐진 최종 오브젝트는
// R2의 실제 한도(5TiB)까지 커질 수 있다.

const DISTRIBUTION_KEY = 'distribution.json'
// 서버별 화이트리스트 편집 권한을 위임하는 키 목록. distribution.json과 같은 R2
// 버킷에 별도 오브젝트로 저장하고, distribution.json과 동일한 ETag 조건부 쓰기로
// 동시 편집 충돌을 막는다.
const WHITELIST_KEYS_KEY = 'whitelist-keys.json'

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400'
}

function withCors(resp) {
    const headers = new Headers(resp.headers)
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}

function checkAuth(request, env) {
    return request.headers.get('Authorization') === `Bearer ${env.UPLOAD_SECRET}`
}

// R2의 onlyIf.etagMatches는 따옴표 없는 원본 해시를 기대하지만 클라이언트/R2 양쪽 모두
// 따옴표(+ 엣지에서 붙는 약한 ETag 접두사 W/)가 붙은 값을 주고받는다 (putDistribution 위
// 주석 참고). 이 정리 로직을 whitelist 관련 오브젝트 쓰기에서도 재사용한다.
function stripEtag(value) {
    return value ? value.replace(/^W\//, '').replace(/^"|"$/g, '') : value
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomWhitelistKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    return 'wlk_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function loadWhitelistKeys(env) {
    const obj = await env.BUCKET.get(WHITELIST_KEYS_KEY)
    if (obj == null) return { keys: [], etag: null }
    const data = await obj.json()
    return { keys: Array.isArray(data.keys) ? data.keys : [], etag: obj.httpEtag }
}

function saveWhitelistKeys(env, keys, etag) {
    const putOpts = { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    if (etag) putOpts.onlyIf = { etagMatches: stripEtag(etag) }
    return env.BUCKET.put(WHITELIST_KEYS_KEY, JSON.stringify({ keys }, null, 2), putOpts)
}

// 요청의 Authorization 헤더를 화이트리스트 키로 해석해서 매칭되는 키 레코드를 반환한다
// (UPLOAD_SECRET과는 별개 — 이 키들은 위임된 화이트리스트 편집 권한만 가진다).
async function authenticateWhitelistKey(request, env) {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) return null
    const hash = await sha256Hex(auth.slice('Bearer '.length))
    const { keys } = await loadWhitelistKeys(env)
    return keys.find(k => k.hash === hash) || null
}

async function createWhitelistKey(request, env) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    let body
    try {
        body = JSON.parse(await request.text())
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 })
    }
    const serverIds = Array.isArray(body.serverIds) ? body.serverIds.filter(s => typeof s === 'string' && s) : []
    if (serverIds.length === 0) return new Response('serverIds가 최소 1개 필요합니다', { status: 400 })
    const label = typeof body.label === 'string' ? body.label.slice(0, 200) : ''

    for (let attempt = 0; attempt < 5; attempt++) {
        const { keys, etag } = await loadWhitelistKeys(env)
        const rawKey = randomWhitelistKey()
        const record = { id: crypto.randomUUID(), hash: await sha256Hex(rawKey), label, serverIds, createdAt: new Date().toISOString() }
        const result = await saveWhitelistKeys(env, [...keys, record], etag)
        if (result != null) {
            return new Response(JSON.stringify({ ok: true, id: record.id, key: rawKey, label, serverIds }),
                { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        // 동시에 다른 관리자가 키 목록을 바꾼 경우 — 최신 목록을 다시 읽어 재시도.
    }
    return new Response('키 생성 중 충돌이 반복돼 실패했습니다. 다시 시도하세요.', { status: 409 })
}

async function listWhitelistKeys(request, env) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    const { keys } = await loadWhitelistKeys(env)
    // 원본 키(hash 이전 값)는 생성 시 한 번만 응답에 실리고 서버에는 저장되지 않으므로,
    // 목록 조회에서는 해시를 제외한 메타데이터만 돌려준다.
    const safe = keys.map(({ id, label, serverIds, createdAt }) => ({ id, label, serverIds, createdAt }))
    return new Response(JSON.stringify({ ok: true, keys: safe }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function deleteWhitelistKey(id, request, env) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    for (let attempt = 0; attempt < 5; attempt++) {
        const { keys, etag } = await loadWhitelistKeys(env)
        const next = keys.filter(k => k.id !== id)
        if (next.length === keys.length) return new Response('Not Found', { status: 404 })
        const result = await saveWhitelistKeys(env, next, etag)
        if (result != null) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('키 삭제 중 충돌이 반복돼 실패했습니다. 다시 시도하세요.', { status: 409 })
}

async function getWhitelistAuth(request, env) {
    const record = await authenticateWhitelistKey(request, env)
    if (!record) return new Response('Unauthorized', { status: 401 })
    return new Response(JSON.stringify({ ok: true, label: record.label, serverIds: record.serverIds }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function putServerWhitelist(serverId, request, env) {
    const record = await authenticateWhitelistKey(request, env)
    if (!record) return new Response('Unauthorized', { status: 401 })
    if (!record.serverIds.includes(serverId)) return new Response('Forbidden: 이 키는 해당 서버 권한이 없습니다', { status: 403 })

    let body
    try {
        body = JSON.parse(await request.text())
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 })
    }
    if (!Array.isArray(body.whitelist) || !body.whitelist.every(v => typeof v === 'string')) {
        return new Response('whitelist는 문자열 배열이어야 합니다', { status: 400 })
    }
    const whitelist = body.whitelist.map(s => s.trim()).filter(Boolean)

    for (let attempt = 0; attempt < 5; attempt++) {
        const obj = await env.BUCKET.get(DISTRIBUTION_KEY)
        if (obj == null) return new Response('distribution.json이 없습니다', { status: 404 })
        const dist = await obj.json()
        const server = (dist.servers || []).find(s => s.id === serverId)
        if (!server) return new Response('서버를 찾을 수 없습니다', { status: 404 })
        server.whitelist = whitelist
        const result = await env.BUCKET.put(DISTRIBUTION_KEY, JSON.stringify(dist, null, 2), {
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            onlyIf: { etagMatches: stripEtag(obj.httpEtag) }
        })
        if (result != null) {
            return new Response(JSON.stringify({ ok: true, serverId, whitelist }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        // distribution.json이 그 사이 다른 곳에서 바뀜 — 최신 값을 다시 읽어 재시도.
    }
    return new Response('동시 편집 충돌이 반복돼 실패했습니다. 다시 시도하세요.', { status: 409 })
}

const CONTENT_TYPES = {
    json: 'application/json; charset=utf-8',
    jar: 'application/java-archive',
    zip: 'application/zip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    txt: 'text/plain; charset=utf-8',
    properties: 'text/plain; charset=utf-8',
    toml: 'text/plain; charset=utf-8',
    cfg: 'text/plain; charset=utf-8'
}

function contentTypeFor(key) {
    const ext = key.split('.').pop().toLowerCase()
    return CONTENT_TYPES[ext] || 'application/octet-stream'
}

async function getDistribution(env) {
    const obj = await env.BUCKET.get(DISTRIBUTION_KEY)
    if (obj == null) return new Response('Not Found', { status: 404 })
    // no-store: 브라우저가 조건부 재검증(If-None-Match)으로 처리하다가 등 그 어떤
    // 경로로도 오래된 ETag를 캐시에서 재사용하지 못하게 완전히 막는다 — 배포 직전
    // 재조회가 "진짜 최신" 임을 보장해야 하므로.
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    headers.set('ETag', obj.httpEtag)
    return new Response(obj.body, { status: 200, headers })
}

async function putDistribution(request, env) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    const text = await request.text()
    try {
        JSON.parse(text)
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 })
    }
    // R2의 onlyIf.etagMatches는 따옴표 없는 원본 해시를 기대하는데, HTTP ETag/If-Match
    // 관례상 클라이언트는 따옴표 붙은 값("abc123...")을 그대로 돌려보내는 게 정상이다
    // (실측 확인: 따옴표가 붙어 있으면 실제 일치 여부와 무관하게 형식 오류로 매번 실패함).
    // 게다가 Cloudflare 엣지가 응답을 지나가면서 강한 ETag를 약한 ETag(W/"...")로 자동
    // 변환하는 경우가 있어(실측 확인 — 우리는 obj.httpEtag로 강한 ETag를 보냈는데
    // 브라우저까지 가는 사이 W/ 접두사가 붙어서 도착함), W/ 접두사도 함께 벗겨야 한다.
    const ifMatch = stripEtag(request.headers.get('If-Match'))
    const putOpts = { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    if (ifMatch) putOpts.onlyIf = { etagMatches: ifMatch }
    const result = await env.BUCKET.put(DISTRIBUTION_KEY, text, putOpts)
    if (result == null) {
        // 디버깅용: 실제로 충돌났다면 클라이언트가 보낸 값과 현재 서버 값이 다를 것 —
        // 둘 다 응답에 실어서 정말 다른지, 아니면 또 다른 형식 문제인지 바로 확인 가능하게 한다.
        const current = await env.BUCKET.head(DISTRIBUTION_KEY)
        return new Response(JSON.stringify({
            error: 'Precondition Failed (distribution.json changed concurrently)',
            sentIfMatch: ifMatch || null,
            currentEtag: current ? current.etag : null
        }), { status: 412, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, etag: result.httpEtag }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function getAsset(key, env, headOnly) {
    const obj = await env.BUCKET.get(key)
    if (obj == null) return new Response('Not Found', { status: 404 })
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', contentTypeFor(key))
    headers.set('Content-Length', String(obj.size))
    headers.set('ETag', obj.httpEtag)
    headers.set('Cache-Control', 'public, max-age=3600')
    return new Response(headOnly ? null : obj.body, { status: 200, headers })
}

async function putAsset(key, request, env) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    if (request.body == null) return new Response('Empty body', { status: 400 })
    const result = await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType: contentTypeFor(key) }
    })
    return new Response(JSON.stringify({ ok: true, key, etag: result.httpEtag }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// ---- 멀티파트 업로드 (큰 파일용 — Workers 요청 본문 한도를 조각 단위로 우회) ----
// distro-builder가 파일을 여러 조각으로 나눠 순서대로 이 라우트들을 호출한다:
//   1) POST /files/<path>?mpu=create                                  -> { uploadId }
//   2) PUT  /files/<path>?mpu=uploadpart&uploadId=X&partNumber=N (body=조각 바이트)  -> { etag }  (N번 반복)
//   3) POST /files/<path>?mpu=complete&uploadId=X  body={"parts":[{"partNumber":1,"etag":"..."}, ...]}
//   실패 시 정리용: POST /files/<path>?mpu=abort&uploadId=X

async function createMultipartUpload(key, request, env) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    const upload = await env.BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType: contentTypeFor(key) }
    })
    return new Response(JSON.stringify({ ok: true, uploadId: upload.uploadId }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function uploadMultipartPart(key, request, env, uploadId, partNumber) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    if (!uploadId || !partNumber || Number.isNaN(partNumber)) return new Response('Bad Request', { status: 400 })
    if (request.body == null) return new Response('Empty body', { status: 400 })
    const upload = env.BUCKET.resumeMultipartUpload(key, uploadId)
    const part = await upload.uploadPart(partNumber, request.body)
    return new Response(JSON.stringify({ ok: true, partNumber: part.partNumber, etag: part.etag }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function completeMultipartUpload(key, request, env, uploadId) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    if (!uploadId) return new Response('Bad Request', { status: 400 })
    let body
    try {
        body = JSON.parse(await request.text())
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 })
    }
    if (!Array.isArray(body.parts) || body.parts.length === 0) return new Response('parts가 필요합니다', { status: 400 })
    const upload = env.BUCKET.resumeMultipartUpload(key, uploadId)
    const result = await upload.complete(body.parts)
    return new Response(JSON.stringify({ ok: true, key, etag: result.httpEtag }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function abortMultipartUpload(key, request, env, uploadId) {
    if (!checkAuth(request, env)) return new Response('Unauthorized', { status: 401 })
    if (!uploadId) return new Response('Bad Request', { status: 400 })
    const upload = env.BUCKET.resumeMultipartUpload(key, uploadId)
    await upload.abort()
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        const { pathname } = url

        if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))

        try {
            if (pathname === '/distribution.json') {
                if (request.method === 'GET') return withCors(await getDistribution(env))
                if (request.method === 'PUT') return withCors(await putDistribution(request, env))
                return withCors(new Response('Method Not Allowed', { status: 405 }))
            }

            // ---- 화이트리스트 위임 키 관리 (UPLOAD_SECRET 필요 — distro-builder 관리자 전용) ----
            if (pathname === '/admin/whitelist-keys') {
                if (request.method === 'POST') return withCors(await createWhitelistKey(request, env))
                if (request.method === 'GET') return withCors(await listWhitelistKeys(request, env))
                return withCors(new Response('Method Not Allowed', { status: 405 }))
            }
            if (pathname.startsWith('/admin/whitelist-keys/')) {
                const id = decodeURIComponent(pathname.slice('/admin/whitelist-keys/'.length))
                if (!id) return withCors(new Response('Bad Request', { status: 400 }))
                if (request.method === 'DELETE') return withCors(await deleteWhitelistKey(id, request, env))
                return withCors(new Response('Method Not Allowed', { status: 405 }))
            }

            // ---- 화이트리스트 위임 키로만 접근 가능 (whitelist.html 전용, UPLOAD_SECRET 불필요) ----
            if (pathname === '/whitelist-auth') {
                if (request.method === 'GET') return withCors(await getWhitelistAuth(request, env))
                return withCors(new Response('Method Not Allowed', { status: 405 }))
            }
            if (pathname.startsWith('/whitelist/')) {
                const serverId = decodeURIComponent(pathname.slice('/whitelist/'.length))
                if (!serverId || serverId.includes('/')) return withCors(new Response('Bad Request', { status: 400 }))
                if (request.method === 'PUT') return withCors(await putServerWhitelist(serverId, request, env))
                return withCors(new Response('Method Not Allowed', { status: 405 }))
            }

            if (pathname.startsWith('/files/')) {
                const key = decodeURIComponent(pathname.slice('/files/'.length))
                if (!key || key.includes('..')) return withCors(new Response('Bad Request', { status: 400 }))

                const mpu = url.searchParams.get('mpu')
                if (mpu != null) {
                    const uploadId = url.searchParams.get('uploadId')
                    if (mpu === 'create' && request.method === 'POST') {
                        return withCors(await createMultipartUpload(key, request, env))
                    }
                    if (mpu === 'uploadpart' && request.method === 'PUT') {
                        const partNumber = parseInt(url.searchParams.get('partNumber'), 10)
                        return withCors(await uploadMultipartPart(key, request, env, uploadId, partNumber))
                    }
                    if (mpu === 'complete' && request.method === 'POST') {
                        return withCors(await completeMultipartUpload(key, request, env, uploadId))
                    }
                    if (mpu === 'abort' && request.method === 'POST') {
                        return withCors(await abortMultipartUpload(key, request, env, uploadId))
                    }
                    return withCors(new Response('Bad Request', { status: 400 }))
                }

                if (request.method === 'GET' || request.method === 'HEAD') {
                    return withCors(await getAsset(key, env, request.method === 'HEAD'))
                }
                if (request.method === 'PUT') return withCors(await putAsset(key, request, env))
                return withCors(new Response('Method Not Allowed', { status: 405 }))
            }

            return withCors(new Response('Not Found', { status: 404 }))
        } catch (err) {
            return withCors(new Response(`Internal Error: ${err.message}`, { status: 500 }))
        }
    }
}
