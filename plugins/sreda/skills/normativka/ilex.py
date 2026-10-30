"""Поиск и чтение документов ilex (https://ilex-private.ilex.by) из любой сессии — без встроенного браузера.

Входит в ilex сама: почта и пароль — из диспетчера учётных данных Windows (общие учётные данные «ilex»,
пользователь кладёт их один раз командой `cmdkey /generic:ilex /user:<почта> /pass`). Пароль программа
никуда не печатает и не пишет; Claude его не видит.

ilex пускает под одной учёткой один вход: новый вход закрывает прежний (код сервера 971, окно
«принудительный выход»). Учёткой пользуются и у заказчика, поэтому программа входит только когда вход
потерян. MIN_RELOGIN_MINUTES — не чаще раза в столько минут; 0 — без ограничения (так решил пользователь:
«сейчас любое количество раз» (пользователь, 30.10.2026)). Поставить 60, если сотрудники заказчика пожалуются, что их выбивает.

Команды:
  python ilex.py status                      — есть ли вход, когда программа входила последний раз
  python ilex.py search "<запрос>" [--n 15]  — «Найдено документов», обзор ilex и ссылки выдачи
  python ilex.py doc <ссылка> [--find "<слова>"] [--max 20000] [--full] [--out <файл>]
                                             — весь текст документа (экспорт в Word, запас — прокрутка);
                                               --full — для совместимости; --find — куски вокруг слов;
                                               --out — весь текст в файл
  python ilex.py doc <ссылка> --links [--find "<слова>"]
                                             — абзацы с сегментами и ссылки документа (тип, адрес)
  python ilex.py backlinks <ссылка> [--seg N] [--tab <вкладка>] [--page N] [--n 25]
                                             — кто ссылается на абзац (или документ): письма,
                                               разъяснения, статьи, формы, суды
  python ilex.py editions <ссылка> [--n 30]  — все редакции с датой и состоянием

  status только смотрит, есть ли вход, и никогда не входит сама.

Коды выхода: 0 — готово; 2 — нет учётных данных «ilex» в Windows; 3 — вход потерян, а войти снова
пока нельзя (лимит); 4 — ilex не пустил (неверный пароль, подписка); 5 — страница не загрузилась;
6 — другая сессия занимает ilex дольше LOCK_WAIT_S.
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import datetime as dt
import json
import msvcrt
import os
import sys
import re
import time
import urllib.parse

from playwright.sync_api import Error as PlaywrightError, sync_playwright

BASE = "https://ilex-private.ilex.by"
LOGIN_URL = BASE + "/public/service-login"
CRED_TARGET = "ilex"
MIN_RELOGIN_MINUTES = 0  # 0 — входить заново каждый раз, когда выбили
LOCK_WAIT_S = 90  # меньше тайм-аута команды в сессии (120 с по умолчанию)

HOME = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ilex-client")
PROFILE = os.path.join(HOME, "profile")
STATE = os.path.join(HOME, "state.json")
LOG = os.path.join(HOME, "log.txt")
LOCK = os.path.join(HOME, "lock")


def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


class _Credential(ctypes.Structure):
    _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("TargetName", wt.LPWSTR),
                ("Comment", wt.LPWSTR), ("LastWritten", wt.FILETIME),
                ("CredentialBlobSize", wt.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                ("Persist", wt.DWORD), ("AttributeCount", wt.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wt.LPWSTR), ("UserName", wt.LPWSTR)]


def read_credential():
    """(почта, пароль) из «Учётные данные Windows» → «ilex» или None."""
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    ptr = ctypes.POINTER(_Credential)()
    if not advapi.CredReadW(CRED_TARGET, 1, 0, ctypes.byref(ptr)):  # 1 = CRED_TYPE_GENERIC
        return None
    try:
        c = ptr.contents
        blob = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize)
        return c.UserName, blob.decode("utf-16-le")
    finally:
        advapi.CredFree(ptr)


class Busy(Exception):
    pass


class Lock:
    """Одна программа за раз: профиль браузера нельзя открыть дважды."""

    def __enter__(self):
        self.f = open(LOCK, "a+")
        for _ in range(LOCK_WAIT_S * 2):
            try:
                msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
                return self
            except OSError:
                time.sleep(0.5)
        self.f.close()
        raise Busy()

    def __exit__(self, *a):
        self.f.seek(0)
        msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
        self.f.close()


def on_login_page(page):
    """Вход потерян: страница входа или окно «под учёткой вошли в другом месте» (il-forced-logout-dialog)."""
    if "/public/service-login" in page.url or "/public/login" in page.url:
        return True
    return page.locator(".forced-logout-dialog").count() > 0


def settle(page, seconds=6):
    """Подождать, не уведёт ли сайт на страницу входа (переадресация бывает не сразу). True — вход потерян."""
    for _ in range(seconds * 2):
        if on_login_page(page):
            return True
        page.wait_for_timeout(500)
    return on_login_page(page)


def check_login(page):
    page.goto(BASE + "/home", wait_until="domcontentloaded")
    return not settle(page)


def ensure_login(page, state, lost=False):
    """Вход потерян (lost или видно по главной) — войти, если лимит позволяет. Возвращает код выхода или 0."""
    if not lost and check_login(page):
        return 0
    last = state.get("last_login")
    if last:
        nxt = dt.datetime.fromisoformat(last) + dt.timedelta(minutes=MIN_RELOGIN_MINUTES)
        if dt.datetime.now() < nxt:
            log("вход потерян, повторный вход отложен до " + f"{nxt:%H:%M}")
            print(f"ilex: вход потерян — под этой учёткой вошли в другом месте. Программа входила в {last[11:16]}; "
                  f"снова войдёт не раньше {nxt:%H:%M}, чтобы не выбивать сотрудника заказчика. "
                  "Срочно — пользователь может войти сам во встроенном браузере.")
            return 3
    cred = read_credential()
    if not cred:
        print("ilex: нет учётных данных «ilex» в диспетчере учётных данных Windows. Пользователь кладёт их сам: "
              "cmdkey /generic:ilex /user:<почта> /pass")
        return 2
    user, password = cred
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    page.wait_for_selector("input[formcontrolname=login]", timeout=20000)
    page.fill("input[formcontrolname=login]", user)
    page.fill("input[formcontrolname=password]", password)
    del password
    box = page.locator("input[type=checkbox]").first
    if box.count() and not box.is_checked():
        box.check(force=True)
    page.click("button[type=submit]:has-text('Войти в сервис')")
    # Под учёткой уже кто-то вошёл — ilex спрашивает, завершить ли его вход («Продолжить» / «Отмена»).
    kicked = False
    for _ in range(60):
        page.wait_for_timeout(500)
        if "/public/" not in page.url:
            break
        cont = page.locator("mat-dialog-container button:has-text('Продолжить')")
        if not kicked and cont.count():
            cont.first.click()
            kicked = True
            log("под учёткой уже был вход — завершила его («Продолжить»)")
    # Лимит считает входы, которые могли выбить другого: удачный вход или нажатое «Продолжить».
    # Неудачный вход без «Продолжить» никого не выбил и не блокирует попытку после нового cmdkey.
    if kicked or "/public/" not in page.url:
        state["last_login"] = dt.datetime.now().isoformat(timespec="seconds")
        save_state(state)
    if "/public/" in page.url:
        err = page.evaluate("() => document.body.innerText.slice(0, 300)")
        log("вход не удался")
        print("ilex: не пустил после ввода учётных данных (неверный пароль или подписка). Страница: "
              + " ".join(err.split()))
        return 4
    log("вошла по учётным данным Windows")
    return 0


def wait_text(page, markers, timeout_s=25):
    for _ in range(timeout_s * 2):
        text = page.evaluate("() => document.body.innerText")
        if any(m in text for m in markers):
            return text
        if on_login_page(page):
            return None
        page.wait_for_timeout(500)
    return None


LOST = "lost"


def cmd_search(page, query, n):
    page.goto(BASE + "/search?query=" + urllib.parse.quote(query), wait_until="domcontentloaded")
    text = wait_text(page, ["Найдено документов", "ничего не найдено"])
    if text is None and on_login_page(page):
        return LOST
    if text is None:
        print("ilex: выдача не загрузилась за 25 с")
        return 5
    page.wait_for_timeout(1500)
    text = page.evaluate("() => document.body.innerText")
    i = text.find("Найдено документов")
    head = text[i:i + 1500] if i >= 0 else text[:600]
    links = page.evaluate("""() => { const seen = new Set(); const out = [];
        for (const a of document.querySelectorAll('a[href*="/view-document/"]')) {
            const t = a.innerText.trim().replace(/\\s+/g, ' ');
            if (!t || seen.has(a.href)) continue; seen.add(a.href); out.push(a.href + ' | ' + t.slice(0, 160)); }
        return out; }""")
    print(head.strip())
    print("\n--- Ссылки выдачи ---")
    for line in links[:n]:
        print(line)
    return 0


def full_url(url):
    return BASE + url if url.startswith("/") else url


def clean_href(href):
    """Адрес документа без служебных параметров выдачи (docSwitcherKey, searchPosition) и пустого «#»."""
    path, _, frag = href.partition("#")
    path = path.split("?")[0].replace(BASE, "")
    return path + ("#" + frag if frag else "")


