import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Option, Pending } from '../types'
import { MEASURE_MS, measure, resetStroka } from './stroka'
import { registerUroven, startUroven, urovenCall, urovenCommand } from './uroven'

// Панель «Ждут ответа» (плагин sreda): вопросы пользователю из ~/.claude/zhdut-otveta.json, с кнопками. Вопрос
// окна AskUserQuestion попадает в панель сам; ответ в окне сразу уносит его в архив, кнопка панели сразу отвечает
// на открытое окно — своей сессии или чужой (та узнаёт из файла при опросе). Отвеченный вопрос — в
// zhdut-otveta-arhiv.json: рабочий файл каждая сессия читает целиком, с отвеченными он рос до ~15 тыс. токенов.
const PANE = 'zhdut-otveta'
const NAME = 'zhdut-otveta.json'
const ARCHIVE = 'zhdut-otveta-arhiv.json'
// Опрос файла: так быстро кнопка другой сессии доходит до окна этой
const POLL_MS = 1500
const items = atom({ plugin: 'sreda', key: 'items' } as const, [] as Pending[])
// Отмеченные флажки вопросов с несколькими ответами: их нажатие должно перерисовать панель — поэтому atom
const picks = atom({ plugin: 'sreda', key: 'picked' } as const, {} as Record<string, string[]>)

// Ответ: один вариант (или свой текст) — строка; несколько отмеченных — список (окно в приложении отдаёт и так)
type Answer = string | string[]
const asText = (answer: Answer) => (Array.isArray(answer) ? answer.join(', ') : answer)

// Открытые окна этой сессии: id вопроса → ответить окну. Переменные модуля живут до перезагрузки плагина.
const waiting = new Map<string, (answer: Answer) => void>()
// Открытые вопросы этой сессии при прошлом опросе — чтобы заметить, что их ответили в другой сессии
let mineOpen = new Set<string>()
let me = ''
// Что панель показывает сейчас (JSON списка) — опрос перерисовывает её, только когда файл изменился
let lastShown = ''
// Вопросы, которые эта сессия уже видела: новый снова открывает панель, закрытую крестиком (26.10 пользователь закрыл
// её в глобальной сессии, и новые вопросы туда больше не показывались). undefined — первый опрос ещё не прошёл.
let seen: Set<string> | undefined
// Сессия подпроекта: панель сама не открывается — вопросы пользователю задаёт глобальная, и в подпроекте та же общая
// панель только дублировала их (sreda:globalnyj-proekt). Вручную — /zhdut-otveta.
let quiet = false

// Подпроект — папка, которую реестр глобального проекта (docs/Подпроекты.md в соседней папке) называет в строке
// «**Где:** `путь`». Строке в CLAUDE.md не доверяем: у части подпроектов её нет.
const REGISTRY = 'docs/Подпроекты.md'
const WHERE = /\*\*Где:\*\*\s*`([^`]+)`/g
const norm = (path: string) => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()

async function subproject($: any): Promise<boolean> {
  const cwd = norm(String(await $.session.cwd()))
  const cut = cwd.lastIndexOf('/')
  if (cut <= 0) return false
  const parent = cwd.slice(0, cut)
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(parent)
  } catch {
    return false
  }
  for (const one of entries) {
    if (one.kind !== 'dir' || norm(`${parent}/${one.name}`) === cwd) continue
    let text = ''
    try {
      text = await $.fs.read(`${parent}/${one.name}/${REGISTRY}`)
    } catch {
      continue
    }
    for (const m of String(text).matchAll(WHERE)) {
      const where = norm(m[1])
      if (cwd === where || cwd.startsWith(`${where}/`)) return true
    }
  }
  return false
}

async function showPane($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Ждут ответа' })
}

// Новый вопрос в файле — открыть панель, если её закрыли (открытую — не трогать: open перехватил бы вкладку)
async function reveal($: any, list: Pending[]): Promise<void> {
  const fresh = list.filter(one => !seen?.has(one.id))
  const first = seen === undefined
  seen = new Set(list.map(one => one.id))
  if (first || quiet || fresh.length === 0) return
  if ((await $.ui.panes()).some((pane: { id: string }) => pane.id === PANE)) return
  await showPane($)
}

// Файлы общие для всех сессий этого компьютера — в папке пользователя.
async function file($: any, name = NAME): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${String(home).split('\\').join('/')}/.claude/${name}`
}

