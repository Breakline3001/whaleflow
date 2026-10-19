# 一条命令跑完发布链：构建 → 测试 → 原生 → 打包 → 校验 → 推送 → Release
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\release-all.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\release-all.ps1 -SkipTests
#   powershell -ExecutionPolicy Bypass -File scripts\release-all.ps1 -NoPush -NoRelease
#   powershell -ExecutionPolicy Bypass -File scripts\release-all.ps1 -DryRun
#
# 版本号请先手工改好 package.json 与 package-lock.json；脚本只校验，不代改。
param(
  [switch]$SkipTests,
  [switch]$NoPush,
  [switch]$NoRelease,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:failed = $false
function Step {
  param([string]$Name, [scriptblock]$Body)
  if ($script:failed) { return }
  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
  if ($DryRun) { Write-Host '  (dry run)' -ForegroundColor DarkGray; return }
  $start = Get-Date
  & $Body
  if ($LASTEXITCODE -ne 0 -or $script:failed) {
    $script:failed = $true
    Write-Host "  ✗ 失败：$Name（退出码 $LASTEXITCODE）" -ForegroundColor Red
    return
  }
  Write-Host ("  ✓ {0:N1}s" -f ((Get-Date) - $start).TotalSeconds) -ForegroundColor Green
}

# 0. 基本信息
$meta = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $meta.version
$tag = "v$version"
$zipName = "WhaleFlow-$version-Windows-x64.zip"
$srcName = "WhaleFlow-$version-source.zip"
Write-Host "WhaleFlow 发布：$version（tag $tag）" -ForegroundColor Yellow
Write-Host "工作目录：$root"

# gh 可执行文件
$gh = 'D:\XYP\tools\gh\bin\gh.exe'
if (-not (Test-Path $gh)) { $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source }
if (-not $gh) { Write-Host '未找到 gh，跳过 Release 步骤需要加 -NoRelease' -ForegroundColor Yellow }

# 1. 前端构建
Step '前端构建' { npm run build | Select-Object -Last 4 }

# 2. 测试
if ($SkipTests) { Write-Host "`n=== 测试（已跳过）===" -ForegroundColor DarkGray }
else { Step 'Node 测试' { npm test 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)' | Select-Object -Last 3 } }

# 3. 原生构建
Step '原生构建' { node scripts/build-native.mjs }

# 4. 原生 smoke（需要桌面会话与 WebView2）
Step '原生 smoke' { node scripts/run-native.mjs --smoke-test "--smoke-screenshot=$root\artifacts\native-smoke.png" }

# 5. 运行包
Step '打包运行包' { npm run pack 2>&1 | Select-Object -Last 1 }

# 6. 校验运行包
Step '校验运行包' { npm run verify 2>&1 | Select-Object -Last 2 }

# 7. 解压复验
Step '解压复验' { npm run smoke:package 2>&1 | Select-Object -Last 1 }

# 8. 源码包
Step '打包源码' { npm run pack:source 2>&1 | Select-Object -Last 1 }

# 9. 校验源码包
Step '校验源码包' { node scripts/verify-artifacts.mjs --source 2>&1 | Select-Object -Last 3 }

if ($script:failed) {
  Write-Host "`n发布中断，未推送。" -ForegroundColor Red
  exit 1
}
if ($DryRun) { Write-Host "`nDry run 完成，未做任何改动。" -ForegroundColor Yellow; exit 0 }

# 10. 提交推送
if ($NoPush) { Write-Host "`n=== 推送（已跳过）===" -ForegroundColor DarkGray }
else {
  Step '提交并推送' {
    git add -A
    git -c core.quotepath=false commit -q -m "release $version"
    if ($LASTEXITCODE -ne 0) { Write-Host '  没有需要提交的改动' -ForegroundColor DarkGray; $global:LASTEXITCODE = 0 }
    git push
  }
}

# 11. 创建 Release
if ($NoRelease) { Write-Host "`n=== Release（已跳过）===" -ForegroundColor DarkGray }
elseif (-not $gh) { Write-Host "`n=== Release 跳过：未找到 gh ===" -ForegroundColor Yellow }
else {
  Step "创建 Release $tag" {
    & $gh release view $tag --json tagName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  该 tag 已存在，改为补传资产" -ForegroundColor Yellow
      & $gh release upload $tag "release\$zipName" "release\$srcName" "release\SHA256SUMS.txt" --clobber
    } else {
      & $gh release create $tag "release\$zipName" "release\$srcName" "release\SHA256SUMS.txt" --title "WhaleFlow $version" --notes "见仓库 README 与 $tag 说明。"
    }
  }
}

# 12. 摘要
Write-Host "`n================ 发布摘要 ================" -ForegroundColor Cyan
Get-Content 'release\SHA256SUMS.txt' -ErrorAction SilentlyContinue
if ($gh -and -not $NoRelease) { & $gh release view $tag --json url -q .url 2>$null }
Write-Host '========================================='
exit 0
