import type { Hook, Register } from 'claude-code'

// Автопередача работы в чистый контекст (замена моду handoff).
//
// Окно поиска момента — от `from` до `to` тысяч токенов контекста (по умолчанию 150–250; в глобальной сессии
// sreda — `globalFrom`–`globalTo`, 150–200). Пороги в токенах, а не в процентах окна: цена каждого действия растёт
// с числом токенов в контексте, а процент при окне в 1 млн означает в 5 раз больше, чем при 200 тыс. Передача делается, когда
// пользователь отправляет следующее сообщение после законченной задачи: прошлый ход закончился без прерывания,
// итоговое окно приложения (wrap_up) не задало вопроса, фоновых агентов нет, и проверка по самому разговору
// ($.model.fork — без инструментов, по кэшу) ответила «ДА, можно передать без потерь». Тогда мод придерживает
// сообщение, Claude пишет документ передачи (навык autohandoff:write), мод делает /clear, отправляет «прочитай
// документ», а следом — придержанное сообщение пользователя. Ответ прошлой задачи пропадает с экрана только после
// того, как пользователь его прочитал и написал новое.
//
// С `to` — вопрос кнопкой «Передать?», как у handoff, даже посреди задачи; «Не сейчас» — снова через +`askStep`
// (50 тыс., в глобальной — `globalAskStep`, 30 тыс.).
// /autohandoff now | off | on | status.

type Dollar = Parameters<Hook<'session.start'>>[0]

type Pending = {
  path: string
  startedAt: number
  // Ход, который пишет документ: первый ход основного цикла после начала передачи
  writeTurnId: string | null
  // Сообщения пользователя, которые уйдут в чистую сессию после документа
  held: string[]
  // Контекст в начале передачи, тыс. токенов: от него считается, когда снова включаться в чистой сессии
  ctx: number
}

type LastTurn = {
  isAborted: boolean
  // Итоговое окно приложения в этом ходе: не было, без вопроса, с вопросом пользователю
  wrap: 'none' | 'clean' | 'ask'
}

// Что мод помнит о диалоге в $.store — переживает сон диалога и перезапуск процесса
type Mark = {
  // Единица порогов в отметке; отметка без неё — из версии с процентами, её не берём
  unit: 'k'
  pending: Pending | null
  askAt: number
  isArmed: boolean
  // Ниже скольких тысяч токенов контекста мод снова включается после передачи
  armBelow: number
  isOff: boolean
  // Контекст (тыс. токенов), на котором проверка момента ответила «нет»: следующая — не раньше +RECHECK_STEP
  checkedAt: number
  lastTurn: LastTurn | null
  at: number
}

const WAIT_MS = 15 * 60_000
const FORK_MS = 30_000
const MARK_TTL = 30 * 24 * 60 * 60_000
// Тыс. токенов
const RECHECK_STEP = 20
// Чистая сессия, которая началась выше `from` (большой CLAUDE.md, длинный документ), включается снова,
// когда контекст опустится на столько тысяч токенов ниже, чем был при передаче
const REARM_DROP = 50
// Глобальная сессия sreda — та, в папке которой лежит реестр подпроектов
const GLOBAL_MARKER = 'docs/Подпроекты.md'
const HOUR = 60 * 60_000
const K_SESSION = 's:'
const K_TIMES = 'times'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])
// Упоминание файла (@путь): при повторной отправке оно не раскрывается — такое сообщение не придерживаем
const MENTION = /(^|\s)@[^\s@]/

const CHECK_PROMPT = `Служебный вопрос мода автопередачи — это не задача, ничего не делай, только ответь.
Контекст сессии — {ctx} тыс. токенов. Пользователь только что написал новое сообщение (ниже, между <<< и >>>).
Можно ли сейчас БЕЗ ПОТЕРЬ передать работу новой чистой сессии, которая получит только документ передачи
(требования, решения и их согласование, что сделано и что не проверено, изменённые файлы, открытые вопросы,
список задач) и это сообщение?
ДА — если прошлая задача закончена или стоит на чёткой границе шага, ничего важного не держится только в памяти
разговора, мы не ждём результатов фоновых сессий или агентов, и новое сообщение не опирается на дословные детали
последних ответов, которых не будет в документе.
НЕТ — во всех остальных случаях, в том числе если сомневаешься.
Ответь одним словом: ДА или НЕТ.

<<<
{text}
>>>`

