// Автоматический уровень усилий (плагин sreda, ADR 0011, 0013). Диапазон пользователя: только Opus 5.5 со средним,
// высоким и сверхвысоким уровнем — без Sonnet, Haiku, Fable, «низкого» и «максимума».
//
// Своя сессия: сменить себе уровень инструментом приложения нельзя, а мод подменяет effort у каждого запроса к модели
// (turn.step). В начале хода уровень ставит бесплатная оценка сообщения пользователя, по ходу — сама сессия
// инструментом `uroven`. Смена уровня сбрасывает кэш переписки (дорого на длинной), поэтому повышение — всегда,
// понижение — только пока переписка короткая. Модель сессии не меняется никогда: кэш привязан к модели.
// Агенты и подпроекты: модель и уровень выправляются в рамки на вызове инструмента; слепая проверка — Opus высокий.
//
// Ручной режим (ADR 0012): уровень основной сессии ставит пользователь, мод его не трогает и не держит в рамках.
// Включается файлом проекта .claude/sreda.json `{"uroven": "ручной"}` (пишет команда /uroven ручной | авто) или сам —
// когда пользователь сменил уровень в программе посреди сессии (e.effort запроса — настройка сессии, не наша подмена).
// В ручном режиме над полем ввода полоса «Уровень вручную: …» с кнопкой «Авто» (1.23.0, пользователь 30.10: «удобнее,
// конечно, если внизу сессии какая-нибудь кнопочка будет»): нажатие возвращает выбор уровня «Среде», как /uroven авто.

import { atom, update } from 'claude-code'

import { ostTurnStart } from './ostanovki'
import { showEffort } from './stroka'
import { ownText } from './tekst'

export type Level = 'medium' | 'high' | 'xhigh'

const NAMES: Record<Level, string> = { medium: 'средний', high: 'высокий', xhigh: 'сверхвысокий' }
const ALL_NAMES: Record<string, string> = { ...NAMES, low: 'низкий', max: 'максимум' }
const PROJECT_FILE = '.claude/sreda.json'
const RANK: Record<Level, number> = { medium: 0, high: 1, xhigh: 2 }
// До стольких токенов переписки оценка понижает уровень сразу: сброс кэша ещё дешевле разницы в уровнях. Дальше —
// только если и следующее сообщение просит ниже (разовая простая просьба посреди сложной работы кэш не сбрасывает).
export const LOWER_UNTIL = 40_000
const OPUS = 'claude-opus-5-5'

let level: Level = 'medium'
let shown = ''
let toolName = 'mcp__sreda__uroven'
// Прошлая оценка просила ниже текущего уровня, но переписка была длинной
let lowerAsked: Level | undefined
// Ручной режим: 'project' — по файлу проекта, 'session' — пользователь сам сменил уровень в этой сессии
let manual: 'project' | 'session' | undefined
// Уровень, который выбран в программе (e.effort прошлого запроса основной сессии); его смена — выбор пользователя
let picked: unknown
// Модель прошлого запроса: при смене модели (запасная, /model) уровень по умолчанию другой — это не выбор уровня
let lastModel: unknown

// Полоса ручного режима (рисует register.tsx, у него atom с тем же ключом): уровень, выбранный в программе; null —
// режим авто, полосы нет. atom, а не переменная модуля: полоса перерисовывается, когда он меняется
const manualBand = atom({ plugin: 'sreda', key: 'urovenRuchnoj' } as const, null as string | null)

