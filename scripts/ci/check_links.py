"""Относительные ссылки в Markdown ведут на существующие файлы.

Битая ссылка в SKILL.md — это указатель, по которому агент ничего не найдёт.

    python scripts/ci/check_links.py
"""
import os
import re
import subprocess
import sys
from urllib.parse import unquote

# Консоль раннера Windows — cp1252; без этого print с кириллицей падает (UnicodeEncodeError).
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

LINK = re.compile(r"\]\(([^)\s]+)\)")


def main():
    # -z: пути с кириллицей приходят как есть, без кавычек и \-экранирования.
    files = subprocess.run(["git", "ls-files", "-z", "*.md"], capture_output=True, text=True, encoding="utf-8",
                           check=True).stdout.split("\0")
    files = [f for f in files if f]
    broken = []
    for f in files:
        text = open(f, encoding="utf-8").read()
        text = re.sub(r"```.*?```", "", text, flags=re.S)  # примеры в блоках кода не проверяем
        for m in LINK.finditer(text):
            target = unquote(m.group(1).split("#")[0])
            if not target or re.match(r"^[a-z]+:", target):
                continue
            if not os.path.exists(os.path.join(os.path.dirname(f), target)):
                broken.append(f"{f}: {m.group(1)}")
    print(f"Проверено файлов: {len(files)}")
    if broken:
        sys.exit("Битые ссылки:\n  " + "\n  ".join(broken))


if __name__ == "__main__":
    main()
