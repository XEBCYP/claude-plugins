import { expect, mock, test } from 'claude-code/testing'

// Под модом нет движка: хуки теста отвечают за него. Вызов на `$` отвечается `{ value }`, событие — своим результатом.
const HOME = 'C:/Users/tester/.claude'
const MAIN = `${HOME}/zhdut-otveta.json`
const ARCHIVE = `${HOME}/zhdut-otveta-arhiv.json`
const Q = 'Слить PR?'

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
  submits: string[]
  // Ответ окна; null — окно висит, пока на него не ответят из панели
  dialog: string | null
  // Ответ окна с несколькими вариантами — списком, как его отдаёт само окно
  dialogMany?: string[]
  // Окно ещё не нарисовано, пока тест не отпустит
  gate?: Promise<void>
  // Ответы окна на каждый вопрос (окно с несколькими вопросами); ядро ставит на результат ref и text
  dialogAll?: Record<string, string | string[]>
  // Сколько раз окно открывалось на самом деле
  opened?: number
  // Какие вопросы окно показало (тексты), по разу на окно
  asked?: string[][]
  // Окно отклонено (Esc)
  deny?: boolean
  // Панель открыта (false — пользователь закрыл её крестиком); сколько раз модуль её открывал
  paneUp?: boolean
  paneOpens?: number
  // Папки: путь → имена вложенных папок (для $.fs.list)
  dirs?: Record<string, string[]>
}

const SKIPPED =
  '[User did not answer this question — they sent a message instead. Treat that message as their response; do not re-ask.]'

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('command.register', () => ({ value: { command: 'zhdut-otveta' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__sreda__${e.name}` } }))
  on('ui.open', () => {
    env.paneOpens = (env.paneOpens ?? 0) + 1
    env.paneUp = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: env.paneUp === false ? [] : [{ id: 'zhdut-otveta', title: 'Ждут ответа', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const names = env.dirs?.[e.path.replace(/\\/g, '/')]
    if (!names) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:\\Projects\\Demo' }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    // Нет файла — пустой текст: модуль читает его как пустой список
    return { value: env.files[e.path.replace(/\\/g, '/')] ?? '' }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    // Движок отдаёт путь в виде ОС (на Windows — с обратной косой)
    env.files[e.path.replace(/\\/g, '/')] = e.text
    return { value: undefined }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    env.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ran' }
    env.opened = (env.opened ?? 0) + 1
    env.asked?.push(e.questions.map((q: any) => q.question))
    if (env.deny) return { deny: 'User declined to answer questions' }
    if (env.gate) await env.gate
    if (env.dialogAll) return { result: { questions: e.questions, answers: env.dialogAll }, ref: 7, text: 'core text' }
    if (env.dialog === null) await new Promise(() => {})
    if (Array.isArray(env.dialogMany)) {
      return { result: { questions: e.questions, answers: { [e.questions[0].question]: env.dialogMany } } }
    }
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: env.dialog } } }
  })
  return clock
}

function list(env: Env, path: string): any[] {
  return path in env.files ? JSON.parse(env.files[path]).items : []
}

function ask($: any) {
  return $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: Q,
      header: 'PR',
      multiSelect: false,
      options: [{ label: 'Да', description: 'Слить' }, { label: 'Нет', description: 'Ждать' }],
    }],
  })
}

test('ответ в окне — вопрос сразу уходит из панели в архив', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: 'Да' }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const r: any = await ask($)

  expect(r.result.answers[Q]).toBe('Да')
  expect(list(env, MAIN)).toEqual([])
  const done = list(env, ARCHIVE)
  expect(done.length).toBe(1)
  expect(done[0].answer).toBe('Да')
  expect(done[0].from).toBe('Demo · PR')
  expect(env.submits).toEqual([])
})

test('окно закрыто сообщением без ответа — вопрос остаётся в панели, Claude велено спросить снова', async ($, on) => {
  // Так отвечает приложение, когда пользователь отправил сообщение, не нажав кнопку окна
  const env: Env = { files: {}, submits: [], dialog: SKIPPED }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const r: any = await ask($)

  const told = String(r.result.answers[Q])
  expect(told).toContain('Не отвечено')
  expect(told).toContain('mcp__sreda__otvecheno')
  expect(told).toContain('задайте этот вопрос окном AskUserQuestion снова')
  expect(told.includes('do not re-ask')).toBe(false)
  expect(list(env, ARCHIVE)).toEqual([])
  const [it] = list(env, MAIN)
  expect(it.question).toBe(Q)
  expect(typeof it.missed).toBe('string')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /закрылось вашим сообщением/ })).toBeDefined()
  await ui.unmount()

  // Claude задаёт вопрос снова теми же словами — та же запись, без дубля и без пометки
  // Окно ответит, когда тест отпустит: висящее окно получило бы ответ уже в следующем тесте
  let release = () => {}
  env.gate = new Promise<void>(r => (release = r))
  env.dialog = 'Да'
  const call = ask($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const again = list(env, MAIN)
  expect(again.length).toBe(1)
  expect(again[0].id).toBe(it.id)
  expect(again[0].missed).toBeUndefined()
  release()
  await call
})

const TWO = [
  { question: 'Первый?', header: 'А', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] },
  { question: 'Второй?', header: 'Б', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] },
]

test('два вопроса: один ответили, на другой — сообщение; результат свой, без ref ядра', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null, dialogAll: { 'Первый?': 'Да', 'Второй?': SKIPPED } }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: TWO })

  // С ref ядро показало бы модели свой текст — с заглушкой
  expect(r.ref).toBeUndefined()
  expect(r.text).toBeUndefined()
  expect(r.result.answers['Первый?']).toBe('Да')
  expect(String(r.result.answers['Второй?'])).toContain('Не отвечено')
  expect(list(env, ARCHIVE).map(one => one.question)).toEqual(['Первый?'])
  const open = list(env, MAIN)
  expect(open.map(one => one.question)).toEqual(['Второй?'])
  expect(typeof open[0].missed).toBe('string')
})

test('первый ответили кнопкой панели, потом сообщение — первый не «не отвечен»', async ($, on) => {
  let release = () => {}
  const env: Env = {
    files: {},
    submits: [],
    dialog: null,
    gate: new Promise<void>(resolve => (release = resolve)),
    dialogAll: { 'Первый?': SKIPPED, 'Второй?': SKIPPED },
  }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const call: Promise<any> = $.tool.call({ tool: 'AskUserQuestion', questions: TWO })
  await new Promise(resolve => setTimeout(resolve, 0))
  const first = list(env, MAIN).find(one => one.question === 'Первый?')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${first.id}:0` })
  await ui.unmount()
  release()
  const r = await call

  expect(r.result.answers['Первый?']).toBe('Да')
  expect(String(r.result.answers['Второй?'])).toContain('Не отвечено')
  expect(list(env, MAIN).map(one => one.question)).toEqual(['Второй?'])
  expect(list(env, ARCHIVE).map(one => one.question)).toEqual(['Первый?'])
  expect(env.submits).toEqual([])
})