def open_doc(page, url):
    """Открыть документ и дождаться текста. LOST — вход потерян, число — код ошибки, None — открыт."""
    page.goto(full_url(url), wait_until="domcontentloaded")
    if settle(page, 4):
        return LOST
    prev, still = -1, 0
    for _ in range(40):  # текст подгружается после открытия: ждать, пока станет длиннее оглавления или перестанет расти
        size = page.evaluate("() => document.body.innerText.length")
        if size > 3000:
            break
        still = still + 1 if size == prev and size > 300 else 0
        if still >= 4:  # короткий документ (письмо, ответ) — 2 с без роста, дальше не ждать
            break
        prev = size
        page.wait_for_timeout(500)
    if on_login_page(page):
        return LOST
    page.wait_for_timeout(1500)
    if len(page.evaluate("() => document.body.innerText").strip()) < 300:
        print(f"{page.url}\nilex: документ не загрузился")
        return 5
    return None


# --- Весь текст: «Экспорт в Word» (RTF) → текст; запас — прокрутка по шагам ---

RTF_SKIP = {"fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "headerl", "headerr",
            "footerl", "footerr", "object", "datastore", "themedata", "listtable", "listoverridetable",
            "generator", "fldinst", "xmlnstbl", "rsidtbl", "latentstyles", "mmathPr"}
