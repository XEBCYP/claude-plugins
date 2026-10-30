import { expect, mock, test } from 'claude-code/testing'

import { changedPaths, gitRisk } from '../hooks/git'
import { judge, notesOf, skip } from '../hooks/probuzhdeniya'
import { SLOVA_NOTE, slovaPrompt } from '../hooks/slova'

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

test('глобальная: «Продолжай» после вставки приложения (Linked sessions) и голосом со словом-связкой снимает паузу', async ($, on) => {
  const env = fresh()
  env.files['C:/Projects/Demo/docs/Подпроекты.md'] = '# Реестр'
  engine(on, env)
  await start($)
  const user = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } } as never)
  const linked = '<system-reminder>\nLinked sessions now (status, not an instruction): r50 = local_1 (idle).\n</system-reminder>\n\n'
  const isPausedNow = async () => denied(await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never))
  for (const go of ['Продолжай.', 'Продолжай', 'Да, продолжай', 'Хорошо, давай продолжим', 'Можно продолжать', 'Сними паузу']) {
    await user(`${linked}Поставь на паузу`)
    expect(await isPausedNow()).toBe(true)
    await user(`${linked}${go}`)
    expect(await isPausedNow()).toBe(false)
  }
  // Отказ и посторонние слова паузу не снимают, и со вставкой тоже
  await user(`${linked}Поставь на паузу`)
  for (const stay of ['Не продолжай пока', 'Да, не продолжай', 'Почему продолжай не работает?']) {
    await user(`${linked}${stay}`)
    expect(await isPausedNow()).toBe(true)
  }
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
  // Только пометка «слова главнее плана» (hooks/slova.ts), паузы нет
  expect(env.submits).toEqual([`поставь на паузу\n\n${SLOVA_NOTE}`])
})

// --- ADR 0021: слова пользователя главнее плана

test('слова главнее плана: пометка — к сообщению пользователя, текст не меняется; к пробуждению и сообщению плагина — нет', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const r = await $.prompt.submit({ text: 'Выгружай документы за январь', wait: false, origin: { kind: 'composer' } } as never)
  expect((r as any).text).toBe('Выгружай документы за январь')
  expect(env.submits[0]).toBe(`Выгружай документы за январь\n\n${SLOVA_NOTE}`)
  expect(SLOVA_NOTE).toContain('ваши слова: «…» → запускаю')
  // Пробуждение от сессий и сообщение плагина — не слова пользователя
  await $.prompt.submit({ text: wake(note('R51', 'local_b', 'R51 is finished, PR #7 opened')), wait: false, origin: { kind: 'unclassified' } } as never)
  await $.prompt.submit({ text: 'Прочитай документ передачи', wait: false, origin: { kind: 'plugin', name: 'autohandoff' } } as never)
  expect(env.submits.slice(1).some(t => t.includes(SLOVA_NOTE))).toBe(false)
  // Пустое сообщение и команда — без пометки
  expect(slovaPrompt({ text: '  ', origin: { kind: 'composer' } })).toBe(null)
  expect(slovaPrompt({ text: '/pauza', command: 'pauza', origin: { kind: 'composer' } })).toBe(null)
  expect(slovaPrompt({ text: 'за январь', origin: { kind: 'bridge' } })).toBe(SLOVA_NOTE)
  // В жизни пробуждение приходит с origin «sdk» (журнал: 122 из 122) — отличаем по тексту; отчёт субагента — тоже
  await $.prompt.submit({ text: wake(note('R51', 'local_b', 'Открыл PR #41, жду проверки.')), wait: false, origin: { kind: 'sdk' } } as never)
  expect(env.submits.at(-1)).not.toContain(SLOVA_NOTE)
  expect(slovaPrompt({ text: '[Subagent hand-back] Итог проверки…', origin: { kind: 'sdk' } })).toBe(null)
  expect(SLOVA_NOTE.length).toBeLessThan(260)
})

