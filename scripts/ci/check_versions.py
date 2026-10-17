"""Изменённый плагин — поднятая версия.

Claude Code хранит свой плагин по полю version, и без новой версии правка не доходит до машин, где он уже стоит.
Для каждого plugins/<плагин>/, где есть изменения между BASE и HEAD, версия в plugin.json должна отличаться
от версии в BASE (новый плагин — проверка не нужна; правки только в evals/ не считаются).

    python scripts/ci/check_versions.py <base-ref>
"""
import json
import subprocess
import sys


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")


def version_at(ref, plugin):
    r = git("show", f"{ref}:plugins/{plugin}/.claude-plugin/plugin.json")
    return json.loads(r.stdout).get("version") if r.returncode == 0 else None


def main():
    base = sys.argv[1]
    diff = git("diff", "--name-only", f"{base}...HEAD", "--", "plugins/")
    if diff.returncode != 0:
        sys.exit(f"git diff {base}...HEAD: {diff.stderr.strip()}")
    # evals/ — тесты навыков, на поведение установленного плагина не влияют.
    plugins = sorted({p.split("/")[1] for p in diff.stdout.split() if p.count("/") >= 2 and p.split("/")[2] != "evals"})
    bad = []
    for plugin in plugins:
        old, new = version_at(base, plugin), version_at("HEAD", plugin)
        if new is None:
            print(f"  {plugin}: удалён или без plugin.json — пропуск")
        elif old is None:
            print(f"  {plugin}: новый плагин {new}")
        elif old == new:
            bad.append(plugin)
            print(f"  {plugin}: изменён, но версия осталась {new}")
        else:
            print(f"  {plugin}: {old} -> {new}")
    if not plugins:
        print("Плагины не менялись.")
    if bad:
        sys.exit(f"Поднимите version в plugin.json: {', '.join(bad)} (см. README, «Выпуск версии»).")


if __name__ == "__main__":
    main()
