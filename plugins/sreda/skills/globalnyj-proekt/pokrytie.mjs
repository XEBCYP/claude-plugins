// Покрытие требований глобального проекта (ADR 0018): читает таблицы требований R из docs/План.md и показывает, что
// передано, но не сделано; сделано, но не установлено; установлено, но не проверено пользователем.
//   node pokrytie.mjs <План.md>           — отчёт
//   node pokrytie.mjs <План.md> --toc     — оглавление открытых R (вывод)
//   node pokrytie.mjs <План.md> --write   — то же оглавление вписать в План.md между метками
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { parse, report, toc, withToc } from './pokrytie-lib.mjs'

function main(argv) {
  const file = argv.find(a => !a.startsWith('--'))
  if (!file) {
    console.log('node pokrytie.mjs <План.md> [--toc | --write]')
    return 2
  }
  const text = readFileSync(file, 'utf8')
  const parsed = parse(text)
  if (argv.includes('--write')) {
    writeFileSync(file, withToc(text, toc(parsed)), 'utf8')
    console.log(`Оглавление открытых R вписано в ${file}`)
  } else if (argv.includes('--toc')) console.log(toc(parsed))
  else console.log(report(parsed))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
