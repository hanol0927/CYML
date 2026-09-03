'use strict'

// distribution.json + 서버 자산 파일(모드/설정/배경/아이콘 등)을 R2에서 서빙/업로드하는
// Cloudflare Worker. GitHub Git Data API의 base64-in-JSON 방식이 가진 ~25-30MB 실질 업로드
// 한도를 대체한다 — 여기서는 요청 본문을 그대로 스트리밍해 R2에 저장하므로 base64 오버헤드가
// 없다. 다만 Cloudflare Workers 자체의 "요청 하나"당 본문 한도(요금제별로 100~200MiB 선)는
// 여전히 있어서, 그보다 큰 파일(최대 2GB 이상)은 아래 멀티파트 업로드 라우트로 여러 조각을
// 나눠 보낸다 — 각 조각은 Workers 요청 본문 한도 밑이지만, R2에 합쳐진 최종 오브젝트는
// R2의 실제 한도(5TiB)까지 커질 수 있다.

const DISTRIBUTION_KEY = 'distribution.json'

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
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
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
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
    // 관례상 클라이언트는 따옴표 붙은 값("abc123...")을 그대로 돌려보내는 게 정상이라
    // (실측 확인: 따옴표가 붙어 있으면 실제 일치 여부와 무관하게 형식 오류로 매번 실패함)
    // 여기서 방어적으로 벗겨준다.
    const ifMatch = request.headers.get('If-Match')?.replace(/^"|"$/g, '')
    const putOpts = { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    if (ifMatch) putOpts.onlyIf = { etagMatches: ifMatch }
    const result = await env.BUCKET.put(DISTRIBUTION_KEY, text, putOpts)
    if (result == null) return new Response('Precondition Failed (distribution.json changed concurrently)', { status: 412 })
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
