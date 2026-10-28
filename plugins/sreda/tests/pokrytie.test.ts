import { expect, test } from 'claude-code/testing'

import { parse, report, statusOf, toc, withToc, TOC_BEGIN, TOC_END } from '../skills/globalnyj-proekt/pokrytie-lib.mjs'

// Пакет 5 аудита (ADR 0018): скрипт покрытия требований R
const PLAN = `# План

## Требования

| № | Требование (дословно) | Подпроект | Есть сейчас | Состояние |
|---|---|---|---|---|
| R01 | «Сбор заказов» | | | open |
| R02.1 | «Клиентов собрать» | FlowerMigration | | передано 27.10 — задание Т1 |

Позже, дословно:

| № | Требование | Подпроект | Состояние |
|---|---|---|---|
| R03 | «плитка» | MobileData1C7 | готово 26.10 — 9f9c58a |
| R04 | «Этикетки | (с чертой)» | Торговля_Связь | в работе — ert |
| R05 | «отчёт» | Закупка | сделано — 1a2b3c, не установлено |
| R06 | «версия» | FlowerCore | установлено 27.10 — r62 |
| R07 | «фото» | КарточкиРастений | проверено пользователем 27.10: «да, так» |
| R08 | «SMS» | | снято — «SMS не надо» |
| R01 | «Сбор заказов» | FlowerCore | частично — часть 1 |
| R09 | «потом» | | done 27.10 |
`

test('статус — первые слова ячейки, а не любое совпадение внутри', () => {
  expect(statusOf('готово 26.10 — 9f9c58a')).toBe('готово')
  expect(statusOf('в работе — ert')).toBe('в работе')
  expect(statusOf('**частично** — часть 1')).toBe('частично')
  expect(statusOf('Open')).toBe('open')
  expect(statusOf('сделанное раньше')).toBe('')
  expect(statusOf('done 27.10')).toBe('')
})

test('строки R из всех таблиц; повтор R — верна последняя запись', () => {
  const { rows, dups } = parse(PLAN)
  expect(rows.map(r => r.id)).toEqual(['R01', 'R02.1', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09'])
  expect(dups).toEqual(['R01'])
  const r01 = rows.find(r => r.id === 'R01')!
  expect(r01.status).toBe('частично')
  expect(r01.sub).toBe('FlowerCore')
})

test('отчёт: передано, но не сделано; сделано, но не установлено; установлено, но не проверено', () => {
  const out = report(parse(PLAN))
  expect(out).toContain('Требований R: 9; закрыто (проверено, снято): 2')
  expect(out).toMatch(/## Передано, но не сделано — 3\n- R01 \(FlowerCore\): частично[^\n]*строка 20\n- R02\.1[^\n]*\n- R04/)
  expect(out).toMatch(/## Сделано, но не установлено — 1\n- R05 \(Закупка\)/)
  expect(out).toMatch(/## Установлено, но не проверено пользователем — 1\n- R06/)
  expect(out).toMatch(/## Старый статус «готово»[^\n]*— 1\n- R03/)
  expect(out).toMatch(/## Статус не распознан — 1\n- R09/)
  expect(out).not.toContain('Записано, но никому не передано')
  expect(out).toContain('Записаны в нескольких таблицах (взята последняя запись): R01')
})

test('черта внутри цитаты добавляет ячейку — подпроект и состояние всё равно на месте', () => {
  const r04 = parse(PLAN).rows.find(r => r.id === 'R04')!
  expect(r04.status).toBe('в работе')
  expect(r04.sub).toBe('Торговля_Связь')
})

test('таблица без заголовка — состояние в последней ячейке', () => {
  const { rows } = parse('| R10 | «x» | готово |\n| R11 | «y» | open |')
  expect(rows.map(r => r.status)).toEqual(['готово', 'open'])
  expect(rows[0].sub).toBe('')
})

test('оглавление открытых R: без проверенных и снятых; вписывается между метками и заменяется', () => {
  const parsed = parse(PLAN)
  const block = toc(parsed)
  expect(block.startsWith(TOC_BEGIN)).toBe(true)
  expect(block.endsWith(TOC_END)).toBe(true)
  expect(block).toContain('Открытые требования (7 из 9')
  expect(block).toContain('- R05 — сделано — Закупка')
  expect(block).not.toContain('R07')
  expect(block).not.toContain('R08')

  const once = withToc(PLAN, block)
  expect(once.indexOf(TOC_BEGIN)).toBeGreaterThan(once.indexOf('## Требования'))
  expect(once.indexOf(TOC_BEGIN)).toBeLessThan(once.indexOf('| № |'))
  const twice = withToc(once, block)
  expect(twice).toBe(once)
  expect(twice.split(TOC_BEGIN).length).toBe(2)
})
