/*
 * Minimal GitHub REST API wrapper for the distro-builder tool.
 * No build step, no dependencies — plain fetch() against api.github.com.
 * GitHub's API supports CORS for browser requests as long as only
 * Authorization / Accept / Content-Type headers are sent (no custom
 * headers like X-GitHub-Api-Version, which aren't in the CORS allowlist).
 *
 * distribution.json과 자산 파일(모드/설정/배경/아이콘) 업로드는 더 이상 GitHub를 쓰지
 * 않는다(25~30MB 업로드 한도 때문에 Cloudflare Worker+R2로 옮김, worker-api.js 참고).
 * 이 파일에는 Forge/NeoForge 로더 자동 생성용 GitHub Actions 워크플로우 호출 기능만
 * 남아있다 — NeoNebula 실행에 JVM이 필요해 브라우저/Worker로 옮길 수 없는 부분이다.
 */
(function(global) {
    'use strict'

    const GITHUB_API = 'https://api.github.com'

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

    global.GitHubAPI = { dispatchWorkflow, findRunSince, getWorkflowRun }
})(window)