test('пропущенный вопрос: ответ кнопкой панели приходит в чат сообщением; «отвечено» уносит его', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: SKIPPED }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  await ask($)
  const [it] = list(env, MAIN)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${it.id}:1` })
  await ui.unmount()
  expect(env.submits).toEqual([`Ответ на вопрос «${Q}» (Demo · PR): Нет`])
  expect(list(env, MAIN)).toEqual([])

  // Второй раз: отказ текстом в чате — инструмент «отвечено»
  await ask($)
  const r: any = await $.tool.call({ tool: 'mcp__sreda__otvecheno', question: Q, answer: 'не сейчас' })
  expect(String(r.result)).toContain('перенесён')
  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE).map(one => one.answer)).toEqual(['Нет', 'не сейчас'])
})

const TURN_END = { turnId: 't1', answer: 'готово', durationMs: 1, isAborted: false } as any

test('ответ в панели, пока идёт ход, — повтор вопроса получает его без окна и без новой записи', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: SKIPPED }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Новое задание', turnId: 't1' } as any)
  await ask($)
  const [it] = list(env, MAIN)

  // Ход ещё идёт: ответ кнопкой не встаёт сообщением в очередь «после хода»
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${it.id}:1` })
  await ui.unmount()
  expect(env.submits).toEqual([])
  expect(list(env, MAIN)).toEqual([])

  // Claude в конце хода задаёт вопрос снова — окно не открывается, ответ из панели приходит сразу
  const again: any = await ask($)
  expect(again.result.answers[Q]).toBe('Нет')
  expect(env.opened).toBe(1)
  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE).map(one => one.answer)).toEqual(['Нет'])

  // Ответ уже отдан — после хода дубля сообщением нет
  await $.turn.complete(TURN_END)
  expect(env.submits).toEqual([])
})

