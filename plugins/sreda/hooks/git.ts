// Защита git (пакет 3 аудита 27.10, ADR 0015).
//
// 1. «git add -A», «git add .», «git add --all», «git add -u», «git commit -a»: если в папке есть изменённые файлы,
//    которые эта сессия не правила, команда не выполняется — свои файлы добавляются по именам. 25.10 в Export1c7 такая
//    команда забрала в коммит незакоммиченные файлы параллельной сессии (убирали отдельным коммитом d5957d0); за неделю —
//    около 315 таких команд примерно в 116 сессиях.
// 2. «git commit -m» с кириллицей в самом сообщении — не выполняется: сообщение через файл, «git commit -F файл»
//    (упоминается в 11–14 передачах: кодировка в PowerShell и heredoc ломают русский текст). Русские имена папок и
//    файлов в команде (git -C, пути после --) не мешают.
//
// Команда разбирается как оболочка: кавычки, heredoc (<<'EOF'), here-string PowerShell (@'…'@), $(…) — поэтому слова
// «git add -A» внутри сообщения или echo не считаются командой, а многострочное сообщение — одно слово.
//
// Свои файлы — те, что сессия писала инструментами Write, Edit, MultiEdit, NotebookEdit (переменная модуля: после
// перезагрузки плагина список пуст, и первый «add -A» попросит перечислить файлы — лишний шаг, но не чужой коммит).

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])
// Сколько чужих файлов показать в отказе
const SHOW = 15

const touched = new Set<string>()

const norm = (path: string) => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()

// --- Разбор команды оболочки

// Тело heredoc: со строки после from до строки-терминатора; индекс после неё
function skipHeredoc(cmd: string, from: number, term: string): number {
  let i = from
  while (i < cmd.length) {
    const eol = cmd.indexOf('\n', i)
    const line = cmd.slice(i, eol < 0 ? cmd.length : eol).replace(/\r$/, '')
    i = eol < 0 ? cmd.length : eol + 1
    if (line.trim() === term) return i
  }
  return cmd.length
}

// «<<EOF», «<<-'EOF'», «<<"EOF"» с позиции i: терминатор и индекс после него; иначе null
function heredocAt(cmd: string, i: number): { term: string; end: number } | null {
  const m = /^<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/.exec(cmd.slice(i))
  return m ? { term: m[1] ?? m[2] ?? m[3], end: i + m[0].length } : null
}

// Двойные кавычки с позиции i (после открывающей): текст и индекс после закрывающей
function dquote(cmd: string, i: number): [string, number] {
  let text = ''
  while (i < cmd.length) {
    const ch = cmd[i]
    if (ch === '"') return [text, i + 1]
    if ((ch === '\\' || ch === '`') && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) {
      text += cmd[i + 1]
      i += 2
      continue
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      const end = subshell(cmd, i)
      text += cmd.slice(i, end)
      i = end
      continue
    }
    text += ch
    i += 1
  }
  return [text, i]
}

// $(…) с позиции i (на «$»): индекс после закрывающей скобки; кавычки и heredoc внутри — учтены
function subshell(cmd: string, i: number): number {
  let depth = 0
  let k = i + 1
  const pending: string[] = []
  while (k < cmd.length) {
    const ch = cmd[k]
    if (ch === "'") {
      const j = cmd.indexOf("'", k + 1)
      k = j < 0 ? cmd.length : j + 1
      continue
    }
    if (ch === '"') {
      k = dquote(cmd, k + 1)[1]
      continue
    }
    if (ch === '<' && cmd[k + 1] === '<') {
      const h = heredocAt(cmd, k)
      if (h) {
        pending.push(h.term)
        k = h.end
        continue
      }
    }
    if (ch === '\n' && pending.length) {
      k += 1
      for (const term of pending.splice(0)) k = skipHeredoc(cmd, k, term)
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return k + 1
    }
    k += 1
  }
  return cmd.length
}

