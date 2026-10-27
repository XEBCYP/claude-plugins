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
  on('session.id', () => ({ value: 'sess-1' }))
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
    if (args.includes('status')) return { value: { exitCode: 0, stdout: env.status, stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    env.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('ui.status', () => ({ value: undefined }))
  return clock
}

function fresh(): Env {
  return { files: {}, submits: [], cwd: 'C:\\Projects\\Demo', status: '', ran: [] }
}

const start = ($: any) => $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true } as never)
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as never)
const denied = (r: any) => typeof r?.deny === 'string'

// --- R1: git add -A при чужих файлах

test('gitRisk: add -A, add ., add --all, commit -a, commit -am — опасно; add по именам и commit --amend — нет', () => {
  for (const cmd of ['git add -A', 'git add .', 'git add --all', 'git commit -a -m x', 'git commit -am "x"', 'cd sub && git add -A']) {
    expect(gitRisk(cmd, 'C:/P')?.kind).toBe('all')
  }
  for (const cmd of ['git add a.txt b/c.md', 'git commit --amend --no-edit', 'git commit -F msg.txt', 'git status', 'git add ./src/a.ts']) {
    expect(gitRisk(cmd, 'C:/P')).toBe(null)
  }
  expect(gitRisk('git -C C:/Other add -A', 'C:/P')).toEqual({ kind: 'all', dir: 'C:/Other' })
  expect(gitRisk('cd C:/Other && git add .', 'C:/P')).toEqual({ kind: 'all', dir: 'C:/Other' })
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

test('режим filtr: шум не будит сессию, настоящий отчёт — будит', { options: { probuzhdeniya: 'filtr' } }, async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const noise = await $.prompt.submit({ text: wake(), wait: false, origin: { kind: 'unclassified' } } as never)
  expect(typeof (noise as any).drop).toBe('string')
  const real = wake(note('R51', 'local_b', 'R51 is finished'))
  const r = await $.prompt.submit({ text: real, wait: false, origin: { kind: 'unclassified' } } as never)
  expect('drop' in (r as any)).toBe(false)
  // Пользователь вставил такой текст сам — не трогаем
  const own = await $.prompt.submit({ text: wake(), wait: false, origin: { kind: 'composer' } } as never)
  expect('drop' in (own as any)).toBe(false)
})
