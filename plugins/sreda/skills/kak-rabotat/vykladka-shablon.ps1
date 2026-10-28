<#
  Заготовка скрипта выкладки (sreda:kak-rabotat, раздел 5; ADR 0019 claude-plugins).
  Скопировать в проект как scripts\vykladka.ps1 и заполнить места с пометкой ЗАПОЛНИТЬ. Файл — UTF-8 с BOM
  (иначе Windows PowerShell 5.1 портит кириллицу).
  Порядок: main без изменений → остановка → копия прежней версии (и базы) → установка → запуск как в работе →
  проверки → номер версии = коммит → при ошибке автооткат → одна строка «прошло / не прошло».

  Запуск:  powershell -ExecutionPolicy Bypass -File scripts\vykladka.ps1 [-Proverka]
  -Proverka — только проверки (служба, адрес, номер версии), без установки и без журнала: для сверки и сторожа.
  Выход: 0 — прошло; 1 — не прошло, работает прежняя версия (или ничего не менялось); 2 — не прошло и откат не
  удался — нужен человек. Подробности (вывод сборки) — в $Kopii\vykladka-<время>.log.
#>
param(
  [switch]$Proverka
)
$ErrorActionPreference = 'Stop'

# --- ЗАПОЛНИТЬ: как программа живёт в работе -------------------------------------------------
$Proekt     = 'C:\Projects\<Проект>'          # основная папка проекта (не worktree)
$Sborka     = { dotnet publish "$Proekt\src\App" -c Release -o "$Proekt\publish" }  # как собрать
$IzSborki   = "$Proekt\publish"               # что ставить
$Ustanovka  = 'C:\Services\<Программа>'        # куда ставить (рабочая папка программы)
$Kopii      = 'C:\Services\_kopii\<Программа>' # где держать прежние версии и журнал выкладки
$Sluzhba    = '<ИмяСлужбы>'                    # служба Windows; для задачи планировщика — поправить Stop/Start-Rabota
$Adres      = 'http://localhost:<порт>/health' # что должно отвечать после запуска; $null — не проверять
$Zhurnal    = "$Ustanovka\logs"                # журналы программы: ищутся ошибки в строках, дописанных после запуска
$Versiya    = { (Invoke-RestMethod "http://localhost:<порт>/version").commit }  # полный или короткий (≥7) хеш коммита
$Baza       = $null                            # файл/папка базы, если новая версия её меняет: копия до установки
$Ozhidanie  = 30                               # секунд на запуск
# ---------------------------------------------------------------------------------------------

$RC = '/R:2', '/W:2', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS'   # не ждать занятый файл бесконечно

function Stop-Rabota {
  if (Get-Service $Sluzhba -ErrorAction SilentlyContinue) {
    Stop-Service $Sluzhba; (Get-Service $Sluzhba).WaitForStatus('Stopped', '00:00:30')
  }
}
function Start-Rabota { Start-Service $Sluzhba }   # так же, как в работе: служба / Start-ScheduledTask, та же учётка

function Get-Stroki {   # сколько строк в каждом журнале сейчас — проверка смотрит только дописанное после
  $m = @{}
  if ($Zhurnal -and (Test-Path $Zhurnal)) {
    Get-ChildItem $Zhurnal -File | ForEach-Object { $m[$_.FullName] = @(Get-Content $_.FullName -ErrorAction SilentlyContinue).Count }
  }
  $m
}

function Test-Versiya([string]$v, [string]$ozhidaem) {
  if (-not $ozhidaem) { return $true }
  $v = "$v".Trim().ToLower(); $ozhidaem = $ozhidaem.ToLower()
  if ($v.Length -lt 7) { return $false }
  return $v.StartsWith($ozhidaem) -or $ozhidaem.StartsWith($v)
}

function Test-Rabota([string]$OzhidaemyjKommit, $StrokiDo) {
  $do = (Get-Date).AddSeconds($Ozhidanie)
  while ($true) {
    try {
      if ((Get-Service $Sluzhba).Status -ne 'Running') { throw 'служба не запущена' }
      if ($Adres) { $null = Invoke-WebRequest $Adres -UseBasicParsing -TimeoutSec 5 }
      $v = & $Versiya
      if (-not $v) { throw 'программа не сообщила номер версии' }
      if (-not (Test-Versiya $v $OzhidaemyjKommit)) { throw "версия $v, ожидалась $OzhidaemyjKommit" }
      if ($null -ne $StrokiDo -and $Zhurnal -and (Test-Path $Zhurnal)) {
        foreach ($f in Get-ChildItem $Zhurnal -File) {
          $propusk = if ($StrokiDo.ContainsKey($f.FullName)) { $StrokiDo[$f.FullName] } else { 0 }
          $oshibka = Get-Content $f.FullName -ErrorAction SilentlyContinue | Select-Object -Skip $propusk |
            Select-String -Pattern 'Unhandled|FATAL|Exception' | Select-Object -First 1
          if ($oshibka) { throw "ошибка в журнале $($f.Name): $($oshibka.Line.Trim())" }
        }
      }
      return "$v"
    } catch {
      if ((Get-Date) -ge $do) { throw }
      Start-Sleep 2
    }
  }
}

