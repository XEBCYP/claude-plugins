#!/usr/bin/env python3
"""Иконки Lucide и Tabler для офлайн-интерфейсов: проверка имён, SVG-спрайт, отдельные SVG-файлы.

Имя иконки: `book-open` или `lucide:book-open` (Lucide), `tabler:file-invoice`,
`tabler-filled:circle-check`. Набор из таблицы соответствия 1С: `--map all` или
`--map meta,biz` (группы: meta, v77, biz, status, cmd).

  python icons.py check lucide:book-open tabler:file-invoice
  python icons.py sprite --out www/icons.svg --map status,cmd tabler:cash-register
  python icons.py files --dir src/icons lucide:warehouse
  python icons.py search ruble

Источник SVG: node_modules проекта (lucide-static, @tabler/icons), иначе архив npm
закреплённой версии; архив проверяется по sha512 из реестра npm и кэшируется.
Только стандартная библиотека Python 3.8+.
"""
import argparse
import base64
import difflib
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSIONS = {"lucide": "1.49.0", "tabler": "3.48.0"}
PACKAGES = {"lucide": "lucide-static", "tabler": "@tabler/icons"}
# Каталог SVG внутри npm-пакета для каждого набора.
SVG_DIRS = {"lucide": "icons", "tabler": "icons/outline", "tabler-filled": "icons/filled"}
LICENSES = {"lucide": "Lucide (ISC) https://lucide.dev", "tabler": "Tabler Icons (MIT) https://tabler.io/icons"}
MAP_PATH = Path(__file__).resolve().parent.parent / "references" / "1c-icon-map.json"
CACHE_DIR = Path(os.environ.get("UI_ICONS_CACHE") or Path.home() / ".cache" / "ui-icons")


def package_of(lib):
    return "tabler" if lib.startswith("tabler") else lib


def parse_name(spec):
    lib, _, name = spec.partition(":") if ":" in spec else ("lucide", "", spec)
    if lib not in SVG_DIRS:
        sys.exit(f"Неизвестный набор «{lib}» в «{spec}»: допустимы lucide, tabler, tabler-filled")
    return lib, name.strip().lower()


def find_node_modules(pkg):
    for d in [Path.cwd(), *Path.cwd().parents]:
        p = d / "node_modules" / pkg
        if (p / "package.json").exists():
            return p
    return None


class Source:
    """SVG одного npm-пакета: из node_modules или из проверенного архива."""

    def __init__(self, pkg_key, offline=False):
        self.pkg = PACKAGES[pkg_key]
        self.dir = find_node_modules(self.pkg)
        self.files = None
        if self.dir:
            self.version = json.loads((self.dir / "package.json").read_text(encoding="utf-8"))["version"]
            self.origin = f"node_modules/{self.pkg}@{self.version}"
        else:
            self.version = VERSIONS[pkg_key]
            self.origin = f"npm {self.pkg}@{self.version}"
            self.files = self._load_tarball(offline)

    def _load_tarball(self, offline):
        safe = self.pkg.replace("/", "__").replace("@", "")
        tgz = CACHE_DIR / f"{safe}-{self.version}.tgz"
        if not tgz.exists():
            if offline:
                sys.exit(f"Нет {self.pkg}@{self.version} ни в node_modules, ни в кэше {CACHE_DIR}")
            meta_url = f"https://registry.npmjs.org/{self.pkg.replace('/', '%2F')}/{self.version}"
            with urllib.request.urlopen(meta_url, timeout=60) as r:
                dist = json.load(r)["dist"]
            with urllib.request.urlopen(dist["tarball"], timeout=120) as r:
                blob = r.read()
            algo, _, digest = dist["integrity"].partition("-")
            if algo != "sha512" or base64.b64encode(hashlib.sha512(blob).digest()).decode() != digest:
                sys.exit(f"Архив {self.pkg}@{self.version} не совпал с контрольной суммой реестра npm")
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tgz.write_bytes(blob)
        files = {}
        with tarfile.open(fileobj=io.BytesIO(tgz.read_bytes()), mode="r:gz") as tar:
            for m in tar.getmembers():
                if m.isfile() and m.name.endswith(".svg") and m.name.startswith("package/icons/"):
                    files[m.name[len("package/"):]] = tar.extractfile(m).read().decode("utf-8")
        return files

    def names(self, lib):
        sub = SVG_DIRS[lib] + "/"
        if self.files is not None:
            return {k[len(sub):-4] for k in self.files if k.startswith(sub) and "/" not in k[len(sub):]}
        d = self.dir / SVG_DIRS[lib]
        return {p.stem for p in d.glob("*.svg")} if d.exists() else set()

    def svg(self, lib, name):
        rel = f"{SVG_DIRS[lib]}/{name}.svg"
        if self.files is not None:
            return self.files.get(rel)
        p = self.dir / rel
        return p.read_text(encoding="utf-8") if p.exists() else None


class Icons:
    def __init__(self, offline=False):
        self.offline = offline
        self.sources = {}

    def source(self, lib):
        key = package_of(lib)
        if key not in self.sources:
            self.sources[key] = Source(key, self.offline)
        return self.sources[key]

    def resolve(self, specs):
        """Возвращает [(lib, name, svg)]; при ошибочных именах печатает подсказки и выходит."""
        found, bad = [], []
        for spec in dict.fromkeys(specs):
            lib, name = parse_name(spec)
            svg = self.source(lib).svg(lib, name)
            if svg is None:
                hints = difflib.get_close_matches(name, self.source(lib).names(lib), n=5, cutoff=0.5)
                bad.append(f"  {lib}:{name} — нет такой иконки" + (f"; похожие: {', '.join(hints)}" if hints else ""))
            else:
                found.append((lib, name, svg))
        if bad:
            sys.exit("Неизвестные иконки:\n" + "\n".join(bad))
        return found


