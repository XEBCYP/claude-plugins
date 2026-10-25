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
}

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('command.register', () => ({ value: { command: 'zhdut-otveta' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__sreda__${e.name}` } }))
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
    if (e.tool !== 'AskUserQuestion') return { result: 'ran' }
    if (env.gate) await env.gate
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

test('команда для пользователя из preview — в панели рамка и кнопка «Скопировать команду»', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  engine(on, env)
  const copied: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_: unknown, e: { text: string }) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  const cmd = 'powershell -ExecutionPolicy Bypass -File "C:\Data\install.ps1"'
  void $.tool.call({
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
  await ui.press({ key: `${it.id}:copy` })
  expect(copied).toEqual([cmd])
  expect(toasts.length).toBe(1)
  // Копирование на вопрос не отвечает
  expect(list(env, MAIN).length).toBe(1)
  await ui.unmount()
})

test('команда в тексте вопроса — тоже в рамку; блок другого языка в preview — не команда', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  void $.tool.call({
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
})

test('тот же вопрос уже в панели — флажки и команда берутся из окна', async ($, on) => {
  const env: Env = { files: {}, submits: [], dialog: null }
  env.files[MAIN] = JSON.stringify({
    items: [{ id: 'q1', from: 'Demo', question: QM, options: [{ label: 'Базы' }], status: 'open' }],
  })
  engine(on, env)
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })

  void askMany($)
  await new Promise(resolve => setTimeout(resolve, 0))
  const [it] = list(env, MAIN)
  expect(it.id).toBe('q1')
  expect(it.multi).toBe(true)
})
