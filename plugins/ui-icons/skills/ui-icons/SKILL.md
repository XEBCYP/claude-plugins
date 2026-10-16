---
name: ui-icons
description: Иконки для веб-интерфейсов, дэшбордов и PWA — Lucide по умолчанию, Tabler для бизнес- и бухгалтерских иконок; подключение в React, в HTML и в офлайн-PWA (SVG-спрайт без CDN); соответствие объектов 1С (справочники, документы, регистры, план счетов, статусы, команды) иконкам. Использовать, когда в веб-интерфейсе, дэшборде, мобильном приложении или прототипе нужны иконки, когда выбираешь иконку для объекта или команды 1С, или когда нужно, чтобы иконки работали без интернета. Не для форм самой 1С — там картинки платформы (StdPicture / БиблиотекаКартинок, навыки 1c-skills).
---

# Иконки для интерфейсов: Lucide + Tabler

Одинаковая сетка 24×24, линия 2 px, скруглённые концы — обе библиотеки смешиваются без разнобоя.

| | Lucide | Tabler |
|---|---|---|
| Роль | по умолчанию | когда в Lucide нет нужной бизнес-иконки (касса, счёт-фактура, банк, налоги, склад) |
| Лицензия | ISC | MIT |
| Версия (закреплена) | 1.49.0 | 3.48.0 |
| Пакеты | `lucide-react`, `lucide` (UMD), `lucide-static` (SVG) | `@tabler/icons-react`, `@tabler/icons-webfont`, `@tabler/icons` (SVG) |

## Правила

1. **Сначала ищи в таблице 1С** — [references/1c-icon-map.md](references/1c-icon-map.md) (то же в `1c-icon-map.json`).
   Одно понятие — одна иконка во всём приложении: «Документ» везде `file-text`, «Проведён» везде `circle-check`.
2. **Не выдумывай имена.** Имя не из таблицы проверь перед использованием:
   `python "${CLAUDE_SKILL_DIR}/scripts/icons.py" check lucide:имя tabler:имя` (выдаёт похожие при опечатке),
   искать по части имени — `icons.py search склад-на-английском`, например `icons.py search warehouse`.
3. **Lucide → Tabler.** Бери Lucide; Tabler — только если в Lucide нет подходящей или в таблице она явно лучше
   (колонка Tabler). Не держи две разные иконки для одного смысла.
4. **Единый вид:** размер 16 (в таблицах и полях), 20 (кнопки, меню), 24 (навигация, плитки); линия 2
   (или везде 1.75 — но одинаково); цвет только `currentColor`, иконку красит цвет текста.
5. **Доступность:** иконка рядом с текстом — `aria-hidden="true"`; кнопка только с иконкой — `aria-label`
   и `title` с русским названием команды. В нижней навигации PWA — иконка + подпись.
6. **Офлайн-PWA — никаких CDN.** Иконки должны лежать в самом приложении (спрайт или бандл) и попадать в кэш
   сервис-воркера.

## React

```bash
npm i lucide-react@1.49.0 @tabler/icons-react@3.48.0
```

```jsx
import { BookOpen, FileText, CircleCheck } from 'lucide-react';
import { IconCashRegister, IconFileInvoice } from '@tabler/icons-react';

<BookOpen size={20} strokeWidth={2} aria-hidden="true" />
<IconCashRegister size={20} stroke={2} aria-hidden="true" />
```

- Lucide: компонент = PascalCase имени (`trash-2` → `Trash2`), свойства `size`, `strokeWidth`, `color`.
- Tabler: `Icon` + PascalCase (`file-invoice` → `IconFileInvoice`), свойства `size`, `stroke`, `color`.
- Только именованные импорты — сборщик оставит в бандле лишь использованные иконки. Не используй
  `import * as`, `icons` целиком и `lucide-react/dynamic` (`DynamicIcon` грузит иконки по сети — офлайн сломается).
- Иконку по типу объекта 1С бери из словаря, а не по имени строкой:

```jsx
import { BookOpen, FileText, Layers, Table, ListTree } from 'lucide-react';
export const META_ICON = { catalog: BookOpen, document: FileText, 'accumulation-register': Layers,
  'information-register': Table, 'chart-of-accounts': ListTree };
const Icon = META_ICON[obj.kind] ?? FileText;
```

В Vite/webpack-PWA иконки из бандла кэшируются вместе с JS — отдельно ничего делать не надо.

## HTML со CDN (прототипы, артефакты, страницы с интернетом)

```html
<script src="https://cdn.jsdelivr.net/npm/lucide@1.49.0/dist/umd/lucide.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.48.0/dist/tabler-icons.min.css">

<i data-lucide="book-open" aria-hidden="true"></i>
<i class="ti ti-cash-register" aria-hidden="true"></i>
<script>lucide.createIcons();</script>   <!-- после вставки нового HTML вызвать снова -->
```

Скрипт Lucide весит ~430 КБ (все иконки) — для рабочего приложения используй спрайт ниже.

## Офлайн-PWA и обычный HTML без сети: SVG-спрайт

1. Собери спрайт только из нужных иконок (стандартная библиотека Python; берёт SVG из `node_modules` проекта,
   иначе скачивает закреплённый npm-архив, проверяет sha512 и кэширует в `~/.cache/ui-icons`):

```bash
python "${CLAUDE_SKILL_DIR}/scripts/icons.py" sprite --out www/icons.svg \
  --map status,cmd  lucide:warehouse lucide:package tabler:cash-register tabler-filled:circle-check
```

   `--map` добавляет группы таблицы 1С (`meta`, `v77`, `biz`, `status`, `cmd` или `all`), `--prefer tabler` —
   брать колонку Tabler. Список можно держать в файле (`--from-file icons.txt`, по одной в строке) и
   пересобирать спрайт при изменениях. Отдельные SVG-файлы: `icons.py files --dir www/icons ...`.

2. Используй через `<use>`; id символа — `<набор>-<имя>`: `lucide-book-open`, `tabler-cash-register`,
   `tabler-filled-circle-check`:

```html
<button><svg class="i" aria-hidden="true"><use href="icons.svg#lucide-warehouse"/></svg>Остатки</button>
<button aria-label="Обновить" title="Обновить"><svg class="i"><use href="icons.svg#lucide-refresh-cw"/></svg></button>
```

```css
.i { width: 20px; height: 20px; flex: none; vertical-align: -0.2em; }
.i-sm { width: 16px; height: 16px; } .i-lg { width: 24px; height: 24px; }
```

3. Добавь `icons.svg` в список кэша сервис-воркера и подними версию кэша, иначе старые клиенты не получат файл:

```js
const CACHE = 'app-shell-v3';                     // было v2
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'icons.svg', /* … */];
```

Спрайт лежит на том же сервере, что и страница (`<use href>` на чужой домен не работает).
Для 2–5 иконок можно вставить SVG прямо в HTML: `icons.py files` и скопировать содержимое файла.

## Лицензии

Lucide (ISC) и Tabler (MIT) можно использовать в коммерческих и закрытых проектах. Спрайт и `files`
записывают строку с лицензиями и версией в файл — не удаляй её.
