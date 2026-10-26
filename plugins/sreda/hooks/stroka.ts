// Строка под полем ввода (плагин sreda): уровень усилий, токены переписки и лимиты подписки — одной строкой.
// Вместо чужого мода ctx (шкалы CTX/5H/7D, автор — Никита Велс): процент окна контекста ничего не говорил,
// а автопередача (autohandoff) считает в тысячах токенов — 150K, 200K, 250K.
// Десктоп рисует строку статуса своим шрифтом в узком месте между режимом и моделью и обрезает многоточием: шкалы,
// слово «TKN» и em-пробелы прятали лимиты (26.10.2026), поэтому строка короткая — «высокий · 149K · 5H 95% до 2:00».
// Последним стоит недельный лимит: при нехватке места скрывается первым.
const SEP = ' · '
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
// Раз в столько обновлять токены и лимиты между ходами: лимит 5 часов тратят и другие сессии
export const MEASURE_MS = 30_000

type Limit = { percent: number; resetsAt?: number }

let effort = ''
let tokens: number | undefined
let h5: Limit | undefined
let d7: Limit | undefined
let shown = ''

const two = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${d.getHours()}:${two(d.getMinutes())}`
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Когда сбросится лимит: сегодня — «до 18:40», завтра — «до завтра 9:00», дальше — день недели «до пт»
export function until(resetsAt: number, now: number): string {
  const days = Math.round((dayOf(resetsAt) - dayOf(now)) / 86_400_000)
  const d = new Date(resetsAt)
  if (days <= 0) return `до ${clock(d)}`
  if (days === 1) return `до завтра ${clock(d)}`
  return `до ${DAYS[d.getDay()]}`
}

export function kilo(n: number | undefined): string {
  return n === undefined ? '—' : `${Math.round(n / 1000)}K`
}

function limit(name: string, it: Limit | undefined, now: number): string | undefined {
  if (!it) return undefined
  // Лимит уже сбросился, а нового ответа с цифрами не было (пауза) — израсходовано 0, а не прежние 95%
  if (it.resetsAt !== undefined && it.resetsAt <= now) return `${name} 0%`
  const left = it.resetsAt !== undefined ? ` ${until(it.resetsAt, now)}` : ''
  return `${name} ${Math.round(it.percent)}%${left}`
}

async function paint($: any): Promise<void> {
  const now = Number(await $.clock.now())
  const parts = [effort, kilo(tokens), limit('5H', h5, now), limit('7D', d7, now)].filter(Boolean)
  const text = parts.join(SEP)
  if (text === shown) return
  shown = text
  $.ui.status(text)
}

// Часть уровня усилий (hooks/uroven.ts): «высокий»
export async function showEffort($: any, text: string): Promise<void> {
  effort = text
  await paint($)
}

const readLimit = (all: any[], kind: string): Limit | undefined => {
  const it = all.find(one => one?.kind === kind)
  if (!it || typeof it.percentUsed !== 'number') return undefined
  const at = it.resetsAt ? Date.parse(it.resetsAt) : NaN
  return { percent: it.percentUsed, ...(Number.isNaN(at) ? {} : { resetsAt: at }) }
}

// Номер замера: замеры могут перекрыться, и опоздавший старый не должен затереть цифры нового
let measuring = 0

export async function measure($: any): Promise<void> {
  const mine = ++measuring
  try {
    const u = await $.session.usage()
    if (mine !== measuring) return
    tokens = typeof u.context?.tokens === 'number' ? u.context.tokens : undefined
    const all: any[] = u.rateLimits ?? []
    h5 = readLimit(all, 'five_hour') ?? h5
    d7 = readLimit(all, 'seven_day') ?? d7
  } catch {
    // Замер не удался — строка остаётся с прошлыми числами
  }
  await paint($)
}

// Новая сессия или перезагрузка плагина: прежние числа — чужой сессии
export function resetStroka(): void {
  effort = ''
  tokens = undefined
  h5 = undefined
  d7 = undefined
  shown = ''
}
