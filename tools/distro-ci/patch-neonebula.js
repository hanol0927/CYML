'use strict'

/*
 * "Install & build NeoNebula" 스텝 이전에 실행된다.
 *
 * NeoNebula의 ForgeGradle3Adapter(구식 Forge, FG3)는 인스톨러를 인자 없이
 * `java -jar installer.jar`로 띄워서 사람이 GUI에서 설치 경로를 직접 입력하고
 * 클릭해주길 기다린다 — GitHub Actions(디스플레이 없음)에서는 항상 실패한다.
 *
 * 반면 같은 저장소의 NeoForgeResolver는 이미
 *   `java -jar installer.jar --installClient <경로>`
 * 로 실행해서 GUI 없이 헤드리스로 설치한다. 실제 Forge 인스톨러
 * (MinecraftForge/Installer, 기본 브랜치 `2.0`)의 SimpleInstaller.java를
 * 확인해보면 `--installClient`가 정식으로 지원되는 CLI 옵션이다 — FG3Adapter가
 * 그냥 이 옵션을 안 쓰고 있을 뿐이다.
 *
 * 이 스크립트는 ForgeGradle3.resolver.ts의 executeInstaller 호출부를 NeoForge와
 * 동일한 방식으로 패치해서, Forge도 GUI 없이 헤드리스로 설치되게 만든다.
 *
 * NeoNebula 소스가 바뀌어서 아래 문자열이 더 이상 안 맞으면(치환 대상을 못 찾으면)
 * 조용히 넘어가지 않고 바로 에러로 죽는다 — 그래야 다음에 사람이 로그를 보고
 * 이 패치를 다시 손봐야 한다는 걸 바로 알 수 있다.
 */

const fs = require('fs')
const path = require('path')

const TARGET = path.join(__dirname, 'neonebula', 'src', 'resolver', 'forge', 'adapter', 'ForgeGradle3.resolver.ts')

function replaceOnce(source, oldStr, newStr, label) {
    const first = source.indexOf(oldStr)
    if (first === -1) {
        throw new Error(`패치 실패 (${label}): 예상한 코드를 못 찾았습니다. NeoNebula 소스가 바뀐 것 같습니다 — patch-neonebula.js를 다시 확인하세요.\n찾던 문자열:\n${oldStr}`)
    }
    if (source.indexOf(oldStr, first + oldStr.length) !== -1) {
        throw new Error(`패치 실패 (${label}): 대상 문자열이 여러 곳에서 발견되어 안전하게 치환할 수 없습니다.`)
    }
    return source.slice(0, first) + newStr + source.slice(first + oldStr.length)
}

function main() {
    if (!fs.existsSync(TARGET)) {
        throw new Error(`패치 대상 파일을 찾지 못했습니다: ${TARGET}`)
    }

    let source = fs.readFileSync(TARGET, 'utf8')

    source = replaceOnce(
        source,
        'await this.executeInstaller(workingInstaller)',
        'await this.executeInstaller(workingInstaller, installerOutputDir)',
        '설치 실행 호출부'
    )

    source = replaceOnce(
        source,
        `    private executeInstaller(installerExec: string): Promise<void> {
        return new Promise(resolve => {
            const fiLogger = LoggerUtil.getLogger('Forge Installer')
            const child = spawn(JavaUtil.getJavaExecutable(), [
                '-jar',
                installerExec
            ], {
                cwd: dirname(installerExec)
            })`,
        `    private executeInstaller(installerExec: string, installerOutputDir: string): Promise<void> {
        return new Promise(resolve => {
            const fiLogger = LoggerUtil.getLogger('Forge Installer')
            const child = spawn(JavaUtil.getJavaExecutable(), [
                '-jar',
                installerExec,
                '--installClient',
                installerOutputDir
            ], {
                cwd: dirname(installerExec)
            })`,
        'executeInstaller 스폰 인자'
    )

    source = replaceOnce(
        source,
        `            ForgeGradle3Adapter.logger.info('============== [ IMPORTANT ] ==============')
            ForgeGradle3Adapter.logger.info('When the installer opens please set the client installation directory to:')
            ForgeGradle3Adapter.logger.info(installerOutputDir)
            ForgeGradle3Adapter.logger.info('===========================================')`,
        `            ForgeGradle3Adapter.logger.debug(\`Installing headlessly (--installClient) to \${installerOutputDir}\`)`,
        '안내 로그 메시지'
    )

    fs.writeFileSync(TARGET, source)
    console.log(`패치 완료: ${TARGET}`)
    console.log('Forge 설치를 --installClient로 헤드리스 실행하도록 변경했습니다.')
}

main()
