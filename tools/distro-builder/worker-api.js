/*
 * distro-worker(Cloudflare Worker + R2)와 통신하는 최소 fetch() 래퍼.
 * 빌드 스텝 없음 — github-api.js와 같은 방식의 전역 노출 IIFE.
 * base64 인코딩 없이 원본 바이트를 그대로 업로드/다운로드한다.
 */
(function(global) {
    'use strict'

    // Cloudflare Workers의 요청 본문 한도(요금제별로 100~200MiB 선)보다 안전하게 작은
    // 값. 이보다 큰 파일은 멀티파트 업로드(여러 조각으로 나눠 순차 PUT)로 전환한다.
    const MULTIPART_THRESHOLD_BYTES = 80 * 1024 * 1024
    const MULTIPART_CHUNK_BYTES = 40 * 1024 * 1024

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

    function byteLengthOf(bytesOrFile) {
        return bytesOrFile instanceof Blob ? bytesOrFile.size : bytesOrFile.length
    }

    function sliceOf(bytesOrFile, start, end) {
        return bytesOrFile instanceof Blob ? bytesOrFile.slice(start, end) : bytesOrFile.subarray(start, end)
    }

    async function putSingleShot(workerBaseUrl, secret, path, bytesOrFile) {
        const res = await fetch(`${workerBaseUrl}/files/${encodePath(path)}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${secret}` },
            body: bytesOrFile
        })
        if (!res.ok) throw new Error(`업로드 실패 (${path}): ${res.status} ${await res.text().catch(() => '')}`)
        return res.json()
    }

    /**
     * 큰 파일을 MULTIPART_CHUNK_BYTES 단위로 나눠 R2 멀티파트 업로드로 올린다.
     * 실패 시 그때까지 만든 멀티파트 업로드를 최선을 다해(abort 실패는 무시) 정리한다.
     */
    async function putMultipart(workerBaseUrl, secret, path, bytesOrFile, onPartProgress) {
        const encodedPath = encodePath(path)
        const authHeaders = { 'Authorization': `Bearer ${secret}` }
        const base = `${workerBaseUrl}/files/${encodedPath}`

        const createRes = await fetch(`${base}?mpu=create`, { method: 'POST', headers: authHeaders })
        if (!createRes.ok) throw new Error(`멀티파트 업로드 시작 실패 (${path}): ${createRes.status} ${await createRes.text().catch(() => '')}`)
        const { uploadId } = await createRes.json()

        const totalBytes = byteLengthOf(bytesOrFile)
        const totalParts = Math.ceil(totalBytes / MULTIPART_CHUNK_BYTES)
        const parts = []

        try {
            for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
                const start = (partNumber - 1) * MULTIPART_CHUNK_BYTES
                const end = Math.min(start + MULTIPART_CHUNK_BYTES, totalBytes)
                const chunk = sliceOf(bytesOrFile, start, end)
                const partRes = await fetch(`${base}?mpu=uploadpart&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, {
                    method: 'PUT',
                    headers: authHeaders,
                    body: chunk
                })
                if (!partRes.ok) throw new Error(`멀티파트 조각 업로드 실패 (${path}, part ${partNumber}/${totalParts}): ${partRes.status} ${await partRes.text().catch(() => '')}`)
                const { etag } = await partRes.json()
                parts.push({ partNumber, etag })
                if (onPartProgress) onPartProgress(partNumber, totalParts)
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
        if (!completeRes.ok) throw new Error(`멀티파트 업로드 완료 실패 (${path}): ${completeRes.status} ${await completeRes.text().catch(() => '')}`)
        return completeRes.json()
    }

    /**
     * @param {string} path R2 key (예: servers/Ssachon-1.21.1/forgemods/foo.jar)
     * @param {Uint8Array|Blob|File} bytesOrFile 업로드할 원본 바이트 (base64 아님)
     * @param {(part: number, totalParts: number) => void} [onPartProgress] 멀티파트일 때만 호출됨
     */
    async function uploadFile(workerBaseUrl, secret, path, bytesOrFile, onPartProgress) {
        if (byteLengthOf(bytesOrFile) > MULTIPART_THRESHOLD_BYTES) {
            return putMultipart(workerBaseUrl, secret, path, bytesOrFile, onPartProgress)
        }
        return putSingleShot(workerBaseUrl, secret, path, bytesOrFile)
    }

    /**
     * @param {Array<{path: string, bytes: Uint8Array}>} files
     * @param {(done: number, total: number) => void} [onProgress]
     * @param {(path: string, part: number, totalParts: number) => void} [onPartProgress] 멀티파트 조각 단위 진행률
     */
    async function uploadFilesSequential(workerBaseUrl, secret, files, onProgress, onPartProgress) {
        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            await uploadFile(workerBaseUrl, secret, f.path, f.bytes,
                onPartProgress ? (part, totalParts) => onPartProgress(f.path, part, totalParts) : undefined)
            if (onProgress) onProgress(i + 1, files.length)
        }
    }

    global.WorkerAPI = { getDistribution, putDistribution, uploadFile, uploadFilesSequential, MULTIPART_THRESHOLD_BYTES }
})(window)