def map_specs(groups, prefer):
    data = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    wanted = set(data["groups"]) if groups == "all" else set(groups.split(","))
    unknown = wanted - set(data["groups"])
    if unknown:
        sys.exit(f"Нет групп {', '.join(sorted(unknown))}; есть: {', '.join(data['groups'])}")
    return [f"{prefer}:{it[prefer]}" for it in data["items"] if it["group"] in wanted]


def parse_svg(svg):
    m = re.search(r"<svg\b([^>]*)>(.*)</svg>", svg, re.S)
    attrs = dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
    inner = re.sub(r"<!--.*?-->", "", m.group(2), flags=re.S)
    # У Tabler первый path — прозрачная рамка 24×24, в спрайте она не нужна.
    inner = re.sub(r'<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*/>', "", inner)
    inner = re.sub(r">\s+<", "><", inner).strip()
    return attrs, inner


def symbol(lib, name, svg, stroke):
    attrs, inner = parse_svg(svg)
    keep = {"viewBox": attrs.get("viewBox", "0 0 24 24")}
    if attrs.get("fill") == "currentColor":
        keep["fill"] = "currentColor"
    else:
        keep.update({"fill": "none", "stroke": "currentColor", "stroke-width": stroke,
                     "stroke-linecap": "round", "stroke-linejoin": "round"})
    a = " ".join(f'{k}="{v}"' for k, v in keep.items())
    return f'<symbol id="{lib}-{name}" {a}>{inner}</symbol>'


def license_comment(icons, sources):
    used = sorted({package_of(lib) for lib, _, _ in icons})
    parts = [f"{LICENSES[k]}, {sources[k].origin}" for k in used]
    return "<!-- " + "; ".join(parts) + " -->"


def collect(args):
    specs = list(args.names)
    if args.map:
        specs += map_specs(args.map, args.prefer)
    if args.from_file:
        for line in Path(args.from_file).read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                specs.append(line)
    if not specs:
        sys.exit("Не задано ни одной иконки")
    return specs


def cmd_check(args):
    ic = Icons(args.offline)
    found = ic.resolve(collect(args))
    for k, s in ic.sources.items():
        print(f"{k}: {s.origin}")
    print(f"Все {len(found)} иконок найдены.")


def cmd_sprite(args):
    ic = Icons(args.offline)
    found = ic.resolve(collect(args))
    body = "".join(symbol(lib, name, svg, args.stroke) for lib, name, svg in found)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = (license_comment(found, ic.sources) + "\n"
            '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">' + body + "</svg>\n")
    out.write_text(text, encoding="utf-8", newline="\n")
    print(f"{out}: {len(found)} иконок, {len(text.encode('utf-8')) // 1024 + 1} КБ. id: <библиотека>-<имя>, "
          f"например #{found[0][0]}-{found[0][1]}")


def cmd_files(args):
    ic = Icons(args.offline)
    found = ic.resolve(collect(args))
    d = Path(args.dir)
    d.mkdir(parents=True, exist_ok=True)
    for lib, name, svg in found:
        attrs, inner = parse_svg(svg)
        sym = symbol(lib, name, svg, args.stroke)
        head = re.search(r"<symbol id=\"[^\"]+\" ([^>]*)>", sym).group(1)
        (d / f"{lib}-{name}.svg").write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" {head}>{inner}</svg>\n',
            encoding="utf-8", newline="\n")
    (d / "LICENSES.txt").write_text(license_comment(found, ic.sources)[5:-4] + "\n", encoding="utf-8")
    print(f"{d}: {len(found)} файлов")


def cmd_search(args):
    ic = Icons(args.offline)
    q = args.query.lower()
    for lib in ("lucide", "tabler", "tabler-filled"):
        hits = sorted(n for n in ic.source(lib).names(lib) if q in n)
        print(f"{lib} ({len(hits)}): {' '.join(hits[:60])}{' …' if len(hits) > 60 else ''}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, names=True):
        if names:
            sp.add_argument("names", nargs="*", help="иконки: имя, lucide:имя, tabler:имя, tabler-filled:имя")
            sp.add_argument("--map", help="группы из 1c-icon-map.json через запятую или all")
            sp.add_argument("--prefer", choices=["lucide", "tabler"], default="lucide",
                            help="какую колонку брать из таблицы 1С (по умолчанию lucide)")
            sp.add_argument("--from-file", help="файл со списком иконок, по одной в строке")
        sp.add_argument("--offline", action="store_true", help="не ходить в сеть, только node_modules и кэш")

    sp = sub.add_parser("check", help="проверить, что иконки существуют")
    common(sp)
    sp.set_defaults(func=cmd_check)
    sp = sub.add_parser("sprite", help="собрать SVG-спрайт из <symbol>")
    common(sp)
    sp.add_argument("--out", required=True)
    sp.add_argument("--stroke", default="2", help="толщина линии (по умолчанию 2)")
    sp.set_defaults(func=cmd_sprite)
    sp = sub.add_parser("files", help="записать отдельные SVG-файлы")
    common(sp)
    sp.add_argument("--dir", required=True)
    sp.add_argument("--stroke", default="2")
    sp.set_defaults(func=cmd_files)
    sp = sub.add_parser("search", help="найти иконки по части имени")
    sp.add_argument("query")
    common(sp, names=False)
    sp.set_defaults(func=cmd_search)

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
