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
  toasts?: string[]
}

function engine(on: any, env: Env) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('command.register', () => ({ value: { command: 'autohandoff' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: env.k * 1000, percent: env.k / 10 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: [] }))
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
}

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

test('итоговое окно задало вопрос — сообщение не придерживается и проверка не идёт', async ($, on) => {
  const env = fresh()
  engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await finishTask($, 't1', 'Закоммитить?')

  const r = await $.prompt.submit(userPrompt('да') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(0)
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
  expect(env.forks).toBe(0)
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
  expect(env.forks).toBe(2)
  env.k = 245
  await finishTask($, 'a3')
  const r = await $.prompt.submit(userPrompt('задача 3') as never)
  expect('drop' in r && r.drop !== undefined).toBe(false)
  expect(env.forks).toBe(2)
})

test('с 250 тыс. — вопрос; «Не сейчас» — снова только через +50 тыс.', async ($, on) => {
  const env = fresh()
  const clock = engine(on, env)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await measure($, 260)
  await clock.settle()
  expect(env.asks).toBe(1)
  await measure($, 300)
  await clock.settle()
  expect(env.asks).toBe(1)
  env.answer = 'Передать'
  await measure($, 315)
  await clock.settle()
  expect(env.asks).toBe(2)
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

test('глобальная сессия (в папке реестр подпроектов) — свои пороги: 150 тыс. и вопрос с 200 тыс.', async ($, on) => {
  const env = fresh()
  env.globalCwd = 'C:/Projects/Global'
  env.k = 160
  const clock = engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Global', surface: 'desktop', isInteractive: true } as never)
  await measure($, 195)
  await clock.settle()
  expect(env.asks).toBe(0)
  await measure($, 205)
  await clock.settle()
  expect(env.asks).toBe(1)
  // «Не сейчас» — снова через +30 тыс.
  await measure($, 230)
  await clock.settle()
  expect(env.asks).toBe(1)
  await measure($, 236)
  await clock.settle()
  expect(env.asks).toBe(2)

  await finishTask($, 't1')
  await $.prompt.submit(userPrompt('дальше') as never)
  expect(env.forks).toBe(1)
  await clock.settle()
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
