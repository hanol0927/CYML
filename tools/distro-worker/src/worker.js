'use strict'

// distribution.json + 서버 자산 파일(모드/설정/배경/아이콘 등)을 R2에서 서빙/업로드하는
// Cloudflare Worker. GitHub Git Data API의 base64-in-JSON 방식이 가진 ~25-30MB 실질 업로드
// 한도를 대체한다 — 여기서는 요청 본문을 그대로 스트리밍해 R2에 저장하므로 base64 오버헤드가
// 없고, Cloudflare Workers의 요청 본문 한도(Free/Pro 100MiB)까지 그대로 업로드 가능하다.

const DISTRIBUTION_KEY = 'distribution.json'

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
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
    const ifMatch = request.headers.get('If-Match')
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

export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url)

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
