"""Реестр источников по нормативке и сверка отчёта с ним — без ilex и браузера.

  python reestr.py new <реестр.md>                       — заготовка реестра (таблица с нужными графами)
  python reestr.py add <реестр.md> <вывод.txt> --from "<документ или запрос>"
                                                         — дописать в реестр всё из вывода `ilex.py refs`, `search`
                                                           или `backlinks` (сохранённого в файл), чего там ещё нет;
                                                           статус — пустой; обрезанный вывод не принимается
                                                           (add-refs — то же)
  python reestr.py check <реестр.md> [<отчёт>]           — проверка реестра и отчёта

Реестр — таблица Markdown, по строке на каждый документ, о котором узнали (из текста, ссылок, «кто ссылается»,
поиска, документов пользователя):
| № | Документ | Откуда узнали | Где прочитан | Статус | Причина, попытки | Цепочка |
Статус — один из: «прочитан», «не относится», «недоступен». Для «недоступен» причина — только из закрытого списка
(REASONS; гриф, документ вне подписки и т. п. — «нет доступа» с пояснением) и попытки и в ilex (поиск по номеру,
названию, editions, backlinks), и вне его (сайт органа, интернет); для «не относится» — почему и где смотрели (или
«по названию»); для «прочитан» — адрес или файл. «Цепочка» — у прочитанного нормативного акта: что сделано дальше по
нему (refs, backlinks по нужным абзацам: числа по вкладкам и что из них прочитано — номера строк реестра).
Отчёт: фразы «не изучен», «не было открыто», «изучить не удалось», «требует дополнительного изучения», «разъяснений
нет» и т. п. о документах — только с причиной из списка в той же части предложения (до «, а», «, но», «;»); причина
сверяется с реестром (у акта с этим номером — «недоступен»); «разъяснений нет» — ещё и с перечнем запросов в
кавычках; акты с номером — должны быть в реестре.
Код возврата: 0 — замечаний нет, 1 — есть (печатаются), 2 — файл не найден или таблица не разобрана.
"""
import re
import sys

COLUMNS = ["№", "Документ", "Откуда узнали", "Где прочитан", "Статус", "Причина, попытки", "Цепочка"]
STATUSES = ("прочитан", "не относится", "недоступен")
REASONS = ("нет доступа", "не опубликован", "не найден ни в одном источнике")
REASON_RE = re.compile(r"нет\s+доступа|не\s+опубликован\w*|не\s+найден\w*\s+ни\s+в\s+одном\s+источнике", re.I)
# Где искали: без этого «недоступен» — не доказано. Нужны попытки и в ilex, и вне его.
TRIED_ILEX = re.compile(r"ilex|search|backlinks|refs|editions|запрос|вкладк", re.I)
TRIED_OUT = re.compile(r"сайт|интернет|pravo|http|библиотек|письм|звон|архив", re.I)
# Нормативный акт: у прочитанного — графа «Цепочка» (refs, backlinks) обязательна.
ACT_RE = re.compile(r"закон|кодекс|указ|декрет|постановлени|положени|инструкци|перечен|перечн|правил|приказ|"
                    r"конституци|соглашени|конвенци|договор|директив|решени\w*\s+(?:совета|исполкома|комиссии)",
                    re.I)
SOURCE_WORDS = (r"документ|акт\b|акта|акту|актом|актов|закон|кодекс|указ|декрет|постановлени|положени|инструкци|"
                r"перечн|перечен|правил|письм|разъяснени|норм|источник|ilex|материал|практик|комментари|текст|"
                r"редакци|стать|пункт|приложени|решени|ответ|мнени|публикаци")
SOURCE_RE = re.compile(SOURCE_WORDS, re.I)
# Отрицательные утверждения об источниках.
VERBS = (r"изучен|изучал|изуча|открыт|открывал|найден|нашл|проверен|проверял|прочитан|просмотрен|смотрел|исследован|"
         r"рассмотрен|рассматрива|получен|проанализирован|анализирова|искал|искать|учтен|учтён|использован|запрашива")
