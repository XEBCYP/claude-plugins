import { expect, mock, test } from 'claude-code/testing'

// Уровень усилий (hooks/uroven.ts). Хуки теста стоят за движок: запоминают, с каким уровнем ушёл запрос к модели и с
// какими параметрами — вызов агента или подпроекта.
type Env = { efforts: string[]; models: string[]; calls: any[]; status: string[]; tokens: number; files: Record<string, string> }

function engine(on: any, env: Env) {
  mock.clock(on, { now: 1_000_000 })
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
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: env.tokens, window: 1_000_000 } } }))
  // Движок отдаёт путь в виде Windows — ключ с прямыми чертами
  const key = (path: unknown) => String(path).split('\\').join('/')
  on('fs.read', (_: unknown, e: any) => ({ value: env.files[key(e.path)] ?? '' }))
  on('fs.exists', (_: unknown, e: any) => ({ value: key(e.path) in env.files }))
  on('fs.write', (_: unknown, e: any) => {
    env.files[key(e.path)] = String(e.text)
    return { value: undefined }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: unknown, e: any) {
    env.efforts.push(String(e.effort))
    env.models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as any
  })
  on('tool.call', (_: unknown, e: any) => {
    env.calls.push(e)
    return { result: 'ran' }
  })
}

const PROJECT = 'C:/Projects/Demo/.claude/sreda.json'

async function start($: any, on: any, tokens = 0, files: Record<string, string> = {}): Promise<Env> {
  const env: Env = { efforts: [], models: [], calls: [], status: [], tokens, files }
  engine(on, env)
  await $.session.start({ cwd: 'C:\\Projects\\Demo', surface: 'desktop', isInteractive: true })
  return env
}

let turns = 0
async function turn($: any, text: string, agentId?: string): Promise<void> {
  const turnId = `t${++turns}`
  await $.turn.start({ text, turnId, ...(agentId ? { agentId } : {}) })
}

async function step($: any, effort = 'medium', agentId?: string): Promise<void> {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
    // ответа модели в тесте нет
  }
}

test('поиск ошибки — высокий уровень; механика — средний, ниже не бывает', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Почему не сходятся остатки по складу? Разберись и исправь.')
  await step($)
  await turn($, 'Покажи список последних коммитов в ветке main.')
  await step($)

  expect(env.efforts).toEqual(['high', 'medium'])
  expect(env.status.at(-1)?.startsWith('средний · ')).toBe(true)
})

test('два признака сложности — сверхвысокий: ошибка и неудачная попытка, ошибка и много пунктов; «Effort: xhigh»', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Остатки всё ещё не сходятся, прошлое исправление не помогло.')
  await step($)
  await turn($, 'Почему падает выгрузка:\n1. первый склад\n2. второй склад\n3. третий склад\n4. сводка')
  await step($)
  await turn($, 'Effort: xhigh\nDesign the sync between the two databases.')
  await step($)

  await turn($, 'Всё еще не работает выгрузка.')
  await step($)

  expect(env.efforts).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh'])
  expect(env.status.at(-1)?.startsWith('сверхвысокий · ')).toBe(true)
})

test('один признак — высокий, а не сверхвысокий: «не помогло» само по себе, «опять не забудь»', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Не помогло.')
  await step($)
  await turn($, 'Опять не забудь закоммитить.')
  await step($)

  expect(env.efforts).toEqual(['high', 'high'])
})

test('короткое «да» посреди работы уровень не меняет', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Сравни два варианта выгрузки и предложи, какой лучше.')
  await turn($, 'Да, делай')
  await step($)

  expect(env.efforts).toEqual(['high'])
})

test('на длинной переписке разовая простая просьба уровень не понижает, вторая подряд — понижает', async ($, on) => {
  const env = await start($, on, 120_000)

  await turn($, 'Найди ошибку в расчёте отсрочки.')
  await turn($, 'Покажи статус ветки.')
  await step($)
  await turn($, 'Закоммить и отправь в GitHub.')
  await step($)

  expect(env.efforts).toEqual(['high', 'medium'])
})