async function load($: any, name = NAME): Promise<Pending[]> {
  try {
    const parsed = JSON.parse(await $.fs.read(await file($, name)))
    return Array.isArray(parsed?.items) ? parsed.items : []
  } catch {
    return []
  }
}

async function save($: any, list: Pending[], name = NAME): Promise<void> {
  await $.fs.write(await file($, name), JSON.stringify({ items: list }, null, 2))
}

async function self($: any): Promise<string> {
  if (!me) me = await $.session.id()
  return me
}

// Убрать вопрос из рабочего файла в архив с ответом; false — его там уже нет (ответили в другом месте).
async function archive($: any, id: string, answer: Answer): Promise<boolean> {
  const list = await load($)
  const it = list.find(one => one.id === id)
  if (!it) return false
  await update($, picks, all => {
    const { [id]: _, ...rest } = all
    return rest
  })
  const done: Pending = {
    ...it,
    status: 'answered',
    answer: asText(answer),
    ...(Array.isArray(answer) ? { picked: answer } : {}),
    answeredAt: new Date().toISOString(),
    answeredIn: await self($),
  }
  await save($, [...(await load($, ARCHIVE)), done], ARCHIVE)
  const rest = list.filter(one => one.id !== id)
  await save($, rest)
  await update($, items, () => rest)
  return true
}

async function refresh($: any): Promise<void> {
  const list = await load($)
  // Перерисовка — только когда список изменился: лишняя мешает набирать свой ответ
  const shown = JSON.stringify(list)
  if (shown !== lastShown) {
    lastShown = shown
    await update($, items, () => list)
  }
  await reveal($, list)
  // Отметки вопросов, которых в файле больше нет (ответили в другой сессии), — убрать
  const marked = await read($, picks)
  if (Object.keys(marked).some(id => !list.some(one => one.id === id))) {
    await update($, picks, all => Object.fromEntries(Object.entries(all).filter(([id]) => list.some(one => one.id === id))))
  }
  const mine = await self($)
  const now = new Set(list.filter(one => one.session === mine).map(one => one.id))
  const gone = [...mineOpen].filter(id => !now.has(id))
  mineOpen = now
  if (gone.length === 0) return
  // Наш вопрос ушёл из файла: ответили кнопкой в другой сессии — ответить окну или прислать ответ сообщением
  const done = await load($, ARCHIVE)
  for (const id of gone) {
    const it = done.find(one => one.id === id)
    if (!it?.answer || it.answeredIn === mine) continue
    const reply = waiting.get(id)
    if (reply) reply(it.picked ?? it.answer)
    else if (it.answeredIn) tell($, it, it.picked ?? it.answer)
  }
}

// Ответ кнопкой на вопрос этой сессии, окна которого уже нет. Пока идёт ход, сообщение встало бы в очередь приложения
// «после хода»: Claude его не видит и по «Не отвечено» задаёт вопрос снова — пользователь отвечает дважды. Поэтому
// ответ ждёт здесь: повтор вопроса окном сразу получает его без окна, а не спрошенный повтором — приходит после хода.
// Текст вопроса → откуда и ответ.
const later = new Map<string, { from: string; answer: Answer }>()
let busy = false

function tell($: any, it: Pending, answer: Answer): void {
  if (busy) {
    later.set(it.question, { from: it.from, answer })
    return
  }
  void $.prompt.submit({ text: `Ответ на вопрос «${it.question}» (${it.from}): ${asText(answer)}`, asUser: true })
}

function flush($: any): void {
  for (const [question, { from, answer }] of later) {
    void $.prompt.submit({ text: `Ответ на вопрос «${question}» (${from}): ${asText(answer)}`, asUser: true })
  }
  later.clear()
}