// Пороги из настроек мода, тыс. токенов; задаются в register, для глобальной сессии — в session.start
type Limits = { from: number; to: number; askStep: number }
let usual: Limits = { from: 150, to: 250, askStep: 50 }
let global: Limits = { from: 150, to: 200, askStep: 30 }
let from = usual.from
let to = usual.to
let askStep = usual.askStep
let isGlobal = false
let perHour = 2

// Приложение усыпляет простаивающие диалоги и будит их новым процессом: переменные модуля пропадают,
// поэтому всё, что нужно между ходами, лежит в $.store под id диалога
let cliId = ''
let mark: Mark = freshMark()
let isAsking = false
let isChecking = false
// Сообщения, пришедшие, пока шла проверка момента: уходят за первым — в чистую сессию или в эту
let queued: string[] = []
let turnWrap: LastTurn['wrap'] = 'none'
// Откуда пришло последнее сообщение не от плагина — для /autohandoff status
let lastOrigin = ''

function freshMark(): Mark {
  return { unit: 'k', pending: null, askAt: to, isArmed: true, armBelow: from, isOff: false, checkedAt: 0, lastTurn: null, at: 0 }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function save($: Dollar): Promise<void> {
  if (!cliId) return
  mark = { ...mark, at: await $.clock.now() }
  await $.store.set(K_SESSION + cliId, mark)
}

async function pruneMarks($: Dollar, now: number): Promise<void> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(K_SESSION)) continue
    const m = (await $.store.get(key)) as Mark | undefined
    if (!m || now - (m.at ?? 0) > MARK_TTL) await $.store.delete(key)
  }
}

// Попытки передачи за последний час — во всех диалогах вместе, удачные и нет
async function recentTimes($: Dollar): Promise<number[]> {
  const now = await $.clock.now()
  const times = ((await $.store.get(K_TIMES)) as number[] | undefined) ?? []
  return times.filter(t => now - t < HOUR)
}

async function noteTime($: Dollar): Promise<void> {
  const times = await recentTimes($)
  await $.store.set(K_TIMES, [...times, await $.clock.now()])
}

// Контекст в тысячах токенов
async function contextK($: Dollar): Promise<number> {
  const { context } = await $.session.usage()
  return (context.tokens ?? 0) / 1000
}

// Пороги меньше 100 — проценты окна из версии 1.x (from 30, to 50): в тысячах токенов они дали бы вопрос
// почти в каждой сессии. Такие пороги не берутся — берутся умолчания, при старте сессии — предупреждение.
const STALE_BELOW = 100
let staleKeys: string[] = []

function limits(raw: Record<string, unknown>, prefix: string, fallback: Limits): Limits {
  const key = (name: string) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name)
  let f = num(raw[key('from')], fallback.from)
  let t = num(raw[key('to')], fallback.to)
  if (f < STALE_BELOW || t < STALE_BELOW) {
    staleKeys.push(`${key('from')}/${key('to')} = ${f}/${t}`)
    f = fallback.from
    t = fallback.to
  }
  return { from: f, to: Math.max(t, f), askStep: num(raw[key('askStep')], fallback.askStep) }
}

