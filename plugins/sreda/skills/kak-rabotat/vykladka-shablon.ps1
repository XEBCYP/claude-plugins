<#
  Заготовка скрипта выкладки (sreda:kak-rabotat, раздел 5; ADR 0019 claude-plugins).
  Скопировать в проект как scripts\vykladka.ps1 и заполнить места с пометкой ЗАПОЛНИТЬ.
  Порядок: main без изменений → копия прежней версии → установка → запуск как в работе → проверки →
  номер версии = коммит → при ошибке автооткат → одна строка «прошло / не прошло».

  Запуск:  powershell -ExecutionPolicy Bypass -File scripts\vykladka.ps1 [-Proverka]
  -Proverka — только проверки и номер версии, без установки (сверка уже выложенного).
  Выход: 0 — прошло; 1 — не прошло, прежняя версия возвращена; 2 — не прошло и откат не удался (нужен человек).
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
$Kopii      = 'C:\Services\_kopii\<Программа>' # где держать прежние версии
$Sluzhba    = '<ИмяСлужбы>'                    # служба Windows; для задачи планировщика — см. Start-Rabota
$Adres      = 'http://localhost:<порт>/health' # что должно отвечать после запуска; $null — не проверять
$Zhurnal    = "$Ustanovka\logs"                # где искать ошибки запуска; $null — не проверять
$Versiya    = { (Invoke-RestMethod "http://localhost:<порт>/version").commit }  # номер версии от самой программы
$Baza       = $null                            # файл/папка базы, если новая версия её меняет: копия до установки
$Ozhidanie  = 30                               # секунд на запуск
# ---------------------------------------------------------------------------------------------

function Stop-Rabota  { Stop-Service $Sluzhba -ErrorAction SilentlyContinue; (Get-Service $Sluzhba).WaitForStatus('Stopped', '00:00:30') }
function Start-Rabota { Start-Service $Sluzhba }   # так же, как в работе: служба / Start-ScheduledTask, та же учётка

function Test-Rabota([string]$OzhidaemyjKommit) {
  $do = (Get-Date).AddSeconds($Ozhidanie)
  while ((Get-Date) -lt $do) {
    try {
      if ((Get-Service $Sluzhba).Status -ne 'Running') { throw 'служба не запущена' }
      if ($Adres) { $null = Invoke-WebRequest $Adres -UseBasicParsing -TimeoutSec 5 }
      $v = & $Versiya
      if (-not $v) { throw 'программа не сообщила номер версии' }
      if ($OzhidaemyjKommit -and -not "$OzhidaemyjKommit".StartsWith("$v") -and -not "$v".StartsWith("$OzhidaemyjKommit")) {
        throw "версия $v, ожидалась $OzhidaemyjKommit"
      }
      if ($Zhurnal -and (Test-Path $Zhurnal)) {
        $oshibki = Get-ChildItem $Zhurnal -File | Where-Object LastWriteTime -gt $script:Nachalo |
          Select-String -Pattern 'Unhandled|FATAL|Exception' -SimpleMatch:$false | Select-Object -First 3
        if ($oshibki) { throw "ошибки в журнале: $($oshibki -join ' | ')" }
      }
      return $v
    } catch { $script:Prichina = "$_"; Start-Sleep 2 }
  }
  throw $script:Prichina
}

$script:Nachalo = Get-Date

if ($Proverka) {
  try { $v = Test-Rabota $null; Write-Output "ПРОШЛО: работает, версия $v"; exit 0 }
  catch { Write-Output "НЕ ПРОШЛО: $_"; exit 1 }
}

# 1. Только из основной папки и ветки main без незакоммиченных изменений
try {
  Push-Location $Proekt
  if ((Resolve-Path .).Path -like '*\.claude\worktrees\*') { throw 'выкладка только из основной папки, не из worktree' }
  if ((git rev-parse --abbrev-ref HEAD) -ne 'main') { throw 'выкладка только из ветки main' }
  if (git status --porcelain) { throw 'есть незакоммиченные изменения' }
  git fetch -q
  if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'main не совпадает с origin/main' }
  $Kommit = git rev-parse --short HEAD
  & $Sborka
  if ($LASTEXITCODE) { throw "сборка: код $LASTEXITCODE" }
} catch { Write-Output "НЕ ПРОШЛО: $_ (ничего не менялось)"; exit 1 }
finally { Pop-Location }

# 2. Копия прежней версии (и базы)
$Metka = Get-Date -Format 'yyyyMMdd-HHmmss'
$Kopiya = Join-Path $Kopii $Metka
New-Item -ItemType Directory -Force $Kopiya | Out-Null
robocopy $Ustanovka "$Kopiya\app" /E /MT:16 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Output "НЕ ПРОШЛО: копия прежней версии не снята (robocopy $LASTEXITCODE), ничего не менялось"; exit 1 }
if ($Baza) { Copy-Item $Baza "$Kopiya\baza" -Recurse -Force }

function Undo-Vykladka {
  Stop-Rabota
  robocopy "$Kopiya\app" $Ustanovka /MIR /MT:16 /NFL /NDL /NJH /NJS | Out-Null
  if ($Baza) { Remove-Item $Baza -Recurse -Force; Copy-Item "$Kopiya\baza" $Baza -Recurse -Force }
  Start-Rabota
  $script:Nachalo = Get-Date
  Test-Rabota $null
}

# 3. Установка → запуск как в работе → проверки → номер версии
try {
  Stop-Rabota
  robocopy $IzSborki $Ustanovka /E /MT:16 /NFL /NDL /NJH /NJS | Out-Null   # /E, не /MIR: настройки и logs остаются
  if ($LASTEXITCODE -ge 8) { throw "копирование: robocopy $LASTEXITCODE" }
  $script:Nachalo = Get-Date
  Start-Rabota
  $v = Test-Rabota $Kommit
  Write-Output "ПРОШЛО: версия $v (коммит $Kommit), прежняя — в $Kopiya"
  exit 0
} catch {
  $prichina = "$_"
  try { $staraya = Undo-Vykladka; Write-Output "НЕ ПРОШЛО: $prichina; возвращена прежняя версия $staraya"; exit 1 }
  catch { Write-Output "НЕ ПРОШЛО: $prichina; ОТКАТ НЕ УДАЛСЯ: $_ — копия в $Kopiya"; exit 2 }
}

<#
  У заказчика (несколько машин) — поэтапно:
  1) этот же скрипт на одной машине; 2) сторож перезапусков: задача планировщика каждые 5 минут вызывает
     scripts\vykladka.ps1 -Proverka и после двух «НЕ ПРОШЛО» подряд возвращает прежнюю версию из $Kopii (последняя
     папка); 3) остальные машины — только после суток работы первой без отката.
#>
