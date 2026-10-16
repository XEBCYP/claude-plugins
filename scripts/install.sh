#!/usr/bin/env bash
# Подключает маркетплейс xebcyp-plugins к Claude Code (Linux / macOS).
# На Linux/macOS включает Python-версию навыков 1С (1c-skills-py) вместо PowerShell-версии.
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
plugins = template["enabledPlugins"]
# PowerShell-версия навыков 1С здесь не нужна — ставим Python-порт.
plugins.pop("1c-skills@xebcyp-plugins", None)
plugins["1c-skills-py@xebcyp-plugins"] = True
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

python3 -c 'import lxml, PIL, psutil' 2>/dev/null || python3 -m pip install --user -q 'lxml>=4.9.0' 'Pillow>=10.0.0' 'psutil>=5.9.0' || true
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then gh auth setup-git; fi
for t in node python3 git unzip; do command -v "$t" >/dev/null || echo "Внимание: не найден $t"; done
echo "Готово. Перезапустите Claude Code."