async function press($: any, it: Pending, answer: Answer): Promise<void> {
  if (!(await archive($, it.id, answer))) return
  const reply = waiting.get(it.id)
  if (reply) return reply(answer)
  // Окно в другой сессии — она ответит ему сама при опросе файла
  if (it.session && it.session !== (await self($))) return
  tell($, it, answer)
}

// Claude сам файл панели не пишет: вопрос, записанный вручную, а потом заданный окном чуть другими словами, вставал в
// панель дважды. Сессии со старыми правилами (CLAUDE.md проекта, навык до 1.2.0) так и делали. Чтение не трогаем.
const WRITES = /Set-Content|Add-Content|Out-File|WriteAll|\.Write\(|Copy-Item|Move-Item|Remove-Item|New-Item|Delete\(|\btee\b|sed\s+-i|\b(cp|mv|rm)\s/i
const REDIRECT = /[^-2]>>?\s*['"]?[^\s'"]*zhdut-otveta/i
let answeredTool = 'mcp__sreda__otvecheno'

function writesPane(tool: string, e: any): boolean {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') return /zhdut-otveta/i.test(String(e.file_path ?? ''))
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(e.command ?? '')
    return /zhdut-otveta/i.test(cmd) && (WRITES.test(cmd) || REDIRECT.test(cmd))
  }
  return false
}

// Пользователь ответил текстом, не нажав кнопку: найти открытый вопрос по тексту (целиком или частью) и в архив.
async function answered($: any, question: string, answer: string): Promise<string> {
  const list = await load($)
  const exact = list.filter(one => one.question === question)
  const found = exact.length > 0 ? exact : list.filter(one => one.question.includes(question))
  if (found.length !== 1) {
    const open = list.map(one => `- ${one.question}`).join('\n') || '(пусто)'
    return `${found.length === 0 ? 'Такого вопроса в панели нет' : 'Подходит несколько вопросов — укажите точнее'}. Открытые:\n${open}`
  }
  await archive($, found[0].id, answer)
  return `Вопрос «${found[0].question}» перенесён в архив с ответом «${answer}».`
}

// Набранный в панели свой ответ: id вопроса → текст
const drafts = new Map<string, string>()

function ownAnswer($: any, it: Pending, value: string): void {
  if (!value.trim()) return
  drafts.delete(it.id)
  void press($, it, value.trim())
}

// Флажок вопроса с несколькими ответами: нажатие только ставит или снимает отметку
async function toggle($: any, it: Pending, label: string): Promise<void> {
  await update($, picks, all => {
    const now = all[it.id] ?? []
    const next = now.includes(label) ? now.filter(one => one !== label) : [...now, label]
    return { ...all, [it.id]: next }
  })
}

// «Ответить» в вопросе с несколькими ответами: отмеченные в порядке вариантов и свой текст последним
async function sendPicked($: any, it: Pending, own: string): Promise<void> {
  const marked = (await read($, picks))[it.id] ?? []
  const answer = it.options.map(o => o.label).filter(label => marked.includes(label))
  if (own.trim()) answer.push(own.trim())
  if (answer.length === 0) return
  drafts.delete(it.id)
  await press($, it, answer)
}

type Question = {
  question: string
  header?: string
  multiSelect?: boolean
  options?: { label: string; description?: string; preview?: string }[]
}

// Команда для пользователя — первый блок ```powershell (или другого языка оболочки) в тексте вопроса, затем в preview
// вариантов (правило kak-rabotat, раздел 3). Блок другого языка — пример кода или макет, не команда.
const FENCE = /```(?:powershell|pwsh|ps1?|cmd|bat|bash|sh|shell|console)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i
function fencedOf(q: Question): string | undefined {
  for (const text of [q.question, ...(q.options ?? []).map(o => o.preview ?? '')]) {
    const found = FENCE.exec(text)?.[1]?.trim()
    if (found) return found
  }
  return undefined
}
// Команда без рамки — строка preview, которая начинается как запуск: 26.10 глобальная сессия положила команду
// подпроекта в preview строкой «powershell -ExecutionPolicy …», и панель показала вопрос без команды
// Только запуск с ключом или скриптом: строка «PowerShell (администратор) …» или «powershell откроется сам» — не команда
const BARE = /^[ \t]*((?:powershell|pwsh)(?:\.exe)?[ \t]+-\S.*|&[ \t]*["'][^"']+\.(?:ps1|cmd|bat|exe)["'].*|\.\\\S+\.(?:ps1|cmd|bat|exe)\b.*|cmd(?:\.exe)?[ \t]+\/[ck][ \t].+)$/m
function commandOf(q: Question): string | undefined {
  const fenced = fencedOf(q)
  if (fenced) return fenced
  for (const o of q.options ?? []) {
    const found = BARE.exec(o.preview ?? '')?.[1]?.trim()
    if (found) return found
  }
  return undefined
}

// Окно «запустил / не запустил» без команды в рамке: пользователю нечего копировать ни в чате, ни в панели. Такое
// окно не показываем, а возвращаем Claude с правилом (sreda:kak-rabotat, раздел 3)
// Подпись, которая начинается с «запустил»: «Не запустил», «Сервер запустился», «Перезапустил службу» — не то окно
const RAN = /^[ \t]*(?:запустил[аи]?(?![а-яё])|выполнил[аи]? команду|ran it\b|I ran\b)/i
function missingCommand(questions: Question[]): string | undefined {
  const q = questions.find(one => (one.options ?? []).some(o => RAN.test(o.label)) && !fencedOf(one))
  if (!q) return undefined
  return (
    `Окно не показано: в вопросе «${q.question.slice(0, 80)}» есть вариант «запустил», но нет команды, которую ` +
    'пользователь скопирует. В preview рекомендуемого варианта положите строку «где запускать» (компьютер; обычный ' +
    'PowerShell или администратор) и команду блоком ```powershell: по нему плагин покажет команду над вариантами окна ' +
    'и в панели «Ждут ответа». Текст посреди хода пользователь видит пересказом, без блоков, — команду ещё раз дайте ' +
    'блоком в последнем сообщении хода. Команду подпроекта, если её нет целиком, сначала возьмите у подпроекта. Затем ' +
    'задайте окно снова.'
  )
}

