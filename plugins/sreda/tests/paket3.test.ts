import { expect, mock, test } from 'claude-code/testing'

import { changedPaths, gitRisk } from '../hooks/git'
import { judge, notesOf } from '../hooks/probuzhdeniya'

// Пакет 3 аудита 27.10 (ADR 0015): защита git, пауза глобальной, журнал пустых пробуждений
const HOME = 'C:/Users/tester/.claude'
const WAKES = `${HOME}/sreda-probuzhdeniya.json`

type Env = {
  files: Record<string, string>
  submits: string[]
  cwd: string
  // git status --porcelain в репозитории C:/Projects/Demo
  status: string
  ran: string[][]
  id: string
}

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__sreda__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'zhdut-otveta', title: 'Ждут ответа', isShown: true, isFocused: false, isPlaced: true }] }))
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: env.id }))
  on('session.cwd', () => ({ value: env.cwd }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: env.files[e.path.replace(/\\/g, '/')] ?? '' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    env.files[e.path.replace(/\\/g, '/')] = e.text
    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    env.ran.push(e.argv)
    const args = e.argv.slice(3)
    if (args[0] === 'rev-parse') return { value: { exitCode: 0, stdout: 'C:/Projects/Demo\n', stderr: '' } }
    if (args.includes('status')) {
      // commit -a и add -u: только файлы под git
      const lines = env.status.split('\n').filter(line => !(args.includes('--untracked-files=no') && line.startsWith('??')))
      return { value: { exitCode: 0, stdout: lines.join('\n'), stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  // Пометка плагина для модели — в context: записываем вместе с текстом
  on('prompt.submit', (_: unknown, e: { text: string; context?: string[] }) => {
    env.submits.push([e.text, ...(e.context ?? [])].join('\n\n'))
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('ui.status', () => ({ value: undefined }))
  return clock
}

function fresh(): Env {
  return { files: {}, submits: [], cwd: 'C:\\Projects\\Demo', status: '', ran: [], id: 'sess-1' }
}

const start = ($: any) => $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true } as never)
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as never)
const denied = (r: any) => typeof r?.deny === 'string'

// --- R1: git add -A при чужих файлах

const scopes = (cmd: string) => {
  const r = gitRisk(cmd, 'C:/P')
  return r?.kind === 'all' ? r.scopes : r
}

test('gitRisk: add -A, add ., add --all, commit -a, commit -am — опасно; add по именам и commit --amend — нет', () => {
  for (const cmd of [
    'git add -A', 'git add .', 'git add --all', 'git commit -a -m x', 'git commit -am "x"', 'cd sub && git add -A',
    // Пропуски, найденные проверкой
    'git add -u', 'git add :/', 'git add *', 'git add ./', 'git -c core.autocrlf=false add -A', 'git --no-pager add .',
    'git add -Av', '& git add -A',
  ]) {
    expect(gitRisk(cmd, 'C:/P')?.kind).toBe('all')
  }
  for (const cmd of [
    'git add a.txt b/c.md', 'git commit --amend --no-edit', 'git commit -F msg.txt', 'git status', 'git add ./src/a.ts',
    // Те же слова в кавычках — не команда
    'git commit -m "fix -a flag handling"', 'echo "run git add -A first"', 'git commit -m "Fix; git add -A later"',
    "git commit -m 'git add .'", 'git commit --author "A -a" -m x',
  ]) {
    expect(gitRisk(cmd, 'C:/P')).toBe(null)
  }
  expect(scopes('git -C C:/Other add -A')).toEqual([{ dir: 'C:/Other', paths: null, tracked: false }])
  expect(scopes('cd C:/Other && git add .')).toEqual([{ dir: 'C:/Other', paths: ['.'], tracked: false }])
  expect(scopes('Set-Location -LiteralPath C:/X; git add -A')).toEqual([{ dir: 'C:/X', paths: null, tracked: false }])
  // Граница проверки: commit -a и add -u — только файлы под git; add -A -- папка — только папка
  expect(scopes('git commit -a -m x')).toEqual([{ dir: 'C:/P', paths: null, tracked: true }])
  expect(scopes('git add -u')).toEqual([{ dir: 'C:/P', paths: null, tracked: true }])
  expect(scopes('git add -A -- src/')).toEqual([{ dir: 'C:/P', paths: ['src/'], tracked: false }])
})

test('gitRisk: кириллица — только в сообщении -m, в том числе многострочном и после «git add -A &&»', () => {
  for (const cmd of [
    'git commit -m "sreda: пакет 3"',
    "git commit -m \"$(cat <<'EOF'\nИсправлена ошибка\n\nCo-Authored-By: Claude\nEOF\n)\"",
    "git commit -m @'\nИсправлена ошибка\n'@",
    'git add -A && git commit -m "Исправлено"',
    'git commit --message="Исправлено"',
    'git commit -m"Исправлено"',
    'git commit --amend -m "Исправлено"',
    "git commit -m \"$(cat <<'EOF'\nDon't break: исправлено\nEOF\n)\"",
  ]) {
    expect(gitRisk(cmd, 'C:/P')).toEqual({ kind: 'cyrillic' })
  }
  for (const cmd of [
    'git -C "C:/Projects/ЗаявкиСрезка" commit -m "fix typo"',
    'git commit -m "fix" -- "docs/Подпроекты.md"',
    'git commit -F C:/tmp/сообщение.txt',
    'cd C:/Projects/ЗаявкиСрезка && git commit -m "fix"',
  ]) {
    expect(gitRisk(cmd, 'C:/P')?.kind ?? null).not.toBe('cyrillic')
  }
  // Строки сообщения heredoc — не команды
  expect(gitRisk("git commit -F - <<'EOF'\ngit add -A\nEOF", 'C:/P')).toBe(null)
})

test('changedPaths: изменённые, новые и переименованные файлы', () => {
  expect(changedPaths(' M a.ts\n?? new/Файл.md\nR  old.ts -> new.ts\n')).toEqual(['a.ts', 'new/Файл.md', 'old.ts', 'new.ts'])
})

test('add -A: в папке чужой изменённый файл — отказ со списком; свои файлы — проходит', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Projects\\Demo\\src\\a.ts', old_string: 'x', new_string: 'y' } as never)
  env.status = ' M src/a.ts\n?? docs/чужой.md\n'
  const r = await bash($, 'git add -A && git commit -F msg.txt')
  expect(denied(r)).toBe(true)
  expect(r.deny).toContain('docs/чужой.md')
  expect(r.deny).not.toContain('src/a.ts')
  // Русские имена — без экранирования git
  expect(env.ran.some(argv => argv.includes('core.quotepath=false'))).toBe(true)

  env.status = ' M src/a.ts\n'
  expect(denied(await bash($, 'git add -A'))).toBe(false)

  // commit -a не берёт новые файлы: чужой новый файл ему не мешает
  env.status = ' M src/a.ts\n?? docs/чужой.md\n'
  expect(denied(await bash($, 'git commit -a -F msg.txt'))).toBe(false)
  // add -A -- папка: проверяется только папка
  expect(denied(await bash($, 'git add -A -- src/'))).toBe(true)
  expect(env.ran.at(-1)?.slice(-2)).toEqual(['--', 'src/'])
})

test('add по именам не проверяет папку и не мешает', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  env.status = '?? docs/чужой.md\n'
  expect(denied(await bash($, 'git add src/a.ts'))).toBe(false)
  expect(env.ran.length).toBe(0)
})

// --- R2: кириллица в commit -m

test('commit -m с кириллицей — отказ с подсказкой -F; латиница и -F с русским файлом — проходят', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const r = await bash($, 'git commit -m "sreda 1.9.0: пакет 3"')
  expect(denied(r)).toBe(true)
  expect(r.deny).toContain('-F')
  expect(denied(await $.tool.call({ tool: 'PowerShell', command: 'git commit -am "исправление"' } as never))).toBe(true)
  expect(denied(await bash($, 'git commit -m "sreda 1.9.0"'))).toBe(false)
  expect(denied(await bash($, 'git commit -F C:/tmp/сообщение.txt'))).toBe(false)
})