test('ответ в панели, пока идёт ход, а повтора не было — сообщение приходит после хода, один раз', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: SKIPPED }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Новое задание', turnId: 't1' } as any)
  await ask($)
  const [it] = list(env, MAIN)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${it.id}:0` })
  await ui.unmount()
  expect(env.submits).toEqual([])

  await $.turn.complete(TURN_END)
  expect(env.submits).toEqual([`Ответ на вопрос «${Q}» (Demo · PR): Да`])
  await $.turn.complete(TURN_END)
  expect(env.submits.length).toBe(1)
})

test('два вопроса: один ответили в панели во время хода — повтор спрашивает в окне только второй', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null, dialogAll: { 'Первый?': SKIPPED, 'Второй?': SKIPPED } }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Новое задание', turnId: 't1' } as any)
  await $.tool.call({ tool: 'AskUserQuestion', questions: TWO })
  const first = list(env, MAIN).find(one => one.question === 'Первый?')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${first.id}:0` })
  await ui.unmount()

  env.asked = []
  env.dialogAll = { 'Второй?': 'Нет' }
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: TWO })

  expect(env.asked).toEqual([['Второй?']])
  expect(r.result.answers).toEqual({ 'Первый?': 'Да', 'Второй?': 'Нет' })
  expect(r.result.questions.length).toBe(2)
  expect(list(env, MAIN)).toEqual([])
})

test('повтор с ответом из панели отклонён (Esc) — ответ не теряется, приходит после хода', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null, dialogAll: { 'Первый?': SKIPPED, 'Второй?': SKIPPED } }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Новое задание', turnId: 't1' } as any)
  await $.tool.call({ tool: 'AskUserQuestion', questions: TWO })
  const first = list(env, MAIN).find(one => one.question === 'Первый?')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${first.id}:0` })
  await ui.unmount()

  env.dialogAll = undefined
  env.deny = true
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: TWO })
  expect(r.deny).toBeDefined()
  expect(env.submits).toEqual([])

  await $.turn.complete(TURN_END)
  expect(env.submits).toEqual(['Ответ на вопрос «Первый?» (Demo · А): Да'])
})

test('кнопка панели сразу отвечает на открытое окно своей сессии', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = ask($)
  // Вопрос появился в панели сам
  await new Promise(resolve => setTimeout(resolve, 0))
  const open = list(env, MAIN)
  expect(open.length).toBe(1)
  expect(open[0].session).toBe('sess-1')

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${open[0].id}:1` })
  const r = await pending

  expect(r.result.answers[Q]).toBe('Нет')
  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE)[0].answer).toBe('Нет')
  // Ответ ушёл окну, отдельное сообщение не нужно
  expect(env.submits).toEqual([])
  await ui.unmount()
})

test('кнопка в другой сессии — окно этой сессии получает ответ при опросе файла', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = ask($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)

  // Другая сессия нажала кнопку: вопрос переехал в архив с её отметкой
  env.files[MAIN] = JSON.stringify({ items: [] })
  env.files[ARCHIVE] = JSON.stringify({ items: [{ ...it, status: 'answered', answer: 'Да', answeredIn: 'sess-2' }] })
  await clock.advance(1500)
  const r = await pending

  expect(r.result.answers[Q]).toBe('Да')
  expect(env.submits).toEqual([])
})

test('вопрос чужой сессии — кнопка только переносит его в архив', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  env.files[MAIN] = JSON.stringify({
    items: [{ id: 'q1', from: 'Other', question: Q, options: [{ label: 'Да' }], status: 'open', session: 'sess-2' }],
  })
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'q1:0' })

  expect(list(env, MAIN)).toEqual([])
  expect(list(env, ARCHIVE)[0].answeredIn).toBe('sess-1')
  expect(env.submits).toEqual([])
  await ui.unmount()
})

test('вопрос, записанный вручную, — ответ кнопкой приходит сообщением', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  env.files[MAIN] = JSON.stringify({
    items: [{ id: 'q1', from: 'Demo', question: Q, options: [{ label: 'Да' }], status: 'open' }],
  })
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'q1:0' })

  expect(env.submits).toEqual([`Ответ на вопрос «${Q}» (Demo): Да`])
  expect(list(env, ARCHIVE).length).toBe(1)
  await ui.unmount()
})