if ($Proverka) {
  try { $v = Test-Rabota $null $null; Write-Output "ПРОШЛО: работает, версия $v"; exit 0 }
  catch { Write-Output "НЕ ПРОШЛО: $_"; exit 1 }
}

# 1. Только из основной папки и ветки main без незакоммиченных изменений; сборка
$Metka = Get-Date -Format 'yyyyMMdd-HHmmss'
try {
  New-Item -ItemType Directory -Force $Kopii | Out-Null
  $Log = Join-Path $Kopii "vykladka-$Metka.log"
  Push-Location $Proekt
  if ((Resolve-Path .).Path -like '*\.claude\worktrees\*') { throw 'выкладка только из основной папки, не из worktree' }
  if ((git rev-parse --abbrev-ref HEAD) -ne 'main') { throw 'выкладка только из ветки main' }
  if (git status --porcelain) { throw 'есть незакоммиченные изменения' }
  git fetch -q
  if ($LASTEXITCODE) { throw 'git fetch не прошёл — нет связи с GitHub, сверить main нельзя' }
  if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'main не совпадает с origin/main' }
  $Kommit = git rev-parse HEAD
  & $Sborka *> $Log
  if ($LASTEXITCODE) { throw "сборка: код $LASTEXITCODE (вывод — $Log)" }
} catch { Write-Output "НЕ ПРОШЛО: $_ (ничего не менялось)"; exit 1 }
finally { Pop-Location -ErrorAction SilentlyContinue }

# 2. Остановка → копия прежней версии (и базы): копия снимается с остановленной программы
$Pervaya = -not (Test-Path $Ustanovka)
$Kopiya = Join-Path $Kopii $Metka
$Staraya = $null
try {
  if (-not $Pervaya) {
    try { $Staraya = "$(& $Versiya)" } catch { }   # прежний номер — чтобы откат проверить по нему
    Stop-Rabota
    New-Item -ItemType Directory -Force $Kopiya | Out-Null
    robocopy $Ustanovka "$Kopiya\app" /E @RC | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "копия прежней версии не снята (robocopy $LASTEXITCODE)" }
    if ($Baza) { Copy-Item $Baza "$Kopiya\baza" -Recurse -Force }
  }
} catch {
  $prichina = "$_"
  try { Start-Rabota; Write-Output "НЕ ПРОШЛО: $prichina; прежняя версия запущена снова, ничего не менялось"; exit 1 }
  catch { Write-Output "НЕ ПРОШЛО: $prichina; ПРЕЖНЯЯ ВЕРСИЯ НЕ ЗАПУСТИЛАСЬ: $_"; exit 2 }
}

function Undo-Vykladka {
  Stop-Rabota
  if ($Pervaya) { return 'нет (первая установка — программа остановлена)' }
  robocopy "$Kopiya\app" $Ustanovka /MIR @RC | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "возврат файлов: robocopy $LASTEXITCODE" }
  if ($Baza) { Remove-Item $Baza -Recurse -Force; Copy-Item "$Kopiya\baza" $Baza -Recurse -Force }
  Start-Rabota
  $v = Test-Rabota $Staraya $null
  "$v"
}

# 3. Установка → запуск как в работе → проверки → номер версии
try {
  New-Item -ItemType Directory -Force $Ustanovka | Out-Null
  robocopy $IzSborki $Ustanovka /E @RC | Out-Null   # /E, не /MIR: настройки и logs остаются
  if ($LASTEXITCODE -ge 8) { throw "копирование: robocopy $LASTEXITCODE" }
  $StrokiDo = Get-Stroki
  Start-Rabota
  $v = Test-Rabota $Kommit $StrokiDo
  $gde = if ($Pervaya) { 'первая установка' } else { "прежняя ($Staraya) — в $Kopiya" }
  Write-Output "ПРОШЛО: версия $v (коммит $($Kommit.Substring(0,7))), $gde"
  exit 0
} catch {
  $prichina = "$_"
  try { $vernuli = Undo-Vykladka; Write-Output "НЕ ПРОШЛО: $prichina; возвращена прежняя версия $vernuli"; exit 1 }
  catch { Write-Output "НЕ ПРОШЛО: $prichina; ОТКАТ НЕ УДАЛСЯ: $_ — копия в $Kopiya"; exit 2 }
}

<#
  У заказчика (несколько машин) — поэтапно:
  1) этот же скрипт на одной машине;
  2) сторож перезапусков: задача планировщика каждые 5 минут вызывает scripts\vykladka.ps1 -Proverka (журнал
     программы не смотрит — только служба, адрес и номер версии) и после двух «НЕ ПРОШЛО» подряд возвращает прежнюю
     версию из последней папки $Kopii (robocopy <копия>\app <установка> /MIR, затем запуск);
  3) остальные машины — только после суток работы первой без отката.
#>
