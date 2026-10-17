"""Проверка результата установщика во временной CLAUDE_CONFIG_DIR.

    python scripts/ci/check_install.py <config-dir> [--seeded]

Без --seeded: settings.json содержит все записи шаблона как есть, CLAUDE.md — блок общих правил.
С --seeded: дополнительно сохранены чужие ключи из scripts/ci/seed-settings.json, а адрес своего
маркетплейса обновлён на адрес из шаблона.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load(path):
    return json.load(open(path, encoding="utf-8-sig"))


def main():
    cfg = sys.argv[1]
    seeded = "--seeded" in sys.argv
    template = load(os.path.join(ROOT, "templates", "user-settings.json"))
    settings = load(os.path.join(cfg, "settings.json"))
    errors = []
    seed = load(os.path.join(ROOT, "scripts", "ci", "seed-settings.json")) if seeded else {}
    for section in ("extraKnownMarketplaces", "enabledPlugins"):
        for k, v in template[section].items():
            have = settings.get(section, {}).get(k)
            if section == "extraKnownMarketplaces" and k == "xebcyp-plugins":
                if have is None or have.get("source") != v["source"]:
                    errors.append(f"{section}.{k}.source: {have}")
            elif k in seed.get(section, {}):
                if have != seed[section][k]:
                    errors.append(f"{section}.{k}: пользовательское значение не сохранено ({have})")
            elif have != v:
                errors.append(f"{section}.{k}: {have!r} вместо {v!r}")
    for k, v in seed.items():
        if k not in ("extraKnownMarketplaces", "enabledPlugins") and settings.get(k) != v:
            errors.append(f"{k}: чужой ключ изменён ({settings.get(k)!r})")
    md = open(os.path.join(cfg, "CLAUDE.md"), encoding="utf-8").read()
    block = open(os.path.join(ROOT, "templates", "user-CLAUDE.md"), encoding="utf-8").read().strip()
    if md.replace("\r\n", "\n").count(block.replace("\r\n", "\n")) != 1:
        errors.append("CLAUDE.md: блок общих правил отсутствует или повторён")
    if seeded and "Мой текст" not in md:
        errors.append("CLAUDE.md: текст пользователя вне блока потерян")
    if errors:
        sys.exit("Ошибки установки:\n  " + "\n  ".join(errors))
    print(f"Установка в {cfg}: ок")


if __name__ == "__main__":
    main()
