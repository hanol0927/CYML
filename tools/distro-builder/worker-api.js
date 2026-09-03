/*
 * distro-worker(Cloudflare Worker + R2)와 통신하는 최소 fetch() 래퍼.
 * 빌드 스텝 없음 — github-api.js와 같은 방식의 전역 노출 IIFE.
 * base64 인코딩 없이 원본 바이트를 그대로 업로드/다운로드한다.
 */
(function(global) {
    'use strict'

    async function getDistribution(workerBaseUrl) {
        const res = await fetch(`${workerBaseUrl}/distribution.json`)
        if (res.status === 404) return { distribution: { version: '1.0.0', servers: [] }, etag: null }
        if (!res.ok) throw new Error(`distribution.json 조회 실패: ${res.status}`)
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
            const err = new Error('distribution.json이 그 사이 다른 곳에서 변경되었습니다. 새로고침 후 다시 시도하세요.')
            err.status = 412
            throw err
        }
        if (!res.ok) throw new Error(`distribution.json 업로드 실패: ${res.status} ${await res.text().catch(() => '')}`)
        return res.json()
    }

    function encodePath(path) {
        return path.split('/').map(encodeURIComponent).join('/')
    }

    /**
     * @param {string} path R2 key (예: servers/Ssachon-1.21.1/forgemods/foo.jar)
     * @param {Uint8Array|Blob|File} bytesOrFile 업로드할 원본 바이트 (base64 아님)
     */
    async function uploadFile(workerBaseUrl, secret, path, bytesOrFile) {
        const res = await fetch(`${workerBaseUrl}/files/${encodePath(path)}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${secret}` },
            body: bytesOrFile
        })
        if (!res.ok) throw new Error(`업로드 실패 (${path}): ${res.status} ${await res.text().catch(() => '')}`)
        return res.json()
    }

    /**
     * @param {Array<{path: string, bytes: Uint8Array}>} files
     * @param {(done: number, total: number) => void} [onProgress]
     */
    async function uploadFilesSequential(workerBaseUrl, secret, files, onProgress) {
        for (let i = 0; i < files.length; i++) {
            await uploadFile(workerBaseUrl, secret, files[i].path, files[i].bytes)
            if (onProgress) onProgress(i + 1, files.length)
        }
    }

    global.WorkerAPI = { getDistribution, putDistribution, uploadFile, uploadFilesSequential }
})(window)