// Команды окна для рисунка над вариантами (ui.render AskUserQuestion): preview виден лишь на выбранном варианте, а текст
// Claude посреди хода приложение показывает пересказом, без блоков кода (26.10: sreda 1.5.5–1.5.6 искали команду в чате
// этого хода и отказывали каждому окну). Поэтому команду рисует сам плагин — по вопросам с вариантом «Запустил».
function commandsOf(questions: Question[]): string[] {
  const found = questions
    .filter(one => (one.options ?? []).some(o => RAN.test(o.label)))
    .map(fencedOf)
    .filter((one): one is string => !!one)
  return [...new Set(found)]
}

// Пользователь отправил сообщение, не ответив: приложение закрывает окно и вместо ответа даёт заглушку «[User did not
// answer this question — they sent a message instead. Treat that message as their response; do not re-ask.]». Это не
// ответ: вопрос остаётся в панели, а Claude получает вместо заглушки notAnswered — задать вопрос снова в конце хода.
const SKIPPED = /did not answer this question|sent a message instead/i
const isSkipped = (answer: Answer | undefined) =>
  answer !== undefined && SKIPPED.test(Array.isArray(answer) ? answer.join(' ') : answer)
function notAnswered(tool: string): string {
  return (
    '[Не отвечено: пользователь отправил сообщение, не нажав кнопку окна. Вопрос остаётся в панели «Ждут ответа». ' +
    'Если его сообщение явно отвечает на этот вопрос или отказывается отвечать («не сейчас», «не отвечу»), — ' +
    `инструмент ${tool} с этим ответом. Иначе сообщение — новое задание, а не ответ: выполните его, а в конце хода ` +
    'задайте этот вопрос окном AskUserQuestion снова, теми же словами: если пользователь тем временем ответил в ' +
    'панели, окно не покажется, а сразу вернёт этот ответ.]'
  )
}

async function markMissed($: any, ids: string[]): Promise<void> {
  const list = await load($)
  const when = new Date().toISOString()
  let changed = false
  for (const it of list) {
    if (ids.includes(it.id)) {
      it.missed = when
      changed = true
    }
  }
  if (!changed) return
  await save($, list)
  await update($, items, () => list)
}


