import { expect, mock, test } from 'claude-code/testing'

// Под модом нет движка: хуки теста отвечают за него. Вызов на `$` отвечается `{ value }`, событие — своим результатом.
type Env = {
  // Контекст, тыс. токенов
  k: number
  // Папка, в которой лежит реестр подпроектов (глобальная сессия sreda)
  globalCwd?: string
  fork: string | null
  forks: number
  commands: string[]
  submits: string[]
  written: number | null
  asks: number
  answer: string
  forkHangs?: boolean
  // Ходы, которые мод отменил сам (жёсткий предел)
  aborted?: string[]
  // Папки ($.fs.list) и файлы ($.fs.read): реестр глобального проекта для сессии подпроекта
  dirs?: Record<string, string[]>
  files?: Record<string, string>
  // Субагенты, которые сейчас работают
  busy?: boolean
  toasts?: string[]
  // id диалога; после /clear приложение может дать новый
  id?: string
  // Хранилище мода при старте и экраны сессии
  store?: Record<string, unknown>
  surfaces?: string[]
  // CLAUDE_CODE_ENTRYPOINT процесса
  entrypoint?: string
}

// Часы теста: finishTask даёт договорить проверке в конце хода
let clockRef: any = null

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  clockRef = clock
  mock.store(on, env.store)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester', ...(env.entrypoint ? { CLAUDE_CODE_ENTRYPOINT: env.entrypoint } : {}) })
  on('command.register', () => ({ value: { command: 'autohandoff' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__autohandoff__${e.name}` } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: env.id ?? 'sess-1' }))
  on('session.surfaces', () => ({ value: env.surfaces ?? ['desktop'] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: env.k * 1000, percent: env.k / 10 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: env.busy ? [{ agentId: 'a1', status: 'running' }] : [] }))
  on('turn.abort', (_: unknown, e: { turnId: string }) => {
    env.aborted?.push(e.turnId)
    return { value: undefined }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    const names = env.dirs?.[e.path.replace(/\\/g, '/').toLowerCase()]
    if (!names) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = env.files?.[e.path.replace(/\\/g, '/').toLowerCase()]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', (_: unknown, e: { path: string }) => {
    // Движок отдаёт путь в виде ОС (на Windows — с обратной косой)
    if (env.globalCwd && e.path.replace(/\\/g, '/') === `${env.globalCwd}/docs/Подпроекты.md`) {
      return { value: { kind: 'file', mtimeMs: 0, size: 10, isLink: false } }
    }
    if (env.written === null) throw new Error('ENOENT')
    return { value: { kind: 'file', mtimeMs: env.written, size: 10, isLink: false } }
  })
  on('model.fork', async () => {
    env.forks += 1
    if (env.forkHangs) await new Promise(() => {})
    return {
      value: env.fork === null
        ? { isAnswered: false, reason: 'empty-reply', usage: {} }
        : { isAnswered: true, text: env.fork, usage: {} },
    }
  })
  on('command.run', (_: unknown, e: { command: string; args: string }) => {
    env.commands.push(`${e.command} ${e.args}`.trim())
    if (e.command === 'clear' && env.id) env.id += '+'
    return { text: '' }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    env.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    env.asks += 1
    const q = e.questions[0].question
    return { result: { questions: e.questions, answers: { [q]: env.answer } } }
  })
  on('ui.toast', (_: unknown, e: { text: string }) => {
    env.toasts?.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  return clock
}

function fresh(): Env {
  return { k: 200, fork: 'ДА', forks: 0, commands: [], submits: [], written: null, asks: 0, answer: 'Не сейчас' }
}

async function finishTask($: any, turnId: string, ask?: string): Promise<void> {
  await $.turn.start({ text: 'сделай задачу', turnId })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.', ...(ask ? { ask } : {}) })
  await $.turn.complete({ answer: 'Готово.', durationMs: 1000, isAborted: false, reason: 'answer', turnId } as never)
  await clockRef.settle()
}

const BAND = {
  plugin: 'autohandoff',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
} as const

function userPrompt(text: string) {
  return { text, wait: false, origin: { kind: 'sdk' } }
}

test('удачный момент: сообщение придержано, документ, /clear, документ и сообщение — в чистую сессию', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')

  const r = await $.prompt.submit(userPrompt('Теперь следующая задача') as never)
  await clock.settle()
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
  expect(env.forks).toBe(1)
  expect(env.submits).toEqual([])
  const write = env.commands.find(c => c.startsWith('autohandoff:write'))
  expect(write).toBeDefined()
  expect(write).toContain('Теперь следующая задача')
  const path = /Сохрани документ в файл (\S+?)\.(\s|$)/.exec(write ?? '')?.[1] ?? ''
  expect(path).toContain('/.claude/handoffs/autohandoff-')

  // Сообщение, набранное во время передачи, тоже уходит в чистую сессию
  const r2 = await $.prompt.submit(userPrompt('И ещё вот это') as never)
  expect('drop' in r2 && typeof r2.drop === 'string').toBe(true)

  // Ход записи документа: документ появился — /clear и продолжение
  await $.turn.start({ text: `/autohandoff:write Сохрани документ в файл ${path}.`, turnId: 't2' })
  env.written = clock.now()
  await $.turn.complete({ answer: path, durationMs: 1000, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  await clock.settle()

  expect(env.commands).toContain('clear')
  expect(env.submits.length).toBe(3)
  expect(env.submits[0]).toContain(path)
  expect(env.submits[1]).toBe('Теперь следующая задача')
  expect(env.submits[2]).toBe('И ещё вот это')
})

test('итоговое окно задало вопрос, пользователь ответил при полосе — ответ идёт в эту же сессию', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1', 'Закоммитить?')

  const r = await $.prompt.submit(userPrompt('да') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
})

test('ниже 150 тыс. токенов — ничего не делает', async ($, on) => {
  const env = fresh()
  env.k = 100
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')

  const r = await $.prompt.submit(userPrompt('дальше') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
})

test('проверка ответила НЕТ — сообщение идёт как обычно, переспрос только через +20 тыс.', async ($, on) => {
  const env = fresh()
  env.fork = 'НЕТ'
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')

  const r = await $.prompt.submit(userPrompt('а почему так?') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(1)

  await finishTask($, 't2')
  env.k = 210
  await $.prompt.submit(userPrompt('ещё вопрос') as never)
  expect(env.forks).toBe(1)

  await finishTask($, 't3')
  env.k = 225
  await $.prompt.submit(userPrompt('и ещё') as never)
  expect(env.forks).toBe(2)
})

test('прерванный ход — не удачный момент', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, reason: 'aborted', turnId: 't1' } as never)

  const r = await $.prompt.submit(userPrompt('продолжай') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
})

test('документ не записан — передача отменена, придержанное сообщение уходит в эту же сессию', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')

  await $.prompt.submit(userPrompt('Новая задача') as never)
  await clock.settle()
  const write = env.commands.find(c => c.startsWith('autohandoff:write')) ?? ''
  const path = /Сохрани документ в файл (\S+?)\.(\s|$)/.exec(write)?.[1] ?? ''

  await $.turn.start({ text: `/autohandoff:write Сохрани документ в файл ${path}.`, turnId: 't2' })
  await $.turn.complete({ answer: 'не вышло', durationMs: 1000, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  await clock.settle()

  expect(env.commands).not.toContain('clear')
  expect(env.submits).toEqual(['Новая задача'])
})
async function measure($: any, k: number): Promise<void> {
  await $.session.measure({ context: { window: 1_000_000, tokens: k * 1000, percent: k / 10 }, rateLimits: [], changed: ['context'] } as never)
}

test('сообщение с упоминанием файла (@путь) не придерживается', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const r = await $.prompt.submit(userPrompt('посмотри @docs/plan.md') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
})

test('лимит в час считает и неудачные попытки', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  for (const [i, ctx] of [[1, 200], [2, 225]] as const) {
    env.k = ctx
    await finishTask($, `a${i}`)
    await $.prompt.submit(userPrompt(`задача ${i}`) as never)
    await clock.settle()
    // Ход записи без документа — отмена, сообщение вернулось в эту сессию
    await $.turn.start({ text: '', turnId: `w${i}` })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: `w${i}` } as never)
    await clock.settle()
  }
  expect(env.commands.filter(c => c.startsWith('autohandoff:write')).length).toBe(2)
  const forks = env.forks
  env.k = 245
  await finishTask($, 'a3')
  const r = await $.prompt.submit(userPrompt('задача 3') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(forks)
  expect(env.commands.filter(c => c.startsWith('autohandoff:write')).length).toBe(2)
})

test('пользователь отошёл: в конце задачи полоса, через 15 с — передача без его сообщения', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1', 'Закоммитить?')
  expect(env.forks).toBe(1)
  const ui = await $.ui.mount(BAND)

  await clock.advance(14_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await clock.advance(1500)
  const write = env.commands.find(c => c.startsWith('autohandoff:write')) ?? ''
  expect(write).toContain('итог последней задачи')
  const path = /Сохрани документ в файл (\S+?)\.(\s|$)/.exec(write)?.[1] ?? ''

  await $.turn.start({ text: '', turnId: 'w' })
  env.written = clock.now()
  await $.turn.complete({ answer: path, durationMs: 1, isAborted: false, reason: 'answer', turnId: 'w' } as never)
  await clock.settle()
  expect(env.commands).toContain('clear')
  expect(env.submits.length).toBe(1)
  expect(env.submits[0]).toContain('пересказа')
  expect(env.submits[0]).toContain('AskUserQuestion')
  // Подпроект после передачи пишет не пользователю, а в глобальную сессию
  expect(env.submits[0]).toContain('подпроект глобального проекта')
  expect(env.submits[0]).toContain('в глобальную сессию')
  await ui.unmount()
})

test('«Пауза» — отсчёт стоит, ничего не передаётся; «Передать» — передача', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'pause' })
  await clock.advance(60_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await ui.press({ key: 'go' })
  await clock.settle()
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
  await ui.unmount()
})

test('«Отменить» — полосы нет до +50 тыс.; с 250 тыс. — полоса в конце хода без проверки момента', async ($, on) => {
  const env = fresh()
  env.k = 260
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  // Посреди хода порог пройден — ни вопроса, ни передачи
  await measure($, 260)
  await clock.settle()
  expect(env.asks).toBe(0)

  await finishTask($, 't1')
  expect(env.forks).toBe(0)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'cancel' })
  await clock.advance(10_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)

  env.k = 300
  await finishTask($, 't2')
  await clock.advance(10_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)

  env.k = 315
  await finishTask($, 't3')
  await clock.advance(16_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
  expect(env.asks).toBe(0)
  await ui.unmount()
})

test('«Отменить», потом сообщение — передачи нет, сообщение идёт в эту же сессию', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'cancel' })
  const r = await $.prompt.submit(userPrompt('а ещё вот что') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await ui.unmount()
})

test('отсчёт из настроек: countdown 30', { options: { countdown: 30 } }, async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  await clock.advance(20_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await clock.advance(11_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
})

test('после передачи: в чистой сессии мод включается, когда контекст спал; без повторной передачи сразу', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  await $.prompt.submit(userPrompt('новая задача') as never)
  await clock.settle()
  await $.turn.start({ text: '', turnId: 'w' })
  env.written = clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'w' } as never)
  await clock.settle()
  expect(env.commands).toContain('clear')

  // Чистая сессия: старый процент ещё виден — мод выключен, проверки нет
  await finishTask($, 't3')
  const r = await $.prompt.submit(userPrompt('ещё') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  const forks = env.forks
  // Контекст спал ниже 150 тыс. — мод снова включён
  await measure($, 100)
  env.k = 100
  await finishTask($, 't4')
  await $.prompt.submit(userPrompt('дальше') as never)
  expect(env.forks).toBe(forks)
  env.k = 170
  await finishTask($, 't5')
  await $.prompt.submit(userPrompt('и ещё') as never)
  expect(env.forks).toBe(forks + 1)
  await clock.settle()
})

test('проверка зависла — через 30 с сообщение уходит как обычно', async ($, on) => {
  const env = fresh()
  env.forkHangs = true
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const pending = $.prompt.submit(userPrompt('дальше') as never)
  await clock.advance(31_000)
  const r = await pending
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await clock.settle()
})

test('глобальная сессия (в папке реестр подпроектов) — свои пороги: 150 тыс. и без проверки с 200 тыс.', async ($, on) => {
  const env = fresh()
  env.globalCwd = 'C:/Projects/Global'
  env.k = 160
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true } as never)
  // 160 тыс.: проверка момента идёт
  await finishTask($, 't1')
  expect(env.forks).toBe(1)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'cancel' })

  // 205 тыс.: верхний порог глобальной, но «Отменить» на 160 держит до 190 — уже прошло: полоса без проверки
  env.k = 205
  await finishTask($, 't2')
  expect(env.forks).toBe(1)
  await ui.press({ key: 'cancel' })
  // «Отменить» — снова через +30 тыс.
  env.k = 230
  await finishTask($, 't3')
  await clock.advance(16_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  env.k = 236
  await finishTask($, 't4')
  await clock.advance(16_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
  expect(env.forks).toBe(1)
  await ui.unmount()
})

test('глобальная сессия на 140 тыс. — ещё рано: новая сессия входит в работу на 90–120 тыс.', async ($, on) => {
  const env = fresh()
  env.globalCwd = 'C:/Projects/Global'
  env.k = 140
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const r = await $.prompt.submit(userPrompt('дальше') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
})

test('обычная сессия на 130 тыс. — ещё рано', async ($, on) => {
  const env = fresh()
  env.globalCwd = 'C:/Projects/Global'
  env.k = 130
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Sub', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const r = await $.prompt.submit(userPrompt('дальше') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
})

test('старые пороги в процентах (from 30, to 50) не берутся — умолчания и предупреждение', { options: { from: 30, to: 50 } }, async ($, on) => {
  const env = fresh()
  env.k = 60
  env.toasts = []
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  expect(env.toasts.some(t => t.includes('from/to = 30/50'))).toBe(true)
  await finishTask($, 't1')
  const r = await $.prompt.submit(userPrompt('дальше') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
})

test('пороги в тысячах (from 160) берутся без предупреждения', { options: { from: 160, to: 260 } }, async ($, on) => {
  const env = fresh()
  env.k = 155
  env.toasts = []
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  expect(env.toasts).toEqual([])
  await finishTask($, 't1')
  const r = await $.prompt.submit(userPrompt('дальше') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
})

test('сессия приложения (isInteractive false, экрана нет) — с 250 тыс. в конце хода передача сама', async ($, on) => {
  const env = fresh()
  env.k = 260
  env.surfaces = []
  env.entrypoint = 'claude-desktop'
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await finishTask($, 't1')
  await clock.advance(16_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
})

test('попытки других сессий не тратят лимит этой', async ($, on) => {
  const env = fresh()
  // Общий счётчик версии 2.1.0: две свежие попытки чужих сессий
  env.store = { times: [1_000_000, 1_000_000] }
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  await clock.advance(16_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
})

test('лимит в час переходит в чистую сессию после /clear: передачи по кругу', { options: { perHour: 1 } }, async ($, on) => {
  const env = fresh()
  env.id = 'a'
  env.k = 300
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  // Обычная сессия — передача не по кругу
  await handoffDone($, clock, env, 'a')
  // Чистая сессия ни разу не была ниже 150 тыс. (мод включился ниже 250): передача по кругу — первая за час проходит
  env.k = 240
  await handoffDone($, clock, env, 'b')
  // Снова по кругу (180 тыс., мод включился ниже 190) — лимит 1 в час исчерпан
  env.k = 180
  await finishTask($, 'c')
  await clock.advance(16_000)
  expect(env.commands.filter(c => c.startsWith('autohandoff:write')).length).toBe(2)
  const status = await $.command.run({ command: 'autohandoff', args: 'status' } as never)
  expect(String((status as any).text)).toContain('по кругу 1')
})

// --- 28.10: сессии Export1c7 дошли до 300–365 тыс. без передачи

// Передача по сообщению пользователя на текущем env.k: документ записан, /clear
async function handoffDone($: any, clock: any, env: Env, tag: string): Promise<void> {
  const before = env.commands.filter(c => c === 'clear').length
  await finishTask($, `${tag}-task`)
  await $.prompt.submit(userPrompt(`задача ${tag}`) as never)
  await clock.settle()
  await $.turn.start({ text: '', turnId: `${tag}-w` })
  env.written = clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: `${tag}-w` } as never)
  await clock.settle()
  expect(env.commands.filter(c => c === 'clear').length).toBe(before + 1)
}

test('после передачи на 188 тыс. мод включается в начале хода чистой сессии — без события session.measure', async ($, on) => {
  const env = fresh()
  env.k = 188
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await handoffDone($, clock, env, 'a')
  // Чистая сессия: первый ход начинается с малым контекстом и за этот ход проходит 250 тыс.
  env.k = 45
  await $.turn.start({ text: 'прочитай документ и продолжай', turnId: 't2' })
  env.k = 260
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'a' } as never)).length).toBe(1)
})

test('две нормальные передачи за час не выбирают лимит: третья на 208 тыс. — полоса есть', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await handoffDone($, clock, env, 'a')
  // Чистая сессия начала с малого контекста, поработала и выросла — передача нормальная
  env.k = 45
  await finishTask($, 'b0')
  env.k = 200
  await handoffDone($, clock, env, 'b')
  env.k = 45
  await finishTask($, 'c0')
  env.k = 208
  await finishTask($, 'c1')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /208 тыс./ })).toBeDefined()
  await ui.unmount()
  await clock.advance(16_000)
  expect(env.commands.filter(c => c.startsWith('autohandoff:write')).length).toBe(3)
})

test('передача без сообщения: первый ход чистой сессии — вся работа (с 45 до 200 тыс.) — не по кругу', { options: { perHour: 1 } }, async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  for (const tag of ['a', 'b']) {
    // Полоса досчитала — передача без сообщения пользователя
    await finishTask($, `${tag}-task`)
    await clock.advance(16_000)
    await $.turn.start({ text: '', turnId: `${tag}-w` })
    env.written = clock.now()
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: `${tag}-w` } as never)
    await clock.settle()
    // Чистая сессия: один ход — прочитать документ (первое действие — запрос до документа) и работать дальше
    env.k = 30
    await $.turn.start({ text: 'Прочитай документ передачи и продолжай', turnId: `${tag}-f` })
    await $.tool.call({ tool: 'Read', file_path: 'doc' } as never)
    env.k = 45
    await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
    env.k = tag === 'a' ? 200 : 208
    await $.turn.complete({ answer: 'Готово.', durationMs: 1, isAborted: false, reason: 'answer', turnId: `${tag}-f` } as never)
    await clock.settle()
  }
  expect(env.commands.filter(c => c.startsWith('autohandoff:write')).length).toBe(2)
  const status = await $.command.run({ command: 'autohandoff', args: 'status' } as never)
  expect(String((status as any).text)).toContain('по кругу 0')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /208 тыс\./ })).toBeDefined()
  await ui.unmount()
})

test('неудачная попытка по кругу считается один раз', { options: { perHour: 2 } }, async ($, on) => {
  const env = fresh()
  env.k = 300
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await handoffDone($, clock, env, 'a')
  // Чистая сессия ни разу не ниже 150 тыс.: попытка по кругу, документ не записан — отмена
  env.k = 240
  env.written = null
  await finishTask($, 'b')
  await clock.advance(16_000)
  await $.turn.start({ text: '', turnId: 'b-w' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'b-w' } as never)
  await clock.settle()
  const status = await $.command.run({ command: 'autohandoff', args: 'status' } as never)
  expect(String((status as any).text)).toContain('по кругу 0, неудачных 1')
})

test('две удачные передачи за час не отключают жёсткий предел', async ($, on) => {
  const env = { ...fresh(), aborted: [] as string[] }
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await handoffDone($, clock, env, 'a')
  env.k = 45
  await $.turn.start({ text: 'дальше', turnId: 'b0' })
  env.k = 200
  await handoffDone($, clock, env, 'b')
  env.k = 45
  await $.turn.start({ text: 'дальше', turnId: 't3' })
  env.k = 310
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await clock.settle()
  expect(env.aborted).toEqual(['t3'])
  expect(env.commands.filter(c => c.startsWith('autohandoff:write')).length).toBe(3)
})

test('две неудачные попытки за час — жёсткий предел ждёт: цикл неудач держит лимит', async ($, on) => {
  const env = { ...fresh(), aborted: [] as string[] }
  env.k = 310
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  for (const n of [1, 2]) {
    await $.turn.start({ text: 'задача', turnId: `t${n}` })
    await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
    await clock.settle()
    // Ход записи кончился без документа — попытка неудачная
    await $.turn.start({ text: '/autohandoff:write', turnId: `w${n}` })
    await $.turn.complete({ answer: 'не вышло', durationMs: 1, isAborted: false, reason: 'answer', turnId: `w${n}` } as never)
    await clock.settle()
  }
  expect(env.aborted).toEqual(['t1', 't2'])
  await $.turn.start({ text: 'задача', turnId: 't3' })
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await clock.settle()
  expect(env.aborted).toEqual(['t1', 't2'])
})

test('запуск -p или SDK (isInteractive false, не приложение) — в конце хода передачи нет', async ($, on) => {
  const env = fresh()
  env.k = 260
  env.surfaces = []
  env.entrypoint = 'sdk-cli'
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await finishTask($, 't1')
  await clock.advance(16_000)
  expect(env.forks).toBe(0)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
})

function nudges(r: any): string[] {
  return (r.context ?? []).filter((t: string) => t.startsWith('Автопередача:'))
}

test('посреди хода с 250 тыс. — напоминание закончить ход, следующее через 50 тыс.', { options: { hard: 500 } }, async ($, on) => {
  const env = fresh()
  env.k = 200
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'большая задача', turnId: 't1' })
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'a' } as never))).toEqual([])
  env.k = 260
  const first = nudges(await $.tool.call({ tool: 'Read', file_path: 'b' } as never))
  expect(first.length).toBe(1)
  expect(first[0]).toContain('260 тыс.')
  env.k = 290
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'c' } as never))).toEqual([])
  env.k = 315
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'd' } as never)).length).toBe(1)
  // Субагент и итоговое окно напоминания не получают
  env.k = 400
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'e', agentId: 'ag1' } as never))).toEqual([])
  expect(nudges(await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x' } as never))).toEqual([])
})

test('напоминания нет: вне хода и при выключенной автопередаче', async ($, on) => {
  const env = fresh()
  env.k = 300
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'a' } as never))).toEqual([])
  await $.command.run({ command: 'autohandoff', args: 'off' } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'b' } as never))).toEqual([])
})

test('в запуске -p или SDK напоминания посреди хода нет', async ($, on) => {
  const env = fresh()
  env.k = 300
  env.entrypoint = 'sdk-cli'
  engine(on, env)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'a' } as never))).toEqual([])
})

test('глобальная сессия: напоминание с 200 тыс., следующее через 30 тыс.', async ($, on) => {
  const env = fresh()
  env.globalCwd = 'C:/Projects/Global'
  env.k = 205
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'a' } as never)).length).toBe(1)
  env.k = 230
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'b' } as never))).toEqual([])
  env.k = 236
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'c' } as never)).length).toBe(1)
})

test('после «Отменить» напоминания нет до +50 тыс.; во время записи документа — нет', { options: { hard: 500 } }, async ($, on) => {
  const env = fresh()
  env.k = 260
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'cancel' })
  await $.turn.start({ text: 'дальше', turnId: 't2' })
  env.k = 290
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'a' } as never))).toEqual([])
  env.k = 312
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'b' } as never)).length).toBe(1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  // Передача началась: ход записи документа напоминаний не получает
  await $.command.run({ command: 'autohandoff', args: 'now' } as never)
  await clock.settle()
  await $.turn.start({ text: '/autohandoff:write', turnId: 'w' })
  env.k = 400
  expect(nudges(await $.tool.call({ tool: 'Read', file_path: 'c' } as never))).toEqual([])
})

// --- Пакет 3 аудита 27.10 (ADR 0015)

test('жёсткий предел 300 тыс.: после действия ход отменён, документ с пометкой «ход прерван»', async ($, on) => {
  const env = { ...fresh(), aborted: [] as string[] }
  env.k = 290
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'большая задача', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await clock.settle()
  expect(env.aborted).toEqual([])
  env.k = 305
  const r = await $.tool.call({ tool: 'Read', file_path: 'b' } as never)
  await clock.settle()
  expect(((r as any).context ?? []).some((t: string) => t.includes('жёсткого предела 300'))).toBe(true)
  expect(env.aborted).toEqual(['t1'])
  const write = env.commands.find(c => c.startsWith('autohandoff:write')) ?? ''
  expect(write).toContain('Ход прерван автопередачей')
})

test('жёсткий предел: пока работает субагент — ход не прерывается', async ($, on) => {
  const env = { ...fresh(), aborted: [] as string[], busy: true }
  env.k = 320
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await clock.settle()
  expect(env.aborted).toEqual([])
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
})

test('жёсткий предел из настроек: hard 400', { options: { hard: 400 } }, async ($, on) => {
  const env = { ...fresh(), aborted: [] as string[] }
  env.k = 350
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await clock.settle()
  expect(env.aborted).toEqual([])
})

const peer = (text: string) => ({ text, wait: false, origin: { kind: 'peer' } })

test('событие с 250 тыс. при полосе не сбрасывает отсчёт: передача, событие — следом за документом', async ($, on) => {
  const env = fresh()
  env.k = 260
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const r = await $.prompt.submit(peer('Глобальная: R50 — ответ на вопрос') as never)
  await clock.settle()
  expect(typeof (r as any).drop).toBe('string')
  const write = env.commands.find(c => c.startsWith('autohandoff:write')) ?? ''
  expect(write).toContain('R50 — ответ на вопрос')
  const path = /Сохрани документ в файл (\S+?)\.(\s|$)/.exec(write)?.[1] ?? ''
  await $.turn.start({ text: '/autohandoff:write', turnId: 'w' })
  env.written = clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'w' } as never)
  await clock.settle()
  expect(env.commands).toContain('clear')
  expect(env.submits[0]).toContain(path)
  expect(env.submits[1]).toContain('Глобальная: R50 — ответ на вопрос')
  expect(env.submits[1]).toContain('пока шла автопередача')
})

test('событие с 250 тыс. без полосы (сессия простаивает) — передача, событие следом', async ($, on) => {
  const env = fresh()
  env.k = 270
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  const r = await $.prompt.submit(peer('Сообщение от подпроекта') as never)
  await clock.settle()
  expect(typeof (r as any).drop).toBe('string')
  expect((env.commands.find(c => c.startsWith('autohandoff:write')) ?? '')).toContain('Сообщение от подпроекта')
})

test('событие ниже 250 тыс. — идёт как обычно; сообщение плагина не придерживается никогда', async ($, on) => {
  const env = fresh()
  env.k = 200
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  expect('drop' in ((await $.prompt.submit(peer('ниже порога') as never)) as any)).toBe(false)
  env.k = 300
  const own = await $.prompt.submit({ text: 'Ответ на вопрос', wait: false, origin: { kind: 'plugin', name: 'sreda' } } as never)
  await clock.settle()
  expect('drop' in (own as any)).toBe(false)
})

test('сообщение другой сессии во время передачи не теряется: уходит в чистую сессию', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.command.run({ command: 'autohandoff', args: 'now' } as never)
  await clock.settle()
  const r = await $.prompt.submit(peer('Глобальная: пауза') as never)
  expect(typeof (r as any).drop).toBe('string')
  await $.turn.start({ text: '/autohandoff:write', turnId: 'w' })
  env.written = clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'w' } as never)
  await clock.settle()
  expect(env.submits.length).toBe(2)
  expect(env.submits[0]).toContain('Следом придут сообщения')
  expect(env.submits[1]).toContain('Глобальная: пауза')
})

test('сессия подпроекта: с 250 тыс. в конце хода — передача сразу, без полосы', async ($, on) => {
  const env = {
    ...fresh(),
    dirs: { 'c:/projects': ['Global', 'Sub'] },
    files: { 'c:/projects/global/docs/подпроекты.md': '## Sub\n**Где:** `C:\\Projects\\Sub`\n' },
  }
  env.k = 260
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Sub', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  await clock.settle()
  // Без отсчёта: часы не двигались, а документ уже пишется
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
})

test('сессия сама просит передачу на 215 тыс. (проверка момента была «нет»): в конце хода — полоса, через 15 с — передача', async ($, on) => {
  const env = fresh()
  env.k = 215
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  // Проверка момента на 209 тыс. ответила «нет»: дальше мод сам молчит до 229 тыс.
  env.fork = 'НЕТ'
  env.k = 209
  await finishTask($, 't0')
  expect(env.forks).toBe(1)
  env.k = 215
  await $.turn.start({ text: 'сверки', turnId: 't1' })
  const r: any = await $.tool.call({ tool: 'mcp__autohandoff__peredat' } as never)
  expect(String(r.result)).toContain('«Пауза»')
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.' })
  await $.turn.complete({ answer: 'Готово.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  await clock.settle()
  // Без новой проверки момента
  expect(env.forks).toBe(1)
  const ui = await $.ui.mount(BAND)
  await clock.advance(15_500)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
  await ui.unmount()
})

// Так приложение шлёт сообщение другой сессии (журнал разговора 31.10): isMeta, origin peer, hostInjected
const peerMeta = (text: string) => ({ text, wait: false, isMeta: true, origin: { kind: 'peer', hostInjected: true } })

async function askedBand($: any, env: any, clock: any): Promise<void> {
  env.k = 207
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'пункт 26', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__autohandoff__peredat' } as never)
  await $.turn.complete({ answer: 'Итог.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  await clock.settle()
}

test('31.10: сообщение другой сессии (isMeta) на 6-й секунде отсчёта по просьбе — передача, сообщение следом', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await askedBand($, env, clock)
  const ui = await $.ui.mount(BAND)
  await clock.advance(6_000)
  const r = await $.prompt.submit(peerMeta('Глобальная: FYI 43babe6') as never)
  await clock.settle()
  expect(typeof (r as any).drop).toBe('string')
  expect(env.commands.find(c => c.startsWith('autohandoff:write')) ?? '').toContain('Глобальная: FYI 43babe6')
  await ui.unmount()
})

test('сообщение другой сессии (isMeta) во время записи документа — придержано, передача не срывается', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.command.run({ command: 'autohandoff', args: 'now' } as never)
  await clock.settle()
  const r = await $.prompt.submit(peerMeta('Глобальная: продолжай') as never)
  expect(typeof (r as any).drop).toBe('string')
  await $.turn.start({ text: '/autohandoff:write', turnId: 'w' })
  env.written = clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'w' } as never)
  await clock.settle()
  expect(env.commands).toContain('clear')
  expect(env.submits[1]).toContain('Глобальная: продолжай')
})

test('ход по другому событию снял полосу просьбы — просьба остаётся: в конце хода снова полоса и передача', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await askedBand($, env, clock)
  const ui = await $.ui.mount(BAND)
  await clock.advance(3_000)
  // Ход начался мимо prompt.submit (уведомление, событие приложения); проверка момента сказала бы «нет», как 31.10
  env.fork = 'НЕТ'
  await $.turn.start({ text: '<task-notification>', turnId: 't2' })
  await $.turn.complete({ answer: 'Принял.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  await clock.settle()
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await clock.advance(15_500)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
  await ui.unmount()
})

test('служебное isMeta не от другой сессии по-прежнему не придерживается', async ($, on) => {
  const env = fresh()
  env.k = 270
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  const r = await $.prompt.submit({ text: 'skill body', wait: false, isMeta: true, origin: { kind: 'sdk' } } as never)
  await clock.settle()
  expect('drop' in (r as any)).toBe(false)
})

test('просьба о передаче: субагент и выключенная автопередача — отказ, передачи нет', async ($, on) => {
  const env = fresh()
  env.k = 180
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const sub: any = await $.tool.call({ tool: 'mcp__autohandoff__peredat', agentId: 'a1' } as never)
  expect(String(sub.result)).toContain('только основная сессия')
  await $.command.run({ command: 'autohandoff', args: 'off' })
  const off: any = await $.tool.call({ tool: 'mcp__autohandoff__peredat' } as never)
  expect(String(off.result)).toContain('выключил')
  await $.turn.complete({ answer: 'Готово.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  await clock.advance(20_000)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
})

test('сессия подпроекта просит передачу — сразу после хода, без полосы', async ($, on) => {
  const env = {
    ...fresh(),
    dirs: { 'c:/projects': ['Global', 'Sub'] },
    files: { 'c:/projects/global/docs/подпроекты.md': '## Sub\n**Где:** `C:\\Projects\\Sub`\n' },
  }
  env.k = 120
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Sub', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__autohandoff__peredat' } as never)
  await $.turn.complete({ answer: 'Готово.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  await clock.settle()
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(true)
})

test('счётчик действий: на 60-м действии напоминание, следующее — на 90-м', async ($, on) => {
  const env = fresh()
  env.k = 100
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  const hits: number[] = []
  for (let n = 1; n <= 95; n += 1) {
    const r = await $.tool.call({ tool: 'Read', file_path: `f${n}` } as never)
    if (((r as any).context ?? []).some((t: string) => t.includes('действий'))) hits.push(n)
  }
  expect(hits).toEqual([60, 90])
  // Новый ход — счёт сначала
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  await $.turn.start({ text: 'дальше', turnId: 't2' })
  const r = await $.tool.call({ tool: 'Read', file_path: 'x' } as never)
  expect(((r as any).context ?? []).some((t: string) => t.includes('действий'))).toBe(false)
})

test('отметка версии 2.2 (held — строки) читается: сообщение уходит от имени пользователя', async ($, on) => {
  const env = fresh()
  env.store = {
    's:sess-1': {
      unit: 'k', pending: { path: 'C:/Users/tester/.claude/handoffs/autohandoff-old.md', startedAt: 999_000, writeTurnId: 'w', held: ['старое сообщение'], ctx: 200 },
      askAt: 250, isArmed: false, armBelow: 150, isOff: false, checkedAt: 0, quietBelow: 0, lastTurn: null, times: [], at: 999_000,
    },
  }
  env.written = 1_000_000
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(3_000)
  await clock.settle()
  expect(env.submits).toContain('старое сообщение')
})

test('отсчёт на паузе: событие с 250 тыс. передачу не запускает и идёт в эту сессию', async ($, on) => {
  const env = fresh()
  env.k = 260
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1')
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'pause' })
  const r = await $.prompt.submit(peer('Подпроект: остановлен') as never)
  await clock.settle()
  expect('drop' in (r as any)).toBe(false)
  expect(env.commands.some(c => c.startsWith('autohandoff:write'))).toBe(false)
  await ui.unmount()
})

test('во время передачи: нажатие кнопки — как сообщение пользователя, неизвестное — без пометки «от другой сессии»', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.command.run({ command: 'autohandoff', args: 'now' } as never)
  await clock.settle()
  const held = (text: string, kind: string) => $.prompt.submit({ text, wait: false, origin: { kind } } as never)
  expect(typeof ((await held('Да, слить', 'auto-continuation')) as any).drop).toBe('string')
  expect(typeof ((await held('Напоминание', 'scheduled-trigger')) as any).drop).toBe('string')
  expect(typeof ((await held('Глобальная: пауза', 'peer')) as any).drop).toBe('string')
  await $.turn.start({ text: '/autohandoff:write', turnId: 'w' })
  env.written = clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'w' } as never)
  await clock.settle()
  expect(env.submits).toContain('Да, слить')
  const other = env.submits.find(t => t.endsWith('Напоминание')) ?? ''
  expect(other).toContain('пока шла автопередача')
  expect(other).not.toContain('от другой сессии')
  expect(env.submits.find(t => t.endsWith('Глобальная: пауза')) ?? '').toContain('от другой сессии')
})
