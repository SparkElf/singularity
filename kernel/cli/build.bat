@echo off
echo.
echo Building SiYuan CLI
echo.
cd /d "%~dp0..\"
if errorlevel 1 (
    exit /b %errorlevel%
)

set GO111MODULE=on
set CGO_ENABLED=1

if "%1"=="" (
    set TARGET=local
) else (
    set TARGET=%1
)

if "%TARGET%"=="local" (
    echo Building for local platform...
    go build -tags fts5 -ldflags "-s -w" -o siyuan.exe ./cli
    if errorlevel 1 (
        echo Build failed
        exit /b %errorlevel%
    )
    echo Done: siyuan.exe
    goto :end
)

if "%TARGET%"=="windows" (
    echo Building Windows amd64...
    set GOOS=windows
    set GOARCH=amd64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-win-amd64.exe ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-win-amd64.exe
)

if "%TARGET%"=="linux" (
    echo Building Linux amd64...
    set GOOS=linux
    set GOARCH=amd64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-linux-amd64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-linux-amd64

    echo Building Linux arm64...
    set GOOS=linux
    set GOARCH=arm64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-linux-arm64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-linux-arm64
)

if "%TARGET%"=="darwin" (
    echo Building macOS amd64...
    set GOOS=darwin
    set GOARCH=amd64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-darwin-amd64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-darwin-amd64

    echo Building macOS arm64...
    set GOOS=darwin
    set GOARCH=arm64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-darwin-arm64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-darwin-arm64
)

if "%TARGET%"=="all" (
    call :build_windows
    call :build_linux
    call :build_darwin
    goto :end
)

goto :end

:build_windows
    echo Building Windows amd64...
    set GOOS=windows
    set GOARCH=amd64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-win-amd64.exe ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-win-amd64.exe
    exit /b

:build_linux
    echo Building Linux amd64...
    set GOOS=linux
    set GOARCH=amd64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-linux-amd64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-linux-amd64

    echo Building Linux arm64...
    set GOOS=linux
    set GOARCH=arm64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-linux-arm64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-linux-arm64
    exit /b

:build_darwin
    echo Building macOS amd64...
    set GOOS=darwin
    set GOARCH=amd64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-darwin-amd64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-darwin-amd64

    echo Building macOS arm64...
    set GOOS=darwin
    set GOARCH=arm64
    go build -tags fts5 -ldflags "-s -w" -o siyuan-darwin-arm64 ./cli
    if errorlevel 1 ( exit /b %errorlevel% )
    echo Done: siyuan-darwin-arm64
    exit /b

:end
echo.
echo Build complete.