// Вопросы окна — в панель. Тот же открытый вопрос, записанный раньше вручную, не дублируется, а становится нашим.
// hold(ids) — до записи в файл: кнопка панели не должна застать вопрос, окно которого ещё не ждёт ответа.
async function enlist($: any, questions: Question[], callId: string, hold: (ids: string[]) => void): Promise<string[]> {
  const mine = await self($)
  const cwd = String(await $.session.cwd()).split('\\').join('/')
  const project = cwd.split('/').filter(Boolean).pop() || cwd
  const list = await load($)
  const ids = questions.map((q, k) => {
    const same = list.find(one => one.question === q.question)
    if (same) {
      same.session = mine
      // Окно снова открыто — пометка «окно закрылось без ответа» больше не верна
      delete same.missed
      // Вид вопроса — по окну, а не по прежней записи: флажки и команда появляются и у такого вопроса
      if (q.multiSelect) same.multi = true
      else delete same.multi
      const command = commandOf(q)
      if (command) same.command = command
      return same.id
    }
    const options: Option[] = (q.options ?? []).map(o => ({
      label: o.label,
      ...(o.description ? { desc: o.description } : {}),
    }))
    const id = `${callId}-${k}`
    const command = commandOf(q)
    list.push({
      id,
      from: q.header ? `${project} · ${q.header}` : project,
      question: q.question,
      options,
      ...(q.multiSelect ? { multi: true as const } : {}),
      ...(command ? { command } : {}),
      status: 'open',
      asked: new Date().toISOString().slice(0, 10),
      session: mine,
    })
    return id
  })
  hold(ids)
  await save($, list)
  await update($, items, () => list)
  ids.forEach(id => mineOpen.add(id))
  return ids
}

