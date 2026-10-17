# В проектах включается Python-версия навыков 1С (`1c-skills-py`)

Статус: принято (2026-10-16).

`.claude/settings.json` проекта действует и на Windows, и в облачной Linux-сессии. PowerShell-версия
`1c-skills` в Linux не работает, а Python-порт работает в обеих средах (скрипты те же, отличаются только
SKILL.md). Поэтому шаблон проекта включает `1c-skills-py` и выключает `1c-skills`; пакеты `lxml`, `Pillow`,
`psutil` в Linux ставит хук SessionStart.

Последствия: на Windows в своём проекте можно вместо Python-версии включить `1c-skills`.