test('кнопка нажата до того, как окно нарисовано, — ответ уходит результатом, без сообщения', async ($, on) => {
  let open = () => {}
  const env: Env = { files: {}, submits: [], dialog: null, gate: new Promise<void>(r => (open = r)) }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = ask($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${it.id}:0` })
  const r = await pending
  open()

  expect(r.result.answers[Q]).toBe('Да')
  expect(list(env, MAIN)).toEqual([])
  expect(env.submits).toEqual([])
  await ui.unmount()
})

async function outcome(p: Promise<any>): Promise<any> {
  try {
    return await p
  } catch (err) {
    return { deny: String(err) }
  }
}

test('Claude не пишет файл панели сам — запись отклонена, чтение проходит', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: 'Да' }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const ps = await outcome($.tool.call({ tool: 'PowerShell', command: `$j | ConvertTo-Json | Set-Content ${MAIN}` } as any))
  expect(String(ps.deny)).toContain('AskUserQuestion')
  const write = await outcome($.tool.call({ tool: 'Write', file_path: MAIN, content: '{}' } as any))
  expect(String(write.deny)).toContain('mcp__sreda__otvecheno')
  const bash = await outcome($.tool.call({ tool: 'Bash', command: `echo x >> ${ARCHIVE}` } as any))
  expect(bash.deny).toBeDefined()

  const read = await outcome($.tool.call({ tool: 'PowerShell', command: `Get-Content ${MAIN} 2>$null` } as any))
  expect(read.deny).toBeUndefined()
})

test('ответ текстом — инструмент «отвечено» переносит вопрос в архив', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  env.files[MAIN] = JSON.stringify({
    items: [
      { id: 'q1', from: 'Demo', question: Q, options: [{ label: 'Да' }], status: 'open' },
      { id: 'q2', from: 'Demo', question: 'Другой вопрос?', options: [{ label: 'Да' }], status: 'open' },
    ],
  })
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const r: any = await $.tool.call({ tool: 'mcp__sreda__otvecheno', question: 'Слить', answer: 'да, слить' } as any)

  expect(String(r.result)).toContain('перенесён')
  expect(list(env, MAIN).map(one => one.id)).toEqual(['q2'])
  expect(list(env, ARCHIVE)[0].answer).toBe('да, слить')
})

test('свой ответ в панели — уходит в открытое окно, как «Other»', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = ask($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  const ui = await $.ui.mount(PANE)
  await $.ui.input({ plugin: 'sreda', key: `${it.id}:own`, text: '   ' })
  expect(list(env, MAIN).length).toBe(1)
  await $.ui.input({ plugin: 'sreda', key: `${it.id}:own`, text: ' Слить после обеда ' })
  const r = await pending

  expect(r.result.answers[Q]).toBe('Слить после обеда')
  expect(list(env, ARCHIVE)[0].answer).toBe('Слить после обеда')
  expect(env.submits).toEqual([])
  await ui.unmount()
})

test('свой ответ набран и не теряется при опросе файла — кнопка «Ответить» отправляет его', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = ask($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  const ui = await $.ui.mount(PANE)
  await $.ui.input({ plugin: 'sreda', key: `${it.id}:own`, text: 'Слить, но после', kind: 'change' })
  await clock.advance(3000)
  await ui.press({ key: `${it.id}:send` })
  const r = await pending

  expect(r.result.answers[Q]).toBe('Слить, но после')
  expect(env.submits).toEqual([])
  await ui.unmount()
})

const QM = 'Что ставить?'

function askMany($: any) {
  return $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: QM,
      header: 'Установка',
      multiSelect: true,
      options: [{ label: 'Базы' }, { label: 'Агент' }, { label: 'Экран' }],
    }],
  })
}

test('несколько ответов: кнопки — флажки, окно получает отмеченные списком в порядке вариантов', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = askMany($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  expect(it.multi).toBe(true)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${it.id}:2` })
  await ui.press({ key: `${it.id}:0` })
  await ui.press({ key: `${it.id}:1` })
  await ui.press({ key: `${it.id}:1` })
  // Нажатие только отмечает — вопрос ещё открыт
  expect(list(env, MAIN).length).toBe(1)
  await ui.press({ key: `${it.id}:send` })
  const r = await pending

  // Окну — строкой через запятую, как в схеме ответа; в архиве — и текст, и список
  expect(r.result.answers[QM]).toBe('Базы, Экран')
  const [done] = list(env, ARCHIVE)
  expect(done.answer).toBe('Базы, Экран')
  expect(done.picked).toEqual(['Базы', 'Экран'])
  expect(env.submits).toEqual([])
  await ui.unmount()
})

