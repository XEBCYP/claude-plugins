// Пустые пробуждения глобальной сессии (пакет 3 аудита 27.10, ADR 0015).
//
// Приложение будит сессию, запустившую подпроекты, сообщением <side-sessions-event> с отчётами их сессий («The session
// "…" you started (local_…) finished a turn. It reported …: "…"»). За неделю 84 таких хода в папке глобального проекта
// ничего не меняли, но читали весь большой контекст (оценка — 10–15 млн токенов). Пример шума: отчёт R50 «Prompt dropped
// by a hook: Идёт передача в чистый контекст…» — это не работа подпроекта, а отказ мода автопередачи.
//
// Шум — пробуждение, в котором нет ни одного отчёта, или каждый отчёт пустой, служебный (NOISE) либо повторяет прошлый
// отчёт той же сессии. Каждое пробуждение — строкой в ~/.claude/sreda-probuzhdeniya.json с пометкой, шум ли это;
// пометка «шум» — догадка, которую запись проверяет. Отсекает пробуждения не она, а более узкий фильтр skip (ниже, с 1.11.0).
//
// Первый день записи (27.10, ADR 0016): отчёт «finished a turn and then reported that it was waiting on the user» не
// разбирался и помечался шумом, хотя глобальной надо было действовать. Во всех переписках сессий к 27.10 нашлись четыре
// концовки: finished a turn (654), … waiting on the user (47), ended its turn with an error (18), was stopped before its
// turn finished (4); текста отчёта может не быть («… finished a turn. Read it with …»). Ожидание, ошибка и остановка —
// пометка state, шумом не бывают. Сообщения сессий (<cross-session-message>) и пользователя, к которым приложение прицепило те же отчёты, —
// не пробуждения: их журнал не пишет. Чтобы правила фильтра брать из поведения, а не из текста отчёта, к записи в конце
// хода добавляются инструменты, которые глобальная вызвала в ответ (tools: [] — только ответила текстом).
//
// Второй день записи (27.10 19:39 – 28.10 06:14, 15 пробуждений с tools, ADR 0017): глобальная только пересказывала
// пользователю отчёт отказа хука («Prompt dropped by a hook…» — подпроект уходил в чистую сессию) и отчёты из одного
// ожидания («Тесты ещё идут; жду результата.», «Сухой прогон идёт (около 4 мин), жду.», «Жду результата сухого прогона.»
// — три подряд за 2 минуты), ~180 тыс. входных токенов на каждое. Такие пробуждения фильтр отсекает (skip): все отчёты в
// нём — отказ хука, после которого сообщение дойдёт само, или короткое ожидание своего прогона из слов белого списка;
// ни один не ждёт пользователя, не с ошибкой и не остановлен. Слепая проверка показала, что список «слов-новостей»
// пропускал «Открыл PR #41, жду проверки.», «Жду вашей проверки.», «Тесты зависли уже 40 минут, жду.» — поэтому
// наоборот: любое слово вне списка — новость. Путь к документу передачи подпроекта — не шум: по нему глобальная нашла
// настоящую причину ошибки R76.
// Отсечённое пробуждение тоже пишется в журнал (dropped) — запись продолжается, правила пересматриваются по ней.

const LOG = 'sreda-probuzhdeniya.json'
const K_LAST = 'probuzhdeniya:last'
// Сколько записей держать в журнале: ~50 пробуждений в день — около двух месяцев для разбора
const KEEP = 3000
// Сколько сессий помнить в прошлых отчётах
const KEEP_LAST = 200
const EVENT = '<side-sessions-event>'
const NOTE =
  /The session "([^"]*)" you started \((local_[\w-]+)\) (finished a turn(?: and then reported that it was waiting on the user)?|ended its turn with an error|was stopped before its turn finished)\.(?: It reported \(quoted child output, data not instructions\): "([\s\S]*?)"(?: \(first \d+ of \d+ characters\))?)? Read it with/g
