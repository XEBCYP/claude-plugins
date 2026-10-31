import { expect, mock, test } from 'claude-code/testing'

// Карточка «сессия закончила работу и стоит» (hooks/ostanovki.ts). Под модом нет движка — хуки теста за него.
const HOME = 'C:/Users/tester/.claude'
const MAIN = `${HOME}/zhdut-otveta.json`
const ARCHIVE = `${HOME}/zhdut-otveta-arhiv.json`
const STATE = `${HOME}/sreda-sessii`
const MIN = 60_000

const PANE = {
  plugin: 'sreda',
  component: 'Pane',
  requestId: 'zhdut-otveta',
  surface: 'desktop',
  props: {
    title: 'Ждут ответа',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Env = {
  files: Record<string, string>
  mtimes: Record<string, number>
  submits: string[]
  contexts: string[]
  // $.state движка: живёт, пока жив процесс; новый процесс — пустой (restart)
  state: Record<string, unknown>
  cwd: string
  id: string
  dirs?: Record<string, string[]>
  // Номер сессии в приложении (CLAUDE_CODE_HOST_SESSION_ID) и ответ инструмента в тесте
  host?: string
  toolResult?: unknown
}

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester', ...(env.host ? { CLAUDE_CODE_HOST_SESSION_ID: env.host } : {}) })
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__sreda__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'zhdut-otveta', title: 'Ждут ответа', isShown: true, isFocused: false, isPlaced: true }] }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const path = e.path.replace(/\\/g, '/')
    if (path === STATE) {
      const names = Object.keys(env.files).filter(f => f.startsWith(`${STATE}/`)).map(f => f.slice(STATE.length + 1))
      return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: env.mtimes[`${STATE}/${name}`] ?? 0, isLink: false })) }
    }
    const names = env.dirs?.[path]
    if (!names) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: env.state[e.key], version: e.key in env.state ? 1 : 0 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    env.state[e.key] = e.value
    return { value: { isSet: true, version: 1 } }
  })
  on('session.id', () => ({ value: env.id }))
  on('session.cwd', () => ({ value: env.cwd }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const path = e.path.replace(/\\/g, '/')
    if (!(path in env.files)) throw new Error('ENOENT')
    return { value: env.files[path] }
  })
  on('fs.write', async (_: unknown, e: { path: string; text: string }) => {
    const path = e.path.replace(/\\/g, '/')
    env.files[path] = e.text
    env.mtimes[path] = await clock.now()
    return { value: undefined }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('prompt.submit', (_: unknown, e: { text: string; context?: string[] }) => {
    env.submits.push(e.text)
    env.contexts.push(...(e.context ?? []))
    return { text: e.text }
  })
  on('tool.call', () => ({ result: env.toolResult ?? 'ran' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  return clock
}

function list(env: Env, path: string): any[] {
  return path in env.files ? JSON.parse(env.files[path]).items : []
}

const newEnv = (over: Partial<Env> = {}): Env => ({
  files: {},
  mtimes: {},
  submits: [],
  contexts: [],
  state: {},
  cwd: 'C:\\Projects\\Demo',
  id: 'sess-1',
  ...over,
})
const END = { turnId: 't1', answer: 'Сделал отчёт.', durationMs: 1, isAborted: false, reason: 'answer' } as any

async function start($: any) {
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
}
// Приложение выгрузило процесс и запустило сессию снова: $.state пуст
async function restart($: any, env: Env) {
  env.state = {}
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
}
async function turn($: any, end: any = END) {
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.turn.complete(end)
}

test('проект: ход закончился — через 3 минуты карточка с итогом wrap_up и названием сессии; раньше — нет', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'Сделай', session_title: 'Отчёт за квартал' } as any)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Отчёт готов, лежит в docs.' } as never)
  await $.turn.complete(END)

  await clock.advance(2 * MIN)
  expect(list(env, MAIN)).toEqual([])
  await clock.advance(2 * MIN)
  const [card] = list(env, MAIN)
  expect(card.kind).toBe('ostanovka')
  expect(card.from).toBe('Demo')
  expect(card.question).toBe('Сессия «Отчёт за квартал» завершила работу и ждёт')
  expect(card.why).toContain('Итог: Отчёт готов, лежит в docs.')
  expect(card.options).toEqual([{ label: 'Ок' }])

  // Ещё минуты стоит — карточка одна
  await clock.advance(5 * MIN)
  expect(list(env, MAIN).length).toBe(1)
})

test('«Ок» убирает карточку в архив и ничего не шлёт сессии; повторно не появляется', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  await start($)
  await turn($)
  await clock.advance(4 * MIN)
  const [card] = list(env, MAIN)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${card.id}:ok` })
  await ui.unmount()
  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE).map(one => one.answer)).toEqual(['Ок'])
  await clock.advance(10 * MIN)
  expect(list(env, MAIN)).toEqual([])
  expect(env.submits).toEqual([])
})

test('новый ход в сессии убирает её карточку сам; ответ раньше 3 минут — карточки нет', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  await start($)
  await turn($)
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).length).toBe(1)
  await $.turn.start({ text: 'Продолжай', turnId: 't2' } as any)
  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE).map(one => one.answer)).toEqual(['сессия продолжила работу'])
  await $.turn.complete(END)
  await clock.advance(2 * MIN)
  await $.turn.start({ text: 'Ещё', turnId: 't3' } as any)
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])
  expect(env.submits).toEqual([])
})

test('прерванный ход — без карточки; ход с ошибкой — «остановилась с ошибкой»', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  await start($)
  await turn($, { ...END, isAborted: true, reason: 'aborted' })
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])
  await turn($, { ...END, reason: 'error', answer: 'API Error: 500' })
  await clock.advance(4 * MIN)
  const [card] = list(env, MAIN)
  expect(card.question).toBe('Сессия остановилась с ошибкой')
  expect(card.why).toContain('API Error: 500')
})

test('сессия ждёт свой вопрос в панели или свою фоновую задачу — карточки нет', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  await start($)
  env.files[MAIN] = JSON.stringify({
    items: [{ id: 'q1', from: 'Demo', question: 'Слить?', options: [{ label: 'Да' }], status: 'open', session: 'sess-1' }],
  })
  await turn($)
  await clock.advance(5 * MIN)
  expect(list(env, MAIN).map(one => one.id)).toEqual(['q1'])

  env.files[MAIN] = JSON.stringify({ items: [] })
  await $.turn.start({ text: 'x', turnId: 't2' } as any)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1' }], session_crons: [] } as any)
  await $.turn.complete(END)
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])
})

test('сессия подпроекта карточек не создаёт, но отмечает, что работает', async ($, on) => {
  const env = newEnv({
    cwd: 'C:\\Projects\\Sub',
    dirs: { 'c:/projects': ['Global', 'Sub'] },
  })
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Sub', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  expect(JSON.parse(env.files[`${STATE}/sess-1.json`]).busy).toBe(true)
  await $.turn.complete(END)
  expect(JSON.parse(env.files[`${STATE}/sess-1.json`]).busy).toBe(false)
  await clock.advance(10 * MIN)
  expect(list(env, MAIN)).toEqual([])
})

test('глобальная: карточка только когда стоят все подпроекты; закрытая посреди хода сессия не держит', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Global', id: 'glob' })
  env.files['C:/Projects/Global/docs/Подпроекты.md'] = '## A\n- **Где:** `C:\\Projects\\Sub`\n'
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true })
  const now = await clock.now()
  // Подпроект работает: свежая отметка
  env.files[`${STATE}/sub-1.json`] = JSON.stringify({ cwd: 'c:/projects/sub', busy: true, at: now })
  env.mtimes[`${STATE}/sub-1.json`] = now
  // Чужой проект работает — глобальную не держит
  env.files[`${STATE}/other.json`] = JSON.stringify({ cwd: 'c:/projects/other', busy: true, at: now })
  env.mtimes[`${STATE}/other.json`] = now
  await turn($)
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])

  // Подпроект встал
  const later = await clock.now()
  env.files[`${STATE}/sub-1.json`] = JSON.stringify({ cwd: 'c:/projects/sub', busy: false, at: later })
  env.mtimes[`${STATE}/sub-1.json`] = later
  await clock.advance(MIN)
  const [card] = list(env, MAIN)
  expect(card.question).toBe('Глобальная сессия и все подпроекты остановились')
  expect(card.from).toBe('Global')
})

test('глобальная: отметка подпроекта «работает» без обновления дольше 10 минут — не держит', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Global', id: 'glob' })
  env.files['C:/Projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true })
  const now = await clock.now()
  env.files[`${STATE}/sub-1.json`] = JSON.stringify({ cwd: 'c:/projects/sub/app', busy: true, at: now })
  env.mtimes[`${STATE}/sub-1.json`] = now
  await turn($)
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])
  await clock.advance(7 * MIN)
  // Подпроект с застывшей отметкой — ещё и карточка «ход оборван» о нём (docs/requirements/2026-10-31-obryv-hoda.md)
  expect(list(env, MAIN).map(one => one.question).sort()).toEqual([
    'Глобальная сессия и все подпроекты остановились',
    'Сессия оборвана посреди хода',
  ])
})

test('после перезапуска программы новый ход всё равно убирает старую карточку сессии', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  await start($)
  await turn($)
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).length).toBe(1)
  await restart($, env)
  await $.turn.start({ text: 'Продолжай', turnId: 't2' } as any)
  expect(list(env, MAIN)).toEqual([])
})

test('сессия подпроекта в рабочей копии git (.claude/worktrees) — тоже подпроект, карточек нет', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Sub\\.claude\\worktrees\\r1', dirs: { 'c:/projects': ['Global', 'Sub'] } })
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  const clock = engine(on, env)
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
  await turn($)
  await clock.advance(10 * MIN)
  expect(list(env, MAIN)).toEqual([])
})

test('подпроект ждёт свою фоновую работу — его отметка «работает», и после хода тоже', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Sub', dirs: { 'c:/projects': ['Global', 'Sub'] } })
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  const clock = engine(on, env)
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'x', turnId: 't1' } as any)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent' }], session_crons: [] } as any)
  await $.turn.complete(END)
  await clock.advance(15 * MIN)
  const it = JSON.parse(env.files[`${STATE}/sess-1.json`])
  expect(it.busy).toBe(true)
  expect(await clock.now() - it.at).toBeLessThan(2 * MIN)
})

test('ошибка глобальной — карточка «остановилась с ошибкой», даже пока подпроект работает', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Global', id: 'glob' })
  env.files['C:/Projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true })
  await turn($, { ...END, reason: 'error', answer: 'API Error' })
  const now = await clock.now()
  env.files[`${STATE}/sub-1.json`] = JSON.stringify({ cwd: 'c:/projects/sub', busy: true, at: now })
  env.mtimes[`${STATE}/sub-1.json`] = now
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).map(one => one.question)).toEqual(['Глобальная сессия остановилась с ошибкой'])
})

// Оборванный ход (docs/requirements/2026-10-31-obryv-hoda.md)
const CUT = '[Плагин sreda: прошлый ход этой сессии оборван.]'

test('O01: прошлая отметка «ход идёт» — при запуске сессия сама получает «доделай начатое», отметка снята', async ($, on) => {
  const env = newEnv()
  env.files[`${STATE}/sess-1.json`] = JSON.stringify({ cwd: 'C:/Projects/Demo', busy: true, at: 900_000 })
  engine(on, env)
  await start($)
  expect(env.submits.filter(s => s.startsWith(CUT)).length).toBe(1)
  const it = JSON.parse(env.files[`${STATE}/sess-1.json`])
  expect(it.busy).toBe(false)
  // Обрыв помнится до начала хода; папка — с заглавными буквами
  expect(it.cut).toBe(900_000)
  expect(it.cwd).toBe('C:/Projects/Demo')
  await $.turn.start({ text: CUT, turnId: 't1' } as any)
  expect(JSON.parse(env.files[`${STATE}/sess-1.json`]).cut).toBe(undefined)
})

test('O08: перезагрузка плагина в том же процессе — не обрыв: ни посреди хода, ни пока ждёт фоновую задачу', async ($, on) => {
  const env = newEnv()
  engine(on, env)
  await start($)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await start($)
  expect(env.submits.filter(s => s.startsWith(CUT))).toEqual([])
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1' }], session_crons: [] } as any)
  await $.turn.complete(END)
  expect(JSON.parse(env.files[`${STATE}/sess-1.json`]).busy).toBe(true)
  await start($)
  expect(env.submits.filter(s => s.startsWith(CUT))).toEqual([])
})

test('O09: обрыв, после которого хода не было, — при следующем запуске сообщение снова; перезагрузка не повторяет', async ($, on) => {
  const env = newEnv()
  env.files[`${STATE}/sess-1.json`] = JSON.stringify({ cwd: 'C:/Projects/Demo', busy: true, at: 900_000 })
  engine(on, env)
  await start($)
  await start($)
  expect(env.submits.filter(s => s.startsWith(CUT)).length).toBe(1)
  // Процесс выгружен снова до начала хода
  await restart($, env)
  expect(env.submits.filter(s => s.startsWith(CUT)).length).toBe(2)
})

test('O07: ход закончился или прерван пользователем — отметка «не идёт», при запуске сообщения нет', async ($, on) => {
  const env = newEnv()
  engine(on, env)
  await start($)
  await turn($, { ...END, isAborted: true, reason: 'aborted' })
  await restart($, env)
  expect(env.submits.filter(s => s.startsWith(CUT))).toEqual([])
})

test('O02: глобальная на паузе — при запуске после обрыва сообщения нет', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Global', id: 'glob' })
  env.files['C:/Projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  engine(on, env)
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pauza', args: '' } as never)
  env.files[`${STATE}/glob.json`] = JSON.stringify({ cwd: 'C:/Projects/Global', busy: true, at: 900_000 })
  // Пауза видна и подпроектам — файлом
  expect(typeof JSON.parse(env.files[`${HOME}/sreda-pauza.json`]).at).toBe('number')
  await restart($, env)
  expect(env.submits.filter(s => s.startsWith(CUT))).toEqual([])
  // Сообщение на паузе — без «доделай»; «продолжай» — с ним, один раз
  await $.prompt.submit({ text: 'Что сейчас?', wait: false, origin: { kind: 'composer' } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT))).toEqual([])
  // Ход на паузе обрыв не снимает
  await turn($)
  await $.prompt.submit({ text: 'Продолжай', wait: false, origin: { kind: 'composer' } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT)).length).toBe(1)
  expect(env.files[`${HOME}/sreda-pauza.json`]).toBe('{}')
  await $.prompt.submit({ text: 'Ещё', wait: false, origin: { kind: 'composer' } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT)).length).toBe(1)
})

test('O02: подпроект на паузе глобальной — при запуске после обрыва сообщения нет, после «продолжай» — есть', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Sub', dirs: { 'c:/projects': ['Global', 'Sub'] } })
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  env.files[`${STATE}/sess-1.json`] = JSON.stringify({ cwd: 'C:/Projects/Sub', busy: true, at: 900_000 })
  // Глобальная на паузе: отметка паузы для других сессий
  env.files[`${HOME}/sreda-pauza.json`] = JSON.stringify({ at: 1, cwd: 'c:/projects/global' })
  engine(on, env)
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
  expect(env.submits.filter(s => s.startsWith(CUT))).toEqual([])
  // Глобальная сняла паузу и прислала «продолжай»
  env.files[`${HOME}/sreda-pauza.json`] = '{}'
  // Команда пометку не забирает
  await $.prompt.submit({ text: '/uroven', command: 'uroven', wait: false, origin: { kind: 'composer' } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT))).toEqual([])
  await $.prompt.submit({ text: 'Продолжай', wait: false, origin: { kind: 'sdk' } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT)).length).toBe(1)
})

test('O02: «продолжай» от глобальной приходит сообщением сессии (isMeta, origin peer) — пометка с ним', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Sub', dirs: { 'c:/projects': ['Global', 'Sub'] } })
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  env.files[`${STATE}/sess-1.json`] = JSON.stringify({ cwd: 'C:/Projects/Sub', busy: true, at: 900_000 })
  env.files[`${HOME}/sreda-pauza.json`] = JSON.stringify({ at: 1, cwd: 'c:/projects/global' })
  engine(on, env)
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
  env.files[`${HOME}/sreda-pauza.json`] = '{}'
  // Своё служебное сообщение (не от другой сессии) пометку не забирает
  await $.prompt.submit({ text: 'служебное', isMeta: true, wait: false, origin: { kind: 'sdk' } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT))).toEqual([])
  await $.prompt.submit({ text: 'Продолжай', isMeta: true, wait: false, origin: { kind: 'peer', hostInjected: true } } as never)
  expect(env.contexts.filter(s => s.startsWith(CUT)).length).toBe(1)
})

test('O03/O04/O06: чужая отметка «ход идёт» без обновления дольше 10 минут — одна карточка «ход оборван»', async ($, on) => {
  const env = newEnv()
  const clock = engine(on, env)
  const now = await clock.now()
  env.files[`${STATE}/glob.json`] = JSON.stringify({ cwd: 'c:/projects/flower', title: 'Глобальный проект', busy: true, at: now })
  // Старше суток и чужая законченная — без карточек
  env.files[`${STATE}/old.json`] = JSON.stringify({ cwd: 'c:/projects/old', busy: true, at: now - 25 * 60 * MIN })
  env.files[`${STATE}/done.json`] = JSON.stringify({ cwd: 'c:/projects/done', busy: false, at: now - 30 * MIN })
  await start($)
  await clock.advance(9 * MIN)
  expect(list(env, MAIN)).toEqual([])
  await clock.advance(3 * MIN)
  const cards = list(env, MAIN)
  expect(cards.length).toBe(1)
  expect(cards[0].id).toBe(`obryv-glob-${now}`)
  expect(cards[0].session).toBe('glob')
  expect(cards[0].from).toBe('flower')
  expect(cards[0].question).toBe('Сессия «Глобальный проект» оборвана посреди хода')
  const at = new Date(now)
  expect(cards[0].why).toContain(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`)
  // Ещё минуты — не дублируется; «Ок» — в архиве, снова не появляется
  await clock.advance(5 * MIN)
  expect(list(env, MAIN).length).toBe(1)
  env.files[ARCHIVE] = JSON.stringify({ items: [{ ...cards[0], status: 'answered', answer: 'Ок' }] })
  env.files[MAIN] = JSON.stringify({ items: [] })
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])
})