test('несколько ответов: свой вариант добавляется к отмеченным, пустой ответ не уходит', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = askMany($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${it.id}:send` })
  expect(list(env, MAIN).length).toBe(1)

  await ui.press({ key: `${it.id}:1` })
  await $.ui.input({ plugin: 'sreda', key: `${it.id}:own`, text: 'Ещё отчёты' })
  const r = await pending

  expect(r.result.answers[QM]).toBe('Агент, Ещё отчёты')
  await ui.unmount()
})

test('несколько ответов кнопкой в другой сессии — окно получает список', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const pending: Promise<any> = askMany($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  env.files[MAIN] = JSON.stringify({ items: [] })
  env.files[ARCHIVE] = JSON.stringify({
    items: [{ ...it, status: 'answered', answer: 'Агент, Экран', picked: ['Агент', 'Экран'], answeredIn: 'sess-2' }],
  })
  await clock.advance(1500)
  const r = await pending

  expect(r.result.answers[QM]).toBe('Агент, Экран')
})

test('несколько ответов в окне — в архив уходит текст и список', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: 'x', dialogMany: ['Базы', 'Агент'] }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  await askMany($)

  expect(list(env, MAIN)).toEqual([])
  const [done] = list(env, ARCHIVE)
  expect(done.answer).toBe('Базы, Агент')
  expect(done.picked).toEqual(['Базы', 'Агент'])
})

test('команда для пользователя из preview — в панели блок кода, без своей кнопки «Скопировать команду»', async ($, on) => {
  // Окно ответит, когда тест отпустит: висящее окно получило бы ответ уже в следующем тесте
  let release = () => {}
  const env: Env = { files: {}, submits: [], dialog: 'Позже', gate: new Promise<void>(r => (release = r)) }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const cmd = 'powershell -ExecutionPolicy Bypass -File "C:\Data\install.ps1"'
  const call = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: 'Запустите установку: Win+X → «Терминал (администратор)», вставьте команду, Enter.',
      header: 'Установка',
      multiSelect: false,
      options: [
        { label: 'Запустил, проверь', description: 'Проверю', preview: '```powershell\n' + cmd + '\n```' },
        { label: 'Позже', description: 'Напомню' },
      ],
    }],
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  expect(it.command).toBe(cmd)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  // Копирует значок самого блока кода; своя большая кнопка убрана (26.10, пользователь: лишняя)
  expect(await ui.find({ type: 'Button', text: /Позже/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Скопировать команду/ })).toBeUndefined()
  await ui.unmount()
  release()
  await call
})

test('команда в тексте вопроса — тоже в рамку; блок другого языка в preview — не команда', async ($, on) => {
  // Окно ответит, когда тест отпустит: висящее окно получило бы ответ уже в следующем тесте
  let release = () => {}
  const env: Env = { files: {}, submits: [], dialog: 'Позже', gate: new Promise<void>(r => (release = r)) }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const call = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Обычный PowerShell (Win+X → «Терминал»):\n```powershell\nGet-Service Flower*\n```',
        header: 'Проверка',
        multiSelect: false,
        options: [{ label: 'Запустил, проверь' }, { label: 'Позже' }],
      },
      {
        question: 'Какой вариант кода взять?',
        header: 'Код',
        multiSelect: false,
        options: [
          { label: 'А', preview: '```ts\nconst a = 1\n```' },
          { label: 'Б', preview: '```ts\nconst b = 2\n```' },
        ],
      },
    ],
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const [first, second] = list(env, MAIN)
  expect(first.command).toBe('Get-Service Flower*')
  expect(second.command).toBeUndefined()
  release()
  await call
})

test('команда в preview строкой без рамки — тоже команда панели', async ($, on) => {
  // Окно ответит, когда тест отпустит: висящее окно получило бы ответ уже в следующем тесте
  let release = () => {}
  const env: Env = { files: {}, submits: [], dialog: 'Позже', gate: new Promise<void>(r => (release = r)) }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const cmd = 'powershell -ExecutionPolicy Bypass -File C:\\MobileData1C7\\stage-r51\\install-r51.ps1'
  const call = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: 'Ставим дни рождения?',
      header: 'Дни рождения',
      multiSelect: false,
      options: [
        { label: 'Готово, проверь', preview: 'Где: сервер EM-WIN-160, обычный PowerShell\n\n' + cmd },
        { label: 'Позже' },
      ],
    }],
  } as any)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  expect(it.command).toBe(cmd)
  release()
  await call
})

test('окно «Запустил» без команды в рамке — не показано, Claude получает правило', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: 'Позже', asked: [] }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const r = await outcome($.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: 'Ставим дни рождения?',
      header: 'Дни рождения',
      multiSelect: false,
      options: [
        { label: 'Запустил, проверь', preview: 'Где: EM-WIN-160\n\npowershell -File C:\\x\\install.ps1' },
        { label: 'Позже' },
      ],
    }],
  } as any))
  expect(String(r.deny)).toContain('```powershell')
  expect(env.opened ?? 0).toBe(0)
  expect(list(env, MAIN).length).toBe(0)

  // «Не запустил», «Сервер запустился» — обычный вопрос, окно показывается; строка-пояснение — не команда
  const ok: any = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: 'Flower поднялся?',
      header: 'Проверка',
      multiSelect: false,
      options: [
        { label: 'Сервер запустился', preview: 'PowerShell 7 уже стоит, ничего ставить не нужно' },
        { label: 'Не запустил' },
      ],
    }],
  } as any)
  expect(ok.deny).toBeUndefined()
  expect(env.opened).toBe(1)
  expect(list(env, ARCHIVE)[0].command).toBeUndefined()
})

