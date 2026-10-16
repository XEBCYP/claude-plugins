# Соответствие объектов 1С иконкам

Машиночитаемая версия — [1c-icon-map.json](1c-icon-map.json) (тот же список). Имена проверены по
lucide-static 1.49.0 и @tabler/icons 3.48.0. Колонка «React» — имя компонента для `lucide-react`;
для Tabler — `Icon` + PascalCase (`file-invoice` → `IconFileInvoice`).

## Объекты метаданных 1С

| 1С | id | Lucide (по умолчанию) | React | Tabler (бизнес, запасной) |
|---|---|---|---|---|
| Подсистема (раздел) | `subsystem` | `folder` | `Folder` | `folder` |
| Константа | `constant` | `pin` | `Pin` | `pin` |
| Справочник | `catalog` | `book-open` | `BookOpen` | `book` |
| Группа справочника (папка) | `catalog-folder` | `folder` | `Folder` | `folder` |
| Элемент справочника | `catalog-item` | `file` | `File` | `file` |
| Документ | `document` | `file-text` | `FileText` | `file-text` |
| Журнал документов | `document-journal` | `files` | `Files` | `files` |
| Перечисление | `enum` | `list-ordered` | `ListOrdered` | `list-numbers` |
| Отчёт | `report` | `chart-column` | `ChartColumn` | `report-analytics` |
| Обработка | `data-processor` | `cog` | `Cog` | `settings-automation` |
| План видов характеристик | `chart-of-characteristic-types` | `tags` | `Tags` | `tags` |
| План счетов | `chart-of-accounts` | `list-tree` | `ListTree` | `list-tree` |
| План видов расчёта | `chart-of-calculation-types` | `percent` | `Percent` | `percentage` |
| План обмена | `exchange-plan` | `arrow-left-right` | `ArrowLeftRight` | `arrows-exchange` |
| Регистр сведений | `information-register` | `table` | `Table` | `table` |
| Регистр накопления | `accumulation-register` | `layers` | `Layers` | `stack-2` |
| Регистр бухгалтерии | `accounting-register` | `book-open-check` | `BookOpenCheck` | `report-money` |
| Регистр расчёта | `calculation-register` | `calculator` | `Calculator` | `calculator` |
| Бизнес-процесс | `business-process` | `workflow` | `Workflow` | `sitemap` |
| Задача | `task` | `list-todo` | `ListTodo` | `checklist` |
| Общий модуль | `common-module` | `code` | `Code` | `code` |
| Роль | `role` | `shield` | `Shield` | `shield` |
| Пользователь | `user` | `user` | `User` | `user` |
| Внешний источник данных | `external-data-source` | `plug` | `Plug` | `plug` |
| Журнал регистрации | `event-log` | `history` | `History` | `history` |

## Бухгалтерия и данные 1С 7.7

| 1С | id | Lucide (по умолчанию) | React | Tabler (бизнес, запасной) |
|---|---|---|---|---|
| Журнал операций (бухгалтерия 7.7) | `operations-journal` | `notebook-tabs` | `NotebookTabs` | `clipboard-list` |
| Операция / проводка | `posting` | `arrow-right-left` | `ArrowRightLeft` | `transfer` |
| Оборотно-сальдовая ведомость | `trial-balance` | `sheet` | `Sheet` | `table-export` |
| База DBF | `dbf-base` | `database` | `Database` | `database` |
| Выгрузка в SQL | `sql-export` | `database-backup` | `DatabaseBackup` | `database-export` |
| Загрузка данных | `data-import` | `file-input` | `FileInput` | `database-import` |

## Бизнес-сущности и документы