test('O06: подпроект тоже даёт карточку об оборванной сессии — открыты только глобальная и подпроекты', async ($, on) => {
  const env = newEnv({ cwd: 'C:\\Projects\\Sub', dirs: { 'c:/projects': ['Global', 'Sub'] } })
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Sub`'
  const clock = engine(on, env)
  env.files[`${STATE}/glob.json`] = JSON.stringify({ cwd: 'C:/Projects/FlowerMarket_App', busy: true, at: await clock.now() })
  await $.session.start({ cwd: env.cwd, surface: 'desktop', isInteractive: true })
  await clock.advance(15 * MIN)
  expect(list(env, MAIN).map(one => one.from)).toEqual(['FlowerMarket_App'])
})

test('O05: оборванная сессия запустилась и пошёл ход — её карточка «ход оборван» в архиве', async ($, on) => {
  const env = newEnv({ id: 'glob' })
  env.files[MAIN] = JSON.stringify({
    items: [{ id: 'obryv-glob-1', from: 'flower', question: 'q', why: 'w', options: [{ label: 'Ок' }], kind: 'ostanovka', status: 'open', asked: '2026-10-31', session: 'glob' }],
  })
  env.files[`${STATE}/glob.json`] = JSON.stringify({ cwd: 'c:/projects/demo', busy: true, at: 900_000 })
  engine(on, env)
  await start($)
  await $.turn.start({ text: CUT, turnId: 't1' } as any)
  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE).map(one => one.id)).toEqual(['obryv-glob-1'])
})

// R11: «чтобы сессия, которая ожидает ответа своей подсессии, не присылала сообщение о том, что она стала на паузу,
// так как подсессия еще работает» (31.10, вариант А)
const KID = `${STATE}/kid-cli.json`
const kidMark = (busy: boolean, at: number) =>
  JSON.stringify({ cwd: 'C:/Projects/Demo', title: 'Справочники без дублей', busy, at, host: 'local_kid' })
const STARTED = [
  {
    type: 'text',
    text:
      'Started session "Справочники без дублей" (session_id: local_kid, name: kid). It runs on its own; you get a ' +
      'note here when its turn ends.',
  },
]

test('R11: сессия запустила подсессию — пока та работает, карточки нет; обе стоят — «и её подсессии остановились»', async ($, on) => {
  const env = newEnv({ host: 'local_parent', toolResult: STARTED })
  const clock = engine(on, env)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'Сделай', session_title: 'Невыполненные пункты' } as any)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Справочники без дублей' } as never)
  await $.turn.complete(END)
  // Своя отметка — с номером сессии в приложении
  expect(JSON.parse(env.files[`${STATE}/sess-1.json`]).host).toBe('local_parent')
  // Подсессия работает или ждёт свою фоновую задачу (её отметка «ход идёт» обновляется раз в минуту)
  for (let i = 0; i < 6; i++) {
    env.files[KID] = kidMark(true, await clock.now())
    await clock.advance(MIN)
  }
  expect(list(env, MAIN)).toEqual([])
  // Подсессия остановилась — карточка о обеих
  env.files[KID] = kidMark(false, await clock.now())
  await clock.advance(MIN)
  const cards = list(env, MAIN)
  expect(cards.length).toBe(1)
  expect(cards[0].question).toBe('Сессия «Невыполненные пункты» и её подсессии остановились')
})

test('R11: подсессия из уведомления «you started (local_…)» — помнится и после перезапуска', async ($, on) => {
  const env = newEnv({ host: 'local_parent' })
  const clock = engine(on, env)
  await start($)
  await $.prompt.submit({
    text:
      '<system-reminder> The session "Справочники без дублей" you started (local_kid) finished a turn. Read it with ' +
      'list_events.',
    wait: false,
    origin: { kind: 'sdk' },
  } as never)
  await restart($, env)
  await turn($)
  env.files[KID] = kidMark(true, await clock.now())
  await clock.advance(5 * MIN)
  expect(list(env, MAIN)).toEqual([])
  env.files[KID] = kidMark(false, await clock.now())
  await clock.advance(MIN)
  expect(list(env, MAIN).length).toBe(1)
})

test('R11: отметка подсессии без обновления дольше 10 минут — не держит; работающая чужая сессия — тоже', async ($, on) => {
  const env = newEnv({ host: 'local_parent', toolResult: STARTED })
  const clock = engine(on, env)
  await start($)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  await $.turn.complete(END)
  env.files[KID] = kidMark(true, (await clock.now()) - 11 * MIN)
  // Работает сессия, которую эта не запускала
  env.files[`${STATE}/other.json`] = JSON.stringify({
    cwd: 'C:/Projects/Demo',
    busy: true,
    at: await clock.now(),
    host: 'local_other',
  })
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).filter(one => one.id.startsWith('ost-')).length).toBe(1)
})

test('R11: цепочка — сессия стоит, а её подсессия работает: своя отметка «работает» для родителя; перестала — снята', async ($, on) => {
  const env = newEnv({ host: 'local_mid', toolResult: STARTED })
  const clock = engine(on, env)
  await start($)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  await $.turn.complete(END)
  const own = () => JSON.parse(env.files[`${STATE}/sess-1.json`])
  expect(own().busy).toBe(false)
  env.files[KID] = kidMark(true, await clock.now())
  await clock.advance(MIN)
  expect(own().busy).toBe(true)
  expect(own().at).toBe(await clock.now())
  env.files[KID] = kidMark(false, await clock.now())
  await clock.advance(MIN)
  expect(own().busy).toBe(false)
})

test('R11: «session_id: local_…» в сообщении (пересылка) — не подсессия', async ($, on) => {
  const env = newEnv({ host: 'local_parent' })
  const clock = engine(on, env)
  await start($)
  await $.prompt.submit({
    text: 'Глобальная: Started session "Справочники без дублей" (session_id: local_kid, name: kid).',
    isMeta: true,
    wait: false,
    origin: { kind: 'peer', hostInjected: true },
  } as never)
  await turn($)
  env.files[KID] = kidMark(true, await clock.now())
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).map(one => one.question)).toEqual(['Сессия завершила работу и ждёт'])
})

test('R11: ход с ошибкой при работающей подсессии — карточка сразу', async ($, on) => {
  const env = newEnv({ host: 'local_parent', toolResult: STARTED })
  const clock = engine(on, env)
  await start($)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  await $.turn.complete({ ...END, reason: 'error', answer: 'API Error: 500' })
  env.files[KID] = kidMark(true, await clock.now())
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).map(one => one.question)).toEqual(['Сессия остановилась с ошибкой'])
})

test('R11: /clear (новый номер CLI, тот же номер в приложении) — подсессии помнятся; не ждала подсессию — обычный текст', async ($, on) => {
  const env = newEnv({ host: 'local_parent', toolResult: STARTED })
  const clock = engine(on, env)
  await start($)
  await $.turn.start({ text: 'Сделай', turnId: 't1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  await $.turn.complete(END)
  env.id = 'sess-2'
  await restart($, env)
  await turn($)
  env.files[KID] = kidMark(true, await clock.now())
  await clock.advance(4 * MIN)
  expect(list(env, MAIN)).toEqual([])
  // Подсессия стоит с самого начала остановки — карточка без «и её подсессии»
  env.files[KID] = kidMark(false, await clock.now())
  await turn($)
  await clock.advance(4 * MIN)
  expect(list(env, MAIN).map(one => one.question)).toEqual(['Сессия завершила работу и ждёт'])
})
