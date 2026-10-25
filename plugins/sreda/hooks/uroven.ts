// Автоматический уровень усилий (плагин sreda, ADR 0011). Диапазон пользователя: Sonnet 5.5 и Opus 5.5 с низким,
// средним, высоким уровнем — без Haiku, Fable, «сверхвысокого» и «максимума».
//
// Своя сессия: сменить себе уровень инструментом приложения нельзя, а мод подменяет effort у каждого запроса к модели
// (turn.step). В начале хода уровень ставит бесплатная оценка сообщения пользователя, по ходу — сама сессия
// инструментом `uroven`. Смена уровня сбрасывает кэш переписки (дорого на длинной), поэтому повышение — всегда,
// понижение — только пока переписка короткая. Модель сессии не меняется никогда: кэш привязан к модели.
// Агенты и подпроекты: модель и уровень выправляются в рамки на вызове инструмента; слепая проверка — Opus высокий.

export type Level = 'low' | 'medium' | 'high'

const NAMES: Record<Level, string> = { low: 'низкий', medium: 'средний', high: 'высокий' }
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 }
// До стольких токенов переписки оценка понижает уровень сразу: сброс кэша ещё дешевле разницы в уровнях. Дальше —
// только если и следующее сообщение просит ниже (разовая простая просьба посреди сложной работы кэш не сбрасывает).
export const LOWER_UNTIL = 40_000
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

let level: Level = 'medium'
let shown = ''
let toolName = 'mcp__sreda__uroven'
// Прошлая оценка просила ниже текущего уровня, но переписка была длинной
let lowerAsked: Level | undefined

// Самый высокий уровень — «высокий»: xhigh и max пользователь не берёт
export function clamp(effort: unknown): Level | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort
  if (effort === 'xhigh' || effort === 'max') return 'high'
  return undefined
}

// Границы слова для кириллицы: \b в JS знает только латиницу («попадает» не должно ловиться на «падает»)
const W = '(?<![а-яёa-z])'
const HARD = new RegExp(
  `${W}(ошибк|ошибоч|не работа|не сход|расхожд|почему|разбер|пада[еюл]|упал|слома|баги?(?![а-яё])|глюч|` +
  `ещё раз|еще раз|снова|опять|не помогл|не получ|архитектур|спроектир|варианты|вариантов|сравни|слеп[аоуы][яюйе]|` +
  `ADR|bug|error|fail|debug|why|mismatch|investigat|root cause|design|refactor)`,
  'iu',
)
const EASY = /^(да|ок|ok|нет|ага|давай|продолжай|продолжи|согласен|готово|спасибо|хорошо|ладно)(?![а-яёa-z])/iu
const MECHANICAL = new RegExp(`${W}(закоммит|отправ|перешли|скопируй|покажи|выведи|найди|статус|список|выгрузи|` +
  `перезапуст|commit|push|copy|list|show|status|collect|fetch)`, 'iu')
// Не задача пользователя: ответ из панели, документ передачи, события приложения и других сессий
const NOT_TASK = /^(Ответ на вопрос «|Прочитай \S+ — это документ передачи|<)/u
// Задание подпроекту от глобальной: первая строка «Effort: high» — уровень задан прямо
const ORDERED = /^\s*Effort:\s*(low|medium|high)\b/im

// Бесплатная оценка сообщения: объём, число вопросов и пунктов, слова о поиске ошибок и решениях, механика.
// undefined — сообщение ничего не говорит о сложности (короткий ответ посреди работы): уровень не трогаем.
export function judge(text: string): Level | undefined {
  const t = text.trim()
  if (!t || NOT_TASK.test(t)) return undefined
  const ordered = ORDERED.exec(t)
  if (ordered) return ordered[1].toLowerCase() as Level
  const questions = (t.match(/\?/g) ?? []).length
  const items = (t.match(/^\s*(\d+[.)]|[-*•])\s/gm) ?? []).length
  if (t.length > 1500 || questions >= 3 || items >= 4 || HARD.test(t)) return 'high'
  if (t.length < 200 && questions === 0 && EASY.test(t)) return undefined
  if (t.length < 300 && MECHANICAL.test(t)) return 'low'
  return 'medium'
}

async function context($: any): Promise<number> {
  try {
    return Number((await $.session.usage()).context?.tokens ?? 0)
  } catch {
    return 0
  }
}

function show($: any): void {
  const text = `Усилия: ${NAMES[level]}`
  if (text === shown) return
  shown = text
  $.ui.status(text)
}

function set($: any, next: Level): string {
  level = next
  lowerAsked = undefined
  show($)
  return `Уровень усилий: ${NAMES[level]}.`
}

