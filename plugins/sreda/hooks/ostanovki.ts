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
//
// Оборванный ход (31.10.2026, требования — docs/requirements/2026-10-31-obryv-hoda.md). Приложение выгружает процесс
// сессии при нехватке памяти («CliGovernor pressure evicting», ожидание фонового агента для него — простой), и ход
// пропадает молча. Отметка такой сессии остаётся «ход идёт»: при новом запуске сессия сама получает «доделай начатое»,
// а пока она стоит — другие сессии через STALE_MS дают карточку «ход оборван». Перезагрузка плагина в том же процессе
// (session.start снова, ход или ожидание фоновой задачи идут) — не обрыв: процесс помечен в $.state, который живёт, пока
// жив процесс. Обрыв помнится в отметке (поле cut), пока не начнётся ход: сообщение не дошло или пришло на паузе — не
// пропадёт.

// Задержка — окно 31.10: «3 минуты (рекомендую)»; по 934 ответам пользователя 56 % приходят раньше — карточки нет
export const DELAY_MS = 3 * 60_000
export const TICK_MS = 60_000
export const STALE_MS = 10 * 60_000
// Отметки старше суток — давно закрытые сессии, карточек о них не даём
export const CUT_MAX_MS = 24 * 60 * 60_000
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
  // Карточка о чужой оборванной сессии: одна на обрыв, session — её id
  postCut: (n: Notice & { session: string }) => Promise<void>
}

const norm = (path: string) => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()

let hooks: Hooks | undefined
let me = ''
let cwd = ''
// Папка для отметки: как есть, только косые прямые — проект в карточке с его заглавными буквами
let shown = ''
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
// Прошлый процесс этой сессии выгружен посреди хода: время его последней отметки; держится до начала хода
let cutAt: number | null = null
// «Доделай начатое» этим процессом уже отправлено
let cutSent = false
const PROC = { plugin: 'sreda', key: 'ostanovki' } as const

async function home($: any): Promise<string> {
  const dir = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${String(dir).split('\\').join('/')}/.claude`
}

async function mark($: any): Promise<void> {
  if (!me) return
  const at = await $.clock.now()
  // Ждёт свою фоновую работу — для глобальной тоже «работает»: проснётся сама
  const it = { cwd: shown, title, busy: busy || wakesItself, at, ...(cutAt !== null ? { cut: cutAt } : {}) }
  await $.fs.write(`${await home($)}/${DIR}/${me}.json`, JSON.stringify(it))
}

export async function startOstanovki($: any, h: Hooks): Promise<void> {
  hooks = h
  me = String(await $.session.id())
  const raw = String(await $.session.cwd())
  cwd = norm(raw)
  shown = raw.split('\\').join('/').replace(/\/+$/, '')
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
  // Тот же процесс (перезагрузка плагина) — отметка «ход идёт» его собственная, не обрыв
  let proc: { id?: string; sent?: boolean } | undefined
  try {
    proc = (await $.state.get(PROC)).value
  } catch {}
  const same = proc?.id === me
  cutSent = same && proc?.sent === true
  // До своей первой отметки: прошлая отметка «ход идёт» — прошлый процесс выгружен посреди хода; cut — обрыв, после
  // которого хода ещё не было
  cutAt = null
  try {
    const was = JSON.parse(String(await $.fs.read(`${await home($)}/${DIR}/${me}.json`)))
    if (typeof was?.cut === 'number') cutAt = was.cut
    else if (was?.busy === true && !same) cutAt = typeof was.at === 'number' ? was.at : 0
  } catch {}
  await $.state.set(PROC, { id: me, sent: cutSent }).catch(() => undefined)
  await mark($).catch(() => undefined)
  $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
}

export const CUT_NOTE =
  '[Плагин sreda: прошлый ход этой сессии оборван.] Приложение выгрузило процесс посреди хода (нехватка памяти или ' +
  'перезапуск), ход закрыт без ответа, начатое не доделано. Посмотри конец своей переписки — план, последние вызовы, ' +
  'отчёты фоновых агентов и сообщения подпроектов — и доделай начатое. Начатого не было — ответь одной строкой.'

// Обрыв есть, а «доделай начатое» этим процессом ещё не отправлено
export function ostCutDue(): boolean {
  return cutAt !== null && !cutSent
}

export async function ostCutSent($: any): Promise<void> {
  cutSent = true
  await $.state.set(PROC, { id: me, sent: true }).catch(() => undefined)
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
  // Ход на паузе (сообщение ещё не отправлено) обрыв не снимает: «доделай» уйдёт после «продолжай»
  if (cutSent) cutAt = null
  stoppedAt = null
  recap = ''
  wakesItself = false
  await mark($).catch(() => undefined)
  // Всегда, а не по флагу posted: после перезапуска программы флаг пуст, а карточка в файле осталась
  posted = false
  await hooks?.unpost()
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

// Чужие оборванные сессии: отметка «ход идёт» не обновлялась дольше STALE_MS (идущий ход отмечается раз в минуту).
// Смотрят все сессии, и подпроекты: открыты только глобальная и её подпроекты, выгружена глобальная — иначе карточки нет
async function cutOthers($: any, now: number): Promise<void> {
  if (!hooks) return
  const dir = `${await home($)}/${DIR}`
  let entries: { name: string; mtimeMs?: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const one of entries) {
    if (!one.name.endsWith('.json') || one.name === `${me}.json`) continue
    let it: { cwd?: string; title?: string; busy?: boolean; at?: number }
    try {
      it = JSON.parse(String(await $.fs.read(`${dir}/${one.name}`)))
    } catch {
      continue
    }
    if (it.busy !== true || typeof it.at !== 'number') continue
    const age = now - it.at
    if (age <= STALE_MS || age > CUT_MAX_MS) continue
    const sid = one.name.slice(0, -'.json'.length)
    const raw = String(it.cwd ?? '')
    const from = raw.split('/').filter(Boolean).pop() || raw
    const at = new Date(it.at)
    await hooks.postCut({
      id: `obryv-${sid}-${it.at}`,
      session: sid,
      from,
      question: `${it.title ? `Сессия «${it.title}»` : 'Сессия'} оборвана посреди хода`,
      why:
        `Последняя отметка хода — ${two(at.getHours())}:${two(at.getMinutes())}: приложение выгрузило сессию (нехватка ` +
        'памяти) или она закрыта. Откройте её — sreda сама попросит доделать начатое.',
    })
  }
}

async function tick($: any): Promise<void> {
  await cutOthers($, await $.clock.now()).catch(() => undefined)
  if (busy || wakesItself) return void (await mark($))
  if (stoppedAt === null || posted || !hooks) return
  const now = await $.clock.now()
  if (now - stoppedAt < DELAY_MS) return
  if (await hooks.hasOpen()) return
  const isGlobal = subPaths.length > 0
  // Ошибка глобальной — сразу: подпроекты без неё не продвинутся
  if (isGlobal && !failed && (await subprojectsBusy($, now))) return
  const at = new Date(stoppedAt)
  const name = isGlobal
    ? title ? `Глобальная сессия «${title}»` : 'Глобальная сессия'
    : title ? `Сессия «${title}»` : 'Сессия'
  const question = failed
    ? `${name} остановилась с ошибкой`
    : isGlobal
      ? `${name} и все подпроекты остановились`
      : `${name} завершила работу и ждёт`
  const said = recap || answer
  const why = `Остановилась в ${two(at.getHours())}:${two(at.getMinutes())}.${said ? ` Итог: ${brief(said)}` : ''}`
  posted = true
  await hooks.post({ id: `ost-${me}-${stoppedAt}`, from: project, question, why })
}
