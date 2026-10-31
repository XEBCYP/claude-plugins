"""Реестр источников по нормативке и сверка отчёта с ним — без ilex и браузера.

  python reestr.py new <реестр.md>                       — заготовка реестра (таблица с нужными графами)
  python reestr.py add-refs <реестр.md> <refs.txt> --from "<документ>"
                                                         — дописать в реестр всё из вывода `ilex.py refs`
                                                           (сохранённого в файл), чего там ещё нет; статус — пустой
  python reestr.py check <реестр.md> [<отчёт>]           — проверка реестра и отчёта

Реестр — таблица Markdown, по строке на каждый документ, о котором узнали (из текста, ссылок, «кто ссылается»,
поиска, документов пользователя):
| № | Документ | Откуда узнали | Где прочитан | Статус | Причина, попытки |
Статус — один из: «прочитан», «не относится», «недоступен». Для «недоступен» причина — только из закрытого списка
(REASONS; гриф, документ вне подписки и т. п. — «нет доступа» с пояснением) и перечень попыток (где и как искали);
для «не относится» — почему; для «прочитан» — адрес или файл.
Отчёт: фразы «не изучен», «не открыт», «разъяснений нет», «практики нет» и т. п. о документах — только с причиной
из списка рядом; «разъяснений нет» — ещё и с перечнем запросов в кавычках; акты с номером — должны быть в реестре.
Код возврата: 0 — замечаний нет, 1 — есть (печатаются), 2 — файл не найден или таблица не разобрана.
"""
import re
import sys

COLUMNS = ["№", "Документ", "Откуда узнали", "Где прочитан", "Статус", "Причина, попытки"]
STATUSES = ("прочитан", "не относится", "недоступен")
REASONS = ("нет доступа", "не опубликован", "не найден ни в одном источнике")
REASON_RE = re.compile(r"нет\s+доступа|не\s+опубликован\w*|не\s+найден\w*\s+ни\s+в\s+одном\s+источнике", re.I)
# Где искали: без этого «недоступен» — не доказано.
TRIED_RE = re.compile(r"ilex|search|backlinks|refs|editions|поиск|запрос|сайт|интернет|pravo|http|библиотек|"
                      r"орган|письм|звон|архив|вкладк", re.I)
SOURCE_WORDS = (r"документ|акт\b|акта|акту|актом|актов|закон|кодекс|указ|декрет|постановлени|положени|инструкци|"
                r"перечн|перечен|правил|письм|разъяснени|норм|источник|ilex|материал|практик|комментари|текст|"
                r"редакци|стать|пункт|приложени|решени|ответ|мнени|публикаци")
SOURCE_RE = re.compile(SOURCE_WORDS, re.I)
# Отрицательные утверждения об источниках.
NEGATIVE = re.compile(
    r"не\s+(?:изучен|изучал|открыт|открывал|найден|нашл|проверен|проверял|прочитан|просмотрен|смотрел|исследован|"
    r"рассмотрен|получен)\w*"
    r"|не\s+удалось\s+(?:найти|открыть|изучить|получить|прочитать|проверить)"
    r"|недоступ\w*|отсутству\w*"
    r"|(?:нет|не\s+нашлось|не\s+найдено|не\s+обнаружено)\s+(?:\S+\s+){0,2}?(?:разъяснени|практик|писем|письм|"
    r"комментари|ответ|материал|мнени|публикаци)\w*"
    r"|(?:разъяснени|практик|писем|письм|комментари|ответ|материал|мнени|публикаци)\w*(?:\s+[^\s.!?]+){0,6}?"
    r"\s+(?:нет|не\s+найден\w*|не\s+нашлось|не\s+обнаружен\w*)\b", re.I)
EVIDENCE_RE = re.compile(r"запрос\w*[^.!?]{0,40}[«\"„]", re.I)  # «запросы «…», «…» — 0»
ABBR = re.compile(r"(?:\b(?:п|пп|ст|ч|г|гг|подп|прил|гл|разд|см|др|абз|им|рис|табл|ред|N|№|т\.\s?к|т\.\s?е|т\.\s?п|"
                  r"т\.\s?д)\.)$", re.I)