// Оценка хода: повышение — сразу; понижение на длинной переписке — со второго сообщения подряд, которое просит ниже
async function guess($: any, next: Level): Promise<void> {
  if (RANK[next] >= RANK[level]) return void set($, next)
  if ((await context($)) <= LOWER_UNTIL || lowerAsked !== undefined) {
    const higher = lowerAsked !== undefined && RANK[lowerAsked] > RANK[next] ? lowerAsked : next
    return void set($, higher)
  }
  lowerAsked = next
}

function blind(e: any): boolean {
  return /(?<![а-яё])слеп(ая|ую|ой|ые)\s+(провер|приём|прием)|blind\s+(check|accept|review|verif)/iu
    .test(`${e.description ?? ''} ${e.prompt ?? ''}`)
}

// Модель агента или подпроекта — в рамках: Haiku → Sonnet, Fable → Opus. Агенту — псевдоним, сессии — полный id.
function model(m: unknown, forSession: boolean): string | undefined {
  if (m === undefined) return undefined
  const s = String(m)
  if (/haiku/i.test(s)) return forSession ? SONNET : 'sonnet'
  if (/fable|mythos/i.test(s)) return forSession ? OPUS : 'opus'
  if (forSession && s === 'sonnet') return SONNET
  if (forSession && s === 'opus') return OPUS
  return s
}
function tidy<T extends Record<string, unknown>>(e: T): T {
  const out: Record<string, unknown> = { ...e }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as T
}

const SESSION_TOOLS = /^mcp__ccd_session(_mgmt)?__(start_session|set_session_effort|set_session_model)$/

// Из session.start плагина: инструмент `uroven` и уровень по умолчанию (новая сессия и перезагрузка плагина)
export async function startUroven($: any): Promise<void> {
  const reg = await $.tool.register({
    name: 'uroven',
    description:
      'Уровень усилий этой сессии (Opus 5.5), когда прочитана задача и оценка мода в начале хода не подходит: low — ' +
      'механика (коммит, пересылка, поиск данных, простой тест); medium — обычная работа; high — поиск ошибок, ' +
      'расхождения цифр, код на много файлов, решения и варианты, вторая неудачная попытка, много требований. ' +
      'Действует с этого же шага, пока оценка следующего сообщения пользователя не выберет другой. Смена уровня ' +
      'сбрасывает кэш переписки: на длинной понижать, только если впереди несколько простых шагов. Не выше high.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['low', 'medium', 'high'] },
        reason: { type: 'string' },
      },
      required: ['level'],
    },
  })
  toolName = reg.tool
  level = 'medium'
  lowerAsked = undefined
  shown = ''
  show($)
}

const effortOf = (e: any) => (e.effort === undefined ? undefined : clamp(e.effort) ?? e.effort)

// Из tool.call плагина: инструмент `uroven`, рамки модели и уровня у агентов и подпроектов. undefined — не наш вызов.
export function urovenCall($: any, e: any, next: any): Promise<any> | undefined {
  if (e.tool === toolName) {
    // Уровень — основной сессии; агент его не меняет (переменная модуля общая)
    if (e.agentId !== undefined) return Promise.resolve({ result: 'Уровень меняет только основная сессия.' })
    const asked = clamp(e.level)
    if (!asked) return Promise.resolve({ result: 'level: low, medium или high.' })
    return Promise.resolve({ result: set($, asked) })
  }
  if (next.origin.plugin !== 'engine') return undefined

  if (e.tool === 'Agent') {
    if (blind(e)) return next({ ...e, model: 'opus', effort: 'high' })
    // Поиск по проекту без указанной модели шёл бы на Haiku — Sonnet
    const m = model(e.model, false) ?? (e.subagent_type === 'Explore' ? 'sonnet' : undefined)
    return next(tidy({ ...e, model: m, effort: effortOf(e) }))
  }
  if (SESSION_TOOLS.test(e.tool)) {
    return next(tidy({ ...e, model: model(e.model, true), effort: effortOf(e) }))
  }
  return undefined
}

export function registerUroven(on: any): void {
  // Ход пользователя: оценить сообщение. Ход без текста (продолжение, ответ агента) — уровень как был.
  on('turn.start', async ($: any, e: any, next: any) => {
    if (e.agentId === undefined) {
      const wanted = judge(String(e.text ?? ''))
      if (wanted) await guess($, wanted)
    }
    return next(e)
  })

  // Каждый запрос к модели: своей сессии — выбранный уровень; агентам — не выше высокого и не Haiku/Fable (их модель
  // могла прийти из описания агента или настройки по умолчанию, мимо вызова Agent)
  on('turn.step', async function* ($: any, e: any, next: any) {
    if (e.agentId === undefined) {
      if (typeof e.effort !== 'string' || e.effort === level) return yield* next(e)
      return yield* next({ ...e, effort: level })
    }
    const m = model(e.model, true) ?? e.model
    const effort = typeof e.effort === 'string' ? clamp(e.effort) ?? e.effort : e.effort
    if (m === e.model && effort === e.effort) return yield* next(e)
    return yield* next(tidy({ ...e, model: m, effort }))
  })
}