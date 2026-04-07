$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- 配置 ----------
$packRoot      = "D:\work\github\aa"
$releaseDir    = "$packRoot\deskclaw\release\win"
$scriptDir     = $PSScriptRoot

# ---------- 加载 .env（独立运行时） ----------
if (-not $env:TOS_ACCESS_KEY_ID) {
    $envFile = Join-Path (Split-Path $scriptDir -Parent | Split-Path -Parent) ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
                [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process")
            }
        }
    }
}

# ---------- 前置检查 ----------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Output "[错误] 未找到 node，请先安装 Node.js"
    exit 1
}

if (-not $env:TOS_ACCESS_KEY_ID -or -not $env:TOS_SECRET_ACCESS_KEY) {
    Write-Output "[错误] 未设置 TOS_ACCESS_KEY_ID 或 TOS_SECRET_ACCESS_KEY 环境变量"
    Write-Output "       请在项目根目录 .env 文件中配置，或设置系统环境变量"
    exit 1
}

# ---------- 1. 打包 ----------
Write-Output "[打包] 开始执行 pack.ps1 ..."
Set-Location $packRoot
& .\pack.ps1
Write-Output "[打包] 完成"

# ---------- 2. 扫描产物 ----------
if (-not (Test-Path $releaseDir)) {
    Write-Output "[错误] 打包产物目录不存在: $releaseDir"
    exit 1
}

$latestExe = Get-ChildItem $releaseDir -File -Filter "*.exe" |
             Sort-Object LastWriteTime -Descending |
             Select-Object -First 1

if (-not $latestExe) {
    Write-Output "[错误] 未找到 .exe 文件"
    exit 1
}

$sizeMB = [math]::Round($latestExe.Length / 1MB, 2)
Write-Output "[扫描] 最新文件: $($latestExe.Name) ($sizeMB MB)"

# ---------- 3. 上传到 TOS ----------
Write-Output "[上传] 开始上传 ..."
node "$scriptDir\upload-to-tos.js" $latestExe.FullName

if ($LASTEXITCODE -ne 0) {
    Write-Output "[错误] 上传失败"
    exit 1
}

Write-Output "[完成] 全部步骤执行成功"
