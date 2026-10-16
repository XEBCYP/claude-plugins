# claude-plugins

Маркетплейс плагинов Claude Code для работы с 1С 7.7/8.x, SQL-базами, OData и дэшбордами.
Сторонние плагины закреплены на проверенных коммитах — результаты проверки в [AUDIT.md](AUDIT.md).

| Плагин | Что даёт | Нужно |
|---|---|---|
| `1c-skills` | Навыки 1С 8.3: формы, метаданные, СКД, MXL, EPF/ERF, расширения, роли, базы, веб-тесты (PowerShell) | Windows, PowerShell 5.1+, Node.js для хуков |
| `1c-skills-py` | То же на Python — для Linux и облачных сессий | Python 3, `lxml`, `Pillow`, `psutil` |
| `bsl-language-server` | LSP для `.bsl`/`.os`: ошибки, переход к определению, ссылки | скачивается сам при первом запуске |
| `dbhub` | SQL-запросы только на чтение: PostgreSQL, MySQL, MariaDB, MS SQL, Oracle, SQLite | Node.js, строка подключения (DSN) |
| `onec-odata` | Живые данные 1С 8.x через OData: справочники, документы, регистры, проводки | Node.js, опубликованный OData |
| `data-skills` | SQL, анализ, графики, интерактивные дэшборды | — |
| `ui-icons` | Иконки Lucide и Tabler: React, HTML, офлайн-PWA (SVG-спрайт), соответствие объектов 1С | Python 3 для сборки спрайта |
| `delivery-control` | Контроль больших задач: требования дословно, независимая проверка плана и слепая приёмка результата свежим агентом, когда выгодно раздавать работу субагентам, отчёт при сдаче | — |
| `frontend-design` *(из официального маркетплейса)* | Дизайн интерфейсов и дэшбордов | — |

## Подключение на компьютере

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/scripts/install.ps1 | iex
```

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/scripts/install.sh | bash
```

Скрипт дописывает маркетплейс и плагины в `~/.claude/settings.json` (уже заданные настройки не меняет,
делает резервную копию). После перезапуска Claude Code плагины установятся сами и будут обновляться.

Вручную: `/plugin marketplace add https://github.com/XEBCYP/claude-plugins.git`, затем `/plugin install <плагин>@xebcyp-plugins`.

## Облачные сессии и проекты

Скопируйте [templates/project-settings.json](templates/project-settings.json) в `.claude/settings.json`
репозитория. Тогда любая сессия на этом репозитории — облачная или на другом компьютере — подключит
маркетплейс и плагины. В проектах включена Python-версия навыков 1С (работает и на Windows, и в Linux-облаке);
хук при старте сессии в Linux доставляет `lxml`, `Pillow`, `psutil`.

## Подключение баз данных

`dbhub` и `onec-odata` выключены, пока не заданы подключения. Включите их в `/plugin` — Claude Code спросит:

- **dbhub** — DSN, например `sqlserver://user:pass@server:1433/base` или `postgres://user:pass@host:5432/db`.
  Используйте пользователя БД только с правом чтения.
- **onec-odata** — адрес вида `http://server/base/odata/standard.odata`, пользователя и пароль 1С.
  Запись в базу выполняется только после подтверждения.

Пароли хранятся в защищённом хранилище Claude Code, а не в этом репозитории.

## Обновление стороннего плагина

1. Проверьте новый коммит исходного репозитория.
2. Поменяйте `sha` в [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json) и запишите итог в AUDIT.md.
3. Закоммитьте — у всех подключённых компьютеров плагин обновится при следующем старте.
