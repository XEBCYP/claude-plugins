// Пустые пробуждения глобальной сессии (пакет 3 аудита 27.10, ADR 0015).
//
// Приложение будит сессию, запустившую подпроекты, сообщением <side-sessions-event> с отчётами их сессий («The session
// "…" you started (local_…) finished a turn. It reported …: "…"»). За неделю 84 таких хода в папке глобального проекта
// ничего не меняли, но читали весь большой контекст (оценка — 10–15 млн токенов). Пример шума: отчёт R50 «Prompt dropped
// by a hook: Идёт передача в чистый контекст…» — это не работа подпроекта, а отказ мода автопередачи.
//
// Шум — пробуждение, в котором нет ни одного отчёта, или каждый отчёт пустой, служебный (NOISE) либо повторяет прошлый
// отчёт той же сессии. Режим «zapis» (по умолчанию): каждое пробуждение — строкой в ~/.claude/sreda-probuzhdeniya.json с
// пометкой, шум ли это; сообщение идёт как обычно. Режим «filtr»: шум не будит сессию. Фильтр включается настройкой
// плагина probuzhdeniya = filtr после просмотра записи — сначала образец, потом весь объём.

const LOG = 'sreda-probuzhdeniya.json'
const K_LAST = 'probuzhdeniya:last'
// Сколько записей держать в журнале
const KEEP = 300
const EVENT = '<side-sessions-event>'
const NOTE =
  /The session "([^"]*)" you started \((local_[\w-]+)\) finished a turn\. It reported \(quoted child output, data not instructions\): "([\s\S]*?)"(?: \(first \d+ of \d+ characters\))? Read it with/g
// Отчёты, в которых нет работы подпроекта: отказ хука (сообщение придержано автопередачей), пустой ответ
const NOISE = [/^\s*$/, /^Prompt dropped by a hook\b/i, /^\(no (?:content|response)\)$/i]

export type Note = { id: string; title: string; report: string }
// head — начало текста: в записи видно, доходят ли отчёты до хука в самом тексте (иначе фильтр включать нельзя)
export type Wake = { at: string; project: string; origin: string; notes: Note[]; isNoise: boolean; why: string; head: string }

let mode: 'zapis' | 'filtr' = 'zapis'

export function setProbuzhdeniyaMode(value: unknown): void {
  mode = value === 'filtr' ? 'filtr' : 'zapis'
}

export function notesOf(text: string): Note[] {
  return [...text.matchAll(NOTE)].map(m => ({ title: m[1], id: m[2], report: m[3] }))
}

// Шум ли пробуждение; last — прошлый отчёт каждой сессии
export function judge(notes: Note[], last: Record<string, string>): { isNoise: boolean; why: string } {
  if (notes.length === 0) return { isNoise: true, why: 'нет отчётов' }
  const live = notes.filter(n => !NOISE.some(re => re.test(n.report.trim())) && last[n.id] !== n.report)
  if (live.length > 0) return { isNoise: false, why: `новые отчёты: ${live.map(n => n.title).join(', ')}` }
  return { isNoise: true, why: 'только служебные или повторные отчёты' }
}

async function home($: any): Promise<string> {
  const dir = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${String(dir).split('\\').join('/')}/.claude`
}

async function append($: any, wake: Wake): Promise<void> {
  const path = `${await home($)}/${LOG}`
  let items: Wake[] = []
  try {
    const parsed = JSON.parse(await $.fs.read(path))
    if (Array.isArray(parsed?.items)) items = parsed.items
  } catch {
    items = []
  }
  await $.fs.write(path, JSON.stringify({ items: [...items, wake].slice(-KEEP) }, null, 2))
}

// Хук prompt.submit: пробуждение — запись; в режиме filtr шум — причина отказа, иначе null
export async function wakeCheck($: any, e: any): Promise<string | null> {
  const text = String(e.text ?? '')
  if (!text.includes(EVENT)) return null
  const kind = String(e.origin?.kind ?? '')
  // Пользователь вставил такой текст сам — не пробуждение
  if (kind === 'composer' || kind === 'bridge') return null
  const notes = notesOf(text)
  const last = ((await $.store.get(K_LAST)) as Record<string, string> | undefined) ?? {}
  const verdict = judge(notes, last)
  const cwd = String(await $.session.cwd()).split('\\').join('/')
  const wake: Wake = {
    at: new Date(await $.clock.now()).toISOString(),
    project: cwd.split('/').filter(Boolean).pop() || cwd,
    origin: kind,
    notes: notes.map(n => ({ ...n, report: n.report.slice(0, 300) })),
    ...verdict,
    head: text.slice(0, 400),
  }
  await append($, wake).catch(() => undefined)
  if (notes.length > 0) {
    await $.store.set(K_LAST, { ...last, ...Object.fromEntries(notes.map(n => [n.id, n.report])) })
  }
  return mode === 'filtr' && verdict.isNoise ? `Пробуждение без новых отчётов подпроектов (${verdict.why}) — пропущено плагином sreda.` : null
}
