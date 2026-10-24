import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Pending } from '../types'

// Панель «Ждут ответа» (плагин sreda): вопросы пользователю из ~/.claude/zhdut-otveta.json (пишут Claude и
// глобальная сессия за подпроекты), с кнопками. Вопрос виден, пока на него не ответили: кнопкой здесь или в чате.
// Отвеченный вопрос переезжает в zhdut-otveta-arhiv.json — рабочий файл каждая сессия читает целиком, и с
// отвеченными он рос до ~15 тыс. токенов на чтение.
const PANE = 'zhdut-otveta'
const NAME = 'zhdut-otveta.json'
const ARCHIVE = 'zhdut-otveta-arhiv.json'
const items = atom({ plugin: 'sreda', key: 'items' } as const, [] as Pending[])

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

async function refresh($: any): Promise<void> {
  const list = await load($)
  await update($, items, () => list)
}

async function answer($: any, it: Pending, label: string): Promise<void> {
  const list = await load($)
  const done = { ...it, status: 'answered' as const, answer: label, answeredAt: new Date().toISOString() }
  const rest = list.filter(one => one.id !== it.id)
  const archive = await load($, ARCHIVE)
  await $.fs.write(await file($, ARCHIVE), JSON.stringify({ items: [...archive, done] }, null, 2))
  await $.fs.write(await file($), JSON.stringify({ items: rest }, null, 2))
  await update($, items, () => rest)
  void $.prompt.submit({ text: `Ответ на вопрос «${it.question}» (${it.from}): ${label}`, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zhdut-otveta', description: 'Открыть панель «Ждут ответа»' })
    await refresh($)
    $.clock.every(5000, () => refresh($))
    void $.ui.open({ id: PANE, title: 'Ждут ответа' })
    return next(e)
  })

  on('command.run', { command: 'zhdut-otveta' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Ждут ответа' })
    return { text: 'Панель «Ждут ответа» открыта.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
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
                <Button variant={k === 0 ? 'primary' : 'secondary'} onPress={() => void answer($, it, opt.label)}>
                  {opt.label}
                </Button>
                {opt.desc ? <Text dimColor>{opt.desc}</Text> : null}
              </Box>
            ))}
            <Text dimColor>Или ответьте в чате — вопрос уйдёт отсюда, когда Claude отметит ответ.</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