test('не задача пользователя и похожие слова — уровень не скачет', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Покажи список файлов в папке docs.')
  await turn($, 'Ответ на вопрос «Какой вариант выбрать?» (Demo · PR): Да')
  await turn($, 'Проверь, совпадает ли сумма в отчёте с выгрузкой, и напиши итог в чат для меня, пожалуйста.')
  await step($)
  await turn($, 'Попробуй ещё раз, теперь с другим складом')
  await step($)

  expect(env.efforts).toEqual(['medium', 'high'])
})

test('задание подпроекту: строка «Effort:» задаёт уровень (low — средний), английские слова об ошибках — высокий', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Effort: low\nCollect the price list from the shared folder and send a summary.')
  await step($)
  await turn($, 'Investigate why the export fails on the second run and fix the root cause.')
  await step($)

  expect(env.efforts).toEqual(['medium', 'high'])
})

test('агент не меняет уровень основной сессии; модель агента Haiku в запросе — Opus', async ($, on) => {
  const env = await start($, on)

  const r: any = await $.tool.call({ tool: 'mcp__sreda__uroven', level: 'low', agentId: 'a1' } as any)
  await step($)
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' })
  for await (const _ of s) {
    // ответа модели в тесте нет
  }

  expect(String(r.result)).toContain('основная')
  expect(env.efforts[0]).toBe('medium')
  expect(env.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

test('сессия сама меняет уровень инструментом: до сверхвысокого, не ниже среднего', async ($, on) => {
  const env = await start($, on)

  const r: any = await $.tool.call({ tool: 'mcp__sreda__uroven', level: 'xhigh', reason: 'вторая неудачная попытка' } as any)
  await step($)
  const max: any = await $.tool.call({ tool: 'mcp__sreda__uroven', level: 'max' } as any)
  await step($)
  const low: any = await $.tool.call({ tool: 'mcp__sreda__uroven', level: 'low' } as any)
  await step($)

  expect(String(r.result)).toContain('сверхвысокий')
  expect(String(max.result)).toContain('сверхвысокий')
  expect(String(low.result)).toContain('средний')
  expect(env.efforts).toEqual(['xhigh', 'xhigh', 'medium'])
})

test('запросы агентов: свой уровень не навязывается, но от среднего до сверхвысокого', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Почему падает тест?')
  await step($, 'medium', 'a1')
  await step($, 'max', 'a1')
  await step($, 'low', 'a1')

  expect(env.efforts).toEqual(['medium', 'xhigh', 'medium'])
})

test('агенты: слепая проверка — Opus высокий, остальные модели и поиск без модели — Opus', async ($, on) => {
  const env = await start($, on)

  await $.tool.call({ tool: 'Agent', description: 'Слепая приёмка', prompt: 'Проверь, не доверяй слепо', model: 'sonnet', effort: 'low' } as any)
  await $.tool.call({ tool: 'Agent', description: 'Поиск', prompt: 'Find it, do not blindly copy', model: 'haiku' } as any)
  await $.tool.call({ tool: 'Agent', description: 'Поиск', prompt: 'Найди', subagent_type: 'Explore' } as any)
  await $.tool.call({ tool: 'Agent', description: 'Код', prompt: 'Сделай', model: 'fable', effort: 'xhigh' } as any)
  await $.tool.call({ tool: 'Agent', description: 'Код', prompt: 'Сделай' } as any)
  await $.tool.call({ tool: 'Agent', description: 'Сбор', prompt: 'Собери', model: 'sonnet', effort: 'low' } as any)

  const agents = env.calls.filter(c => c.tool === 'Agent')
  expect([agents[0].model, agents[0].effort]).toEqual(['opus', 'high'])
  expect(agents[1].model).toBe('opus')
  expect(agents[2].model).toBe('opus')
  expect([agents[3].model, agents[3].effort]).toEqual(['opus', 'xhigh'])
  expect('model' in agents[4]).toBe(false)
  expect([agents[5].model, agents[5].effort]).toEqual(['opus', 'medium'])
})

test('подпроекты: любая модель — Opus, низкий — средний, максимум — сверхвысокий', async ($, on) => {
  const env = await start($, on)

  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Сбор', model: 'claude-haiku-5-5', effort: 'low' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__set_session_model', session_id: 's', model: 'claude-fable-5-1' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__set_session_effort', session_id: 's', effort: 'max' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__set_session_model', session_id: 's', model: 'claude-sonnet-5-5' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__set_session_effort', session_id: 's', effort: 'xhigh' } as any)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Без модели' } as any)

  const [s, m, f, sn, x, none] = env.calls.filter(c => /ccd_session/.test(c.tool))
  expect([s.model, s.effort]).toEqual(['claude-opus-5-5', 'medium'])
  expect(m.model).toBe('claude-opus-5-5')
  expect(f.effort).toBe('xhigh')
  expect(sn.model).toBe('claude-opus-5-5')
  expect(x.effort).toBe('xhigh')
  expect(none.model).toBe('claude-opus-5-5')
})

