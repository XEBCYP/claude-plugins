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
  cwd: string
  id: string
  dirs?: Record<string, string[]>
}

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
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
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    env.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ran' }))
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
  cwd: 'C:\\Projects\\Demo',
  id: 'sess-1',
  ...over,
})
const END = { turnId: 't1', answer: 'Сделал отчёт.', durationMs: 1, isAborted: false, reason: 'answer' } as any

async function start($: any) {
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
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
  expect(list(env, MAIN).length).toBe(1)
})