export const register: Register = on => {
  // Ход сессии идёт — ответы кнопкой на вопросы без окна ждут его конца (tell). Начало хода — один хук на модуль, он
  // в uroven.ts
  registerUroven(on, () => (busy = true))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zhdut-otveta', description: 'Открыть панель «Ждут ответа»' })
    await $.command.register({
      name: 'uroven',
      description: 'Уровень усилий в этом проекте: ручной — ставите сами, авто — выбирает «Среда»',
      argumentHint: 'ручной | авто',
      immediate: true,
    })
    const reg = await $.tool.register({
      name: 'otvecheno',
      description:
        'Панель «Ждут ответа»: пользователь ответил на вопрос текстом в чате, не нажав кнопку окна, — перенести вопрос ' +
        'из панели в архив с этим ответом. question — текст вопроса окна (целиком или узнаваемая часть), answer — ответ ' +
        'пользователя коротко. Файлы панели вручную не писать.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' }, answer: { type: 'string' } },
        required: ['question', 'answer'],
      },
      isDeferred: true,
    })
    answeredTool = reg.tool
    resetStroka()
    await startUroven($)
    quiet = await subproject($)
    seen = undefined
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    void measure($)
    $.clock.every(MEASURE_MS, () => void measure($))
    if (!quiet) void showPane($)
    return next(e)
  })

  // Конец хода: не спрошенные повтором ответы из панели — сообщениями; строка под полем ввода — новые токены и лимиты
  on('turn.complete', async ($, e, next) => {
    // Ход агента — не ответ сессии: цифры переписки от него не меняются
    if (e.agentId === undefined) {
      busy = false
      flush($)
      void measure($)
    }
    return next(e)
  })
  on('session.measure', async ($, e, next) => {
    void measure($)
    return next(e)
  })

  on('command.run', { command: 'zhdut-otveta' }, async $ => {
    await refresh($)
    await showPane($)
    return { text: 'Панель «Ждут ответа» открыта.' }
  })
  on('command.run', { command: 'uroven' }, async ($, e) => ({ text: await urovenCommand($, String(e.args ?? '')) }))

  // Имя инструмента движок даёт при регистрации — сверяем с ним, а не с догадкой
  on('tool.call', async ($, e: any, next) => {
    // Уровень усилий: свой инструмент и рамки модели у агентов и подпроектов (hooks/uroven.ts)
    const level = urovenCall($, e, next)
    if (level) return level
    if (e.tool === answeredTool) {
      return { result: await answered($, String(e.question ?? ''), String(e.answer ?? '')) } as never
    }
    if (next.origin.plugin !== 'engine' || !writesPane(e.tool, e)) return next(e)
    return {
      deny:
        'Файл панели «Ждут ответа» пишет сам плагин sreda: задайте вопрос окном AskUserQuestion — в панель он попадёт ' +
        `сам, без дубля. Пользователь ответил текстом, не нажав кнопку, — инструмент ${answeredTool}.`,
    }
  })

  // Окно вопроса Claude: ждём, кто ответит первым — окно или кнопка панели. Вопросы других плагинов не трогаем.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const all = e.questions as Question[]
    // До разбора ответов из панели: отказ не трогает later, и исправленный повтор окна получит их как обычно
    const noCommand = missingCommand(all)
    if (noCommand) return { deny: noCommand }
    // Повтор вопроса, на который пользователь уже ответил кнопкой панели, пока шёл ход: ответ сразу, без окна и без
    // новой записи в панели; в окне — только остальные вопросы
    const known: Record<string, Answer> = {}
    const took = new Map<string, { from: string; answer: Answer }>()
    for (const q of all) {
      const got = later.get(q.question)
      if (!got) continue
      known[q.question] = asText(got.answer)
      took.set(q.question, got)
      later.delete(q.question)
    }
    const questions = all.filter(q => known[q.question] === undefined)
    if (questions.length === 0) return { result: { questions: e.questions, answers: known } } as never
    const ask = questions.length === all.length ? e : { ...e, questions }
    let delivered = false
    const answers: Record<string, Answer> = {}
    let done = (_: Record<string, Answer>) => {}
    const fromPane = new Promise<Record<string, Answer>>(resolve => (done = resolve))
    const ids = await enlist($, questions, e.tool_use_id, held =>
      held.forEach((id, k) =>
        waiting.set(id, answer => {
          waiting.delete(id)
          // Окну — строкой, как в схеме ответа AskUserQuestion: несколько вариантов через запятую
          answers[questions[k].question] = asText(answer)
          if (Object.keys(answers).length === questions.length) done(answers)
        }),
      ),
    )

    try {
      const dialog = next(ask).then(r => ({ dialog: r }))
      // Окно закрыто ответом из панели — его поздний отказ уже никому не нужен
      dialog.catch(() => {})
      const won = await Promise.race([dialog, fromPane.then(a => ({ pane: a }))])
      if ('pane' in won) {
        delivered = true
        return { result: { questions: e.questions, answers: { ...known, ...won.pane } } } as never
      }

      const r = won.dialog
      const got = r.deny === undefined && !r.isError
        ? ((r.result as { answers?: Record<string, Answer> })?.answers ?? {})
        : {}
      const missed: string[] = []
      const told: Record<string, Answer> = { ...got }
      for (const [k, id] of ids.entries()) {
        const q = questions[k].question
        const answer = got[q]
        if (!isSkipped(answer)) {
          if (answer && answer.length > 0) await archive($, id, answer)
          continue
        }
        // Часть вопросов успели ответить кнопкой панели (она уже унесла их в архив) — это ответ, а не пропуск
        if (answers[q] !== undefined) told[q] = answers[q]
        else {
          missed.push(id)
          told[q] = notAnswered(answeredTool)
        }
      }
      const mixed = Object.keys(known).length > 0 && r.deny === undefined && !r.isError
      if (!mixed && Object.keys(got).every(q => told[q] === got[q])) return r
      if (missed.length > 0) await markMissed($, missed)
      delivered = true
      // Свой { result } без ref ядра: с ref ядро взяло бы свой текст результата — с заглушкой «do not re-ask» и без
      // ответов, взятых из панели
      return {
        result: { ...(r.result as object), questions: e.questions, answers: { ...known, ...told } },
        ...(r.context ? { context: r.context } : {}),
      } as never
    } finally {
      ids.forEach(id => waiting.delete(id))
      // Взятые из панели ответы не дошли до Claude (окно отклонено, ход прерван) — не терять: сообщением после хода
      if (!delivered && took.size > 0) {
        took.forEach((one, q) => later.set(q, one))
        if (!busy) flush($)
      }
    }
  })

  // Команда над вариантами окна, какой вариант ни выбран: блок кода с копированием. Дерево вокруг окна — узел движка
  // ровно один раз; лишнее по строкам (12 в терминале, 48 в приложении) движок отклонит и нарисует своё окно
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const commands = commandsOf((e.props.questions ?? []) as Question[])
    if (commands.length === 0) return next(e)
    const { Box, Text, Code } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{commands.length === 1 ? 'Команда:' : 'Команды:'}</Text>
        {commands.map((command, k) => (
          <Code key={`cmd-${k}`} source={command} language="powershell" />
        ))}
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Code } = $.ui.resolve(e)
    const open = (await read($, items)).filter(one => one.status !== 'answered')
    const marked = await read($, picks)
    const ticked = (it: Pending) => marked[it.id] ?? []

    return (
      <Box flexDirection="column" gap={1}>
        {open.length === 0 && <Text dimColor>Все вопросы отвечены.</Text>}
        {open.map(it => (
          <Box key={it.id} flexDirection="column" gap={1} borderStyle="round" padding={1}>
            <Text dimColor>{it.from}</Text>
            <Text bold>{it.question}</Text>
            {it.missed ? (
              <Text color="warning">Окно в сессии закрылось вашим сообщением, ответа не было — вопрос ждёт здесь.</Text>
            ) : null}
            {it.why ? <Text>{it.why}</Text> : null}
            {/* Своя кнопка «Скопировать команду» под блоком убрана (26.10, пользователь: лишняя) — у блока кода есть свой
                значок «Копировать код» */}
            {it.command ? <Code source={it.command} language="powershell" /> : null}
            {it.multi ? <Text dimColor>Можно выбрать несколько: отметьте и нажмите «Ответить».</Text> : null}
            {it.options.map((opt, k) => (
              <Box key={`${it.id}-${k}`} flexDirection="column">
                {it.multi ? (
                  <Button
                    key={`${it.id}:${k}`}
                    variant={ticked(it).includes(opt.label) ? 'primary' : 'secondary'}
                    onPress={() => void toggle($, it, opt.label)}
                  >
                    {`${ticked(it).includes(opt.label) ? '☑' : '☐'} ${opt.label}`}
                  </Button>
                ) : (
                  <Button
                    key={`${it.id}:${k}`}
                    variant={k === 0 ? 'primary' : 'secondary'}
                    onPress={() => void press($, it, opt.label)}
                  >
                    {opt.label}
                  </Button>
                )}
                {opt.desc ? <Text dimColor>{opt.desc}</Text> : null}
              </Box>
            ))}
            {/* Свой ответ, как «Other» в окне: уходит туда же, куда и кнопка. Набранное держим в drafts — опрос
                файла перерисовывает панель, и без value поле теряло текст и прыгало в начало */}
            <Box flexDirection="row" gap={1} alignItems="flex-end">
              <Box flexGrow={1} flexDirection="column">
                <Input
                  key={`${it.id}:own`}
                  placeholder={it.multi ? 'Свой вариант (добавится к отмеченным)…' : 'Свой ответ…'}
                  rows={3}
                  value={drafts.get(it.id) ?? ''}
                  onInput={value => void drafts.set(it.id, value)}
                  onSubmit={value => (it.multi ? void sendPicked($, it, value) : ownAnswer($, it, value))}
                />
              </Box>
              <Button
                key={`${it.id}:send`}
                variant={ticked(it).length > 0 ? 'primary' : 'secondary'}
                onPress={() =>
                  it.multi ? void sendPicked($, it, drafts.get(it.id) ?? '') : ownAnswer($, it, drafts.get(it.id) ?? '')
                }
              >
                {ticked(it).length > 0 ? `Ответить: выбрано ${ticked(it).length}` : 'Ответить'}
              </Button>
            </Box>
            <Text dimColor>Или ответьте в окне вопроса в чате — отсюда вопрос уйдёт сам.</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