| 1С | id | Lucide (по умолчанию) | React | Tabler (бизнес, запасной) |
|---|---|---|---|---|
| Организация | `organization` | `building-2` | `Building2` | `building` |
| Контрагент | `counterparty` | `handshake` | `Handshake` | `users-group` |
| Покупатель | `customer` | `shopping-cart` | `ShoppingCart` | `shopping-cart` |
| Поставщик | `supplier` | `truck` | `Truck` | `truck` |
| Номенклатура (товар) | `product` | `package` | `Package` | `package` |
| Штрихкод | `barcode` | `scan-barcode` | `ScanBarcode` | `barcode` |
| Склад | `warehouse` | `warehouse` | `Warehouse` | `building-warehouse` |
| Остатки товаров | `stock` | `boxes` | `Boxes` | `packages` |
| Поступление товаров | `goods-receipt` | `package-plus` | `PackagePlus` | `truck-loading` |
| Реализация (отгрузка) | `sale` | `package-check` | `PackageCheck` | `truck-delivery` |
| Счёт на оплату | `invoice` | `receipt-text` | `ReceiptText` | `file-invoice` |
| Счёт-фактура | `tax-invoice` | `receipt-russian-ruble` | `ReceiptRussianRuble` | `invoice` |
| Касса (ПКО, РКО) | `cash` | `wallet` | `Wallet` | `cash-register` |
| Банк, выписка | `bank` | `landmark` | `Landmark` | `building-bank` |
| Платёжное поручение | `payment-order` | `banknote` | `Banknote` | `credit-card-pay` |
| Взаиморасчёты, долги | `settlements` | `scale` | `Scale` | `scale` |
| Налоги, НДС | `tax` | `percent` | `Percent` | `receipt-tax` |
| Сумма в рублях | `rub` | `russian-ruble` | `RussianRuble` | `currency-ruble` |
| Валюта | `currency` | `coins` | `Coins` | `coins` |
| Цена, прайс | `price` | `tag` | `Tag` | `tag` |
| Скидка | `discount` | `badge-percent` | `BadgePercent` | `discount` |
| Сотрудник | `employee` | `id-card` | `IdCard` | `id-badge-2` |
| Зарплата | `payroll` | `hand-coins` | `HandCoins` | `report-money` |
| Договор | `contract` | `file-signature` | `FileSignature` | `contract` |
| Печать организации | `stamp` | `stamp` | `Stamp` | `rubber-stamp` |
| Основные средства | `fixed-assets` | `factory` | `Factory` | `building-factory-2` |
| Дэшборд | `dashboard` | `layout-dashboard` | `LayoutDashboard` | `layout-dashboard` |

## Состояния

| 1С | id | Lucide (по умолчанию) | React | Tabler (бизнес, запасной) |
|---|---|---|---|---|
| Проведён | `posted` | `circle-check` | `CircleCheck` | `circle-check` |
| Записан, не проведён | `not-posted` | `circle-dashed` | `CircleDashed` | `circle-dashed` |
| Помечен на удаление | `marked-for-deletion` | `trash-2` | `Trash2` | `trash-x` |
| Ошибка | `error` | `circle-alert` | `CircleAlert` | `alert-circle` |
| Предупреждение | `warning` | `triangle-alert` | `TriangleAlert` | `alert-triangle` |
| Синхронизация | `sync` | `refresh-cw` | `RefreshCw` | `refresh` |
| Нет сети | `offline` | `wifi-off` | `WifiOff` | `wifi-off` |
| Загрузка | `loading` | `loader-circle` | `LoaderCircle` | `loader-2` |

## Стандартные команды

| 1С | id | Lucide (по умолчанию) | React | Tabler (бизнес, запасной) |
|---|---|---|---|---|
| Создать | `create` | `plus` | `Plus` | `plus` |
| Скопировать | `copy` | `copy` | `Copy` | `copy` |
| Изменить | `edit` | `square-pen` | `SquarePen` | `edit` |
| Удалить | `delete` | `trash-2` | `Trash2` | `trash` |
| Провести | `post` | `check` | `Check` | `check` |
| Отмена проведения | `unpost` | `undo-2` | `Undo2` | `arrow-back-up` |
| Записать | `save` | `save` | `Save` | `device-floppy` |
| Печать | `print` | `printer` | `Printer` | `printer` |
| Найти | `search` | `search` | `Search` | `search` |
| Отбор | `filter` | `funnel` | `Funnel` | `filter` |
| Сортировка | `sort` | `arrow-up-down` | `ArrowUpDown` | `arrows-sort` |
| Обновить | `refresh` | `refresh-cw` | `RefreshCw` | `refresh` |
| Создать на основании | `create-based-on` | `copy-plus` | `CopyPlus` | `copy-plus` |
| Иерархия | `hierarchy` | `folder-tree` | `FolderTree` | `hierarchy-2` |
| Выгрузить в файл | `export-file` | `file-down` | `FileDown` | `file-download` |
| Загрузить из файла | `import-file` | `file-up` | `FileUp` | `file-upload` |
| Excel | `excel` | `file-spreadsheet` | `FileSpreadsheet` | `file-spreadsheet` |
| Период | `period` | `calendar-range` | `CalendarRange` | `calendar-month` |
| Ещё | `more` | `ellipsis-vertical` | `EllipsisVertical` | `dots-vertical` |
| Закрыть | `close` | `x` | `X` | `x` |
| Настройки | `settings` | `settings` | `Settings` | `settings` |
| Выход | `logout` | `log-out` | `LogOut` | `logout` |
