// Сессия закончила работу и стоит (31.10.2026, ADR 0026; требования — docs/requirements/2026-10-31-ostanovki-sessij.md).
//
// Пользователь: «мне приходится бегать по своим проектам, по сессиям и смотреть, чтобы они не простаивали». Сессия
// проекта или глобальная закончила ход и стоит 3 минуты без вопроса к пользователю — в панели «Ждут ответа» карточка с
// кнопкой «Ок». Сообщение в эту сессию (любой новый ход) убирает карточку само. Сессии подпроектов карточек не создают:
// они сообщают глобальной, а та даёт карточку, только когда стоит сама и стоят все её подпроекты из реестра.
//
// Чтобы глобальная знала, работают ли подпроекты, каждая сессия держит отметку ~/.claude/sreda-sessii/<id>.json
// (папка, идёт ли ход, когда отмечена); идущий ход отмечается раз в минуту. Отметка без обновления дольше STALE_MS —
// сессия закрыта посреди хода и считается стоящей.

// Задержка — окно 31.10: «3 минуты (рекомендую)»; по 934 ответам пользователя 56 % приходят раньше — карточки нет
export const DELAY_MS = 3 * 60_000
export const TICK_MS = 60_000
export const STALE_MS = 10 * 60_000
const DIR = 'sreda-sessii'
const REGISTRY = 'docs/Подпроекты.md'
const WHERE = /\*\*Где:\*\*\s*`([^`]+)`/g
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const BRIEF = 300

export type Notice = { id: string; from: string; question: string; why: string }
type Hooks = {
  isSub: boolean
  post: (n: Notice) => Promise<void>
  unpost: () => Promise<void>
  // Вопрос этой сессии ждёт в панели — карточка не нужна: сессия и так ждёт ответа
  hasOpen: () => Promise<boolean>
}

const norm = (path: string) => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()

let hooks: Hooks | undefined
let me = ''
let cwd = ''
let project = ''
let subPaths: string[] = []
let busy = false
let stoppedAt: number | null = null
let failed = false
let answer = ''
let recap = ''
let title = ''
// Сессия сама проснётся (фоновая задача, таймер /loop, ScheduleWakeup) — она не стоит
let wakesItself = false
let posted = false

async function home($: any): Promise<string> {
  const dir = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${String(dir).split('\\').join('/')}/.claude`
}

async function mark($: any): Promise<void> {
  if (!me) return
  const at = await $.clock.now()
  await $.fs.write(`${await home($)}/${DIR}/${me}.json`, JSON.stringify({ cwd, busy, at }))
}

export async function startOstanovki($: any, h: Hooks): Promise<void> {
  hooks = h
  me = String(await $.session.id())
  const raw = String(await $.session.cwd())
  cwd = norm(raw)
  project = raw.split('\\').join('/').split('/').filter(Boolean).pop() || raw
  subPaths = []
  try {
    const text = String((await $.fs.read(`${raw.split('\\').join('/').replace(/\/+$/, '')}/${REGISTRY}`)) ?? '')
    for (const m of text.matchAll(WHERE)) subPaths.push(norm(m[1]))
  } catch {}
  busy = false
  stoppedAt = null
  posted = false
  wakesItself = false
  await mark($).catch(() => undefined)
  $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
}

// Название сессии — из полей хуков приложения (classic.SessionStart, classic.UserPromptSubmit)
export function ostTitle(e: any): void {
  const t = String(e?.session_title ?? '').trim()
  if (t) title = t
}

// Итог хода — из wrap_up (recap: что сделано и где стоит)
export function ostTool(tool: string, e: any): void {
  if (tool === WRAP_UP && typeof e?.recap === 'string') recap = e.recap.trim()
}

export function ostStop(e: any): void {
  const tasks = Array.isArray(e?.background_tasks) ? e.background_tasks.length : 0
  const crons = Array.isArray(e?.session_crons) ? e.session_crons.length : 0
  wakesItself = tasks + crons > 0
}

export async function ostTurnStart($: any): Promise<void> {
  busy = true
  stoppedAt = null
  recap = ''
  wakesItself = false
  await mark($).catch(() => undefined)
  if (posted) {
    posted = false
    await hooks?.unpost()
  }
}

export async function ostTurnComplete($: any, e: any): Promise<void> {
  busy = false
  await mark($).catch(() => undefined)
  // Прерванный пользователем ход — он и так в этой сессии
  if (hooks?.isSub || e.isAborted || e.reason === 'aborted') return
  stoppedAt = await $.clock.now()
  failed = e.reason === 'error' || e.reason === 'refusal'
  answer = String(e.answer ?? '').trim()
}

// Работает ли хоть один подпроект глобальной: свежая отметка с идущим ходом в папке из реестра
async function subprojectsBusy($: any, now: number): Promise<boolean> {
  if (subPaths.length === 0) return false
  const dir = `${await home($)}/${DIR}`
  let entries: { name: string; mtimeMs?: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return false
  }
  for (const one of entries) {
    if (!one.name.endsWith('.json') || one.name === `${me}.json`) continue
    // Старые отметки не читаем: такая сессия заведомо не работает
    if (typeof one.mtimeMs === 'number' && one.mtimeMs > 0 && now - one.mtimeMs > STALE_MS) continue
    let it: { cwd?: string; busy?: boolean; at?: number }
    try {
      it = JSON.parse(String(await $.fs.read(`${dir}/${one.name}`)))
    } catch {
      continue
    }
    if (!it.busy || typeof it.at !== 'number' || now - it.at > STALE_MS) continue
    const where = norm(String(it.cwd ?? ''))
    if (subPaths.some(p => where === p || where.startsWith(`${p}/`))) return true
  }
  return false
}

const brief = (text: string) => (text.length > BRIEF ? `${text.slice(0, BRIEF - 1)}…` : text)
const two = (n: number) => String(n).padStart(2, '0')

async function tick($: any): Promise<void> {
  if (busy) return void (await mark($))
  if (stoppedAt === null || posted || !hooks) return
  const now = await $.clock.now()
  if (now - stoppedAt < DELAY_MS || wakesItself) return
  if (await hooks.hasOpen()) return
  const isGlobal = subPaths.length > 0
  if (isGlobal && (await subprojectsBusy($, now))) return
  const at = new Date(stoppedAt)
  const name = title ? `Сессия «${title}»` : 'Сессия'
  const question = isGlobal
    ? `${title ? `Глобальная сессия «${title}»` : 'Глобальная сессия'} и все подпроекты остановились`
    : failed
      ? `${name} остановилась с ошибкой`
      : `${name} завершила работу и ждёт`
  const said = recap || answer
  const why = `Остановилась в ${two(at.getHours())}:${two(at.getMinutes())}.${said ? ` Итог: ${brief(said)}` : ''}`
  posted = true
  await hooks.post({ id: `ost-${me}-${stoppedAt}`, from: project, question, why })
}