// Диапазон — от «среднего» до «сверхвысокого»: low и max пользователь не берёт
export function clamp(effort: unknown): Level | undefined {
  if (effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort
  if (effort === 'low') return 'medium'
  if (effort === 'max') return 'xhigh'
  return undefined
}

// Границы слова для кириллицы: \b в JS знает только латиницу («попадает» не должно ловиться на «падает»)
const W = '(?<![а-яёa-z])'
const HARD = new RegExp(
  `${W}(ошибк|ошибоч|не работа|не сход|расхожд|почему|разбер|пада[еюл]|упал|слома|баги?(?![а-яё])|глюч|` +
  `ещё раз|еще раз|снова|опять|не получ|архитектур|спроектир|варианты|вариантов|сравни|слеп[аоуы][яюйе]|` +
  `ADR|bug|error|fail|debug|why|mismatch|investigat|root cause|design|refactor)`,
  'iu',
)
// Прошлая попытка не помогла — отдельный признак, не пересекается с HARD: для «сверхвысокого» нужен ещё один
const REPEAT = new RegExp(`${W}(не помогл|вс[её] е[щш][её] не|до сих пор не|по-прежнему не|still not|still fail|` +
  `didn['’]t help)`, 'iu')
const EASY = /^(да|ок|ok|нет|ага|давай|продолжай|продолжи|согласен|готово|спасибо|хорошо|ладно)(?![а-яёa-z])/iu
// Не задача пользователя: ответ из панели, документ передачи, события приложения и других сессий
const NOT_TASK = /^(Ответ на вопрос «|Прочитай \S+ — это документ передачи|<)/u
// Задание подпроекту от глобальной: первая строка «Effort: high» — уровень задан прямо
const ORDERED = /^\s*Effort:\s*(low|medium|high|xhigh|max)\b/im

// Бесплатная оценка сообщения: объём, число вопросов и пунктов, слова о поиске ошибок, решениях и неудачной попытке.
// Один признак сложности — «высокий», два и больше — «сверхвысокий»; без признаков — «средний» (механика тоже).
// undefined — сообщение ничего не говорит о сложности (короткий ответ посреди работы): уровень не трогаем.
export function judge(text: string): Level | undefined {
  // Вставка приложения перед словами пользователя («Linked sessions now») — не его текст: без неё сообщение глобальной
  // сессии начиналось с «<» и считалось не задачей
  const t = ownText(text)
  if (!t || NOT_TASK.test(t)) return undefined
  const ordered = ORDERED.exec(t)
  if (ordered) return clamp(ordered[1].toLowerCase())
  const questions = (t.match(/\?/g) ?? []).length
  const items = (t.match(/^\s*(\d+[.)]|[-*•])\s/gm) ?? []).length
  const signs = [t.length > 1500, questions >= 3, items >= 4, HARD.test(t), REPEAT.test(t)].filter(Boolean).length
  if (signs >= 2) return 'xhigh'
  if (signs === 1) return 'high'
  if (t.length < 200 && questions === 0 && EASY.test(t)) return undefined
  return 'medium'
}

async function context($: any): Promise<number> {
  try {
    return Number((await $.session.usage()).context?.tokens ?? 0)
  } catch {
    return 0
  }
}