test('тот же вопрос уже в панели — флажки и команда берутся из окна', async ($, on) => {
  // Окно ответит, когда тест отпустит: висящее окно получило бы ответ уже в следующем тесте
  let release = () => {}
  const env: Env = { files: {}, submits: [], dialog: 'Базы', gate: new Promise<void>(r => (release = r)) }
  env.files[MAIN] = JSON.stringify({
    items: [{ id: 'q1', from: 'Demo', question: QM, options: [{ label: 'Базы' }], status: 'open' }],
  })
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const call = askMany($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  expect(it.id).toBe('q1')
  expect(it.multi).toBe(true)
  release()
  await call
})

const other = (id: string, question: string) => ({
  id, from: 'Other', question, options: [{ label: 'Да' }], status: 'open', session: 'sess-2',
})

test('панель закрыта крестиком — новый вопрос открывает её снова, старый — нет', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: 'Да' }
  env.files[MAIN] = JSON.stringify({ items: [other('q1', 'Старый?')] })
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })
  expect(env.paneOpens).toBe(1)

  // Пользователь закрыл панель; опрос с тем же списком её не открывает
  env.paneUp = false
  await clock.advance(1500)
  expect(env.paneOpens).toBe(1)

  // Вопрос другой сессии появился в файле — панель снова открыта
  env.files[MAIN] = JSON.stringify({ items: [other('q1', 'Старый?'), other('q2', 'Новый?')] })
  await clock.advance(1500)
  expect(env.paneOpens).toBe(2)

  // Открытую панель новый вопрос не переоткрывает
  env.files[MAIN] = JSON.stringify({ items: [other('q1', 'Старый?'), other('q2', 'Новый?'), other('q3', 'Ещё?')] })
  await clock.advance(1500)
  expect(env.paneOpens).toBe(2)
})

test('сессия подпроекта — панель сама не открывается, вопросы всё равно в файле', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  env.dirs = { 'c:/projects': ['Global', 'Demo', 'Other'] }
  env.files['c:/projects/Global/docs/Подпроекты.md'] =
    '# Реестр\n\n## 1. Demo\n\n- **Где:** `C:\\Projects\\Demo`, ветка `main`.\n'
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })
  expect(env.paneOpens ?? 0).toBe(0)

  env.paneUp = false
  env.files[MAIN] = JSON.stringify({ items: [other('q2', 'Новый?')] })
  await clock.advance(1500)
  expect(env.paneOpens ?? 0).toBe(0)

  // Вопрос самого подпроекта — в общий файл (его покажет панель глобальной), панель здесь закрыта
  const pending = ask($)
  await new Promise(resolve => setTimeout(resolve, 0))
  await clock.advance(1500)
  expect(list(env, MAIN).some(one => one.question === Q)).toBe(true)
  expect(env.paneOpens ?? 0).toBe(0)

  // Вручную — открывается
  await $.command.run({ command: 'zhdut-otveta' })
  expect(env.paneOpens).toBe(1)
  const mine = list(env, MAIN).find(one => one.question === Q)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `${mine.id}:0` })
  expect((await pending).result.answers[Q]).toBe('Да')
  await ui.unmount()
})

test('реестр не называет эту папку — обычная сессия, панель открыта', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: 'Да' }
  env.dirs = { 'c:/projects': ['Global', 'Demo'] }
  env.files['c:/projects/Global/docs/Подпроекты.md'] = '- **Где:** `C:\\Projects\\Demo2`, ветка `main`.\n'
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })
  expect(env.paneOpens).toBe(1)
})
