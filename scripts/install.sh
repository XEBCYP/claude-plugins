#!/usr/bin/env bash
# Подключает маркетплейс xebcyp-plugins к Claude Code (Linux / macOS).
# Навыки 1С (1c-skills, 1c-skills-py) глобально выключены — их включает .claude/settings.json проекта 1С.
# В ~/.claude/CLAUDE.md ставит или обновляет блок общих правил из templates/user-CLAUDE.md.
#
#   curl -fsSL https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/scripts/install.sh | bash
set -euo pipefail

TEMPLATE_URL="https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/templates/user-settings.json"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CLAUDE_DIR"

TEMPLATE="$(curl -fsSL "$TEMPLATE_URL")"
[ -f "$CLAUDE_DIR/settings.json" ] && cp "$CLAUDE_DIR/settings.json" "$CLAUDE_DIR/settings.json.bak-$(date +%Y%m%d-%H%M%S)"

TEMPLATE="$TEMPLATE" python3 - "$CLAUDE_DIR/settings.json" <<'PY'
import json, os, sys
path = sys.argv[1]
template = json.loads(os.environ["TEMPLATE"])
settings = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
added = []
for section in ("extraKnownMarketplaces", "enabledPlugins"):
    dst = settings.setdefault(section, {})
    for k, v in template[section].items():
        if k not in dst:
            dst[k] = v
            added.append(f"{section}.{k}")
with open(path, "w", encoding="utf-8") as f:
    json.dump(settings, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("Добавлено:" if added else "Всё уже было настроено.", *added, sep="\n  + ")
PY

# Общие правила в ~/.claude/CLAUDE.md: блок между метками ставится или заменяется, остальной текст не трогается.
MD_URL="https://raw.githubusercontent.com/XEBCYP/claude-plugins/main/templates/user-CLAUDE.md"
BLOCK="$(curl -fsSL "$MD_URL")"
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
