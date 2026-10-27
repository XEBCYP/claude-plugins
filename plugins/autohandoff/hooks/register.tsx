import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Band } from '../types'

// Автопередача работы в чистый контекст (замена моду handoff).
//
// Окно поиска момента — от `from` до `to` тысяч токенов контекста (по умолчанию 150–250; в глобальной сессии
// sreda — `globalFrom`–`globalTo`, 150–200). Пороги в токенах, а не в процентах окна: цена каждого действия растёт
// с числом токенов в контексте, а процент при окне в 1 млн означает в 5 раз больше, чем при 200 тыс. Передача делается, когда
// пользователь отправляет следующее сообщение после законченной задачи: прошлый ход закончился без прерывания,
// итоговое окно приложения (wrap_up) не задало вопроса, фоновых агентов нет, и проверка по самому разговору
// ($.model.fork — без инструментов, по кэшу) ответила «ДА, можно передать без потерь». Тогда мод придерживает
// сообщение, Claude пишет документ передачи (навык autohandoff:write), мод делает /clear, отправляет «прочитай
// документ», а следом — придержанное сообщение пользователя.
//
// Пользователь может и не написать — отошёл от компьютера или сессия не на экране. Поэтому и в конце хода, без его
// сообщения, тот же удачный момент (вопрос в итоговом окне не мешает — он уйдёт в документ) даёт полосу над полем
// ввода: «через `countdown` с передам» с кнопками «Пауза» (дочитать; передача — кнопкой «Передать»), «Передать», «Отменить».
// Никто не нажал — передача. С `to` — то же в конце хода, без проверки момента; посреди хода не передаём.
// Зато с `to` посреди хода после инструмента основного цикла Claude читает напоминание: довести шаг, записать
// сделанное и закончить ход (не чаще чем через `askStep`). 25–26.10 один ход доходил до 200–330 действий, и контекст рос
// со 100 до 570 тыс.: передача ждала конца хода, а он не наступал.
// Конец хода — только там, где за сессией стоит человек: терминал (isInteractive) или приложение Claude. Сессия
// приложения стартует с isInteractive false, как -p и SDK, и отличается от них переменной CLAUDE_CODE_ENTRYPOINT.
// «Отменить» — снова не раньше +`askStep` (50 тыс., в глобальной — `globalAskStep`, 30 тыс.). Последний ответ
// с экрана пропадёт — новая сессия начнёт с его пересказа и заново задаст открытый вопрос окном.
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
  // «Отменить» на полосе: до скольких тысяч токенов полосы больше нет
  quietBelow: number
  lastTurn: LastTurn | null
  // Попытки передачи этой сессии (удачные и нет); после /clear переходят в чистую — против передач по кругу
  times: number[]
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
// Общий счётчик попыток всех сессий из версии 2.1.0 — убирается
const K_OLD_TIMES = 'times'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])
const DESKTOP_ENTRYPOINT = 'claude-desktop'
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

const IDLE_PROMPT = `Служебный вопрос мода автопередачи — это не задача, ничего не делай, только ответь.
Контекст сессии — {ctx} тыс. токенов. Ход только что закончился, пользователь пока ничего не написал (мог отойти).
Можно ли сейчас БЕЗ ПОТЕРЬ передать работу новой чистой сессии, которая получит только документ передачи
(требования, решения и их согласование, что сделано и что не проверено, изменённые файлы, открытые вопросы,
список задач)?
ДА — если задача закончена или стоит на чёткой границе шага, ничего важного не держится только в памяти разговора
и мы не ждём результатов фоновых сессий или агентов. Вопрос пользователю в конце хода не мешает: он перейдёт
в документ, и новая сессия задаст его снова.
НЕТ — во всех остальных случаях, в том числе если сомневаешься.
Ответь одним словом: ДА или НЕТ.`

const NUDGE = `Автопередача: контекст {ctx} тыс. токенов — выше порога {to} тыс., и каждое действие заново читает
весь контекст. Передать работу в чистую сессию можно только в конце хода. Доведи текущий шаг до точки, где ничего
не держится только в памяти разговора: запиши сделанное и что осталось (коммит — если в задаче так принято). Новых больших чтений и
длинных логов здесь не начинай — их отдай субагенту. Затем закончи ход коротким итогом. Шаг, который нельзя прервать
без потерь, закончи, но без лишних действий.`

