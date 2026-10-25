import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Option, Pending } from '../types'
import { registerUroven, startUroven, urovenCall } from './uroven'

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

// Открытые окна этой сессии: id вопроса → ответить окну. Переменные модуля живут до перезагрузки плагина.
const waiting = new Map<string, (label: string) => void>()
// Открытые вопросы этой сессии при прошлом опросе — чтобы заметить, что их ответили в другой сессии
let mineOpen = new Set<string>()
let me = ''
// Что панель показывает сейчас (JSON списка) — опрос перерисовывает её, только когда файл изменился
let lastShown = ''

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
async function archive($: any, id: string, label: string): Promise<boolean> {
  const list = await load($)
  const it = list.find(one => one.id === id)
  if (!it) return false
  const done: Pending = {
    ...it,
    status: 'answered',
    answer: label,
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
    if (reply) reply(it.answer)
    else if (it.answeredIn) {
      void $.prompt.submit({ text: `Ответ на вопрос «${it.question}» (${it.from}): ${it.answer}`, asUser: true })
    }
  }
}

async function press($: any, it: Pending, label: string): Promise<void> {
  if (!(await archive($, it.id, label))) return
  const reply = waiting.get(it.id)
  if (reply) return reply(label)
  // Окно в другой сессии — она ответит ему сама при опросе файла
  if (it.session && it.session !== (await self($))) return
  void $.prompt.submit({ text: `Ответ на вопрос «${it.question}» (${it.from}): ${label}`, asUser: true })
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

type Question = { question: string; header?: string; options?: { label: string; description?: string }[] }

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
      return same.id
    }
    const options: Option[] = (q.options ?? []).map(o => ({
      label: o.label,
      ...(o.description ? { desc: o.description } : {}),
    }))
    const id = `${callId}-${k}`
    list.push({
      id,
      from: q.header ? `${project} · ${q.header}` : project,
      question: q.question,
      options,
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
  registerUroven(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zhdut-otveta', description: 'Открыть панель «Ждут ответа»' })
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
    await startUroven($)
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: 'Ждут ответа' })
    return next(e)
  })

  on('command.run', { command: 'zhdut-otveta' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Ждут ответа' })
    return { text: 'Панель «Ждут ответа» открыта.' }
  })

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
    const questions = e.questions as Question[]
    const answers: Record<string, string> = {}
    let done = (_: Record<string, string>) => {}
    const fromPane = new Promise<Record<string, string>>(resolve => (done = resolve))
    const ids = await enlist($, questions, e.tool_use_id, held =>
      held.forEach((id, k) =>
        waiting.set(id, label => {
          waiting.delete(id)
          answers[questions[k].question] = label
          if (Object.keys(answers).length === questions.length) done(answers)
        }),
      ),
    )

    try {
      const dialog = next(e).then(r => ({ dialog: r }))
      // Окно закрыто ответом из панели — его поздний отказ уже никому не нужен
      dialog.catch(() => {})
      const won = await Promise.race([dialog, fromPane.then(a => ({ pane: a }))])
      if ('pane' in won) return { result: { questions: e.questions, answers: won.pane } } as never

      const r = won.dialog
      const got = r.deny === undefined && !r.isError
        ? ((r.result as { answers?: Record<string, string> })?.answers ?? {})
        : {}
      for (const [k, id] of ids.entries()) {
        const label = got[questions[k].question]
        if (label) await archive($, id, label)
      }
      return r
    } finally {
      ids.forEach(id => waiting.delete(id))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const open = (await read($, items)).filter(one => one.status !== 'answered')

    return (
      <Box flexDirection="column" gap={1}>
        {open.length === 0 && <Text dimColor>Все вопросы отвечены.</Text>}
        {open.map(it => (
          <Box key={it.id} flexDirection="column" gap={1} borderStyle="round" padding={1}>
            <Text dimColor>{it.from}</Text>
            <Text bold>{it.question}</Text>
            {it.why ? <Text>{it.why}</Text> : null}
            {it.options.map((opt, k) => (
              <Box key={`${it.id}-${k}`} flexDirection="column">
                <Button
                  key={`${it.id}:${k}`}
                  variant={k === 0 ? 'primary' : 'secondary'}
                  onPress={() => void press($, it, opt.label)}
                >
                  {opt.label}
                </Button>
                {opt.desc ? <Text dimColor>{opt.desc}</Text> : null}
              </Box>
            ))}
            {/* Свой ответ, как «Other» в окне: уходит туда же, куда и кнопка. Набранное держим в drafts — опрос
                файла перерисовывает панель, и без value поле теряло текст и прыгало в начало */}
            <Box flexDirection="row" gap={1} alignItems="flex-end">
              <Box flexGrow={1} flexDirection="column">
                <Input
                  key={`${it.id}:own`}
                  placeholder="Свой ответ…"
                  rows={3}
                  value={drafts.get(it.id) ?? ''}
                  onInput={value => void drafts.set(it.id, value)}
                  onSubmit={value => ownAnswer($, it, value)}
                />
              </Box>
              <Button key={`${it.id}:send`} variant="secondary" onPress={() => ownAnswer($, it, drafts.get(it.id) ?? '')}>
                Ответить
              </Button>
            </Box>
            <Text dimColor>Или ответьте в окне вопроса в чате — отсюда вопрос уйдёт сам.</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
