#!/usr/bin/env bash
# Подключает маркетплейс xebcyp-plugins к Claude Code (Linux / macOS).
# Навыки 1С (1c-skills, 1c-skills-py) глобально выключены — их включает .claude/settings.json проекта 1С.
# В ~/.claude/CLAUDE.md ставит или обновляет блок общих правил из templates/user-CLAUDE.md.
#
#   curl -fsSL https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/scripts/install.sh | bash
set -euo pipefail

BASE_URL="https://raw.githubusercontent.com/XEBCYP/claude-plugins/main"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CLAUDE_DIR"

# Запуск из клона — шаблоны берутся рядом (можно проверить правку до пуша); через curl | bash — из main.
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
template() {
  if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/templates/$1" ]; then cat "$SRC_DIR/templates/$1"
  else curl -fsSL "$BASE_URL/templates/$1"; fi
}

TEMPLATE="$(template user-settings.json)"
TEMPLATE="$TEMPLATE" python3 - "$CLAUDE_DIR/settings.json" <<'PY'
import copy, json, os, shutil, sys, time
path = sys.argv[1]
template = json.loads(os.environ["TEMPLATE"])
# utf-8-sig: файл, сохранённый в Windows с BOM, тоже читается.
settings = json.load(open(path, encoding="utf-8-sig")) if os.path.exists(path) else {}
original = copy.deepcopy(settings) if os.path.exists(path) else None
OWN = "xebcyp-plugins"
added, updated, differs = [], [], []
for section in ("extraKnownMarketplaces", "enabledPlugins"):
    dst = settings.setdefault(section, {})
    for k, v in template[section].items():
        if k not in dst:
            dst[k] = v
            added.append(f"{section}.{k}")
        elif section == "extraKnownMarketplaces" and k == OWN and dst[k].get("source") != v["source"]:
            dst[k]["source"] = v["source"]  # адрес своего маркетплейса — всегда из шаблона
            updated.append(f"{section}.{k}.source")
        elif dst[k] != v:
            differs.append(f"{section}.{k}: у вас {json.dumps(dst[k], ensure_ascii=False)}, в шаблоне {json.dumps(v, ensure_ascii=False)}")
# Резервная копия и запись — только если содержимое меняется.
if settings != original:
    if original is not None:
        shutil.copy(path, path + time.strftime(".bak-%Y%m%d-%H%M%S"))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)
        f.write("\n")
if added: print("Добавлено:", *added, sep="\n  + ")
if updated: print("Обновлено:", *updated, sep="\n  ~ ")
if not (added or updated): print("Всё уже было настроено.")
if differs: print("Отличается от шаблона (оставлено как есть):", *differs, sep="\n  = ")
PY

# Общие правила в ~/.claude/CLAUDE.md: блок между метками ставится или заменяется, остальной текст не трогается.
BLOCK="$(template user-CLAUDE.md)"
BLOCK="$BLOCK" python3 - "$CLAUDE_DIR/CLAUDE.md" <<'PY'
import os, re, shutil, sys, time
path = sys.argv[1]
block = os.environ["BLOCK"].strip()
pattern = re.compile(r"<!-- xebcyp-plugins:begin.*?<!-- xebcyp-plugins:end -->", re.S)
if os.path.exists(path):
    md = open(path, encoding="utf-8").read()
    new = pattern.sub(lambda m: block, md) if pattern.search(md) else md.rstrip() + "\n\n" + block + "\n"
    if new != md:
        shutil.copy(path, path + time.strftime(".bak-%Y%m%d-%H%M%S"))
        open(path, "w", encoding="utf-8").write(new)
        print("Обновлён блок общих правил в", path)
    else:
        print("Общие правила уже актуальны:", path)
else:
    open(path, "w", encoding="utf-8").write("# Общие правила для всех проектов\n\n" + block + "\n")
    print("Создан", path)
PY

# Пакеты для 1c-skills-py. На Debian 12 / Ubuntu 23.04+ (PEP 668) обычный --user запрещён — пробуем с
# --break-system-packages, затем без --user (внутри venv); не вышло — говорим об этом.
PKGS=('lxml>=4.9.0' 'Pillow>=10.0.0' 'psutil>=5.9.0')
python3 -c 'import lxml, PIL, psutil' 2>/dev/null \
  || python3 -m pip install --user -q "${PKGS[@]}" 2>/dev/null \
  || python3 -m pip install --user -q --break-system-packages "${PKGS[@]}" 2>/dev/null \
  || python3 -m pip install -q "${PKGS[@]}" 2>/dev/null \
  || echo "Внимание: не удалось поставить lxml, Pillow, psutil — навыки 1c-skills-py работать не будут." >&2
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then gh auth setup-git; fi
for t in node python3 git unzip; do command -v "$t" >/dev/null || echo "Внимание: не найден $t"; done
echo "Готово. Перезапустите Claude Code."