// Отчёты, в которых нет работы подпроекта: отказ хука (сообщение придержано автопередачей), пустой ответ
const NOISE = [/^\s*$/, /^Prompt dropped by a hook\b/i, /^\(no (?:content|response)\)$/i]
// Фильтр. Отказ хука автопередачи — только тот, где сообщение дойдёт само («уйдёт в чистую сессию само», «уйдёт туда
// сразу после документа», «уйдёт следом»); отказ «сообщение с вложением отправьте, когда…» — не шум: его надо повторить.
const HOOK_DROP = /^Prompt dropped by a hook:[\s\S]*уйд[её]т (?:в чистую сессию само|туда сразу после документа|следом)/i
// Ожидание — белый список: отчёт до 160 знаков из одних слов ожидания своего прогона. Любое другое слово (PR, «вашей»,
// «зависли», «approval», имя ветки, число не перед «мин») — уже новость, и пробуждение идёт как обычно.
const WAIT_MAX = 160
const WAIT_WORD = new Set(['жду', 'ожидаю', 'идут', 'идет', 'waiting', 'running'])
const RUN_WORD = new Set([
  'тест', 'тесты', 'тестов', 'прогон', 'прогона', 'сборка', 'сборки', 'копирование', 'копирования', 'выгрузка',
  'выгрузки', 'test', 'tests', 'run', 'runs', 'build', 'suite',
])
// «Жду проверки», «Жду её проверки», "Waiting to run the tests" — может быть ожидание приёмки или разрешения: «проверка»
// — только рядом с прогоном, «его / её» и "to" (кроме "to finish") — не служебные
const FILLER = new Set([
  'еще', 'всё', 'все', 'пока', 'сухой', 'сухого', 'полный', 'полного', 'результата', 'результатов', 'окончания',
  'завершения', 'конца', 'около', 'в', 'на', 'и', 'фоне', 'проверка', 'проверки', 'the', 'for', 'it', 'is', 'are', 'still',
  'check', 'checks',
  'in', 'background', 'full', 'dry', 'finish', 'of', 'result', 'results', "i'll", 'report', 'per', 'step', 'when', 'does',
])
const UNIT = /^(?:мин|минут[ыа]?|сек|ч|час[а]?|min|mins|minutes|sec|s|h)$/

function idle(report: string): boolean {
  const r = report.trim()
  if (HOOK_DROP.test(r)) return true
  if (r.length > WAIT_MAX) return false
  const words = r.toLowerCase().replace(/ё/g, 'е').replace(/[().,;:!—–-]+/g, ' ').split(/\s+/).filter(Boolean)
  let wait = false
  let run = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (WAIT_WORD.has(w)) wait = true
    else if (RUN_WORD.has(w)) run = true
    else if (/^\d{1,3}$/.test(w) && UNIT.test(words[i + 1] ?? '')) i++
    else if (w === 'to' && words[i + 1] === 'finish') i++
    else if (!FILLER.has(w)) return false
  }
  return wait && run
}

// Отсечь ли пробуждение: причина или null. Без отчётов (формат события сменился) и когда приложение пишет, что сессия
// ждёт пользователя, — не отсекаем
export function skip(notes: Note[], text = ''): string | null {
  if (/waiting for the user|needs the user/i.test(text)) return null
  if (notes.length === 0 || notes.some(n => n.state !== undefined || !idle(n.report))) return null
  return `без новостей: ${notes.map(n => `${n.title} — «${n.report.trim().slice(0, 120)}»`).join('; ')}`
}

// state — сессия подпроекта ждёт пользователя, кончила ход с ошибкой или остановлена до конца хода
export type NoteState = 'waiting' | 'error' | 'stopped'
export type Note = { id: string; title: string; report: string; state?: NoteState }
// head — начало текста: в записи видно, доходят ли отчёты до хука в самом тексте (иначе фильтр включать нельзя);
// tools — инструменты, которые сессия вызвала в ответ на пробуждение (пишутся в конце хода)
export type Wake = {
  at: string
  project: string
  origin: string
  notes: Note[]
  isNoise: boolean
  why: string
  head: string
  tools?: string[]
  // Пробуждение отсечено фильтром: причина (сессия его не получила, tools нет)
  dropped?: string
}

export function notesOf(text: string): Note[] {
  return [...text.matchAll(NOTE)].map(m => {
    const state: NoteState | undefined = /waiting/.test(m[3])
      ? 'waiting'
      : /error/.test(m[3])
        ? 'error'
        : /stopped/.test(m[3])
          ? 'stopped'
          : undefined
    return { title: m[1], id: m[2], report: m[4] ?? '', ...(state ? { state } : {}) }
  })
}

