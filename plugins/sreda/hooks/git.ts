// Защита git (пакет 3 аудита 27.10, ADR 0015).
//
// 1. «git add -A», «git add .», «git add --all», «git commit -a»: если в папке есть изменённые файлы, которые эта
//    сессия не правила, команда не выполняется — свои файлы добавляются по именам. 25.10 в Export1c7 такая команда
//    забрала в коммит незакоммиченные файлы параллельной сессии (убирали отдельным коммитом d5957d0); за неделю — около
//    315 таких команд примерно в 116 сессиях.
// 2. «git commit -m» с кириллицей — не выполняется: сообщение через файл, «git commit -F файл» (упоминается в 11–14
//    передачах: кодировка в PowerShell и heredoc ломают русский текст).
//
// Свои файлы — те, что сессия писала инструментами Write, Edit, MultiEdit, NotebookEdit (переменная модуля: после
// перезагрузки плагина список пуст, и первый «add -A» попросит перечислить файлы — лишний шаг, но не чужой коммит).

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])
// Сколько чужих файлов показать в отказе
const SHOW = 15

const touched = new Set<string>()

export function resetGit(): void {
  touched.clear()
}

const norm = (path: string) => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()

// Команда делится на части по ; && || | и переводам строки — каждая часть проверяется отдельно
function parts(cmd: string): string[] {
  return cmd.split(/\r?\n|;|&&|\|\||\|/).map(one => one.trim()).filter(Boolean)
}

// git … add -A | --all | . (точка — вся папка)
const ADD_ALL = /(?:^|\s)git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*\s+add\s+(?:[^\s]+\s+)*?(?:-A\b|--all\b|-[a-zA-Z]*A[a-zA-Z]*\b|\.(?=\s|$))/
// git … commit … -a | -am | --all (не --amend, не --author)
const COMMIT_ALL = /(?:^|\s)git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b(?:\s+\S+)*?\s+(?:-[b-zA-Z]*a[a-zA-Z]*\b|--all\b)/
// git … commit … -m | -am | --message
const COMMIT_M = /(?:^|\s)git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b[\s\S]*?\s(?:-[a-zA-Z]*m\b|--message\b)/
const CYRILLIC = /[А-Яа-яЁё]/
const GIT_C = /(?:^|\s)git\s+-C\s+("([^"]*)"|'([^']*)'|(\S+))/
const CD = /^(?:cd|Set-Location|sl|pushd)\s+(?:-Path\s+)?("([^"]*)"|'([^']*)'|(\S+))/i

function unquote(m: RegExpExecArray): string {
  return m[2] ?? m[3] ?? m[4] ?? ''
}

export type GitCheck = { kind: 'all'; dir: string } | { kind: 'cyrillic' } | null

// Что в команде опасного; dir — папка, где git выполнит add -A (git -C, cd перед ним, иначе папка сессии)
export function gitRisk(cmd: string, cwd: string): GitCheck {
  let dir = cwd
  for (const part of parts(cmd)) {
    const cd = CD.exec(part)
    if (cd) {
      const to = unquote(cd)
      dir = /^([a-zA-Z]:|\/|\\)/.test(to) ? to : `${dir}/${to}`
      continue
    }
    if (COMMIT_M.test(part) && CYRILLIC.test(part)) return { kind: 'cyrillic' }
    if (ADD_ALL.test(part) || COMMIT_ALL.test(part)) {
      const c = GIT_C.exec(part)
      if (c) {
        const to = unquote(c)
        dir = /^([a-zA-Z]:|\/|\\)/.test(to) ? to : `${dir}/${to}`
      }
      return { kind: 'all', dir }
    }
  }
  return null
}

// Строки git status --porcelain → пути от корня репозитория (переименование «a -> b» — оба)
export function changedPaths(porcelain: string): string[] {
  const out: string[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue
    const rest = line.slice(3)
    for (const one of rest.split(' -> ')) out.push(one.replace(/^"|"$/g, ''))
  }
  return out
}

async function git($: any, dir: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 15_000 })
    return r.exitCode === 0 ? String(r.stdout) : null
  } catch {
    return null
  }
}

// Чужие изменённые файлы в репозитории dir; null — git не ответил (тогда не мешаем)
async function foreign($: any, dir: string): Promise<string[] | null> {
  const root = await git($, dir, ['rev-parse', '--show-toplevel'])
  if (root === null) return null
  // quotepath=false: русские имена файлов — как есть, а не «\320\237…»
  const status = await git($, dir, ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'])
  if (status === null) return null
  const base = norm(root.trim())
  return changedPaths(status).filter(rel => !touched.has(norm(`${base}/${rel}`)))
}

const CYRILLIC_DENY =
  'Команда не выполнена (плагин sreda): сообщение коммита с кириллицей через -m ломается кодировкой оболочки. ' +
  'Запишите сообщение в файл инструментом Write (например, в папку scratchpad) и выполните git commit -F <файл>.'

function allDeny(list: string[]): string {
  const shown = list.slice(0, SHOW).map(one => `- ${one}`).join('\n')
  const more = list.length > SHOW ? `\n… и ещё ${list.length - SHOW}` : ''
  return (
    'Команда не выполнена (плагин sreda): в папке есть изменённые файлы, которые эта сессия не правила, — «git add -A», ' +
    '«git add .» и «git commit -a» забрали бы и их (возможно, это работа параллельной сессии). Добавьте свои файлы по ' +
    `именам: git add <файл> …. Не ваши изменения:\n${shown}${more}`
  )
}

// Хук tool.call: запомнить свои файлы; отказ — { deny }, иначе null
export async function gitCall($: any, e: any): Promise<{ deny: string } | null> {
  if (EDIT_TOOLS.has(e.tool)) {
    const path = String(e.file_path ?? e.notebook_path ?? '')
    if (path) touched.add(norm(path))
    return null
  }
  if (!SHELLS.has(e.tool)) return null
  const cmd = String(e.command ?? '')
  if (!/\bgit\b/.test(cmd)) return null
  const risk = gitRisk(cmd, String(await $.session.cwd()))
  if (!risk) return null
  if (risk.kind === 'cyrillic') return { deny: CYRILLIC_DENY }
  const list = await foreign($, risk.dir)
  return list && list.length > 0 ? { deny: allDeny(list) } : null
}