test('ручной режим проекта: уровень как в программе, без оценки и без рамок; инструмент отказывает', async ($, on) => {
  const env = await start($, on, 0, { [PROJECT]: '{"uroven": "ручной"}' })

  await turn($, 'Покажи список последних коммитов в ветке main.')
  await step($, 'xhigh')
  const r: any = await $.tool.call({ tool: 'mcp__sreda__uroven', level: 'low' } as any)
  await step($, 'xhigh')

  expect(env.efforts).toEqual(['xhigh', 'xhigh'])
  expect(String(r.result)).toContain('пользователь')
  expect(env.status.at(-1)?.startsWith('вручную · сверхвысокий · ')).toBe(true)
})

test('пользователь сменил уровень в программе — до конца сессии «Среда» его не понижает', async ($, on) => {
  const env = await start($, on)

  await turn($, 'Почему не сходятся остатки по складу?')
  await step($, 'medium')
  await turn($, 'Покажи статус ветки.')
  await step($, 'high')
  await turn($, 'Покажи список файлов.')
  await step($, 'high')

  expect(env.efforts).toEqual(['high', 'high', 'high'])
  expect(env.status.at(-1)?.startsWith('вручную · высокий · ')).toBe(true)
})

test('/uroven ручной пишет файл проекта, сохраняя прочие ключи; /uroven авто — оценка снова работает', async ($, on) => {
  const env = await start($, on, 0, { [PROJECT]: '{"other": 1}' })

  const a: any = await $.command.run({ command: 'uroven', args: 'ручной' })
  await turn($, 'Покажи список последних коммитов в ветке main.')
  await step($, 'medium')
  expect(JSON.parse(env.files[PROJECT])).toEqual({ other: 1, uroven: 'ручной' })
  expect(String(a.text)).toContain('Ручной режим')

  const s: any = await $.command.run({ command: 'uroven', args: '' })
  await $.command.run({ command: 'uroven', args: 'авто' })
  await turn($, 'Почему падает тест?')
  await step($, 'medium')

  expect(String(s.text)).toContain('ставите вы')
  expect(JSON.parse(env.files[PROJECT]).uroven).toBe('авто')
  expect(env.efforts).toEqual(['medium', 'high'])
})

test('ручной режим сессии переживает перезагрузку плагина; смена модели — не выбор уровня', async ($, on) => {
  const env = await start($, on)

  const s1 = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
  for await (const _ of s1) {
    // ответа модели в тесте нет
  }
  // Запасная модель с другим уровнем по умолчанию — ручной режим не включается
  const s2 = $.turn.step({ turnId: 't', index: 1, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1 })
  for await (const _ of s2) {
    // ответа модели в тесте нет
  }
  await turn($, 'Покажи список последних коммитов в ветке main.')
  await step($, 'high')
  expect(env.efforts.at(-1)).toBe('medium')

  // Пользователь поднял уровень — ручной; перезагрузка плагина (session.start снова) его не сбрасывает
  await step($, 'max')
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })
  await turn($, 'Покажи список последних коммитов в ветке main.')
  await step($, 'max')

  expect(env.efforts.slice(-2)).toEqual(['max', 'max'])
})

test('/uroven: файл проекта не JSON — не перезаписывается; BOM в начале файла не мешает', async ($, on) => {
  const env = await start($, on, 0, { [PROJECT]: '{ сломано' })

  const r: any = await $.command.run({ command: 'uroven', args: 'ручной' })
  expect(String(r.text)).toContain('не меняю')
  expect(env.files[PROJECT]).toBe('{ сломано')

  env.files[PROJECT] = '\uFEFF{"uroven": "ручной"}'
  await $.session.start({ cwd: 'C:\Projects\Demo', surface: 'desktop', isInteractive: true })
  await step($, 'xhigh')
  expect(env.efforts.at(-1)).toBe('xhigh')
})