// Команда → простые команды (по ; && || | & переводам строки и скобкам вне кавычек) → слова без кавычек
export function commands(cmd: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const pending: string[] = []
  const push = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const end = () => {
    push()
    if (words.length) out.push(words)
    words = []
  }
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1)
      const stop = j < 0 ? cmd.length : j
      word = (word ?? '') + cmd.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    // Here-string PowerShell: @' или @" и перевод строки … перевод строки '@ или "@
    if (ch === '@' && (cmd[i + 1] === "'" || cmd[i + 1] === '"') && /^\r?\n/.test(cmd.slice(i + 2))) {
      const q = cmd[i + 1]
      const close = cmd.indexOf(`\n${q}@`, i + 2)
      word = (word ?? '') + cmd.slice(i + 2, close < 0 ? cmd.length : close).replace(/^\r?\n/, '')
      i = close < 0 ? cmd.length : close + 3
      continue
    }
    if (ch === '"') {
      const [text, j] = dquote(cmd, i + 1)
      word = (word ?? '') + text
      i = j
      continue
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      const j = subshell(cmd, i)
      word = (word ?? '') + cmd.slice(i, j)
      i = j
      continue
    }
    if (ch === '<' && cmd[i + 1] === '<') {
      const h = heredocAt(cmd, i)
      if (h) {
        push()
        pending.push(h.term)
        i = h.end
        continue
      }
    }
    if (ch === '\n') {
      end()
      i += 1
      for (const term of pending.splice(0)) i = skipHeredoc(cmd, i, term)
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      push()
      i += 1
      continue
    }
    if (';&|()'.includes(ch)) {
      end()
      i += ch === cmd[i + 1] && (ch === '&' || ch === '|') ? 2 : 1
      continue
    }
    word = (word ?? '') + ch
    i += 1
  }
  end()
  return out
}

// --- Что опасного в команде

// Пути «вся папка» для git add: . ./ * :/ (вся рабочая копия)
const WHOLE = new Set(['.', './', '*', ':/', ':', ':/*', ':(top)'])
const CYRILLIC = /[А-Яа-яЁё]/
const CD = new Set(['cd', 'set-location', 'sl', 'pushd', 'chdir'])
// Глобальные ключи git со значением отдельным словом
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
// Ключи git commit со значением отдельным словом
const COMMIT_VALUE = new Set([
  '--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup',
  '--squash', '--cleanup', '--trailer', '--pathspec-from-file',
])
// Короткие ключи git commit, за которыми — значение (остаток слова или следующее слово)
const COMMIT_SHORT_VALUE = 'mFCct'

// Проверка папки: dir — где выполнится git; paths — пути (null — вся рабочая копия); tracked — только файлы под git
export type Scope = { dir: string; paths: string[] | null; tracked: boolean }
export type GitCheck = { kind: 'all'; scopes: Scope[] } | { kind: 'cyrillic' } | null

const isAbs = (path: string) => /^([a-zA-Z]:|\/|\\)/.test(path)
const join = (dir: string, to: string) => (isAbs(to) ? to : `${dir}/${to}`)
const exe = (word: string) => word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')

// git add: опасно с -A/--all/-u/--update или путём «вся папка»; пути после ключей — граница проверки
function addScope(args: string[], dir: string): Scope | null {
  let all = false
  let tracked = false
  const paths: string[] = []
  let isPaths = false
  for (const a of args) {
    if (!isPaths && a === '--') isPaths = true
    else if (!isPaths && (a === '--all' || a === '--no-ignore-removal')) all = true
    else if (!isPaths && a === '--update') tracked = true
    else if (!isPaths && /^-[a-zA-Z]+$/.test(a)) {
      if (a.includes('A')) all = true
      else if (a.includes('u')) tracked = true
    } else if (isPaths || !a.startsWith('-')) paths.push(a)
  }
  const whole = paths.some(p => WHOLE.has(p))
  if (!all && !tracked && !whole) return null
  // -A без путей — вся рабочая копия; «:/» — тоже; иначе — указанные пути от папки команды
  if (paths.length === 0 || paths.some(p => p.startsWith(':/') || p === ':' || p === ':(top)')) {
    return { dir, paths: null, tracked: tracked && !all }
  }
  return { dir, paths, tracked: tracked && !all }
}

