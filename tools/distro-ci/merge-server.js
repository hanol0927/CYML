'use strict'

/*
 * generate-server.yml의 마지막 단계에서 실행된다.
 *
 * NeoNebula가 방금 만든(이번 실행 한정, 서버 하나짜리) distribution.json에서 그
 * 서버 객체 하나만 꺼내서:
 *   1. 그 서버가 참조하는 실제 바이너리 파일들을 자산 저장소(ASSET_REPO)에 커밋
 *   2. ddumon(DISTRO_REPO)의 distribution.json을 다시 불러와 그 서버 id만
 *      안전하게 upsert (다른 서버, 그리고 distro-builder가 관리하는 whitelist/
 *      background/icon/onceFiles/모드 모듈은 절대 건드리지 않음)
 *
 * ⚠️ NeoNebula의 ROOT 디렉터리 내부 레이아웃을 문서만으로 완전히 확인하지
 * 못했다. locateGeneratedFile()의 경로 가정이 이 스크립트에서 가장 깨지기
 * 쉬운 지점 — 실제 실행 로그를 보고 조정해야 할 가능성이 높다.
 *
 * Node 20 기준(전역 fetch 사용), 외부 npm 의존성 없음.
 */

const fs = require('fs')
const path = require('path')

const GITHUB_API = 'https://api.github.com'

const {
    GH_TOKEN,
    OWNER,
    DISTRO_REPO,
    ASSET_REPO,
    BRANCH,
    BASE_URL,
    SERVER_ID,
    MC_VERSION,
    ROOT_DIR
} = process.env

// distribution.json에서 "로더가 소유한" 모듈 타입 — NeoNebula가 새로 생성해준
// 서버에는 이 타입들만 들어있다고 가정한다(모드/설정 파일은 없음). 기존 서버를
// 다시 생성(로더 버전 업데이트)한 경우, 이 타입들만 새 것으로 교체하고 나머지
// (ForgeMod/FabricMod/File 등, distro-builder가 관리)는 그대로 둔다.
const LOADER_OWNED_TYPES = new Set(['Forge', 'ForgeHosted', 'Fabric', 'VersionManifest', 'Library'])

function required(name, value) {
    if (!value) throw new Error(`환경변수 ${name}가 없습니다.`)
    return value
}

async function ghRequest(method, apiPath, body) {
    const res = await fetch(GITHUB_API + apiPath, {
        method,
        headers: Object.assign(
            {
                'Authorization': 'Bearer ' + GH_TOKEN,
                'Accept': 'application/vnd.github+json'
            },
            body != null ? { 'Content-Type': 'application/json' } : {}
        ),
        body: body != null ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        const err = new Error(`GitHub API ${method} ${apiPath} failed: ${res.status} ${res.statusText} ${text}`)
        err.status = res.status
        throw err
    }
    if (res.status === 204) return null
    return res.json()
}

async function getFile(owner, repo, filePath, branch) {
    try {
        const data = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`)
        return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha }
    } catch (err) {
        if (err.status === 404) return null
        throw err
    }
}

async function putFile(owner, repo, filePath, contentText, message, sha, branch) {
    return ghRequest('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, {
        message,
        content: Buffer.from(contentText, 'utf8').toString('base64'),
        sha: sha || undefined,
        branch
    })
}

async function commitFilesBatch(owner, repo, branch, files, message) {
    if (files.length === 0) return null
    const ref = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
    const baseCommit = await ghRequest('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)

    const treeEntries = []
    for (const f of files) {
        const blob = await ghRequest('POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: f.base64Content,
            encoding: 'base64'
        })
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha })
        console.log(`  blob 생성: ${f.path}`)
    }

    const newTree = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeEntries
    })
    const newCommit = await ghRequest('POST', `/repos/${owner}/${repo}/git/commits`, {
        message,
        tree: newTree.sha,
        parents: [ref.object.sha]
    })
    await ghRequest('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: newCommit.sha
    })
    return newCommit.sha
}

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
    throw new Error(`ROOT(${rootDir})에서 생성된 distribution.json을 찾지 못했습니다. NeoNebula의 출력 경로가 예상과 다른 것 같습니다 — 워크플로우 로그의 파일 목록을 확인하세요.`)
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
 * BASE_URL이 "ROOT의 내용물이 서빙될 주소"라는 전제(NeoNebula README 기준)를
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
    required('GH_TOKEN', GH_TOKEN)
    required('OWNER', OWNER)
    required('DISTRO_REPO', DISTRO_REPO)
    required('ASSET_REPO', ASSET_REPO)
    required('BASE_URL', BASE_URL)
    required('SERVER_ID', SERVER_ID)
    required('ROOT_DIR', ROOT_DIR)
    const branch = BRANCH || 'main'

    const generatedPath = locateGeneratedDistribution(ROOT_DIR)
    console.log(`생성된 distribution.json: ${generatedPath}`)
    const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'))
    const generatedServers = generated.servers || []
    const newServer = generatedServers.find(s => s.id === SERVER_ID) || generatedServers[0]
    if (newServer == null) {
        throw new Error('생성된 distribution.json에 서버가 하나도 없습니다.')
    }
    console.log(`대상 서버: ${newServer.id} (모듈 ${(newServer.modules || []).length}개)`)

    // 1) 이 서버가 참조하는 실제 바이너리 파일들을 자산 저장소로 커밋.
    const filesToCommit = []
    collectModuleFiles(newServer.modules || [], filesToCommit)
    if (filesToCommit.length > 0) {
        console.log(`자산 저장소(${ASSET_REPO})에 파일 ${filesToCommit.length}개 커밋 중..`)
        const assetFiles = filesToCommit.map(f => ({
            path: f.url.slice(BASE_URL.length).replace(/^\/+/, ''),
            base64Content: fs.readFileSync(f.localPath).toString('base64')
        }))
        await commitFilesBatch(OWNER, ASSET_REPO, branch, assetFiles, `distro-ci: generate loader for ${SERVER_ID}`)
        console.log('자산 커밋 완료.')
    } else {
        console.warn('커밋할 자산 파일이 하나도 없습니다 — urlToLocalPath 매핑을 확인하세요.')
    }

    // 2) ddumon의 distribution.json에 이 서버 하나만 안전하게 upsert.
    console.log(`${DISTRO_REPO}/distribution.json 불러오는 중..`)
    const file = await getFile(OWNER, DISTRO_REPO, 'distribution.json', branch)
    const distribution = file ? JSON.parse(file.content) : { version: '1.0.0', servers: [] }
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

    await putFile(
        OWNER, DISTRO_REPO, 'distribution.json',
        JSON.stringify(distribution, null, 2),
        `distro-ci: generate loader for ${SERVER_ID}`,
        file ? file.sha : null,
        branch
    )
    console.log('distribution.json 커밋 완료.')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
