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
}

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('command.register', () => ({ value: { command: 'zhdut-otveta' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    env.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', async (_: unknown, e: any) => {
    if (env.dialog === null) await new Promise(() => {})
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