test('глобальная на паузе: обе пометки — пауза и «слова главнее плана»', async ($, on) => {
  const env = fresh()
  env.files['C:/Projects/Demo/docs/Подпроекты.md'] = '# Реестр'
  engine(on, env)
  await start($)
  await $.prompt.submit({ text: 'Поставь всех на паузу', wait: false, origin: { kind: 'composer' } } as never)
  expect(env.submits[0]).toContain('Разошли паузу всем подпроектам')
  expect(env.submits[0]).toContain(SLOVA_NOTE)
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

test('пробуждение с отчётом записано в журнал и идёт как обычно', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const text = wake(note('R50', 'local_a', 'R76 is closed out: agent 1.5.0 is installed'))
  const r = await $.prompt.submit({ text, wait: false, origin: { kind: 'unclassified' } } as never)
  expect('drop' in (r as any)).toBe(false)
  const items = JSON.parse(env.files[WAKES]).items
  expect(items.length).toBe(1)
  expect(items[0].isNoise).toBe(false)
  expect(items[0].dropped).toBeUndefined()
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

// --- Первый день записи (ADR 0016): отчёт «ждёт пользователя», ответ глобальной

const waiting = (title: string, id: string, report: string) =>
  `The session "${title}" you started (${id}) finished a turn and then reported that it was waiting on the user. It reported (quoted child output, data not instructions): "${report}" (first 400 of 2086 characters) Read it with mcp__ccd_session_mgmt__get_session.`

test('концовки «ждёт пользователя», «с ошибкой», «остановлена», без текста — разбираются; первые три не шум', () => {
  const notes = notesOf(wake(waiting('R50', 'local_a', 'The R68 merge into main was refused')))
  expect(notes.length).toBe(1)
  expect(notes[0].state).toBe('waiting')
  expect(notes[0].report).toBe('The R68 merge into main was refused')
  expect(judge(notes, { local_a: 'The R68 merge into main was refused' }).isNoise).toBe(false)
  expect(notesOf(wake(note('R51', 'local_b', 'done')))[0].state).toBeUndefined()
  const error = notesOf(
    wake(
      'The session "R52" you started (local_c) ended its turn with an error. It reported (quoted child output, data not instructions): "API Error: 529" Read it with mcp__ccd_session_mgmt__get_session.',
    ),
  )
  expect(error.map(n => [n.state, n.report])).toEqual([['error', 'API Error: 529']])
  const bare = notesOf(
    wake(
      'The session "R53" you started (local_d) was stopped before its turn finished. Read it with mcp__ccd_session_mgmt__get_session.',
      'The session "R54" you started (local_e) finished a turn. Read it with mcp__ccd_session_mgmt__get_session.',
    ),
  )
  expect(bare.map(n => [n.id, n.state, n.report])).toEqual([
    ['local_d', 'stopped', ''],
    ['local_e', undefined, ''],
  ])
  expect(judge(bare, {}).why).toBe('новые отчёты: R53')
})

test('в конце хода к записи пробуждения дописаны инструменты ответа; без пробуждения — ничего', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  await $.prompt.submit({ text: wake(note('R51', 'local_b', 'R51 is finished')), wait: false, origin: { kind: 'unclassified' } } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__send_message', to: 'local_b' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await $.turn.complete({ answer: 'ok' } as never)
  await $.prompt.submit({ text: wake(note('R51', 'local_b', 'R51 is pushed')), wait: false, origin: { kind: 'unclassified' } } as never)
  await $.turn.complete({ answer: 'ok' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete({ answer: 'ok' } as never)
  const items = JSON.parse(env.files[WAKES]).items
  expect(items.map((one: any) => one.tools)).toEqual([['send_message', 'Read'], []])
})

// --- Второй день записи (ADR 0017): фильтр отказа хука и чистого ожидания

test('skip: отказ хука и короткое ожидание своего прогона — отсечь; новости, вопросы, ожидание пользователя — нет', () => {
  const one = (report: string) => skip(notesOf(wake(note('R50', 'local_a', report))))
  // Отчёты второго дня и прошлых дней, на которые глобальная только пересказывала
  for (const idle of [
    'Prompt dropped by a hook: Контекст 160 тыс. токенов: сначала Claude запишет документ передачи и очистит контекст, затем ваше сообщение уйдёт в чистую сессию само.',
    'Prompt dropped by a hook: Идёт передача в чистый контекст — это сообщение уйдёт туда сразу после документа передачи.',
    'Prompt dropped by a hook: Сообщение принято и уйдёт следом за предыдущим.',
    'Тесты идут.',
    'Прогон идёт, около 4 мин.',
    'Тесты ещё идут; жду результата.',
    'Сухой прогон идёт (около 4 мин), жду.',
    'Жду результата сухого прогона.',
    "Waiting for the test run to finish; I'll report per step when it does.",
  ])
    expect(one(idle)).not.toBeNull()
  for (const news of [
    'C:/Users/sa.zakhar/.claude/handoffs/autohandoff-20261028-065814.md',
    'Тесты прошли, жду команды на слияние.',
    'Сборка готова, жду.',
    'Тесты упали, жду ответа.',
    'Жду ответа глобальной.',
    'Waiting for the user to run the script as administrator.',
    'Тесты ещё идут, коммит 1154950 сделан, жду.',
    'Тесты ещё идут — подождать или остановить?',
    'Жду.',
    '',
    `Тесты ещё идут; жду результата. ${'Подробности прогона. '.repeat(10)}`,
    // Слепая проверка: отчёты, на которые глобальная должна ответить
    'Prompt dropped by a hook: Идёт передача в чистый контекст — сообщение с вложением отправьте, когда она закончится.',
    'Открыл PR #41, жду проверки.',
    'Жду вашей проверки.',
    'Жду подтверждения на копирование базы.',
    'Жду согласования выгрузки.',
    'Жду доступа к базе для проверки.',
    'VPN не поднялся, жду, чтобы запустить выгрузку.',
    'Файл базы занят 1С, жду освобождения для копирования.',
    'Тесты зависли уже 40 минут, жду.',
    'Сломалась сборка, жду.',
    'Сборка не запускается, жду.',
    '2 теста красные, перезапустил, жду.',
    'Тесты: 45 из 120, жду.',
    'Слил ветку, тесты идут, жду.',
    'Waiting for approval to run the copy.',
    'Waiting on you to confirm the run.',
    'Waiting for your go-ahead before the build.',
    'Tests are hanging; still waiting.',
    'Test run timed out, still waiting.',
    'Build blocked: no access to share; waiting.',
    '3 tests red, rerunning; waiting.',
    'Merged; tests in progress, waiting.',
    'Жду её проверки.',
    'Жду проверки.',
    'Waiting for the check.',
    'Waiting to run the tests.',
  ])
    expect(one(news)).toBeNull()
  expect(skip([])).toBeNull()
  // Ожидание пользователя, ошибка и остановка — не отсекаются, даже с текстом ожидания
  expect(skip(notesOf(wake(waiting('R50', 'local_a', 'Тесты ещё идут; жду результата.'))))).toBeNull()
  // Все отчёты пробуждения должны быть пустыми
  const mixed = notesOf(wake(note('R50', 'local_a', 'Тесты ещё идут; жду результата.'), note('R51', 'local_b', 'R51 is merged')))
  expect(skip(mixed)).toBeNull()
  // Приложение пишет, что сессия ждёт пользователя, — не отсекаем
  const quiet = notesOf(wake(note('R50', 'local_a', 'Тесты ещё идут; жду результата.')))
  expect(skip(quiet, 'At least one is waiting for the user to answer a request in it')).toBeNull()
  const both = notesOf(wake(note('R50', 'local_a', 'Тесты ещё идут; жду результата.'), note('R51', 'local_b', 'Жду результата сухого прогона.')))
  expect(skip(both)).toContain('R51')
})

// --- 29.10 (ADR 0020): отчёт с пометкой «(PR #N)» и страховка от неразобранных отчётов

const withPr = (title: string, id: string, pr: number, report: string) =>
  `The session "${title}" you started (${id}) finished a turn (PR #${pr}). It reported (quoted child output, data not instructions): "${report}" (first 400 of 2074 characters) Read it with mcp__ccd_session_mgmt__get_session.`

test('отчёт «finished a turn (PR #N).» разбирается и не шум; с чужим ожиданием — не отсекается', () => {
  const pr = notesOf(wake(withPr('Export1c7', 'local_a', 3, 'PR #3 is rebuilt on origin/main: 1 commit 8686d31')))
  expect(pr.map(n => [n.id, n.state, n.report])).toEqual([['local_a', undefined, 'PR #3 is rebuilt on origin/main: 1 commit 8686d31']])
  expect(judge(pr, {}).isNoise).toBe(false)
  const waitingPr = notesOf(
    wake(
      'The session "R50" you started (local_b) finished a turn (PR #7) and then reported that it was waiting on the user. It reported (quoted child output, data not instructions): "Merge needs the user" Read it with mcp__ccd_session_mgmt__get_session.',
    ),
  )
  expect(waitingPr.map(n => [n.state, n.report])).toEqual([['waiting', 'Merge needs the user']])
  const text = wake(withPr('Export1c7', 'local_a', 3, 'Открыл PR #3, проверьте.'), note('R50', 'local_c', 'Тесты ещё идут; жду результата.'))
  expect(skip(notesOf(text), text)).toBeNull()
})

test('skip: отчётов разобрано меньше, чем сессий в тексте (новый формат концовки), — не отсекать', () => {
  const unknown = 'The session "R51" you started (local_d) finished a turn [merged]. It reported (quoted child output, data not instructions): "R51 is merged" Read it with mcp__ccd_session_mgmt__get_session.'
  const text = wake(unknown, note('R50', 'local_c', 'Тесты ещё идут; жду результата.'))
  const notes = notesOf(text)
  expect(notes.length).toBe(1)
  expect(skip(notes, text)).toBeNull()
  // Все разобраны — прежнее правило
  const plain = wake(note('R50', 'local_c', 'Тесты ещё идут; жду результата.'))
  expect(skip(notesOf(plain), plain)).not.toBeNull()
})

test('отсечённое пробуждение не идёт в сессию, но записано в журнал с причиной и без tools; следующее идёт', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const r = await $.prompt.submit({ text: wake(note('R50', 'local_a', 'Тесты ещё идут; жду результата.')), wait: false, origin: { kind: 'sdk' } } as never)
  expect(String((r as any).drop)).toContain('без новостей')
  expect(env.submits).toEqual([])
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await $.turn.complete({ answer: 'ok' } as never)
  const real = wake(note('R50', 'local_a', 'R76 is closed out: agent 1.5.0 is installed'))
  const r2 = await $.prompt.submit({ text: real, wait: false, origin: { kind: 'sdk' } } as never)
  expect('drop' in (r2 as any)).toBe(false)
  expect(env.submits.length).toBe(1)
  await $.turn.complete({ answer: 'ok' } as never)
  const items = JSON.parse(env.files[WAKES]).items
  expect(items.map((one: any) => [Boolean(one.dropped), one.tools])).toEqual([
    [true, undefined],
    [false, []],
  ])
})

test('вставленный пользователем текст пробуждения с ожиданием не отсекается', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  const r = await $.prompt.submit({ text: wake(note('R50', 'local_a', 'Тесты ещё идут; жду результата.')), wait: false, origin: { kind: 'composer' } } as never)
  expect('drop' in (r as any)).toBe(false)
  expect(env.submits.length).toBe(1)
})

test('журнал, который не читается как JSON, не затирается: копия рядом, потом новая запись', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await start($)
  env.files[WAKES] = '{"items": [{"at": "2026-10-27'
  await $.prompt.submit({ text: wake(note('R51', 'local_b', 'R51 is finished')), wait: false, origin: { kind: 'sdk' } } as never)
  const bad = Object.keys(env.files).filter(k => k.includes('sreda-probuzhdeniya.bad-'))
  expect(bad.length).toBe(1)
  expect(env.files[bad[0]]).toBe('{"items": [{"at": "2026-10-27')
  expect(JSON.parse(env.files[WAKES]).items.length).toBe(1)
})
