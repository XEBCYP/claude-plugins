# Проверка кода плагинов

Дата проверки: 2026-10-16. Каждый сторонний плагин в `marketplace.json` закреплён на проверенном коммите (`sha`),
поэтому изменения в исходных репозиториях сами по себе к вам не попадут. Чтобы обновить плагин, проверьте новый
коммит и поменяйте `sha`.

Что искал: сетевые запросы и адреса, скачивание и запуск файлов, `eval`/`Invoke-Expression`/base64-обфускацию,
доступ к реестру, `~/.ssh`, сохранённым паролям, автозагрузке, хуки Claude Code и их поведение.

| Плагин | Исходник и коммит | Итог |
|---|---|---|
| `1c-skills` | [Nikolay-Shirokov/cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) `acfd993` (MIT) | Чисто |
| `1c-skills-py` | та же репа, ветка `port-claude-code-py` `231e45a` | Чисто; скрипты совпадают с основной веткой, различаются только SKILL.md |
| `bsl-language-server` | [1c-syntax/claude-code-bsl-lsp](https://github.com/1c-syntax/claude-code-bsl-lsp) `c303a60` (MIT) | Чисто, с оговоркой |
| `dbhub` | [bytebase/dbhub](https://github.com/bytebase/dbhub) `2dbf01a`, каталог `plugin/` (MIT) | Чисто |
| `onec-odata` | свой плагин; запускает npm-пакет `@theyahia/aprovodka@4.3.0` (MIT), дерево зависимостей закреплено lock-файлом | Чисто, с оговоркой |
| `data-skills` | копия `data/` из [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) `33eeda1` (Apache-2.0) | Чисто; внешние коннекторы удалены |
| `ui-icons` | свой плагин; скрипт `icons.py` скачивает `lucide-static@1.49.0` и `@tabler/icons@3.48.0` с registry.npmjs.org | Чисто; архив проверяется по sha512 из реестра, распаковывается только в память |
| `delivery-control` | свой плагин; идеи из [nick-vels/skills](https://github.com/nick-vels/skills) `9fc898c` (Autopilot), [obra/superpowers](https://github.com/obra/superpowers) `bb92a77` и [mattpocock/skills](https://github.com/mattpocock/skills) `49dd158` (все MIT), текст переписан | Только markdown, кода и хуков нет |
| `autohandoff` | свой плагин (мод с функциональными хуками); идея — мод `handoff` (nickvels-mods 1.1.0), код написан заново | Сеть не использует; пишет только свою отметку в хранилище мода; читает время изменения файла передачи; отправляет сообщения и `/clear` в своей же сессии |
| `frontend-design` | официальный маркетплейс Anthropic `claude-plugins-official` | Один SKILL.md без кода |

## Подробности

**1c-skills / 1c-skills-py.** 73 PowerShell-, 74 Python- и 63 JS-скрипта. Хуки (только в PowerShell-версии):
`support-guard.mjs` запрещает правку объектов типовой конфигурации, которые стоят «на замке» поставщика;
`skill-suggester.mjs` раз за сессию подсказывает подходящий навык. Оба работают только с локальными файлами,
сеть не трогают. Сеть используется только по явному вызову навыков:
- `v8-xsd-fetch` — скачивает XSD-схемы 1С с GitHub;
- `web-publish` — может сам скачать Apache с apachelounge.com (без проверки контрольной суммы — при желании скачайте вручную);
- `web-test` — обращается к вашей веб-публикации 1С; озвучка роликов — к OpenAI/ElevenLabs, только если вы сами дали ключ.
`exec()` в `meta-validate.py` — повторный запуск собственного файла для пакетной проверки. Обфускации нет.

**bsl-language-server.** Хук при старте сессии (не чаще раза в 8 минут) проверяет последний релиз
`1c-syntax/bsl-language-server` на GitHub и при необходимости скачивает и распаковывает его в
`%LOCALAPPDATA%\Programs\bsl-language-server` (Linux: `~/.local/share/bsl-language-server`). Версия бинарника
не закреплена и контрольная сумма не проверяется — источник официальный, но обновляется автоматически.

**dbhub.** Запускает `@bytebase/dbhub@1.5.0` через npx; конфиг плагина — только чтение (`readonly = true`),
не более 1000 строк. Строка подключения (DSN) спрашивается при включении и хранится в защищённом хранилище
Claude Code. Телеметрии в исходниках нет.

**onec-odata (aprovodka).** В GitHub-репозитории автора кода нет, поэтому проверен опубликованный npm-пакет
4.3.0 и его зависимость `@theyahia/mcp-core@1.1.0` (~4300 строк JS). Запросы идут только на ваш `ONEC_BASE_URL`
(HTTP Basic). По умолчанию у пакета запись в базу ничем не ограничена (`ONEC_WRITE_MODE=off`), поэтому в плагине
стоит `approval`: любое изменение сначала показывается как предпросмотр и выполняется только после подтверждения.
С 2026-10-17 (onec-odata 1.1.0) всё дерево зависимостей — 97 пакетов — закреплено в
`plugins/onec-odata/server/package-lock.json` и ставится `npm ci --ignore-scripts` (скрипт `server/start.mjs`),
а не `npx -y`. Пакетов со скриптами установки в дереве нет; `npm audit` — 0 уязвимостей, `npm audit signatures` —
подписи проверены. Обновление aprovodka или зависимостей — новый lock-файл и перепроверка.

**data-skills.** Только Markdown-инструкции и один Python-скрипт упаковки ZIP без сети. Из оригинала удалён
`.mcp.json` с восемью внешними сервисами (Snowflake, BigQuery и др.).
