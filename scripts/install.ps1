# Подключает маркетплейс xebcyp-plugins к Claude Code на этом компьютере (Windows).
# Дописывает в ~/.claude/settings.json маркетплейсы и включённые плагины из
# templates/user-settings.json. Уже заданные ключи не трогает, делает резервную копию.
#
# Запуск:
#   irm https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/scripts/install.ps1 | iex
# или из клона репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$ErrorActionPreference = 'Stop'

$templateUrl = 'https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/templates/user-settings.json'
$localTemplate = if ($PSScriptRoot) { Join-Path $PSScriptRoot '..\templates\user-settings.json' } else { $null }

if ($localTemplate -and (Test-Path $localTemplate)) {
    $template = Get-Content $localTemplate -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    $template = Invoke-RestMethod -Uri $templateUrl
}

$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$settingsPath = Join-Path $claudeDir 'settings.json'
New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null

if (Test-Path $settingsPath) {
    Copy-Item $settingsPath "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    $settings = [pscustomobject]@{}
}

$added = @()
foreach ($section in 'extraKnownMarketplaces', 'enabledPlugins') {
    if (-not $settings.PSObject.Properties[$section]) {
        $settings | Add-Member -NotePropertyName $section -NotePropertyValue ([pscustomobject]@{})
    }
    foreach ($p in $template.$section.PSObject.Properties) {
        if (-not $settings.$section.PSObject.Properties[$p.Name]) {
            $settings.$section | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value
            $added += "$section.$($p.Name)"
        }
    }
}

$json = $settings | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($settingsPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))

if ($added) {
    Write-Host 'Добавлено в' $settingsPath ':'
    $added | ForEach-Object { Write-Host '  +' $_ }
} else {
    Write-Host 'Всё уже было настроено:' $settingsPath
}

# Доступ git к GitHub без запроса пароля (нужен для приватных маркетплейсов и автообновления).
if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { gh auth setup-git }
}

foreach ($tool in 'node', 'python', 'git') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "Внимание: не найден $tool." -ForegroundColor Yellow
    }
}
Write-Host 'Готово. Перезапустите Claude Code — плагины установятся при старте сессии.'