RTF_TOKEN = re.compile(r"\\([a-zA-Z]{1,32})(-?\d{1,10})? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+"
                       r"|([^\\{}\r\n]+)")


def rtf_to_text(data):
    """Простой разбор RTF ilex: кириллица \\'xx (cp1251) и \\uN, служебные группы пропускаются."""
    data = data.decode("latin-1")
    stack, skip, uc, drop = [], False, 1, 0
    out, buf = [], bytearray()

    def flush():
        if buf:
            out.append(buf.decode("cp1251", "replace"))
            buf.clear()

    for m in RTF_TOKEN.finditer(data):
        word, arg, hx, sym, brace, chunk = m.groups()
        if brace == "{":
            stack.append((skip, uc))
        elif brace == "}":
            flush()
            skip, uc = stack.pop() if stack else (False, 1)
            drop = 0
        elif hx:
            if drop:
                drop -= 1
            elif not skip:
                buf.extend(bytes.fromhex(hx))
        elif sym:
            if sym in "\r\n" and not skip:  # «\» с переводом строки — то же, что \par
                flush()
                out.append("\n")
            elif sym == "*":
                skip = True
            elif not skip and sym in "\\{}":
                flush()
                out.append(sym)
            elif not skip and sym == "~":
                flush()
                out.append(" ")
        elif word:
            if word in RTF_SKIP:
                skip = True
            elif word == "uc":
                uc = int(arg or 1)
            elif skip:
                pass
            elif word in ("par", "line", "row", "sect", "page"):
                flush()
                out.append("\n")
            elif word in ("tab", "cell"):
                flush()
                out.append("\t")
            elif word == "u" and arg:
                flush()
                v = int(arg)
                out.append(chr(v + 65536 if v < 0 else v))
                drop = uc  # за \uN идёт замена для старых программ — пропустить
        elif chunk and not skip:
            if drop:
                k = min(drop, len(chunk))
                chunk, drop = chunk[k:], drop - k
            if chunk:
                flush()
                out.append(chunk)
    flush()
    text = re.sub(r"[ \t]+\n", "\n", "".join(out))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def text_by_word(page):
    """Нажать «Экспорт в Word», дождаться RTF и вернуть его текст; None — не скачался."""
    btn = page.locator("button:has(mat-icon[data-mat-icon-name='export-word'])").first
    if not btn.count():
        return None
    path = os.path.join(HOME, "export.rtf")
    try:
        with page.expect_download(timeout=60000) as dl:
            btn.evaluate("e => e.click()")
        dl.value.save_as(path)
        with open(path, "rb") as f:
            text = rtf_to_text(f.read())
    except (PlaywrightError, ValueError, TypeError, IndexError, OSError):  # не скачался или не разобрался — прокрутка
        return None
    finally:
        if os.path.exists(path):
            os.remove(path)  # платный текст на диске не оставлять
    return text if len(text) > 300 else None