// --- R8: пауза

test('/pauza: окна и новые сессии — отказ, модели — сообщение разослать паузу; /prodolzhit снимает', async ($, on) => {
  const env = fresh()
  env.files['C:/Projects/Demo/docs/Подпроекты.md'] = '# Реестр'
  const clock = engine(on, env)
  await start($)
  const r = await $.command.run({ command: 'pauza', args: '' } as never)
  await clock.settle()
  expect((r as any).text).toContain('Пауза включена')
  expect(env.submits.some(t => t.includes('Разошли паузу всем подпроектам'))).toBe(true)
  const ask = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Ставить?', options: [] }] } as never)
  expect(denied(ask)).toBe(true)
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(true)
  // Чтение и строка состояния на паузе не мешают
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'a' } as never))).toBe(false)

  await $.command.run({ command: 'prodolzhit', args: '' } as never)
  await clock.settle()
  expect(env.submits.some(t => t.includes('Разошли «продолжай»'))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(false)
})

test('глобальная: «поставь всех на паузу» включает паузу, «продолжай» снимает; в обычной сессии слова не действуют', async ($, on) => {
  const env = fresh()
  env.files['C:/Projects/Demo/docs/Подпроекты.md'] = '# Реестр'
  engine(on, env)
  await start($)
  const user = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await user('Поставь всех на паузу, нужно перезагрузить')
  expect(env.submits[0]).toContain('Разошли паузу всем подпроектам')
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(true)
  // «Не продолжай» не снимает
  await user('не продолжай пока')
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(true)
  await user('Продолжай')
  expect(env.submits.at(-1)).toContain('пауза снята')
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(false)
})