// git commit: сообщения из -m и «-a» (все изменённые файлы под git)
function commitParse(args: string[]): { messages: string[]; all: boolean; paths: string[] } {
  const messages: string[] = []
  const paths: string[] = []
  let all = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--') {
      paths.push(...args.slice(i + 1))
      break
    }
    if (a === '--all') all = true
    else if (a === '--message') messages.push(args[++i] ?? '')
    else if (a.startsWith('--message=')) messages.push(a.slice('--message='.length))
    else if (COMMIT_VALUE.has(a)) i += 1
    else if (a.startsWith('--')) continue
    else if (/^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k += 1) {
        const c = a[k]
        if (c === 'a') all = true
        if (COMMIT_SHORT_VALUE.includes(c)) {
          const value = k + 1 < a.length ? a.slice(k + 1) : (args[++i] ?? '')
          if (c === 'm') messages.push(value)
          break
        }
      }
    } else paths.push(a)
  }
  return { messages, all, paths }
}

// Что в команде опасного; cwd — папка сессии (cd в команде её меняет, git -C — для своей команды)
export function gitRisk(cmd: string, cwd: string): GitCheck {
  let dir = cwd
  const scopes: Scope[] = []
  for (const raw of commands(cmd)) {
    const words = [...raw]
    while (words.length && /^\w+=/.test(words[0])) words.shift()
    if (!words.length) continue
    const name = exe(words[0])
    if (CD.has(name)) {
      const to = words.slice(1).find(w => !w.startsWith('-'))
      if (to && to !== '~') dir = join(dir, to)
      continue
    }
    if (name !== 'git') continue
    // Глобальные ключи до подкоманды
    let gitDir = dir
    let k = 1
    while (k < words.length && words[k].startsWith('-')) {
      if (words[k] === '-C') gitDir = join(gitDir, words[k + 1] ?? '')
      k += GIT_VALUE.has(words[k]) ? 2 : 1
    }
    const sub = words[k]
    const args = words.slice(k + 1)
    if (sub === 'commit') {
      const c = commitParse(args)
      if (c.messages.some(m => CYRILLIC.test(m))) return { kind: 'cyrillic' }
      if (c.all) scopes.push({ dir: gitDir, paths: null, tracked: true })
      else if (c.paths.some(p => WHOLE.has(p))) scopes.push({ dir: gitDir, paths: c.paths, tracked: true })
    } else if (sub === 'add') {
      const s = addScope(args, gitDir)
      if (s) scopes.push(s)
    }
  }
  return scopes.length ? { kind: 'all', scopes } : null
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

// Чужие изменённые файлы в границах проверки; null — git не ответил (тогда не мешаем)
async function foreign($: any, scope: Scope): Promise<string[] | null> {
  const root = await git($, scope.dir, ['rev-parse', '--show-toplevel'])
  if (root === null) return null
  // quotepath=false: русские имена файлов — как есть, а не «\320\237…»; пути в выводе — от корня репозитория
  const status = await git($, scope.dir, [
    '-c', 'core.quotepath=false', 'status', '--porcelain', `--untracked-files=${scope.tracked ? 'no' : 'all'}`,
    ...(scope.paths ? ['--', ...scope.paths] : []),
  ])
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
    '«git add .», «git add -u» и «git commit -a» забрали бы и их (возможно, это работа параллельной сессии). Добавьте ' +
    `свои файлы по именам: git add <файл> …. Не ваши изменения:\n${shown}${more}`
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
  if (!/\bgit\b/i.test(cmd)) return null
  const risk = gitRisk(cmd, String(await $.session.cwd()))
  if (!risk) return null
  if (risk.kind === 'cyrillic') return { deny: CYRILLIC_DENY }
  const list: string[] = []
  for (const scope of risk.scopes) {
    for (const one of (await foreign($, scope)) ?? []) if (!list.includes(one)) list.push(one)
  }
  return list.length > 0 ? { deny: allDeny(list) } : null
}