MARK_CONTAINER = """() => { let best = null, bh = 0;
    for (const el of document.querySelectorAll('*')) { const h = el.scrollHeight;
        if (h > el.clientHeight + 200 && h > bh) { bh = h; best = el; } }
    if (best) best.setAttribute('data-ilex-walk', '1'); return !!best; }"""
STEP_DOWN = """() => { const e = document.querySelector('[data-ilex-walk]'); const before = e.scrollTop;
    e.scrollTop = before + e.clientHeight * 0.8; return e.scrollTop === before; }"""


WALK_LIMIT_S = 150  # вместе со входом и экспортом в Word укладывается в тайм-аут команды 300 с


def walk(page, collect_js, steps=400, limit_s=WALK_LIMIT_S):
    """Прокрутить текст документа сверху вниз по 0,8 экрана, на каждом шаге вызывая collect_js.
    True — дошли до конца, False — остановились по числу шагов или времени (конец не собран)."""
    if not page.evaluate(MARK_CONTAINER):
        page.evaluate(collect_js)
        return True
    page.evaluate("() => { document.querySelector('[data-ilex-walk]').scrollTop = 0; }")
    page.wait_for_timeout(1500)
    end, done = time.monotonic() + limit_s, False
    for _ in range(steps):
        page.evaluate(collect_js)
        if page.evaluate(STEP_DOWN):
            done = True
            break
        if time.monotonic() > end:
            break
        page.wait_for_timeout(700)
    page.wait_for_timeout(700)
    page.evaluate(collect_js)
    return done


NOT_TO_END = ("\n[ВНИМАНИЕ: прокрутка остановлена по времени — конец документа не собран; нужный пункт — "
              "через --find (идёт экспортом в Word) или по абзацу #M<сегмент>]")


WALK_TEXT = """() => { const w = window.__ilexText = window.__ilexText || {seen: new Set(), lines: []};
    const e = document.querySelector('[data-ilex-walk]') || document.body;
    for (let line of e.innerText.split('\\n')) { line = line.trim();
        if (line && !w.seen.has(line)) { w.seen.add(line); w.lines.push(line); } } }"""


