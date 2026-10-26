import { expect, mock, test } from 'claude-code/testing'

import { kilo, until } from '../hooks/stroka'

// Строка под полем ввода (hooks/stroka.ts): уровень усилий, токены, лимиты 5 часов и недели — одной строкой.
const S = ' · '
// Воскресенье 25.10.2026, 12:00 по часам машины
const NOW = new Date(2026, 9, 25, 12, 0).getTime()

type Env = { status: string[]; tokens?: number; limits: any[] }

async function start($: any, on: any, env: Env) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  on('command.register', () => ({ value: { command: 'zhdut-otveta' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__sreda__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    if (e.text) env.status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:\\Projects\\Demo' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: env.limits, context: { tokens: env.tokens, window: 1_000_000 } },
  }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  return clock
}

const iso = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString()

test('одна строка: усилия, токены в тысячах, 5H и 7D с процентом и временем сброса', async ($, on) => {
  const env: Env = {
    status: [],
    tokens: 152_400,
    limits: [
      { kind: 'five_hour', percentUsed: 37, resetsAt: iso(2026, 9, 25, 18, 40) },
      { kind: 'seven_day', percentUsed: 12.4, resetsAt: iso(2026, 9, 30, 9, 0) },
    ],
  }
  await start($, on, env)

  expect(env.status.at(-1)).toBe(
    `средний${S}152K${S}5H 37% до 18:40${S}7D 12% до пт`,
  )
})

test('новая сессия до первого ответа: токенов ещё нет, лимитов нет — только то, что известно', async ($, on) => {
  const env: Env = { status: [], limits: [] }
  await start($, on, env)

  expect(env.status.at(-1)).toBe(`средний${S}—`)
})

test('раз в 30 с и после ответа строка обновляет токены; пропавший лимит остаётся прежним', async ($, on) => {
  const env: Env = {
    status: [],
    tokens: 10_000,
    limits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: iso(2026, 9, 25, 15, 5) }],
  }
  const clock = await start($, on, env)
  expect(env.status.at(-1)).toContain('10K')

  env.tokens = 48_600
  env.limits = []
  await clock.advance(30_000)
  expect(env.status.at(-1)).toBe(`средний${S}49K${S}5H 5% до 15:05`)

  env.tokens = 151_000
  await $.turn.complete({ turnId: 't1', answer: 'готово', durationMs: 1000, isAborted: false } as any)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(env.status.at(-1)).toContain('151K')
})

test('лимит сбросился в паузе — 0%, а не прежние проценты; сброс завтра — «до завтра»', async ($, on) => {
  const env: Env = {
    status: [],
    tokens: 80_000,
    limits: [
      { kind: 'five_hour', percentUsed: 95, resetsAt: iso(2026, 9, 25, 12, 5) },
      { kind: 'seven_day', percentUsed: 40, resetsAt: iso(2026, 9, 26, 9, 0) },
    ],
  }
  const clock = await start($, on, env)
  expect(env.status.at(-1)).toContain('5H 95% до 12:05')
  expect(env.status.at(-1)).toContain('7D 40% до завтра 9:00')

  // Новых ответов нет — цифры прежние, но время сброса 5 часов прошло
  await clock.advance(10 * 60_000)
  expect(env.status.at(-1)).toBe(`средний${S}80K${S}5H 0%${S}7D 40% до завтра 9:00`)
})

test('время сброса: сегодня — часы, завтра — «завтра», дальше — день недели; токены — в тысячах', () => {
  expect(until(new Date(2026, 9, 25, 23, 5).getTime(), NOW)).toBe('до 23:05')
  expect(until(new Date(2026, 9, 26, 1, 10).getTime(), NOW)).toBe('до завтра 1:10')
  expect(until(new Date(2026, 9, 29, 9, 0).getTime(), NOW)).toBe('до чт')
  expect(kilo(undefined)).toBe('—')
  expect(kilo(499)).toBe('0K')
  expect(kilo(199_600)).toBe('200K')
})
