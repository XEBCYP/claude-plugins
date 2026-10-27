// Пауза глобального проекта (пакет 3 аудита 27.10, ADR 0015; правило — sreda:globalnyj-proekt, «Пауза»).
//
// 25.10 после «пауза» глобальная прислала два новых окна по установке: «Я тебе уже несколько раз просил поставь на
// паузу». Теперь пауза — состояние сессии, которое держит плагин: /pauza или слова пользователя «поставь на паузу»,
// «нужно перезагрузить» включают её, /prodolzhit или «продолжай» — снимают. На паузе плагин не даёт показать новое окно
// вопроса и запустить новую сессию; рассылку паузы и «продолжай» подпроектам делает сама глобальная (SendMessage) по
// сообщению плагина. Пауза хранится в $.store под id сессии — переживает перезапуск программы, ради которого и ставится.

const K_PAUSE = 'pauza:'
const START_SESSION = 'mcp__ccd_session__start_session'

// «поставь (всех) на паузу», «нужно перезагрузить(ся)», сообщение из одного слова «пауза»
const PAUSE_WORDS = /(?:^|[^а-яё])(?:постав[а-яё]*\s+(?:\S+\s+){0,3}на\s+паузу|нужно\s+перезагрузит[а-яё]*)|^\s*пауза[\s.!]*$/i
// «продолжай», «продолжаем», «продолжить»: в начале сообщения — чтобы «не продолжай» и «продолжай после паузы
// разбор» по ошибке не снимали; снимает и «можно продолжать»
const GO_WORDS = /^\s*(?:можно\s+)?продолж(?:ай|аем|айте|ить|ать)(?![а-яё])/i
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

// Реестр подпроектов в папке сессии — это глобальная сессия; в остальных пауза словами не включается
const REGISTRY = 'docs/Подпроекты.md'

let paused = false
let key = ''
let isGlobal = false

export async function startPauza($: any): Promise<void> {
  key = K_PAUSE + String(await $.session.id())
  paused = !!(await $.store.get(key))
  const cwd = String(await $.session.cwd()).split('\\').join('/').replace(/\/+$/, '')
  isGlobal = await $.fs.read(`${cwd}/${REGISTRY}`).then((text: unknown) => String(text ?? '').length > 0, () => false)
}

export function isPaused(): boolean {
  return paused
}

async function setPaused($: any, on: boolean): Promise<void> {
  paused = on
  if (on) await $.store.set(key, { at: await $.clock.now() })
  else await $.store.delete(key)
}

const PAUSE_NOTE =
  '[Плагин sreda: пауза включена.] Разошли паузу всем подпроектам, которые сейчас работают (SendMessage: «Пауза: доведи ' +
  'текущую операцию до безопасной точки, запиши состояние и остановись; дальше — только по «продолжай»»). Затем ответь ' +
  'пользователю только строкой состояния по каждому подпроекту и «можно перегружать». Новых окон, установок и заданий — ' +
  'не начинать до «продолжай»: окна и запуск сессий плагин на паузе не пропустит. Открытые вопросы окнами не повторять — ' +
  'они ждут в панели «Ждут ответа».'

const GO_NOTE =
  '[Плагин sreda: пауза снята.] Разошли «продолжай» подпроектам, которые были поставлены на паузу, и продолжай работу; ' +
  'открытые вопросы, отложенные на паузе, задай окнами снова.'

// Команды /pauza, /prodolzhit: текст для пользователя; сообщение модели — отдельно, через $.prompt.submit
export async function pauzaCommand($: any, on: boolean): Promise<string> {
  if (on === paused) return on ? 'Пауза уже включена — снять: /prodolzhit или «продолжай».' : 'Паузы нет.'
  await setPaused($, on)
  // Из хука command.run сообщение ждало бы ход, который этот хук держит, — отправляем после него
  void $.clock.after(0, () => void $.prompt.submit({ text: on ? PAUSE_NOTE : GO_NOTE }))
  return on ? 'Пауза включена: окна вопросов и новые сессии — после /prodolzhit.' : 'Пауза снята.'
}

// Сообщение пользователя: включает или снимает паузу; само сообщение идёт как обычно, с пометкой для модели
export async function pauzaPrompt($: any, e: any): Promise<string | null> {
  if (!isGlobal || !USER_ORIGINS.has(e.origin?.kind) || e.command || e.isMeta) return null
  const text = String(e.text ?? '')
  if (paused && GO_WORDS.test(text)) {
    await setPaused($, false)
    return `${text}\n\n${GO_NOTE}`
  }
  if (!paused && PAUSE_WORDS.test(text)) {
    await setPaused($, true)
    return `${text}\n\n${PAUSE_NOTE}`
  }
  return null
}

const DENY =
  'Не выполнено (плагин sreda): глобальный проект на паузе по команде пользователя — новые окна вопросов и новые ' +
  'сессии только после «продолжай» (/prodolzhit). Ответьте строкой состояния; вопрос ждёт в панели «Ждут ответа» или ' +
  'задайте его после паузы.'

// Окно вопроса или запуск сессии на паузе — отказ
export function pauzaDeny(tool: string): { deny: string } | null {
  if (!paused) return null
  return tool === 'AskUserQuestion' || tool === START_SESSION ? { deny: DENY } : null
}