def text_by_scroll(page):
    """Текст прокруткой и признак, что дошли до конца."""
    done = walk(page, WALK_TEXT)
    return "\n".join(page.evaluate("() => window.__ilexText ? window.__ilexText.lines : []")), done


# --- Ссылки документа и абзацы с номерами (сегментами) ---

WALK_LINKS = """() => { const w = window.__ilexLinks = window.__ilexLinks || {links: {}, paras: {}, order: 0};
    const root = document.querySelector('[data-ilex-walk]') || document.body;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let seg = '', n;
    const sp = t => (t || '').replace(/\\s+/g, ' ').trim();
    const own = el => sp([...el.childNodes].filter(c => !(c.tagName || '').toLowerCase().endsWith('additional-link'))
        .map(c => c.textContent).join(''));
    while ((n = it.nextNode())) {
        if (n.classList.contains('segmentId-element') && n.getAttribute('segmentid')) { seg = n.getAttribute('segmentid'); continue; }
        const tag = n.tagName.toLowerCase();
        if (tag === 'p') {  // номер абзаца — пустой span внутри него
            const own = n.querySelector('.segmentId-element[segmentid]'); if (own) seg = own.getAttribute('segmentid');
            if (seg && !w.paras[seg]) { const t = sp(n.innerText); if (t) w.paras[seg] = [w.order++, t]; } }
        if (tag !== 'document-link' && tag !== 'simple-link' && tag !== 'document-additional-link') continue;
        const key = n.id || (tag + n.getAttribute('docid') + n.getAttribute('segmentid') + seg);
        if (w.links[key]) continue;
        const p = n.closest('p');
        w.links[key] = {o: w.order++, seg, extra: tag === 'document-additional-link',
            type: n.getAttribute('link-type') || (tag === 'simple-link' ? 'справка' : ''),
            ib: n.getAttribute('infobank') || '', doc: n.getAttribute('docid') || '', to: n.getAttribute('segmentid') || '',
            text: tag === 'document-additional-link' ? '' : own(n), para: p ? sp(p.innerText).slice(0, 90) : ''};
    } }"""

LINK_TYPES = ("Типы: РДД — акт, которым внесено изменение («в ред. …»); НУЛ — ссылка на норму (без базы — внутри этого "
              "документа, с базой — другой акт или прежняя редакция); ПОТ — акт утратил силу; ИЗА — изменённая норма "
              "другого акта; УМС — одно слово ведёт к нескольким документам (каждый следующий — строкой с «+»); "
              "справка — ссылки шапки и справки (редакции, вопросы).")


def print_links(page, words, max_chars):
    done = walk(page, WALK_LINKS)
    if on_login_page(page):  # вход потерян по дороге — ничего не печатать, иначе повтор выведет список дважды
        return LOST
    data = page.evaluate("() => window.__ilexLinks || {links: {}, paras: {}}")
    links = sorted(data["links"].values(), key=lambda x: x["o"])
    paras = sorted(data["paras"].items(), key=lambda x: x[1][0])
    if words:
        keep = {seg for seg, (_, t) in paras if all(w in t.lower() for w in words)}
        paras = [x for x in paras if x[0] in keep]
        links = [x for x in links if x["seg"] in keep]
    counts = {}
    for x in links:
        counts[x["type"] or "—"] = counts.get(x["type"] or "—", 0) + 1
    lines = [f"\n--- Абзацы: {len(paras)} (сегмент | начало) — сегмент нужен для backlinks --seg ---"]
    lines += [f"M{seg} | {t[:110]}" for seg, (_, t) in paras]
    lines.append(f"\n--- Ссылки: {len(links)} ({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))}) ---")
    lines.append(LINK_TYPES)
    lines.append("абзац | тип | текст ссылки | адрес")
    for x in links:
        if x["ib"] and x["doc"]:
            addr = f"/view-document/{x['ib']}/{x['doc']}" + (f"#M{x['to']}" if x["to"] else "")
        elif x["to"]:
            addr = f"#M{x['to']} (этот документ)"
        else:
            addr = "(без адреса)"
        mark = "+" if x["extra"] else " "
        lines.append(f"{mark}M{x['seg'] or '—'} | {x['type'] or '—'} | {x['text'][:70]} | {addr}")
    out = "\n".join(lines)
    print(page.url)
    print(out[:max_chars])
    if len(out) > max_chars:
        print(f"\n[обрезано: показано {max_chars} из {len(out)} знаков; сузить — --find, больше — --max]")
    if not done:
        print(NOT_TO_END)
    return 0