INF = r"найти|открыть|изучить|получить|прочитать|проверить|рассмотреть|проанализировать|посмотреть|просмотреть"
SOURCE_NOUNS = r"разъяснени|практик|писем|письм|комментари|ответ|материал|мнени|публикаци|текст|редакци|документ|акт"
NEGATIVE = re.compile(
    r"не\s+(?:(?:был|была|было|были|стал\w*)\s+)?(?:" + VERBS + r")\w*"
    r"|\bне(?:" + VERBS + r")\w*"  # «неизученным», «непроверенные»
    r"|не\s+(?:удалось|успел\w*|получилось|смогл\w*|смог)\s+(?:\S+\s+)?(?:" + INF + r")"
    r"|(?:" + INF + r")\s+(?:\S+\s+)?не\s+(?:удалось|успел\w*|получилось|смогл\w*|смог)"
    r"|требу\w*\s+(?:\S+\s+)?(?:изучени|проверк|анализ|рассмотрени)\w*"
    r"|рекоменду\w*\s+(?:\S+\s+)?(?:проверить|изучить|уточнить|рассмотреть)"
    r"|(?:за|вне)\s+(?:рамками|рамок|пределами)\b"
    r"|отложен\w*|на\s+потом|позже\s+(?:изучить|проверить)"
    r"|недоступ\w*"
    r"|отсутству\w*\s+(?:\S+\s+){0,2}?(?:" + SOURCE_NOUNS + r")\w*"
    r"|(?<!\bв\s)(?<!\bво\s)(?<!\bна\s)\b(?:" + SOURCE_NOUNS + r")\w*(?:\s+[^\s.!?]+){0,6}?\s+отсутству\w*"
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


def filled(text, size=5):
    """В графе есть содержание, а не «-», «нет», «?»."""
    return len(re.findall(r"\w", text)) >= size


def check_registry(items):
    issues = [] if items else ["реестр пуст: ни одного документа — полнота не доказана"]
    for i, r in items:
        name, status, why = r["Документ"], r["Статус"].lower(), r["Причина, попытки"]
        where = f"реестр, строка {i} «{name[:60]}»"
        if not name:
            issues.append(f"{where}: не назван документ")
        if not filled(r["Откуда узнали"], 3):
            issues.append(f"{where}: не указано, откуда узнали")
        if status not in STATUSES:
            issues.append(f"{where}: статус «{r['Статус']}» — нужен один из: {', '.join(STATUSES)}")
        elif status == "прочитан":
            if not filled(r["Где прочитан"]):
                issues.append(f"{where}: «прочитан», но не указано где (адрес ilex, сайт, файл)")
            if ACT_RE.search(name) and not filled(r["Цепочка"], 10):
                issues.append(f"{where}: нормативный акт прочитан, но «Цепочка» пуста — refs и backlinks по нужным "
                              "абзацам: числа по вкладкам и что из них прочитано")
        elif status == "не относится":
            if not filled(why, 15):
                issues.append(f"{where}: «не относится» — нужно, почему (по какому месту или по названию)")
            elif not filled(r["Где прочитан"]) and not re.search(r"по\s+названи", why, re.I):
                issues.append(f"{where}: «не относится» — не указано, где смотрели (адрес) или «по названию»")
        elif status == "недоступен":
            rest = REASON_RE.sub("", why)
            if not REASON_RE.search(why):
                issues.append(f"{where}: «недоступен» — причина только из списка: {'; '.join(REASONS)}")
            elif not (TRIED_ILEX.search(rest) and TRIED_OUT.search(rest)):
                issues.append(f"{where}: «недоступен» — нужны попытки и в ilex (поиск по номеру и названию, editions, "
                              "backlinks), и вне его (сайт органа, интернет)")
    return issues


def clauses(sentence):
    """Части предложения: «А не изучено, а Б — нет доступа» — причина Б к А не относится."""
    return re.split(r";|,\s*(?:а|но|однако|тогда\s+как|при\s+этом|зато)\s+", sentence)


GENERIC = {"докум", "текст", "акт", "акта", "норма", "норму", "этот", "такой", "котор"}


def named(part, name):
    """В части отчёта назван документ строки реестра: все значимые слова названия (по первым 5 буквам)."""
    words = [w[:5] for w in re.findall(r"\w{4,}", name.lower()) if w[:5] not in GENERIC]
    have = {w[:5] for w in re.findall(r"\w{4,}", part.lower())}
    return bool(words) and all(w in have for w in words[:3])


def row_nums(items):
    """Номер акта → статус строки реестра."""
    out = {}
    for _, r in items:
        for n in NUM_RE.findall(r["Документ"]):
            out.setdefault(n.lower().rstrip(".-–"), r["Статус"].lower())
    return out


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
    nums, unavailable = row_nums(items), [r for _, r in items if r["Статус"].lower() == "недоступен"]
    for i, line in enumerate(text.splitlines(), 1):
        for near in (c for sentence in sentences(line) for c in clauses(sentence)):
            for m in NEGATIVE.finditer(near):
                if not SOURCE_RE.search(near):
                    continue  # «врач не проверен», «противоречий не найдено» — не про источники
                if re.search(r"не\s+относится", near, re.I):
                    continue
                reason = REASON_RE.search(near)
                if reason:  # причина в этой части предложения — сверить с реестром
                    said = [n.lower().rstrip(".-–") for n in NUM_RE.findall(near)]
                    wrong = [n for n in said if nums.get(n) not in (None, "недоступен")]
                    if wrong:
                        issues.append(f"отчёт, строка {i}: «{reason.group(0)}» у акта № {wrong[0]}, а в реестре он "
                                      f"«{nums[wrong[0]]}» — …{near.strip()[:120]}…")
                    elif not said and not any(named(near, r["Документ"]) for r in unavailable):
                        issues.append(f"отчёт, строка {i}: «{reason.group(0)}» — не назван документ из реестра со "
                                      f"статусом «недоступен» (номер или название) — …{near.strip()[:120]}…")
                    break
                if re.search(r"разъяснени|практик|писем|письм|комментари|ответ|материал|мнени|публикаци",
                             m.group(0), re.I) and EVIDENCE_RE.search(near):
                    continue  # «нет» с перечнем запросов в кавычках — доказано
                issues.append(f"отчёт, строка {i}: «{m.group(0)}» без причины ({'; '.join(REASONS)}) в этой части "
                              f"предложения — …{near.strip()[:140]}…")
        for num in NUM_RE.findall(line):
            if num.lower().rstrip(".-–") not in known_nums:
                issues.append(f"отчёт, строка {i}: акт № {num} не в реестре")
    return issues


# Пометки ilex.py о неполном выводе: добавить показанное, но предупредить и вернуть 1.
PARTIAL = (("[обрезано", "вывод обрезан по --max — переснять с --max больше"),
           ("ВНИМАНИЕ", "ilex.py предупредил о неполноте (см. строку «ВНИМАНИЕ» в файле)"),
           ("[на этой странице показано", "страница урезана --n — переснять без --n"),
           ("[следующие 25", "листались не все страницы — переснять с --all"))


def doc_key(addr):
    m = re.search(r"/view-document/([A-Za-z]+)/(\d+)", addr)
    return f"/view-document/{m.group(1)}/{m.group(2)}".lower() if m else addr.lower()


def same_name(probe, names):
    """Название уже в реестре: те же слова (по 5 букв); длиннее — только если дальше номер или скобка
    («Положением о воинском учете» ≠ «… учете в органах госбезопасности»)."""
    p = [w[:5] for w in re.findall(r"\w+", probe.lower())]
    for name in names:
        n = re.findall(r"\(|№|\w+", name.lower())
        if [w[:5] for w in n[:len(p)]] == p and (len(n) == len(p) or n[len(p)] in ("(", "№", "n")
                                                 or n[len(p)].isdigit()):
            return True
    return False


def add_refs(path, out_path, source):
    """Дописать в реестр документы из вывода ilex.py refs, search или backlinks, которых там нет (по номеру акта,
    названию или адресу)."""
    text, out = read(path), read(out_path)
    if text is None or out is None:
        return 2
    items = rows(text)
    if items is None:
        print(f"reestr: в {path} нет таблицы с графами: {' | '.join(COLUMNS)}")
        return 2
    have = " ".join(f"{r['Документ']} {r['Где прочитан']}" for _, r in items).lower()
    keys = {doc_key(a.upper()) for a in re.findall(r"/view-document/[a-z]+/\d+", have)}
    names = [r["Документ"] for _, r in items]
    new, section, kind = [], "", "refs"
    for line in out.splitlines():
        if line.startswith("--- "):
            section = line
            if "страница" in line:
                kind = "backlinks" if "/backlinks/" in out[:300] else "search"
            continue
        cells = [c.strip() for c in line.split(" | ")]
        if ("реквизит" in section and "Акты" in section and len(cells) >= 3
                and re.match(r"\d{2}\.\d{2}\.\d{4}$|без даты$", cells[0])):
            date = "" if cells[0] == "без даты" else f" от {cells[0]}"
            doc, num = f"{cells[2]}{date} № {cells[1]}", cells[1].lower()
            if f"№ {num}" in have or f"n {num}" in have:
                continue
            have += f" № {num}"
        elif "Названы" in section and len(cells) == 2 and cells[1].isdigit():
            doc = cells[0]
            if same_name(doc, names):
                continue
            names.append(doc)
        elif cells[0].startswith("/view-document/") or (len(cells) >= 3 and cells[-1].startswith("/view-document/")):
            addr, label = (cells[0], cells[3] if len(cells) > 3 else "") if cells[0].startswith("/view") \
                else (cells[-1], cells[-2])
            key = doc_key(addr)
            nums = [n.lower() for n in NUM_RE.findall(label)]
            if key in keys or (kind == "refs" and any(f"№ {n}" in have or f"n {n}" in have for n in nums)):
                continue  # тот же документ уже есть по адресу или (для ссылок refs) по номеру
            keys.add(key)
            doc = f"{label[:200]} — {key}" if label else key
        else:
            continue
        new.append(doc.replace("|", "/"))
    start = len(items) + 1
    add = "".join(f"| {start + k} | {doc} | {kind}: {source} |  |  |  |  |\n" for k, doc in enumerate(new))
    with open(path, "a", encoding="utf-8") as f:
        f.write(("" if text.endswith("\n") else "\n") + add)
    print(f"Дописано строк: {len(new)} (статус пустой — заполнить: прочитан / не относится / недоступен)")
    gaps = [why for mark, why in PARTIAL if mark in out]
    for why in gaps:
        print(f"ВНИМАНИЕ: вывод неполный — {why}; дописано только показанное")
    return 1 if gaps else 0


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
    if len(args) == 5 and args[0] in ("add", "add-refs") and args[3] == "--from":
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
