#!/usr/bin/env bash
# Прогон установщика во временных CLAUDE_CONFIG_DIR: чистая установка, повторный запуск без изменений,
# установка поверх «старых» настроек (scripts/ci/seed-settings.json).
#
#   bash scripts/ci/test_install.sh bash scripts/install.sh
#   bash scripts/ci/test_install.sh powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY=python; command -v python >/dev/null || PY=python3
TMP="$(mktemp -d)"
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
install_in() { local dir="$1"; shift; CLAUDE_CONFIG_DIR="$(winpath "$dir")" "$@" >"$dir.log" 2>&1 || { cat "$dir.log"; exit 1; }; }

echo "== чистая установка"
mkdir -p "$TMP/fresh"
install_in "$TMP/fresh" "$@"
"$PY" "$HERE/check_install.py" "$(winpath "$TMP/fresh")"

echo "== повторный запуск: файлы не меняются, резервных копий нет"
before="$(cat "$TMP/fresh/settings.json" "$TMP/fresh/CLAUDE.md" | md5sum)"
install_in "$TMP/fresh" "$@"
after="$(cat "$TMP/fresh/settings.json" "$TMP/fresh/CLAUDE.md" | md5sum)"
[ "$before" = "$after" ] || { echo "файлы изменились при повторном запуске"; exit 1; }
if ls "$TMP/fresh" | grep -q '\.bak-'; then echo "лишняя резервная копия:"; ls "$TMP/fresh"; exit 1; fi

echo "== установка поверх старых настроек"
mkdir -p "$TMP/seeded"
cp "$HERE/seed-settings.json" "$TMP/seeded/settings.json"
printf '# Мой текст\n\nправило\n' > "$TMP/seeded/CLAUDE.md"
install_in "$TMP/seeded" "$@"
"$PY" "$HERE/check_install.py" "$(winpath "$TMP/seeded")" --seeded
ls "$TMP/seeded" | grep -q 'settings.json.bak-' || { echo "нет резервной копии изменённого settings.json"; exit 1; }

echo "Установщик прошёл все проверки: $*"