// Своя часть строки под полем ввода — первой; токены и лимиты дописывает hooks/stroka.ts
function show($: any): void {
  const own = ALL_NAMES[String(picked)]
  const text = manual ? (own ? `вручную · ${own}` : 'вручную') : NAMES[level]
  if (text === shown) return
  shown = text
  void showEffort($, text)
  void update($, manualBand, () => (manual ? own ?? 'как в программе' : null)).catch(() => undefined)
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

// Модель агента или подпроекта — всегда Opus 5.5 (Sonnet, Haiku, Fable → Opus). Агенту — псевдоним, сессии — полный id.
function model(m: unknown, forSession: boolean): string | undefined {
  if (m === undefined) return undefined
  const s = String(m)
  if (forSession && s === 'opus') return OPUS
  if (/opus/i.test(s)) return s
  return forSession ? OPUS : 'opus'
}
function tidy<T extends Record<string, unknown>>(e: T): T {
  const out: Record<string, unknown> = { ...e }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as T
}

const SESSION_TOOLS = /^mcp__ccd_session(_mgmt)?__(start_session|set_session_effort|set_session_model)$/

async function projectFile($: any): Promise<string> {
  return `${String(await $.session.cwd()).split('\\').join('/').replace(/\/+$/, '')}/${PROJECT_FILE}`
}

// Файла нет — {}; файл есть, но не JSON-объект — undefined: команда его не перезаписывает (потеряли бы прочие ключи).
// BOM в начале — PowerShell 5 пишет его при -Encoding UTF8.
async function readProject($: any): Promise<Record<string, unknown> | undefined> {
  const path = await projectFile($)
  let text = ''
  try {
    if (!(await $.fs.exists(path))) return {}
    text = String(await $.fs.read(path)).replace(/^﻿/, '')
  } catch {
    return {}
  }
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// Ручной режим сессии и уровень программы — в состоянии сессии: перезагрузка плагина переменные модуля сбрасывает
const SAVED = { plugin: 'sreda', key: 'uroven' } as const
async function remember($: any): Promise<void> {
  try {
    await $.state.set(SAVED, { isSession: manual === 'session', picked: picked ?? null })
  } catch {
    // состояние недоступно — режим держится до перезагрузки плагина
  }
}

// Уровень по умолчанию из настроек программы — точка отсчёта, если пользователь выбрал другой ещё до первого запроса
async function configured($: any): Promise<unknown> {
  try {
    const row = (await $.config.list()).find((r: { key: string }) => /effort/i.test(r.key))
    return typeof row?.value === 'string' && ALL_NAMES[row.value] ? row.value : undefined
  } catch {
    return undefined
  }
}

const isManual = (v: unknown) => /^(ручн|manual)/iu.test(String(v ?? ''))

// /uroven ручной | авто — режим проекта в .claude/sreda.json (прочие ключи файла сохраняются); без слова — состояние
export async function urovenCommand($: any, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  const where = PROJECT_FILE
  if (!word) {
    if (manual === 'project') return `Уровень ставите вы: ручной режим проекта (${where}). Вернуть — /uroven авто.`
    if (manual === 'session') return 'Уровень ставите вы: вы сменили его в этой сессии. Вернуть — /uroven авто.'
    return `Уровень выбирает «Среда»: сейчас ${NAMES[level]}. Ставить самому в этом проекте — /uroven ручной.`
  }
  const toManual = isManual(word)
  if (!toManual && !/^(авто|auto)/u.test(word)) return 'Команда: /uroven ручной или /uroven авто.'
  const data = await readProject($)
  if (!data) return `${where} — не JSON-объект: файл не меняю, поправьте его (ключ "uroven": "ручной" или "авто").`
  await $.fs.write(await projectFile($), `${JSON.stringify({ ...data, uroven: toManual ? 'ручной' : 'авто' }, null, 2)}\n`)
  manual = toManual ? 'project' : undefined
  lowerAsked = undefined
  shown = ''
  show($)
  await remember($)
  return toManual
    ? `Ручной режим в этом проекте (${where}): уровень ставите вы в программе, «Среда» его не меняет.`
    : `«Среда» снова выбирает уровень сама в этом проекте (${where}).`
}

// Кнопка «Авто» на полосе ручного режима: ручной режим проекта — как /uroven авто (файл проекта), ручной режим
// сессии — забыть его. Уровень программы (picked) помним: следующий запрос с ним же — не новый выбор пользователя, а
// забытый после перезагрузки плагина подменился бы уровнем из настроек, и первый запрос снова включил бы ручной режим
export async function toAuto($: any): Promise<string> {
  let text = '«Среда» снова выбирает уровень сама.'
  if (manual === 'project') {
    text = await urovenCommand($, 'авто')
    if (manual) return text
  }
  manual = undefined
  lowerAsked = undefined
  shown = ''
  show($)
  await remember($)
  return text
}

// Из session.start плагина: инструмент `uroven` и уровень по умолчанию (новая сессия и перезагрузка плагина)
export async function startUroven($: any): Promise<void> {
  const reg = await $.tool.register({
    name: 'uroven',
    description:
      'Уровень усилий этой сессии (Opus 5.5), когда прочитана задача и оценка мода в начале хода не подходит: ' +
      'medium — механика и обычная работа; high — поиск ошибок, расхождения цифр, код на много файлов, решения и ' +
      'варианты, много требований; xhigh — то же, но трудное: вторая неудачная попытка, ошибка без явной причины, ' +
      'архитектура на много частей, много связанных требований сразу. Действует с этого же шага, пока оценка ' +
      'следующего сообщения пользователя не выберет другой. Смена уровня сбрасывает кэш переписки: на длинной ' +
      'понижать, только если впереди несколько простых шагов. Не ниже medium и не выше xhigh.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['medium', 'high', 'xhigh'] },
        reason: { type: 'string' },
      },
      required: ['level'],
    },
  })
  toolName = reg.tool
  level = 'medium'
  lowerAsked = undefined
  lastModel = undefined
  let saved: { isSession?: boolean; picked?: unknown } | undefined
  try {
    saved = (await $.state.get(SAVED)).value
  } catch {
    saved = undefined
  }
  picked = saved?.picked ?? (await configured($))
  manual = isManual((await readProject($))?.uroven) ? 'project' : saved?.isSession ? 'session' : undefined
  shown = ''
  show($)
}

