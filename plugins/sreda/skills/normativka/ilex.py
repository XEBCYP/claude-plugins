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
  python ilex.py doc <ссылка> [--find "<слова>"] [--max 20000]
                                             — текст документа; --find — только куски вокруг слов

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


def cmd_doc(page, url, find, max_chars):
    if url.startswith("/"):
        url = BASE + url
    page.goto(url, wait_until="domcontentloaded")
    if settle(page, 4):
        return LOST
    # Длинный документ подгружается частями при прокрутке — крутим, пока текст растёт.
    prev = -1
    for _ in range(30):
        length = page.evaluate("""() => { window.scrollTo(0, document.body.scrollHeight);
            for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
            return document.body.innerText.length; }""")
        if length == prev:
            break
        prev = length
        page.wait_for_timeout(1200)
    if on_login_page(page):
        return LOST
    text = page.evaluate("() => document.body.innerText")
    if len(text.strip()) < 300:
        print(f"{page.url}\nilex: документ не загрузился (на странице {len(text.strip())} знаков)")
        return 5
    words = [w.lower() for w in (find or "").split()]
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
        print(f"{page.url}\nСовпадений «{find}»: {len(hits)}")
        for h in hits:
            print("\n=====\n" + h)
        return 0
    print(page.url)
    print(text[:max_chars])
    if len(text) > max_chars:
        print(f"\n[обрезано: показано {max_chars} из {len(text)} знаков; нужный пункт — через --find]")
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
        ctx = p.chromium.launch_persistent_context(PROFILE, channel="msedge", headless=True,
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
                else:
                    code = cmd_doc(page, args.url, args.find, args.max)
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