const band = atom({ plugin: 'autohandoff', key: 'band' } as const, null as Band | null)

// Пороги из настроек мода, тыс. токенов; задаются в register, для глобальной сессии — в session.start
type Limits = { from: number; to: number; askStep: number }
let usual: Limits = { from: 150, to: 250, askStep: 50 }
let global: Limits = { from: 150, to: 200, askStep: 30 }
let from = usual.from
let to = usual.to
let askStep = usual.askStep
let isGlobal = false
let perHour = 2
// Секунд отсчёта на полосе
let countdown = 15

// Приложение усыпляет простаивающие диалоги и будит их новым процессом: переменные модуля пропадают,
// поэтому всё, что нужно между ходами, лежит в $.store под id диалога
let cliId = ''
let mark: Mark = freshMark()
let isChecking = false
// За сессией стоит человек (терминал или приложение): в -p и SDK конец хода не передаёт
let isPersonal = false
// Идёт ход основного цикла: проверка в конце хода, которую догнал новый ход, ничего не показывает
let isTurnRunning = false
// Проверка момента в конце хода — отдельно от проверки по сообщению: сообщения при ней не придерживаются
let isIdleChecking = false
// Полоса сейчас (то же, что в atom band) и номер отсчёта: пауза, отмена и новый отсчёт гасят старые тики
let bandNow: Band | null = null
let countGen = 0
// Сообщения, пришедшие, пока шла проверка момента: уходят за первым — в чистую сессию или в эту
let queued: string[] = []
let turnWrap: LastTurn['wrap'] = 'none'
// С какого контекста (тыс. токенов) следующее напоминание посреди хода; новый ход — с `to`
let nudgeAt = 0
// Откуда пришло последнее сообщение не от плагина — для /autohandoff status
let lastOrigin = ''

function freshMark(): Mark {
  return {
    unit: 'k', pending: null, askAt: to, isArmed: true, armBelow: from, isOff: false, checkedAt: 0, quietBelow: 0,
    lastTurn: null, times: [], at: 0,
  }
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
    if (key === K_OLD_TIMES) await $.store.delete(key)
    if (!key.startsWith(K_SESSION)) continue
    const m = (await $.store.get(key)) as Mark | undefined
    if (!m || now - (m.at ?? 0) > MARK_TTL) await $.store.delete(key)
  }
}

// Попытки передачи этой сессии за последний час, удачные и нет
async function recentTimes($: Dollar): Promise<number[]> {
  const now = await $.clock.now()
  return (mark.times ?? []).filter(t => now - t < HOUR)
}