const effortOf = (e: any) => (e.effort === undefined ? undefined : clamp(e.effort) ?? e.effort)

// Из tool.call плагина: инструмент `uroven`, рамки модели и уровня у агентов и подпроектов. undefined — не наш вызов.
export function urovenCall($: any, e: any, next: any): Promise<any> | undefined {
  if (e.tool === toolName) {
    // Уровень — основной сессии; агент его не меняет (переменная модуля общая)
    if (e.agentId !== undefined) return Promise.resolve({ result: 'Уровень меняет только основная сессия.' })
    if (manual) return Promise.resolve({ result: 'Уровень ставит пользователь (ручной режим) — не менять.' })
    const asked = clamp(e.level)
    if (!asked) return Promise.resolve({ result: 'level: medium, high или xhigh.' })
    return Promise.resolve({ result: set($, asked) })
  }
  if (next.origin.plugin !== 'engine') return undefined

  if (e.tool === 'Agent') {
    if (blind(e)) return next({ ...e, model: 'opus', effort: 'high' })
    // Поиск по проекту без указанной модели шёл бы на Haiku — Opus
    const m = model(e.model, false) ?? (e.subagent_type === 'Explore' ? 'opus' : undefined)
    return next(tidy({ ...e, model: m, effort: effortOf(e) }))
  }
  if (SESSION_TOOLS.test(e.tool)) {
    // Новая сессия без модели унаследовала бы модель этой (запасную, выбранную /model) — Opus явно
    const m = e.model === undefined && /start_session$/.test(e.tool) ? OPUS : model(e.model, true)
    return next(tidy({ ...e, model: m, effort: effortOf(e) }))
  }
  return undefined
}

// started — начало хода основной сессии для register.tsx (второй хук turn.start в модуле движок не принимает)
export function registerUroven(on: any, started: () => void = () => {}): void {
  // Ход пользователя: оценить сообщение. Ход без текста (продолжение, ответ агента) — уровень как был.
  on('turn.start', async ($: any, e: any, next: any) => {
    if (e.agentId === undefined) {
      started()
      // Сессия снова работает — её карточка «стоит» уходит из панели (hooks/ostanovki.ts)
      await ostTurnStart($).catch(() => undefined)
      const wanted = manual ? undefined : judge(String(e.text ?? ''))
      if (wanted) await guess($, wanted)
    }
    return next(e)
  })

  // Каждый запрос к модели: своей сессии — выбранный уровень (в ручном режиме — как есть); агентам — Opus от среднего
  // до сверхвысокого (их модель могла прийти из описания агента или настройки по умолчанию, мимо вызова Agent)
  on('turn.step', async function* ($: any, e: any, next: any) {
    if (e.agentId === undefined) {
      // Уровень в программе сменился с прошлого запроса — его выбрал пользователь: дальше не вмешиваемся
      const sameModel = lastModel === undefined || e.model === lastModel
      const changed = e.effort !== undefined && e.effort !== picked
      if (changed && picked !== undefined && sameModel && !manual) manual = 'session'
      if (e.effort !== undefined) picked = e.effort
      lastModel = e.model
      if (changed) await remember($)
      if (manual) {
        show($)
        return yield* next(e)
      }
      if (typeof e.effort !== 'string' || e.effort === level) return yield* next(e)
      return yield* next({ ...e, effort: level })
    }
    const m = model(e.model, true) ?? e.model
    const effort = typeof e.effort === 'string' ? clamp(e.effort) ?? e.effort : e.effort
    if (m === e.model && effort === e.effort) return yield* next(e)
    return yield* next(tidy({ ...e, model: m, effort }))
  })
}