def cmd_doc(page, url, find, max_chars, full, links, out):
    code = open_doc(page, url)
    if code:
        return code
    words = [w.lower() for w in (find or "").split()]
    if links:
        if out or full:
            print("ilex: --links выводит список ссылок; --out и --full с ним не действуют")
        return print_links(page, words, max_chars)
    # Всегда весь текст: страница подгружает длинный документ частями и середину теряет. --full оставлен для
    # совместимости и только добавляет строку «как получен текст».
    text, how, done = text_by_word(page), "экспорт в Word", True
    if text is None:
        text, done = text_by_scroll(page)
        how = "прокрутка (Word не скачался; оглавление и одинаковые строки вроде «Исключен.» могут смешаться)"
    if on_login_page(page):
        return LOST
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{page.url}\nВесь текст ({how}): {len(text)} знаков → {out}")
        if not words:
            if not done:
                print(NOT_TO_END)
            return 0
    if words:
        low = text.lower()
        hits, pos = [], 0
        while len(hits) < 15:
            j = low.find(words[0], pos)
            if j < 0:
                break
            a, b = max(0, j - 600), j + 1200
            if all(w in low[a:b] for w in words):
                hits.append(text[a:b].strip())
                pos = b  # следующий кусок — после этого, без повторов
            else:
                pos = j + 1
        print(f"{page.url}\nТекст: {how}, {len(text)} знаков. Совпадений «{find}»: {len(hits)}")
        for h in hits:
            print("\n=====\n" + h)
        if not done:
            print(NOT_TO_END)
        return 0
    print(f"{page.url}\nТекст: {how}, {len(text)} знаков")
    print(text[:max_chars])
    if len(text) > max_chars:
        print(f"\n[обрезано: показано {max_chars} из {len(text)} знаков; нужный пункт — через --find]")
    if not done:
        print(NOT_TO_END)
    return 0


# --- «Кто ссылается» (значок (i) у абзаца) и редакции ---

TABS = ["Все", "Законодательство", "Аналитика", "Формы", "Судебная практика"]
LIST_ITEMS = """() => [...document.querySelectorAll('a.document-link[href*="/view-document/"]')].map(a => {
    let e = a, head = '';
    for (let i = 0; i < 10 && e.parentElement; i++) { e = e.parentElement;
        const t = (e.innerText || '').trim(); if (/^\\d{2}\\.\\d{2}\\.\\d{4}/.test(t)) { head = t.split('\\n')[0]; break; } }
    return [a.href, head, (a.innerText || '').replace(/\\s+/g, ' ').trim()]; })"""
SHOWN = """() => (document.body.innerText.match(/Показано[^\\n]*/) || [''])[0]"""


def wait_shown(page, before, timeout_s=20):
    """Дождаться, что строка «Показано …» сменилась (список перерисован)."""
    for _ in range(timeout_s * 2):
        now = page.evaluate(SHOWN)
        if now and now != before:
            return now
        page.wait_for_timeout(500)
    return page.evaluate(SHOWN)


