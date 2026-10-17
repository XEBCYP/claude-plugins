# Подключает маркетплейс xebcyp-plugins к Claude Code на этом компьютере (Windows).
# Дописывает в ~/.claude/settings.json маркетплейсы и включённые плагины из
# templates/user-settings.json. Уже заданные ключи не трогает, делает резервную копию.
# Навыки 1С глобально выключены — их включает .claude/settings.json проекта 1С.
# В ~/.claude/CLAUDE.md ставит или обновляет блок общих правил из templates/user-CLAUDE.md.
#
# Запуск:
#   irm https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/scripts/install.ps1 | iex
# или из клона репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# Всё тело — в блоке & { }: при запуске через irm | iex настройки ($ErrorActionPreference и др.)
# не остаются в окне пользователя.
& {
$ErrorActionPreference = 'Stop'

# JSON с отступом в 2 пробела и без \u-экранирования & < > ' — одинаково в PowerShell 5.1 и 7
# (ConvertTo-Json в 5.1 экранирует эти символы и ставит огромные отступы).
function ToJson($v, [string]$ind = '') {
    $in = $ind + '  '
    if ($null -eq $v) { return 'null' }
    if ($v -is [bool]) { return $(if ($v) { 'true' } else { 'false' }) }
    if ($v -is [datetime]) { $v = $v.ToString('yyyy-MM-ddTHH:mm:ss.FFFFFFFK') }
    if ($v -is [string]) {
        $sb = New-Object System.Text.StringBuilder '"'
        foreach ($c in $v.ToCharArray()) {
            switch ([int]$c) {
                34 { [void]$sb.Append('\"') }
                92 { [void]$sb.Append('\\') }
                8 { [void]$sb.Append('\b') }
                12 { [void]$sb.Append('\f') }
                10 { [void]$sb.Append('\n') }
                13 { [void]$sb.Append('\r') }
                9 { [void]$sb.Append('\t') }
                default {
                    if ([int]$c -lt 32) { [void]$sb.AppendFormat('\u{0:x4}', [int]$c) } else { [void]$sb.Append($c) }
                }
            }
        }
        return $sb.Append('"').ToString()
    }
    if ($v -is [double] -or $v -is [single]) { return $v.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
    if ($v -is [ValueType]) { return [Convert]::ToString($v, [Globalization.CultureInfo]::InvariantCulture) }
    if ($v -is [System.Collections.IList]) {
        if ($v.Count -eq 0) { return '[]' }
        return "[`n" + ((@($v) | ForEach-Object { $in + (ToJson $_ $in) }) -join ",`n") + "`n$ind]"
    }
    $props = @($v.PSObject.Properties)
    if ($props.Count -eq 0) { return '{}' }
    return "{`n" + (($props | ForEach-Object { $in + (ToJson $_.Name) + ': ' + (ToJson $_.Value $in) }) -join ",`n") + "`n$ind}"
}

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

$origJson = $null
if (Test-Path $settingsPath) {
    $origJson = [System.IO.File]::ReadAllText($settingsPath, [System.Text.Encoding]::UTF8)
    $settings = $origJson | ConvertFrom-Json
} else {
    $settings = [pscustomobject]@{}
}

$own = 'xebcyp-plugins'
$added = @(); $updated = @(); $differs = @()
function Compact($v) { ToJson $v }
foreach ($section in 'extraKnownMarketplaces', 'enabledPlugins') {
    if (-not $settings.PSObject.Properties[$section]) {
        $settings | Add-Member -NotePropertyName $section -NotePropertyValue ([pscustomobject]@{})
    }
    foreach ($p in $template.$section.PSObject.Properties) {
        $cur = $settings.$section.PSObject.Properties[$p.Name]
        if (-not $cur) {
            $settings.$section | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value
            $added += "$section.$($p.Name)"
        } elseif ($section -eq 'extraKnownMarketplaces' -and $p.Name -eq $own -and
                  (Compact $cur.Value.source) -ne (Compact $p.Value.source)) {
            # Адрес своего маркетплейса — всегда из шаблона.
            $cur.Value | Add-Member -NotePropertyName source -NotePropertyValue $p.Value.source -Force
            $updated += "$section.$($p.Name).source"
        } elseif ((Compact $cur.Value) -ne (Compact $p.Value)) {
            $differs += "$section.$($p.Name): у вас $(Compact $cur.Value), в шаблоне $(Compact $p.Value)"
        }
    }
}

$json = (ToJson $settings) + "`n"
# Резервная копия и запись — только если содержимое меняется (сравнение без учёта форматирования).
if ($null -eq $origJson -or (ToJson ($origJson | ConvertFrom-Json)) + "`n" -ne $json) {
    if ($null -ne $origJson) { Copy-Item $settingsPath "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
    [System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

if ($added) {
    Write-Host 'Добавлено в' $settingsPath ':'
    $added | ForEach-Object { Write-Host '  +' $_ }
}
if ($updated) {
    Write-Host 'Обновлено в' $settingsPath ':'
    $updated | ForEach-Object { Write-Host '  ~' $_ }
}
if (-not ($added -or $updated)) {
    Write-Host 'Всё уже было настроено:' $settingsPath
}
if ($differs) {
    Write-Host 'Отличается от шаблона (оставлено как есть):'
    $differs | ForEach-Object { Write-Host '  =' $_ }
}

# Общие правила в ~/.claude/CLAUDE.md: блок между метками ставится или заменяется, остальной текст не трогается.
$mdUrl = 'https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/templates/user-CLAUDE.md'
$localMd = if ($PSScriptRoot) { Join-Path $PSScriptRoot '..\templates\user-CLAUDE.md' } else { $null }
if ($localMd -and (Test-Path $localMd)) {
    $block = [System.IO.File]::ReadAllText((Resolve-Path $localMd), [System.Text.Encoding]::UTF8)
} else {
    $resp = Invoke-WebRequest -Uri $mdUrl -UseBasicParsing
    $block = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
}
$block = $block.Trim() -replace "`r`n", "`n"
$mdPath = Join-Path $claudeDir 'CLAUDE.md'
$utf8 = New-Object System.Text.UTF8Encoding $false
$pattern = '(?s)<!-- xebcyp-plugins:begin.*?<!-- xebcyp-plugins:end -->'
if (Test-Path $mdPath) {
    $md = [System.IO.File]::ReadAllText($mdPath, [System.Text.Encoding]::UTF8) -replace "`r`n", "`n"
    if ($md -match $pattern) {
        $new = [regex]::Replace($md, $pattern, { param($m) $block })
    } else {
        $new = $md.TrimEnd() + "`n`n" + $block + "`n"
    }
    if ($new -ne $md) {
        Copy-Item $mdPath "$mdPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        [System.IO.File]::WriteAllText($mdPath, $new, $utf8)
        Write-Host 'Обновлён блок общих правил в' $mdPath
    } else {
        Write-Host 'Общие правила уже актуальны:' $mdPath
    }
} else {
    [System.IO.File]::WriteAllText($mdPath, "# Общие правила для всех проектов`n`n" + $block + "`n", $utf8)
    Write-Host 'Создан' $mdPath
}

# Доступ git к GitHub без запроса пароля (нужен для приватных маркетплейсов и автообновления).
if (Get-Command gh -ErrorAction SilentlyContinue) {
    # В PowerShell 5.1 при 'Stop' даже перенаправленный stderr внешней программы прерывает скрипт,
    # а gh без входа пишет туда «You are not logged into any GitHub hosts».
    $ErrorActionPreference = 'Continue'
    gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { gh auth setup-git }
    $ErrorActionPreference = 'Stop'
}

foreach ($tool in 'node', 'python', 'git') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "Внимание: не найден $tool." -ForegroundColor Yellow
    }
}
Write-Host 'Готово. Перезапустите Claude Code — плагины установятся при старте сессии.'
}
