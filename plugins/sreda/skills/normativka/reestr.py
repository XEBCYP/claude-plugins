"""Реестр источников по нормативке и сверка отчёта с ним — без ilex и браузера.

  python reestr.py new <реестр.md>              — заготовка реестра (таблица с нужными графами)
  python reestr.py check <реестр.md> [<отчёт>]  — проверка реестра и фраз «не изучен / не открыт / нет разъяснений»

Реестр — таблица Markdown, по строке на каждый документ, о котором узнали (из текста, ссылок, «кто ссылается»,
поиска, документов пользователя):
| № | Документ | Откуда узнали | Где прочитан | Статус | Причина, попытки |
Статус — один из: «прочитан», «не относится», «недоступен». Для «недоступен» причина — только из закрытого списка
(REASONS) и перечень попыток (где и как искали); для «не относится» — почему; для «прочитан» — адрес или файл.
Код возврата: 0 — замечаний нет, 1 — есть (печатаются), 2 — файл не найден или таблица не разобрана.
"""
import re
import sys

COLUMNS = ["№", "Документ", "Откуда узнали", "Где прочитан", "Статус", "Причина, попытки"]
STATUSES = ("прочитан", "не относится", "недоступен")
REASONS = ("нет доступа", "не опубликован", "не найден ни в одном источнике")
REASON_RE = re.compile(r"нет\s+доступа|не\s+опубликован\w*|не\s+найден\w*\s+ни\s+в\s+одном\s+источнике", re.I)
# Отрицательные утверждения об источниках: в отчёте — только с причиной из REASONS или «не относится».
NEGATIVE = re.compile(r"не\s+(?:изучен|открыт|найден|проверен|прочитан|просмотрен|смотрел|удалось\s+(?:найти|открыть|"
                      r"изучить|получить|прочитать))\w*|(?:нет|не\s+нашлось|не\s+найдено)\s+разъяснени\w*|"
                      r"разъяснени\w*(?:\s+[^\s.!?]+){0,3}?\s+(?:нет|не\s+найден\w*)", re.I)
TEMPLATE = ("# Реестр источников: <вопрос>\n\n"
            "Статус: прочитан | не относится | недоступен. Причина «недоступен» — только: "
            + "; ".join(REASONS) + " — и попытки (где и как искали).\n\n"
            "| " + " | ".join(COLUMNS) + " |\n|" + "---|" * len(COLUMNS) + "\n")


def read(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return f.read()
    except OSError as e:
        print(f"reestr: {path}: {e.strerror}")
        return None


def rows(text):
    """Строки таблицы реестра: [(номер строки файла, {графа: значение})]; None — шапки с нужными графами нет."""
    head, out = None, []
    for i, line in enumerate(text.splitlines(), 1):
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if head is None:
            if [c.lower() for c in cells[:len(COLUMNS)]] == [c.lower() for c in COLUMNS]:
                head = cells
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue
        out.append((i, dict(zip(COLUMNS, cells + [""] * len(COLUMNS)))))
    return out if head else None


def check_registry(items):
    issues = []
    for i, r in items:
        name, status, why = r["Документ"], r["Статус"].lower(), r["Причина, попытки"]
        where = f"реестр, строка {i} «{name[:60]}»"
        if not name:
            issues.append(f"{where}: не назван документ")
        if not r["Откуда узнали"]:
            issues.append(f"{where}: не указано, откуда узнали")
        if status not in STATUSES:
            issues.append(f"{where}: статус «{r['Статус']}» — нужен один из: {', '.join(STATUSES)}")
        elif status == "прочитан" and not r["Где прочитан"]:
            issues.append(f"{where}: «прочитан», но не указано где (адрес ilex, сайт, файл)")
        elif status == "не относится" and len(why) < 10:
            issues.append(f"{where}: «не относится» — нужно, почему")
        elif status == "недоступен":
            reason = REASON_RE.search(why)
            if not reason:
                issues.append(f"{where}: «недоступен» — причина только из списка: {'; '.join(REASONS)}")
            elif len(REASON_RE.sub("", why).strip(" .,;:—-")) < 15:
                issues.append(f"{where}: «недоступен» — нет перечня попыток (где и как искали)")
    return issues


def check_report(text):
    """Фразы «не изучен», «не открыт», «разъяснений нет» без причины из закрытого списка."""
    issues = []
    for i, line in enumerate(text.splitlines(), 1):
        for sentence in re.split(r"(?<=[.!?])\s+", line):
            low = sentence.lower()
            m = NEGATIVE.search(sentence)
            if not m or REASON_RE.search(sentence) or "не относится" in low:
                continue
            if "разъяснени" in m.group(0).lower() and "запрос" in low:
                continue  # «разъяснений нет» с перечнем запросов — доказано
            issues.append(f"отчёт, строка {i}: «{m.group(0)}» без причины ({'; '.join(REASONS)}) — "
                          f"…{sentence.strip()[:140]}…")
    return issues


def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "new":
        with open(args[1], "x", encoding="utf-8") as f:
            f.write(TEMPLATE)
        print(f"Заготовка реестра: {args[1]}")
        return 0
    if not (2 <= len(args) <= 3 and args[0] == "check"):
        print(__doc__)
        return 2
    text = read(args[1])
    if text is None:
        return 2
    items = rows(text)
    if items is None:
        print(f"reestr: в {args[1]} нет таблицы с графами: {' | '.join(COLUMNS)}")
        return 2
    issues = check_registry(items)
    if len(args) == 3:
        report = read(args[2])
        if report is None:
            return 2
        issues += check_report(report)
    counts = {s: sum(1 for _, r in items if r["Статус"].lower() == s) for s in STATUSES}
    print(f"Реестр: документов {len(items)} — " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    for x in issues:
        print("- " + x)
    print("Замечаний нет" if not issues else f"Замечаний: {len(issues)}")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