NUM_RE = re.compile(r"(?:N|№)\s*(\d[\w/\-–.]*\w|\d)")
TEMPLATE = ("# Реестр источников: <вопрос>\n\n"
            "Дорожная карта (виды источников): закон или кодекс; указ; постановление Совмина; ведомственные акты; "
            "письма и разъяснения; аналитика и ответы экспертов; формы; судебная практика.\n\n"
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
    issues = [] if items else ["реестр пуст: ни одного документа — полнота не доказана"]
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
            if not REASON_RE.search(why):
                issues.append(f"{where}: «недоступен» — причина только из списка: {'; '.join(REASONS)}")
            elif not TRIED_RE.search(REASON_RE.sub("", why)):
                issues.append(f"{where}: «недоступен» — нет перечня попыток (где и как искали: ilex, сайт, интернет …)")
    return issues


def sentences(line):
    """Предложения строки; точка после «п.», «ст.», «г.», «т. к.», «№» предложение не заканчивает."""
    out = []
    for part in re.split(r"(?<=[.!?])\s+(?=[А-ЯЁA-Z«\"(])", line):
        if out and ABBR.search(out[-1]):
            out[-1] += " " + part
        else:
            out.append(part)
    return out


def check_report(text, items):
    """Отрицательные фразы об источниках без причины рядом и акты с номером, которых нет в реестре."""
    issues = []
    known = " ".join(f"{r['Документ']} {r['Где прочитан']}" for _, r in items).lower()
    known_nums = {n.lower() for n in NUM_RE.findall(known)} | set(re.findall(r"\d[\w/\-–]*\w|\d", known))
    for i, line in enumerate(text.splitlines(), 1):
        for sentence in sentences(line):
            for m in NEGATIVE.finditer(sentence):
                near = sentence[max(0, m.start() - 120):m.end() + 160]
                if not SOURCE_RE.search(near):
                    continue  # «врач не проверен», «противоречий не найдено» — не про источники
                if REASON_RE.search(near) or re.search(r"не\s+относится", near, re.I):
                    continue
                if re.search(r"разъяснени|практик|писем|письм|комментари|ответ|материал|мнени|публикаци",
                             m.group(0), re.I) and EVIDENCE_RE.search(near):
                    continue  # «нет» с перечнем запросов в кавычках — доказано
                issues.append(f"отчёт, строка {i}: «{m.group(0)}» без причины ({'; '.join(REASONS)}) рядом — "
                              f"…{sentence.strip()[:140]}…")
        for num in NUM_RE.findall(line):
            if num.lower().rstrip(".-–") not in known_nums:
                issues.append(f"отчёт, строка {i}: акт № {num} не в реестре")
    return issues


def add_refs(path, refs_path, source):
    """Дописать в реестр строки из вывода ilex.py refs, которых там нет (по номеру акта, названию или адресу)."""
    text, refs = read(path), read(refs_path)
    if text is None or refs is None:
        return 2
    items = rows(text)
    if items is None:
        print(f"reestr: в {path} нет таблицы с графами: {' | '.join(COLUMNS)}")
        return 2
    have = " ".join(f"{r['Документ']} {r['Где прочитан']}" for _, r in items).lower()
    new, section = [], ""
    for line in refs.splitlines():
        if line.startswith("--- "):
            section = line
            continue
        cells = [c.strip() for c in line.split(" | ")]
        if "реквизит" in section and "Акты" in section and len(cells) >= 3 and re.match(r"\d{2}\.\d{2}\.\d{4}$", cells[0]):
            doc, probe = f"{cells[2]} от {cells[0]} № {cells[1]}", f"№ {cells[1]}".lower()
            if probe in have or f"n {cells[1]}".lower() in have:
                continue
        elif "Названы" in section and len(cells) == 2 and cells[1].isdigit():
            doc, probe = cells[0], " ".join(w[:5] for w in cells[0].lower().split())
            if probe in " ".join(w[:5] for w in have.split()):
                continue
        elif "Ссылки ilex" in section and cells[0].startswith("/view-document/"):
            label = cells[3] if len(cells) > 3 else ""
            doc, probe = f"{cells[0]} (ссылка «{label}»)", cells[0].lower()
            nums = [n.lower() for n in NUM_RE.findall(label)]
            if probe in have or any(f"№ {n}" in have or f"n {n}" in have for n in nums):
                continue  # тот же акт уже есть по номеру («N 413-З» — «Закон … № 413-З»)
        else:
            continue
        have += " " + probe
        new.append(doc.replace("|", "/"))
    start = len(items) + 1
    add = "".join(f"| {start + k} | {doc} | refs: {source} |  |  |  |\n" for k, doc in enumerate(new))
    with open(path, "a", encoding="utf-8") as f:
        f.write(("" if text.endswith("\n") else "\n") + add)
    print(f"Дописано строк: {len(new)} (статус пустой — заполнить: прочитан / не относится / недоступен)")
    return 0


def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "new":
        try:
            with open(args[1], "x", encoding="utf-8") as f:
                f.write(TEMPLATE)
        except FileExistsError:
            print(f"reestr: {args[1]} уже есть — не перезаписываю")
            return 2
        print(f"Заготовка реестра: {args[1]}")
        return 0
    if len(args) == 5 and args[0] == "add-refs" and args[3] == "--from":
        return add_refs(args[1], args[2], args[4])
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
        issues += check_report(report, items)
    counts = {s: sum(1 for _, r in items if r["Статус"].lower() == s) for s in STATUSES}
    print(f"Реестр: документов {len(items)} — " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    for x in issues:
        print("- " + x)
    print("Замечаний нет" if not issues else f"Замечаний: {len(issues)}")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