async function noteTime($: Dollar): Promise<void> {
  mark = { ...mark, times: [...(await recentTimes($)), await $.clock.now()] }
  await save($)
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
    : '\n\nПользователь мог не прочитать последний ответ: запиши в документ итог последней задачи коротко и вопрос, который ему задан в конце (итоговое окно или окно вопроса), дословно с вариантами — если был.'
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
    mark = { ...freshMark(), isOff, isArmed: false, armBelow: Math.max(from, p.ctx - REARM_DROP), times: mark.times }
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
      await $.prompt.submit({
        text: `Прочитай ${p.path} — это документ передачи работы из прошлой сессии (автопередача по заполнению контекста; пользователь мог не видеть последний ответ). Если документ говорит, что эта сессия — подпроект глобального проекта, пользователю сама не пиши и не спрашивай: пересказ, вопросы и команды для него отправь сообщением в глобальную сессию (её id — в документе), команду — целиком. Иначе начни с короткого пересказа для пользователя: итог прошлой задачи и что сделано; если в документе есть открытый вопрос к пользователю — задай его окном AskUserQuestion. Затем продолжай работу, если она не ждёт его ответа.`,
      })
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

async function setBand($: Dollar, next: Band | null): Promise<void> {
  bandNow = next
  await update($, band, () => next)
}

// Полоса с отсчётом: никто не нажал — передача
async function startCountdown($: Dollar, ctx: number, isDue: boolean): Promise<void> {
  if (bandNow || mark.pending) return
  const gen = ++countGen
  await setBand($, { left: countdown, isPaused: false, ctx: Math.round(ctx), isDue })
  tick($, gen)
}

function tick($: Dollar, gen: number): void {
  void $.clock.after(1000, async () => {
    if (gen !== countGen || !bandNow || bandNow.isPaused) return
    if (bandNow.left > 1) {
      await setBand($, { ...bandNow, left: bandNow.left - 1 })
      tick($, gen)
    } else {
      await handoffNow($)
    }
  })
}

// «Передать» или конец отсчёта; held — сообщения пользователя, набранные при полосе
async function handoffNow($: Dollar, held: string[] = []): Promise<void> {
  const b = bandNow
  if (!b) return
  countGen += 1
  await setBand($, null)
  // Не ждём: из хука prompt.submit команда записи ждала бы ход, который этот хук держит
  if (!mark.pending && !mark.isOff) void startHandoff($, held, b.ctx)
}

async function pauseCountdown($: Dollar): Promise<void> {
  if (!bandNow) return
  countGen += 1
  await setBand($, { ...bandNow, isPaused: true })
}

// «Отменить» — снова не раньше +askStep; isQuiet — полосу убрал новый ход, это не отказ
async function cancelCountdown($: Dollar, isQuiet = false): Promise<void> {
  const b = bandNow
  if (!b) return
  countGen += 1
  await setBand($, null)
  if (isQuiet) return
  mark = { ...mark, quietBelow: b.ctx + askStep, askAt: Math.max(mark.askAt, b.ctx + askStep) }
  await save($)
}

async function isAgentBusy($: Dollar): Promise<boolean> {
  return (await $.agent.list()).some(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
}

// Конец хода основного цикла: удачный момент или верхний порог — полоса с отсчётом
async function afterTurn($: Dollar, isAborted: boolean): Promise<void> {
  if (!isPersonal || isAborted || mark.pending || mark.isOff || !mark.isArmed || bandNow || isChecking || isIdleChecking) return
  const ctx = await contextK($)
  if (ctx < from || ctx < mark.quietBelow) return
  if ((await recentTimes($)).length >= perHour || (await isAgentBusy($))) return
  const isDue = ctx >= to && ctx >= mark.askAt
  if (!isDue) {
    if (ctx < mark.checkedAt + RECHECK_STEP) return
    isIdleChecking = true
    let reply: string | null = null
    try {
      reply = await forkAnswer($, IDLE_PROMPT.replace('{ctx}', String(Math.round(ctx))))
    } catch {
      reply = null
    } finally {
      isIdleChecking = false
    }
    if (reply === null || !/^[\s*]*ДА(?![а-яё])/i.test(reply)) {
      mark = { ...mark, checkedAt: ctx }
      await save($)
      return
    }
  }
  // Пока шла проверка, пользователь написал или начался другой ход — момент уже не тот
  if (isTurnRunning || isChecking || mark.pending || bandNow) return
  await startCountdown($, ctx, isDue)
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
  // «Отменить» на полосе действует и на передачу по сообщению
  if (ctx < mark.quietBelow) return false
  if ((await recentTimes($)).length >= perHour) return false
  if (await isAgentBusy($)) return false
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
        ? `ждёт момента: ${from}–${to} тыс. токенов — в конце задачи, с ${to} тыс. — в конце хода без проверки; перед передачей отсчёт ${countdown} с`
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
  isTurnRunning = true
  nudgeAt = 0
  // Начался ход не по полосе (событие другой сессии, сообщение плагина) — отсчёт снимаем, решим в конце хода
  await cancelCountdown($, true)
  // Команда передачи стоит в очереди: первый ход основного цикла после её начала — ход записи документа
  const p = mark.pending
  if (p && !p.writeTurnId) {
    mark = { ...mark, pending: { ...p, writeTurnId: turnId } }
    await save($)
  }
}

async function noteTurnEnd($: Dollar, isAborted: boolean, turnId: string): Promise<void> {
  isTurnRunning = false
  mark = { ...mark, lastTurn: { isAborted, wrap: turnWrap } }
  await save($)
  await checkPending($, turnId)
  void afterTurn($, isAborted)
}

// Напоминание посреди хода основного цикла: с `to`, затем через каждые `askStep`; после «Отменить» — с той же высоты
async function nudgeText($: Dollar): Promise<string | null> {
  if (!isPersonal || !isTurnRunning || mark.pending || mark.isOff || !mark.isArmed) return null
  const ctx = await contextK($)
  if (ctx < to || ctx < nudgeAt || ctx < mark.quietBelow) return null
  nudgeAt = ctx + askStep
  return NUDGE.replace('{ctx}', String(Math.round(ctx))).replace('{to}', String(to))
}

async function onMeasure($: Dollar, ctx: number): Promise<void> {
  if (ctx < mark.armBelow && !mark.pending && !mark.isArmed) {
    mark = { ...mark, isArmed: true, askAt: to, checkedAt: 0, quietBelow: 0, armBelow: from }
    await save($)
  }
}

// Пользователь написал при полосе — момент уже проверен: передаём с его сообщением
async function submitDuringBand($: Dollar, text: string): Promise<string | null> {
  const b = bandNow
  if (!b) return null
  // Ответ на вопрос итогового окна — в этой же сессии; полосу снова покажет конец следующего хода
  if (!b.isDue && mark.lastTurn?.wrap === 'ask') {
    await cancelCountdown($, true)
    return null
  }
  await handoffNow($, [text])
  return `Контекст ${b.ctx} тыс. токенов: сначала Claude запишет документ передачи и очистит контекст, затем ваше сообщение уйдёт в чистую сессию само.`
}

export const register: Register = (on, options) => {
  staleKeys = []
  usual = limits(options, '', { from: 150, to: 250, askStep: 50 })
  global = limits(options, 'global', { from: 150, to: 200, askStep: 30 })
  ;({ from, to, askStep } = usual)
  perHour = num(options.perHour, 2)
  countdown = Math.max(1, Math.round(num(options.countdown, 15)))
  mark = freshMark()

  on('session.start', async ($, e, next) => {
    isPersonal = !!e.isInteractive || (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === DESKTOP_ENTRYPOINT
    await $.command.register({
      name: 'autohandoff',
      description: 'Автопередача в чистый контекст: now — передать сейчас, off/on — выключить/включить для этой сессии, status',
    })
    if (staleKeys.length) {
      $.ui.toast(
        `autohandoff: в настройках старые пороги в процентах (${staleKeys.join(', ')}) — взяты умолчания в тысячах токенов. Поправьте настройки плагина`,
        { timeoutMs: 10000 },
      )
    }
    await chooseLimits($, e.cwd ?? '')
    await loadMark($)
    // Перезагрузка плагина: atom полосы живёт дольше переменных модуля — без этого полоса висела бы с мёртвыми кнопками
    await setBand($, null)
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

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.tool === WRAP_UP || r.deny !== undefined || r.isError) return r
    const text = await nudgeText($)
    return text ? { ...r, context: [...(r.context ?? []), text] } : r
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

    // Полоса с отсчётом: сообщение с вложением или @путь не придерживаем — полосу снимаем, оно идёт как обычно
    if (bandNow) {
      if (e.attachments?.length || MENTION.test(e.text)) {
        await cancelCountdown($, true)
        return next(e)
      }
      const reason = await submitDuringBand($, e.text)
      return reason === null ? next(e) : { drop: reason }
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (!b || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const text = b.isPaused
      ? `Передача в чистый контекст на паузе (контекст ${b.ctx} тыс. токенов). Дочитайте и нажмите «Передать».`
      : `Контекст ${b.ctx} тыс. токенов, задача закончена: через ${b.left} с передам работу в чистый контекст.`
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text>{text}</Text>
        {b.isPaused ? null : (
          <Button key="pause" variant="primary" onPress={() => void pauseCountdown($)}>
            Пауза
          </Button>
        )}
        <Button key="go" variant={b.isPaused ? 'primary' : 'secondary'} onPress={() => void handoffNow($)}>
          Передать
        </Button>
        <Button key="cancel" variant="secondary" onPress={() => void cancelCountdown($)}>
          Отменить
        </Button>
      </Box>
    )
  })
}