def print_list(page, n):
    for href, head, title in page.evaluate(LIST_ITEMS)[:n]:
        head = re.sub(r"^(\d{2}\.\d{2}\.\d{4})(?=\S)", r"\1 ", head)
        print(f"{head} | {title[:220]} | {clean_href(href)}")


def parse_target(url, seg):
    """(база, номер, сегмент абзаца или None) из адреса документа, backlinks или редакций."""
    m = re.search(r"/(?:view-document|backlinks|editions)/([A-Z]+)/(\d+)(?:/(\d+))?", url)
    if not m:
        return None
    if seg and not re.fullmatch(r"#?[Mm]?\d+", seg.strip()):
        return None
    s = (seg or "").strip().lstrip("#Mm") or (m.group(3) if "/backlinks/" in url else None)
    if not s:
        h = re.search(r"#M(\d+)", url)
        s = h.group(1) if h and h.group(1) != "100001" else None  # #M100001 — начало документа, не абзац
    return m.group(1), m.group(2), s


COUNT = r"""() => { const m = document.body.innerText.match(/Дополнительная информация к [^\n]*\n\s*(\d+)/);
    return m ? m[1] : ''; }"""
EMPTY = "По вашему запросу ничего не найдено"


def open_list(page, url):
    """Открыть страницу «кто ссылается» и дождаться списка. LOST, код ошибки или None."""
    page.goto(url, wait_until="domcontentloaded")
    if wait_text(page, ["Показано", EMPTY]) is None:
        if on_login_page(page):
            return LOST
        print("ilex: список не загрузился за 25 с")
        return 5
    page.wait_for_timeout(1000)
    return None


def click_tab(page, name):
    """Открыть вкладку списка. None — вкладки нет, "empty" — в ней ничего, "ok" — открыта.
    Пустая вкладка бывает недоступной кнопкой или страницей «ничего не найдено» — тогда кнопки вкладок пропадают."""
    btn = page.locator("button.filter-section", has_text=name).first
    if not btn.count():
        return None
    if btn.is_disabled():
        return "empty"
    if "selected" in (btn.get_attribute("class") or ""):
        return "ok"
    before = page.evaluate(SHOWN)
    btn.click()
    for _ in range(40):
        page.wait_for_timeout(500)
        if EMPTY in page.evaluate("() => document.body.innerText"):
            return "empty"
        now = page.evaluate(SHOWN)
        if now and now != before:
            break
    page.wait_for_timeout(800)
    return "ok"


def cmd_backlinks(page, url, seg, tab, pg, n):
    target = parse_target(full_url(url), seg)
    if not target:
        print("ilex: нужен адрес документа вида /view-document/BELAW/<номер>[#M<сегмент>], --seg — M<цифры>")
        return 5
    ib, doc, s = target
    list_url = f"{BASE}/backlinks/{ib}/{doc}" + (f"/{s}" if s else "")
    code = open_list(page, list_url)
    if code:
        return code
    text = page.evaluate("() => document.body.innerText")
    i = text.find("Дополнительная информация к")
    j = text.find("\nВсе", i) if i >= 0 else -1
    head = text[i:j if j > 0 else i + 300].strip() if i >= 0 else ""
    print(page.url + "\n" + head)
    if not tab:  # сколько в каждой вкладке — чтобы решить, куда смотреть
        counts = []
        for name in TABS[1:]:
            state = click_tab(page, name)
            if state is None:  # после пустой вкладки кнопок нет — открыть список заново
                code = open_list(page, list_url)
                if code:
                    return code
                state = click_tab(page, name)
            if state == "ok":
                counts.append(f"{name} {page.evaluate(COUNT) or '?'}")
            elif state == "empty":
                counts.append(f"{name} 0")
        print("Вкладки: " + ", ".join(counts))
        if click_tab(page, "Все") != "ok":
            code = open_list(page, list_url)
            if code:
                return code
    else:
        state = click_tab(page, tab)
        if state is None:
            print(f"ilex: нет вкладки «{tab}»" + (" (список пуст)" if EMPTY in page.evaluate("() => document.body.innerText") else ""))
            return 5
        if state == "empty":
            print(f"\n--- {tab}: ничего нет ---")
            return 0
    for _ in range(pg - 1):
        nxt = page.locator("button.mat-mdc-paginator-navigation-next").first
        if not nxt.count() or nxt.is_disabled():
            break
        before = page.evaluate(SHOWN)
        nxt.evaluate("e => e.click()")
        wait_shown(page, before)
        page.wait_for_timeout(800)
    if on_login_page(page):
        return LOST
    print(f"\n--- {tab or 'Все'}: {page.evaluate(SHOWN)} (свежие сверху; следующие 25 — --page) ---")
    print("дата и состояние | название | адрес")
    print_list(page, n)
    return 0


