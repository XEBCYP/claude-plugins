// Пауза глобального проекта (пакет 3 аудита 27.10, ADR 0015; правило — sreda:globalnyj-proekt, «Пауза»).
//
// 25.10 после «пауза» глобальная прислала два новых окна по установке: «Я тебе уже несколько раз просил поставь на
// паузу». Теперь пауза — состояние сессии, которое держит плагин: /pauza или слова пользователя «поставь на паузу»,
// «нужно перезагрузить» включают её, /prodolzhit или «продолжай» — снимают. На паузе плагин не даёт показать новое окно
// вопроса и запустить новую сессию; рассылку паузы и «продолжай» подпроектам делает сама глобальная (SendMessage) по
// сообщению плагина. Пауза хранится в $.store по папке глобального проекта, а не по id сессии: переживает перезапуск
// программы, ради которого и ставится, и передачу в чистую сессию (после /clear id сессии может смениться). Пауза — только
// в глобальной сессии (в её папке — docs/Подпроекты.md); в других /pauza отвечает подсказкой.

import { ownText } from './tekst'

const K_PAUSE = 'pauza:'
const START_SESSION = 'mcp__ccd_session__start_session'

// «поставь (всех) на паузу», «нужно перезагрузить(ся)», сообщение из одного слова «пауза»
const PAUSE_WORDS = /(?:^|[^а-яё])(?:постав[а-яё]*\s+(?:\S+\s+){0,3}на\s+паузу|нужно\s+перезагрузит[а-яё]*)|^\s*пауза[\s.!]*$/i
// «продолжай», «продолжаем», «продолжить»: в начале сообщения — чтобы «не продолжай» по ошибке не снимал; снимает и
// «можно продолжать», «сними паузу». Голосом сообщение часто начинается со слова-связки («Да, продолжай», «Хорошо,
// давай продолжим») — до трёх таких слов перед ним не мешают
const GO_LEAD = String.raw`(?:(?:да|хорошо|ладно|ок|окей|ok|всё|все|так|ну|теперь|давай|итак)[\s,.!—–-]+){0,3}`
const GO_WORDS = new RegExp(
  String.raw`^\s*${GO_LEAD}(?:(?:можно\s+)?продолж(?:ай|аем|айте|ить|ать|им)|(?:сними|снимай|снимаем|снять)\s+паузу)(?![а-яё])`,
  'i',
)
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

// Реестр подпроектов в папке сессии — это глобальная сессия; в остальных пауза словами не включается
const REGISTRY = 'docs/Подпроекты.md'

let paused = false
let key = ''
let isGlobal = false

export async function startPauza($: any): Promise<void> {
  const cwd = String(await $.session.cwd()).split('\\').join('/').replace(/\/+$/, '')
  isGlobal = await $.fs.read(`${cwd}/${REGISTRY}`).then((text: unknown) => String(text ?? '').length > 0, () => false)
  key = K_PAUSE + cwd.toLowerCase()
  paused = isGlobal && !!(await $.store.get(key))
}

export function isPaused(): boolean {
  return paused
}

// Пауза для других сессий (подпроектов) — файлом: его каждая сессия читает заново, а $.store процесс мог прочитать раньше
const FLAG = 'sreda-pauza.json'

async function flagPath($: any): Promise<string> {
  const dir = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${String(dir).split('\\').join('/')}/.claude/${FLAG}`
}

// Пауза любой глобальной: подпроект на паузе глобальной тоже ждёт «продолжай»
export async function pausedAnywhere($: any): Promise<boolean> {
  if (paused) return true
  try {
    return typeof JSON.parse(String(await $.fs.read(await flagPath($))))?.at === 'number'
  } catch {
    return false
  }
}

async function setPaused($: any, on: boolean): Promise<void> {
  paused = on
  const at = await $.clock.now()
  if (on) await $.store.set(key, { at })
  else await $.store.delete(key)
  const flag = await flagPath($).catch(() => '')
  if (flag) await $.fs.write(flag, JSON.stringify(on ? { at, cwd: key.slice(K_PAUSE.length) } : {})).catch(() => undefined)
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

const NOT_GLOBAL =
  'Пауза — команда глобальной сессии (в её папке — docs/Подпроекты.md): там она останавливает окна и запуск сессий и ' +
  'рассылается подпроектам. Здесь пауза не включена — поставьте её в глобальной сессии.'

// Команды /pauza, /prodolzhit: текст для пользователя; сообщение модели — отдельно, через $.prompt.submit
export async function pauzaCommand($: any, on: boolean): Promise<string> {
  if (!isGlobal) return NOT_GLOBAL
  if (on === paused) return on ? 'Пауза уже включена — снять: /prodolzhit или «продолжай».' : 'Паузы нет.'
  await setPaused($, on)
  // Из хука command.run сообщение ждало бы ход, который этот хук держит, — отправляем после него
  void $.clock.after(0, () => void $.prompt.submit({ text: on ? PAUSE_NOTE : GO_NOTE }))
  return on ? 'Пауза включена: окна вопросов и новые сессии — после /prodolzhit.' : 'Пауза снята.'
}

// Сообщение пользователя: включает или снимает паузу; само сообщение идёт как обычно, пометка для модели — рядом
// (context), не в его тексте
export async function pauzaPrompt($: any, e: any): Promise<string | null> {
  if (!isGlobal || !USER_ORIGINS.has(e.origin?.kind) || e.command || e.isMeta) return null
  const text = ownText(String(e.text ?? ''))
  if (paused && GO_WORDS.test(text)) {
    await setPaused($, false)
    return GO_NOTE
  }
  if (!paused && PAUSE_WORDS.test(text)) {
    await setPaused($, true)
    return PAUSE_NOTE
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
