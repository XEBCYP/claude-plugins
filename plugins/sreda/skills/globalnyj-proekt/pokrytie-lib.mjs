// Покрытие требований глобального проекта (ADR 0018): разбор таблиц требований R из docs/План.md. Без импортов —
// чтобы тесты плагина могли его загрузить; чтение и запись файла — в pokrytie.mjs.
// Статус — первые слова ячейки «Состояние»: «готово 26.10 — …», «в работе — …»
export const STATUSES = [
  'open', 'передано', 'в работе', 'частично', 'сделано', 'установлено', 'проверено',
  'заглушка', 'отложено', 'снято', 'готово',
]
const CLOSED = new Set(['проверено', 'снято'])
export const TOC_BEGIN = '<!-- открытые R: начало -->'
export const TOC_END = '<!-- открытые R: конец -->'

// R05, R05.1, R14i; диапазон «R62.1–R62.10» — одной строкой
const ID = /^R\d+(?:\.\d+)*[a-zа-яё]?(?:\s*[–—-]\s*R\d+(?:\.\d+)*[a-zа-яё]?)?$/i
const LIKE_R = /^R\d/i

function cells(line) {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

export function statusOf(cell) {
  const s = (cell || '').toLowerCase().replace(/^[*_`\s]+/, '')
  for (const w of STATUSES) if (s === w || (s.startsWith(w) && !/[\p{L}\d]/u.test(s[w.length]))) return w
  return ''
}

// Все строки таблиц, где первая ячейка — номер R. Колонки «Подпроект» и «Состояние/Статус» — по заголовку таблицы,
// без заголовка — состояние в последней ячейке. Строки после пустой строки — новая таблица.
export function parse(text) {
  const rows = []
  const odd = []
  let head = null
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const c = cells(line)
    if (!c) { head = null; return }
    if (c.every(x => /^:?-{2,}:?$/.test(x))) return
    const id = c[0].replace(/[*_`]/g, '')
    if (!ID.test(id)) {
      // Похоже на номер R, но не разобрано — в отчёт, а не молча мимо
      if (LIKE_R.test(id)) odd.push(`${id.slice(0, 30)} — строка ${i + 1}`)
      else if (!head) head = c.map(x => x.toLowerCase())
      return
    }
    // Колонка — по месту от конца строки: черта внутри цитаты добавляет ячейку раньше, а «Подпроект» и «Состояние»
    // стоят после цитаты
    const col = name => {
      const k = head ? head.findIndex(h => name.test(h)) : -1
      if (k < 0) return -1
      return c.length > head.length ? c.length - (head.length - k) : k
    }
    const si = col(/состояни|статус/)
    const pi = col(/подпроект|кому/)
    // Колонка «Состояние» есть, а строка короче — состояние пусто (не распознано), а не соседняя ячейка
    const state = si < 0 ? c[c.length - 1] : c[si] ?? ''
    rows.push({ id, line: i + 1, state, status: statusOf(state), sub: pi > 0 ? c[pi] || '' : '' })
  })
  // Одно R в нескольких таблицах — верна последняя запись
  const last = new Map()
  for (const r of rows) last.set(r.id, r)
  const dups = [...new Set(rows.filter(r => last.get(r.id) !== r).map(r => r.id))]
  return { rows: [...last.values()], dups, odd }
}

export const GROUPS = [
  ['Записано, но никому не передано', r => r.status === 'open'],
  ['Передано, но не сделано', r => ['передано', 'в работе', 'частично'].includes(r.status)],
  ['Сделано, но не установлено', r => r.status === 'сделано'],
  ['Установлено, но не проверено пользователем', r => r.status === 'установлено'],
  ['Старый статус «готово» — уточнить: сделано, установлено или проверено', r => r.status === 'готово'],
  ['Заглушка или отложено', r => r.status === 'заглушка' || r.status === 'отложено'],
  ['Статус не распознан', r => r.status === ''],
]

const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function report({ rows, dups, odd = [] }) {
  const out = [`Требований R: ${rows.length}; закрыто (проверено, снято): ${rows.filter(r => CLOSED.has(r.status)).length}`]
  for (const [title, pick] of GROUPS) {
    const g = rows.filter(pick)
    if (!g.length) continue
    out.push('', `## ${title} — ${g.length}`)
    for (const r of g) out.push(`- ${r.id}${r.sub ? ` (${short(r.sub, 40)})` : ''}: ${short(r.state, 110)} — строка ${r.line}`)
  }
  if (odd.length) out.push('', `## Похожи на R, но не разобраны — ${odd.length}`, ...odd.map(x => `- ${x}`))
  if (dups.length) out.push('', `Записаны в нескольких таблицах (взята последняя запись): ${dups.join(', ')}`)
  return out.join('\n')
}

// Оглавление — строка на статус, номера через запятую: план читается при старте, оглавление не должно его раздувать
export function toc({ rows }) {
  const open = rows.filter(r => !CLOSED.has(r.status))
  const by = new Map()
  for (const r of open) {
    const k = r.status || 'статус не распознан'
    by.set(k, [...(by.get(k) || []), r.id])
  }
  const order = [...STATUSES, 'статус не распознан'].filter(k => by.has(k))
  return [
    TOC_BEGIN,
    `Открытые требования: ${open.length} из ${rows.length} (собрано скриптом pokrytie.mjs, руками не править).`,
    '',
    ...order.map(k => `- **${k}** (${by.get(k).length}): ${by.get(k).join(', ')}`),
    TOC_END,
  ].join('\n')
}

// Вписать оглавление между метками; меток нет — после заголовка «## Требования» (или в начало)
export function withToc(text, block) {
  const a = text.indexOf(TOC_BEGIN)
  const b = text.indexOf(TOC_END)
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + TOC_END.length)
  const m = /^## Требования[^\n]*\n/m.exec(text)
  const at = m ? m.index + m[0].length : 0
  return text.slice(0, at) + '\n' + block + '\n\n' + text.slice(at)
}