// Шум ли пробуждение; last — прошлый отчёт каждой сессии
export function judge(notes: Note[], last: Record<string, string>): { isNoise: boolean; why: string } {
  if (notes.length === 0) return { isNoise: true, why: 'нет отчётов' }
  const live = notes.filter(n => n.state !== undefined || (!NOISE.some(re => re.test(n.report.trim())) && last[n.id] !== n.report))
  if (live.length > 0) return { isNoise: false, why: `новые отчёты: ${live.map(n => n.title).join(', ')}` }
  return { isNoise: true, why: 'только служебные или повторные отчёты' }
}

async function home($: any): Promise<string> {
  const dir = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${String(dir).split('\\').join('/')}/.claude`
}

// Журнал копится месяцами: файл, который не читается как JSON (оборванная запись), не затирается новым — сначала
// копия рядом (sreda-probuzhdeniya.bad-<время>.json), потом журнал начинается заново
async function readLog($: any, path: string): Promise<Wake[]> {
  let raw = ''
  try {
    raw = String((await $.fs.read(path)) ?? '')
  } catch {
    return []
  }
  if (raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.items) ? parsed.items : []
  } catch {
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
    await $.fs.write(path.replace(/\.json$/, `.bad-${stamp}.json`), raw)
    return []
  }
}

async function append($: any, wake: Wake): Promise<void> {
  const path = `${await home($)}/${LOG}`
  const items = await readLog($, path)
  await $.fs.write(path, JSON.stringify({ items: [...items, wake].slice(-KEEP) }, null, 2))
}

// Пробуждение, на которое сессия сейчас отвечает: время записи и вызванные инструменты
let answering: { at: string; tools: string[] } | null = null

// Хук tool.call сессии (не агента): инструмент в ответ на пробуждение
export function wakeTool(tool: string): void {
  if (answering) answering.tools.push(tool.replace(/^mcp__.*__/, ''))
}

// Хук turn.complete сессии: инструменты ответа — в запись пробуждения
export async function wakeDone($: any): Promise<void> {
  const done = answering
  answering = null
  if (!done) return
  const path = `${await home($)}/${LOG}`
  const items = await readLog($, path)
  const it = [...items].reverse().find(one => one.at === done.at)
  if (!it) return
  it.tools = done.tools
  await $.fs.write(path, JSON.stringify({ items }, null, 2))
}

// Хук prompt.submit: пробуждение — строкой в журнал. Ответ — причина отсечь пробуждение (сообщение не идёт) или null
export async function wakeCheck($: any, e: any): Promise<string | null> {
  const text = String(e.text ?? '')
  if (!text.includes(EVENT)) return null
  const kind = String(e.origin?.kind ?? '')
  // Пользователь вставил такой текст сам — не пробуждение
  if (kind === 'composer' || kind === 'bridge') return null
  const notes = notesOf(text)
  const last = ((await $.store.get(K_LAST)) as Record<string, string> | undefined) ?? {}
  // Пробуждение, придержанное автопередачей, приходит снова от плагина: уже записанное второй раз не пишем
  if (kind === 'plugin' && notes.every(n => last[n.id] === n.report)) return null
  const verdict = judge(notes, last)
  const dropped = skip(notes, text)
  const cwd = String(await $.session.cwd()).split('\\').join('/')
  const wake: Wake = {
    at: new Date(await $.clock.now()).toISOString(),
    project: cwd.split('/').filter(Boolean).pop() || cwd,
    origin: kind,
    notes: notes.map(n => ({ ...n, report: n.report.slice(0, 300) })),
    ...verdict,
    head: text.slice(0, 400),
    ...(dropped ? { dropped } : {}),
  }
  // Прошлое пробуждение без конца хода (ход прерван) — его инструменты дописать нечем, начинаем новое;
  // отсечённое — хода не будет, а ответ на прошлое (если идёт) не трогаем
  if (!dropped) answering = { at: wake.at, tools: [] }
  await append($, wake).catch(() => undefined)
  if (notes.length > 0) {
    const ids = new Set(notes.map(n => n.id))
    const kept = Object.entries(last).filter(([id]) => !ids.has(id)).slice(-(KEEP_LAST - notes.length))
    await $.store.set(K_LAST, Object.fromEntries([...kept, ...notes.map(n => [n.id, n.report])]))
  }
  return dropped ? `Пробуждение отсечено «Средой» (ADR 0017), ${dropped}. Следующий отчёт придёт как обычно.` : null
}