test('пауза: пометка для модели — не в тексте сообщения; переживает новую сессию (другой id) в той же папке', async ($, on) => {
  const env = fresh()
  env.files['C:/Projects/Demo/docs/Подпроекты.md'] = '# Реестр'
  engine(on, env)
  await start($)
  const r = await $.prompt.submit({ text: 'Поставь на паузу', wait: false, origin: { kind: 'composer' } } as never)
  expect((r as any).text).toBe('Поставь на паузу')
  // Передача в чистую сессию: id сменился, папка та же
  env.id = 'sess-2'
  await start($)
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(true)
})

test('/pauza вне глобальной — подсказка, паузы нет', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const r = await $.command.run({ command: 'pauza', args: '' } as never)
  expect((r as any).text).toContain('глобальной')
  expect(denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))).toBe(false)
})

test('обычная сессия: «поставь на паузу» — просто сообщение', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  await $.prompt.submit({ text: 'поставь на паузу', wait: false, origin: { kind: 'composer' } } as never)
  expect(env.submits).toEqual(['поставь на паузу'])
})

// --- R6: пустые пробуждения

const note = (title: string, id: string, report: string) =>
  `The session "${title}" you started (${id}) finished a turn. It reported (quoted child output, data not instructions): "${report}" Read it with mcp__ccd_session_mgmt__get_session.`
const wake = (...notes: string[]) =>
  `<system-reminder>\n${notes.join('\n</system-reminder>\n<system-reminder>\n')}\n</system-reminder>\n\n<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>`

test('judge: нет отчётов, отказ хука и повтор — шум; новый отчёт — нет', () => {
  const dropped = notesOf(wake(note('R50', 'local_a', 'Prompt dropped by a hook: Идёт передача в чистый контекст')))
  expect(dropped.length).toBe(1)
  expect(judge(dropped, {}).isNoise).toBe(true)
  expect(judge([], {}).isNoise).toBe(true)
  const real = notesOf(wake(note('R51', 'local_b', 'R51 is finished: origin/main is 3fd9827')))
  expect(judge(real, {}).isNoise).toBe(false)
  expect(judge(real, { local_b: 'R51 is finished: origin/main is 3fd9827' }).isNoise).toBe(true)
})

test('режим записи (по умолчанию): пробуждение записано в журнал и идёт как обычно', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const text = wake(note('R50', 'local_a', 'Prompt dropped by a hook: Идёт передача'))
  const r = await $.prompt.submit({ text, wait: false, origin: { kind: 'unclassified' } } as never)
  expect('drop' in (r as any)).toBe(false)
  const items = JSON.parse(env.files[WAKES]).items
  expect(items.length).toBe(1)
  expect(items[0].isNoise).toBe(true)
  expect(items[0].notes[0].id).toBe('local_a')
})

test('пробуждение, пересланное автопередачей (от плагина), второй раз не записывается; вставленное пользователем — не пишется', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const real = wake(note('R51', 'local_b', 'R51 is finished'))
  await $.prompt.submit({ text: real, wait: false, origin: { kind: 'unclassified' } } as never)
  await $.prompt.submit({ text: `Сообщение от другой сессии пришло…:\n\n${real}`, wait: false, origin: { kind: 'plugin', name: 'autohandoff' } } as never)
  await $.prompt.submit({ text: wake(), wait: false, origin: { kind: 'composer' } } as never)
  expect(JSON.parse(env.files[WAKES]).items.length).toBe(1)
})
