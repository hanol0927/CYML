@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ===============================
echo  CYML 런처 설치파일 빌드
echo ===============================
echo.

if not exist node_modules (
    echo [1/2] 의존성 설치 중... (node_modules가 없어서 처음 한 번만 실행됩니다)
    call npm install
    if errorlevel 1 (
        echo.
        echo 의존성 설치에 실패했습니다.
        pause
        exit /b 1
    )
) else (
    echo [1/2] 의존성이 이미 설치되어 있어 건너뜁니다.
)

echo.
echo [2/2] 설치파일 빌드 중... (몇 분 걸릴 수 있습니다)
call npx electron-builder build -w --publish never
if errorlevel 1 (
    echo.
    echo 빌드에 실패했습니다. 위 로그를 확인하세요.
    pause
    exit /b 1
)

echo.
echo ===============================
echo  빌드 완료!
echo  결과물 위치: dist 폴더 (CYML-setup-버전.exe)
echo ===============================
echo.

explorer "%~dp0dist"

pause
