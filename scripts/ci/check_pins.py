"""Не вышли ли новые версии сторонних плагинов и пакетов.

Сравнивает закреплённые sha в marketplace.json с текущим коммитом исходных репозиториев (git ls-remote) и
версию @theyahia/aprovodka из plugins/onec-odata/server/package.json с последней в npm. Ничего не обновляет:
печатает отчёт в Markdown; при расхождениях — код 3 (для CI: открыть issue «проверить и обновить»).

    python scripts/ci/check_pins.py [marketplace.json] > report.md
"""
import json
import os
import subprocess
import sys

# Консоль раннера Windows — cp1252; без этого print с кириллицей падает (UnicodeEncodeError).
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

KNOWN_RISKS = """\
Известные риски, которые надо перепроверить при обновлении (см. AUDIT.md):
- `bsl-language-server`: хук при старте сессии скачивает последний релиз BSL Language Server без проверки
  контрольной суммы;
- `1c-skills`, навык `web-publish`: может скачать Apache с apachelounge.com без проверки контрольной суммы."""


def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", shell=(os.name == "nt"))
    return r.stdout.strip() if r.returncode == 0 else None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".claude-plugin", "marketplace.json")
    market = json.load(open(path, encoding="utf-8"))
    rows, stale = [], []
    for p in market["plugins"]:
        src = p["source"]
        if not isinstance(src, dict) or "sha" not in src:
            continue
        ref = src.get("ref", "HEAD")
        out = run("git", "ls-remote", src["url"], ref if ref == "HEAD" else f"refs/heads/{ref}")
        head = out.split()[0] if out else None
        state = "ошибка ls-remote" if head is None else ("актуально" if head == src["sha"] else "**есть новее**")
        if head != src["sha"]:
            stale.append(p["name"])
        rows.append(f"| `{p['name']}` | {src['url']} `{ref}` | `{src['sha'][:7]}` | `{(head or '?')[:7]}` | {state} |")

    pkg_path = os.path.join(ROOT, "plugins", "onec-odata", "server", "package.json")
    pinned = json.load(open(pkg_path, encoding="utf-8"))["dependencies"]["@theyahia/aprovodka"]
    latest = run("npm", "view", "@theyahia/aprovodka", "version")
    state = "ошибка npm" if latest is None else ("актуально" if latest == pinned else "**есть новее**")
    if latest != pinned:
        stale.append("onec-odata (aprovodka)")
    rows.append(f"| `onec-odata` | npm `@theyahia/aprovodka` | `{pinned}` | `{latest or '?'}` | {state} |")

    print("| Плагин | Источник | Закреплено | Сейчас | Итог |\n|---|---|---|---|---|")
    print("\n".join(rows))
    print()
    if stale:
        print(f"Расходятся: {', '.join(stale)}. Проверьте новые коммиты и версии так же, как в AUDIT.md, и только "
              "потом меняйте `sha` в marketplace.json или lock-файл onec-odata.\n")
    print(KNOWN_RISKS)
    sys.exit(3 if stale else 0)


if __name__ == "__main__":
    main()