def cmd_editions(page, url, n):
    code = open_doc(page, url)
    if code:
        return code
    icon = page.locator("mat-icon[data-mat-icon-name*='redactions']").first
    if not icon.count():
        print(f"{page.url}\nilex: у документа нет списка редакций")
        return 0
    icon.evaluate("e => (e.closest('button') || e).click()")
    if wait_text(page, ["Список редакций"]) is None:
        if on_login_page(page):
            return LOST
        print("ilex: список редакций не загрузился за 25 с")
        return 5
    page.wait_for_timeout(1500)
    print(page.url + "\n--- Редакции: дата редакции и состояние | название | адрес ---")
    print_list(page, n)
    return 0


def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="ilex: поиск и чтение документов")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--n", type=int, default=15)
    d = sub.add_parser("doc")
    d.add_argument("url")
    d.add_argument("--find")
    d.add_argument("--max", type=int, default=20000)
    d.add_argument("--full", action="store_true")
    d.add_argument("--links", action="store_true")
    d.add_argument("--out")
    b = sub.add_parser("backlinks")
    b.add_argument("url")
    b.add_argument("--seg")
    b.add_argument("--tab", choices=TABS)
    b.add_argument("--page", type=int, default=1)
    b.add_argument("--n", type=int, default=25)
    e = sub.add_parser("editions")
    e.add_argument("url")
    e.add_argument("--n", type=int, default=30)
    args = ap.parse_args()

    os.makedirs(HOME, exist_ok=True)
    try:
        with Lock():
            return run(args)
    except Busy:
        print(f"ilex: другая сессия занимает ilex дольше {LOCK_WAIT_S} с — повторите позже")
        return 6
    except PlaywrightError as e:
        print("ilex: страница не загрузилась: " + str(e).splitlines()[0])
        return 5


def run(args):
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(PROFILE, channel="msedge", headless=True, accept_downloads=True,
                                                   viewport={"width": 1400, "height": 1000})
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.set_default_timeout(30000)
            state = load_state()
            if args.cmd == "status":
                ok = check_login(page)
                print(json.dumps({"учётные_данные_windows": bool(read_credential()), "вход": ok,
                                  "программа_входила": state.get("last_login")}, ensure_ascii=False))
                return 0 if ok else 3
            code = ensure_login(page, state)
            if code:
                return code
            for attempt in range(2):
                if args.cmd == "search":
                    code = cmd_search(page, args.query, args.n)
                elif args.cmd == "doc":
                    code = cmd_doc(page, args.url, args.find, args.max, args.full, args.links, args.out)
                elif args.cmd == "backlinks":
                    code = cmd_backlinks(page, args.url, args.seg, args.tab, args.page, args.n)
                else:
                    code = cmd_editions(page, args.url, args.n)
                if code != LOST:
                    return code
                if attempt == 0:  # вход потеряли по дороге — войти (если лимит позволяет) и повторить раз
                    code = ensure_login(page, state, lost=True)
                    if code:
                        return code
            print("ilex: вход теряется сразу после входа — повторите позже")
            return 3
        finally:
            ctx.close()


if __name__ == "__main__":
    sys.exit(main())