async function chooseLimits($: Dollar, cwd: string): Promise<void> {
  const marker = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${GLOBAL_MARKER}`
  isGlobal = !!cwd && (await $.fs.stat(marker).then(s => s.kind === 'file', () => false))
  ;({ from, to, askStep } = isGlobal ? global : usual)
}

async function resubmit($: Dollar, texts: string[]): Promise<void> {
  for (const text of texts) await $.prompt.submit({ text, asUser: true })
}

// Куда Claude запишет документ: ~/.claude/handoffs/, вне проекта
async function handoffPath($: Dollar): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const d = new Date(await $.clock.now())
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  return `${home.replace(/\\/g, '/')}/.claude/handoffs/autohandoff-${stamp}.md`
}

// Шаг 1: Claude пишет документ передачи; шаг 2 — в turn.complete хода записи
async function startHandoff($: Dollar, held: string[], ctx: number): Promise<void> {
  if (mark.pending) return
  const path = await handoffPath($)
  mark = { ...mark, isArmed: false, pending: { path, startedAt: await $.clock.now(), writeTurnId: null, held, ctx } }
  await save($)
  await noteTime($)
  // Если ход записи так и не начался, отмена по времени не должна ждать следующего хода
  void $.clock.after(WAIT_MS + 1000, () => void checkPending($, null))
  const next = held.length
    ? `\n\nСледующая сессия начнёт с этого сообщения пользователя — построй документ под него, но сейчас его НЕ выполняй:\n<<<\n${held.join('\n\n')}\n>>>`
    : ''
  try {
    await $.command.run({ command: 'autohandoff:write', args: `Сохрани документ в файл ${path}.${next}` })
  } catch (err: any) {
    await cancelHandoff($, `Команда передачи не запустилась: ${String(err?.message ?? err).slice(0, 80)}`)
  }
}

// Передача не удалась: придержанные сообщения не теряем — отправляем их в эту же сессию
async function cancelHandoff($: Dollar, why: string): Promise<void> {
  const p = mark.pending
  if (!p) return
  mark = { ...mark, pending: null, isArmed: true }
  await save($)
  $.ui.toast(`${why} (${p.path}) — передача отменена`)
  await resubmit($, p.held)
}

// Документ записан в этой передаче — не старый файл с тем же именем и не до её начала
async function isWritten($: Dollar, p: Pending): Promise<boolean> {
  const stat = await $.fs.stat(p.path).catch(() => undefined)
  return stat !== undefined && stat.mtimeMs >= p.startedAt - 2000
}

// Шаг 2: документ записан — чистый контекст, документ, затем придержанные сообщения пользователя
async function continueFresh($: Dollar, p: Pending): Promise<void> {
  const isOff = mark.isOff
  mark = { ...mark, pending: null }
  await save($)
  let sent = 0
  try {
    await $.command.run({ command: 'clear' })
    // После /clear у диалога может смениться id: отметка — с нуля; включится снова, когда контекст спадёт
    cliId = await $.session.id()
    mark = { ...freshMark(), isOff, isArmed: false, armBelow: Math.max(from, p.ctx - REARM_DROP) }
    await save($)
    if (p.held.length) {
      await $.prompt.submit({
        text: `Прочитай ${p.path} — это документ передачи работы из прошлой сессии (автопередача по заполнению контекста). Сейчас ничего не делай и ответь одной строкой, что прочитал: следующее сообщение пользователя придёт сразу за этим.`,
      })
      for (const text of p.held) {
        await $.prompt.submit({ text, asUser: true })
        sent += 1
      }
    } else {
      await $.prompt.submit({ text: `Прочитай ${p.path} и продолжай работу` })
    }
  } catch (err: any) {
    $.ui.toast(`Передача не дошла до конца: ${String(err?.message ?? err).slice(0, 80)}. Документ — ${p.path}`)
    // Неотправленные сообщения пользователя — туда, где сессия сейчас (чистая или прежняя)
    await resubmit($, p.held.slice(sent)).catch(() => undefined)
  }
}

// Документ появился — продолжаем; ход записи кончился без документа или вышло время — отменяем
async function checkPending($: Dollar, endedTurnId: string | null): Promise<void> {
  const p = mark.pending
  if (!p) return
  if (await isWritten($, p)) {
    void continueFresh($, p)
    return
  }
  if (endedTurnId && p.writeTurnId === endedTurnId) {
    await cancelHandoff($, 'Документ передачи не записан')
  } else if ((await $.clock.now()) - p.startedAt > WAIT_MS) {
    await cancelHandoff($, 'Документ передачи не дождались')
  }
}

// С порога `to` — вопрос кнопкой, как у handoff
async function offerHandoff($: Dollar, ctx: number): Promise<void> {
  if (isAsking || mark.pending || !mark.isArmed || mark.isOff) return
  // Диалог, который никто не видит (фоновая сессия): вопрос повис бы навсегда
  if ((await $.session.surfaces()).length === 0) return
  isAsking = true
  try {
    const answer = await $.ui.ask(`Контекст ${Math.round(ctx)} тыс. токенов. Передать работу в чистый контекст?`, {
      header: 'Контекст',
      options: ['Передать', 'Не сейчас'],
    })
    // Пока вопрос висел, передача могла пройти сама: тогда ответ уже ни к чему
    if (answer === 'Передать' && mark.isArmed && !mark.pending) await startHandoff($, [], ctx)
    else if (answer !== 'Передать') mark = { ...mark, askAt: Math.round(ctx) + askStep }
  } catch {
    mark = { ...mark, askAt: Math.round(ctx) + askStep }
  } finally {
    isAsking = false
    await save($)
  }
}

// $.model.fork без своего предела времени: не дольше FORK_MS, иначе — «не сейчас»
async function forkAnswer($: Dollar, prompt: string): Promise<string | null> {
  const timeout = new Promise<null>(resolve => void $.clock.after(FORK_MS, () => resolve(null)))
  const reply = await Promise.race([$.model.fork({ prompt }), timeout])
  return reply && reply.isAnswered ? reply.text : null
}

// Удачный ли момент: дешёвые признаки, затем один вопрос по самому разговору
async function isGoodMoment($: Dollar, ctx: number, text: string): Promise<boolean> {
  const last = mark.lastTurn
  if (!last || last.isAborted || last.wrap === 'ask') return false
  if (ctx < mark.checkedAt + RECHECK_STEP) return false
  if ((await recentTimes($)).length >= perHour) return false
  const busy = (await $.agent.list()).some(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
  if (busy) return false
  const prompt = CHECK_PROMPT.replace('{ctx}', String(Math.round(ctx))).replace('{text}', () => text)
  const reply = await forkAnswer($, prompt)
  const isYes = reply !== null && /^[\s*]*ДА(?![а-яё])/i.test(reply)
  if (!isYes) {
    mark = { ...mark, checkedAt: ctx }
    await save($)
  }
  return isYes
}

async function commandText($: Dollar, raw: string): Promise<string> {
  const arg = raw.trim().toLowerCase()
  if (arg === 'now') {
    if (mark.pending) return `Передача уже идёт: ${mark.pending.path}`
    void startHandoff($, [], await contextK($))
    return 'Claude пишет документ передачи; после — чистый контекст и продолжение'
  }
  if (arg === 'off' || arg === 'on') {
    mark = { ...mark, isOff: arg === 'off' }
    await save($)
    return arg === 'off' ? 'Автопередача в этой сессии выключена' : 'Автопередача в этой сессии включена'
  }
  const ctx = Math.round(await contextK($))
  const state = mark.isOff
    ? 'выключена (/autohandoff on)'
    : mark.pending
      ? `идёт передача: ${mark.pending.path}`
      : mark.isArmed
        ? `ждёт момента: ${from}–${to} тыс. токенов — в конце задачи, с ${to} тыс. — вопрос`
        : `ждёт, пока контекст опустится ниже ${mark.armBelow} тыс. токенов`
  const times = (await recentTimes($)).length
  const origin = lastOrigin ? ` Последнее сообщение пользователя пришло как «${lastOrigin}».` : ''
  const wraps = { none: 'не было', clean: 'было, без вопроса', ask: 'было, с вопросом' }
  const last = mark.lastTurn
  const turn = last ? ` Прошлый ход: ${last.isAborted ? 'прерван' : 'закончен'}, итоговое окно — ${wraps[last.wrap]}.` : ''
  const kind = isGlobal ? ' Сессия глобального проекта — свои пороги.' : ''
  return `Контекст ${ctx} тыс. токенов.${kind} Автопередача ${state}. Попыток за час: ${times} из ${perHour}.${origin}${turn}`
}

// Удачный момент — начать передачу с этим сообщением и пришедшими во время проверки; иначе — null
async function tryHandoff($: Dollar, text: string): Promise<string | null> {
  const ctx = await contextK($)
  if (ctx < from) return null
  isChecking = true
  let isGood = false
  try {
    isGood = await isGoodMoment($, ctx, text)
  } catch {
    isGood = false
  } finally {
    isChecking = false
  }
  const extra = queued
  queued = []
  if (!isGood) {
    // Пришедшие во время проверки — следом за этим, в эту же сессию
    if (extra.length) void resubmit($, extra)
    return null
  }
  void startHandoff($, [text, ...extra], ctx)
  $.ui.toast(`Контекст ${Math.round(ctx)} тыс. токенов: задача закончена — передаю работу в чистый контекст`)
  return `Контекст ${Math.round(ctx)} тыс. токенов, задача закончена: сначала Claude запишет документ передачи и очистит контекст, затем ваше сообщение уйдёт в чистую сессию само. Выключить автопередачу для этой сессии — /autohandoff off.`
}

async function holdDuringHandoff($: Dollar, text: string): Promise<string> {
  const p = mark.pending
  if (p) {
    mark = { ...mark, pending: { ...p, held: [...p.held, text] } }
    await save($)
  }
  return 'Идёт передача в чистый контекст — это сообщение уйдёт туда сразу после документа передачи.'
}

async function loadMark($: Dollar): Promise<void> {
  cliId = await $.session.id()
  const saved = (await $.store.get(K_SESSION + cliId)) as Mark | undefined
  mark = saved && saved.unit === 'k' ? { ...freshMark(), ...saved } : freshMark()
  void pruneMarks($, await $.clock.now())
  // Процесс перезапустился посреди передачи: документ мог успеть записаться
  if (mark.pending) void $.clock.after(2_000, () => void checkPending($, null))
}

async function noteTurnStart($: Dollar, turnId: string): Promise<void> {
  turnWrap = 'none'
  // Команда передачи стоит в очереди: первый ход основного цикла после её начала — ход записи документа
  const p = mark.pending
  if (p && !p.writeTurnId) {
    mark = { ...mark, pending: { ...p, writeTurnId: turnId } }
    await save($)
  }
}

async function noteTurnEnd($: Dollar, isAborted: boolean, turnId: string): Promise<void> {
  mark = { ...mark, lastTurn: { isAborted, wrap: turnWrap } }
  await save($)
  await checkPending($, turnId)
}

async function onMeasure($: Dollar, ctx: number): Promise<void> {
  if (ctx < mark.armBelow && !mark.pending && !mark.isArmed) {
    mark = { ...mark, isArmed: true, askAt: to, checkedAt: 0, armBelow: from }
    await save($)
  }
  if (ctx >= to && ctx >= mark.askAt) void offerHandoff($, ctx)
}

export const register: Register = (on, options) => {
  staleKeys = []
  usual = limits(options, '', { from: 150, to: 250, askStep: 50 })
  global = limits(options, 'global', { from: 150, to: 200, askStep: 30 })
  ;({ from, to, askStep } = usual)
  perHour = num(options.perHour, 2)
  mark = freshMark()

  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      await $.command.register({
        name: 'autohandoff',
        description: 'Автопередача в чистый контекст: now — передать сейчас, off/on — выключить/включить для этой сессии, status',
      })
    }
    if (staleKeys.length && e.isInteractive) {
      $.ui.toast(
        `autohandoff: в настройках старые пороги в процентах (${staleKeys.join(', ')}) — взяты умолчания в тысячах токенов. Поправьте настройки плагина`,
        { timeoutMs: 10000 },
      )
    }
    await chooseLimits($, e.cwd ?? '')
    await loadMark($)
    return next(e)
  })

  on('command.run', { command: 'autohandoff' }, async ($, e) => ({ text: await commandText($, e.args) }))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await noteTurnStart($, e.turnId)
    return next(e)
  })

  on('tool.call', { tool: WRAP_UP }, async ($, e, next) => {
    if (!e.agentId) {
      const ask = (e as Record<string, unknown>).ask
      turnWrap = typeof ask === 'string' && ask.trim() ? 'ask' : 'clean'
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await noteTurnEnd($, e.isAborted, e.turnId)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') lastOrigin = e.origin.kind
    const isUser = USER_ORIGINS.has(e.origin.kind) && !e.command && !e.isMeta
    if (!isUser) return next(e)

    // Передача идёт: сообщение уйдёт в чистую сессию вслед за документом; картинки так не переслать — просим позже
    if (mark.pending) {
      if (e.attachments?.length) {
        return { drop: 'Идёт передача в чистый контекст — сообщение с вложением отправьте, когда она закончится.' }
      }
      return { drop: await holdDuringHandoff($, e.text) }
    }
    // Идёт проверка момента по прошлому сообщению: это — за ним следом, в ту же сессию, что и оно
    if (isChecking && !e.attachments?.length) {
      queued = [...queued, e.text]
      return { drop: 'Сообщение принято и уйдёт следом за предыдущим.' }
    }

    // Не придерживаем: выключено, ждёт спада контекста, набрано посреди хода, вложения, упоминания файлов
    if (mark.isOff || !mark.isArmed || isChecking || e.turnId || e.attachments?.length || MENTION.test(e.text)) {
      return next(e)
    }
    const reason = await tryHandoff($, e.text)
    return reason === null ? next(e) : { drop: reason }
  })

  on('session.measure', async ($, e, next) => {
    await onMeasure($, (e.context?.tokens ?? 0) / 1000)
    return next(e)
  })
}
