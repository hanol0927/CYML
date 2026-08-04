/*
 * Minimal GitHub REST API wrapper for the distro-builder tool.
 * No build step, no dependencies — plain fetch() against api.github.com.
 * GitHub's API supports CORS for browser requests as long as only
 * Authorization / Accept / Content-Type headers are sent (no custom
 * headers like X-GitHub-Api-Version, which aren't in the CORS allowlist).
 */
(function(global) {
    'use strict'

    const GITHUB_API = 'https://api.github.com'

    function utf8ToBase64(text) {
        // btoa() only handles latin1; this is the standard no-dependency
        // way to base64-encode arbitrary UTF-8 text (e.g. Korean strings)
        // in a browser without a bundler.
        return btoa(unescape(encodeURIComponent(text)))
    }

    function base64ToUtf8(base64) {
        return decodeURIComponent(escape(atob(base64.replace(/\n/g, ''))))
    }

    async function ghRequest(token, method, path, body) {
        const res = await fetch(GITHUB_API + path, {
            method,
            headers: Object.assign(
                {
                    'Authorization': 'Bearer ' + token,
                    'Accept': 'application/vnd.github+json'
                },
                body != null ? { 'Content-Type': 'application/json' } : {}
            ),
            body: body != null ? JSON.stringify(body) : undefined
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const err = new Error(`GitHub API ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`)
            err.status = res.status
            throw err
        }
        if (res.status === 204) return null
        return res.json()
    }

    // ---- Contents API: small files (distribution.json) ----

    /**
     * @returns {Promise<{content: string, sha: string}|null>} null if the file doesn't exist yet
     */
    async function getFile(token, owner, repo, path, branch) {
        try {
            const data = await ghRequest(token, 'GET',
                `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`)
            return { content: base64ToUtf8(data.content), sha: data.sha }
        } catch (err) {
            if (err.status === 404) return null
            throw err
        }
    }

    /**
     * @param {string|null} sha Existing file's sha (from getFile), or null/undefined to create a new file.
     */
    async function putFile(token, owner, repo, path, contentText, message, sha, branch) {
        return ghRequest(token, 'PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
            message,
            content: utf8ToBase64(contentText),
            sha: sha || undefined,
            branch
        })
    }

    // ---- Git Data API: batched multi-file commit (mods, configs, background) ----

    async function getBranchTip(token, owner, repo, branch) {
        const ref = await ghRequest(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
        const commit = await ghRequest(token, 'GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)
        return { commitSha: ref.object.sha, treeSha: commit.tree.sha }
    }

    async function createBlob(token, owner, repo, base64Content) {
        const blob = await ghRequest(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: base64Content,
            encoding: 'base64'
        })
        return blob.sha
    }

    /**
     * Commits multiple binary files in ONE commit via the Git Data API
     * (blob -> tree -> commit -> ref update), instead of one Contents-API
     * commit per file. Untouched existing files are preserved automatically
     * via base_tree.
     *
     * @param {Array<{path: string, base64Content: string}>} files
     * @param {(done: number, total: number) => void} [onProgress]
     * @returns {Promise<string>} the new commit sha
     */
    async function commitFilesBatch(token, owner, repo, branch, files, message, onProgress) {
        if (files.length === 0) return null

        const { commitSha, treeSha } = await getBranchTip(token, owner, repo, branch)

        // Blobs are created one at a time (not Promise.all) to avoid GitHub's
        // secondary/abuse-detection rate limiting on bursts of mutating requests.
        const treeEntries = []
        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            const blobSha = await createBlob(token, owner, repo, f.base64Content)
            treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blobSha })
            if (onProgress) onProgress(i + 1, files.length)
        }

        const newTree = await ghRequest(token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
            base_tree: treeSha,
            tree: treeEntries
        })
        const newCommit = await ghRequest(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
            message,
            tree: newTree.sha,
            parents: [commitSha]
        })
        await ghRequest(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
            sha: newCommit.sha
        })
        return newCommit.sha
    }

    // ---- Actions API: Forge/NeoForge 로더 자동 생성 워크플로우 트리거/폴링 ----
    // 브라우저 쪽 PAT에 "Actions: Read and write" 권한이 추가로 필요하다.

    /**
     * @param {Object} inputs workflow_dispatch inputs (문자열 값만 지원)
     */
    async function dispatchWorkflow(token, owner, repo, workflowFile, ref, inputs) {
        await ghRequest(token, 'POST', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, {
            ref,
            inputs
        })
    }

    /**
     * dispatch 이후 새로 생긴 workflow run을 찾는다. workflow_dispatch 자체는 run id를
     * 돌려주지 않아서(204 No Content), sinceMs 이후 생성된 run 중 가장 최근 것을 찾는
     * 방식으로 대응한다.
     */
    async function findRunSince(token, owner, repo, workflowFile, sinceMs) {
        const data = await ghRequest(token, 'GET',
            `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&per_page=5`)
        const runs = (data.workflow_runs || []).filter(r => new Date(r.created_at).getTime() >= sinceMs)
        if (runs.length === 0) return null
        return runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    }

    async function getWorkflowRun(token, owner, repo, runId) {
        return ghRequest(token, 'GET', `/repos/${owner}/${repo}/actions/runs/${runId}`)
    }

    global.GitHubAPI = { getFile, putFile, commitFilesBatch, dispatchWorkflow, findRunSince, getWorkflowRun, utf8ToBase64 }
})(window)
