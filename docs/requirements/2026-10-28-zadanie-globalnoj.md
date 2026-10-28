Effort: medium

Task from the claude-plugins session (audit packets 4–5, ADR 0018 of claude-plugins; and packets 6–7, ADR 0019; plugins sreda 1.13.0, autohandoff 2.5.0, delivery-control 1.2.1 — installed and loaded 28.10.2026 10:10). You are the SAMPLE project: do your own files first, report, and only after the user's OK send the same to the subprojects.

User's words (verbatim, 28.10.2026, chosen option): «В проектах: глобальной сессии — задание перенести свой журнал и План.md (оглавление открытых R, статусы «передано → сделано → установлено → проверено вами») и скрипт «передано, но не сделано»; ей же — разослать перенос журналов подпроектам; Export1c7 — своей сессии. Сначала образец на одном проекте, потом остальные.» Also: «журнал проекта делится на «Текущее состояние» (до ~150 строк, читается при старте) и «Историю» (только дописывается, при старте не читается), коммит журнала при передаче».

Rules: sreda:kak-rabotat section 8 («Журнал проекта — два файла»), sreda:globalnyj-proekt section 2 (statuses of R, coverage script), templates in globalnyj-proekt/shablony.md.

What to do (your own repo only):
1. docs/Передача_сессии.md → current state only (≤150 lines, template «Текущее состояние»). Everything else moves verbatim to docs/История_сессий.md (append-only, nothing deleted — move, don't summarize away). CLAUDE.md «С чего начать сессию»: read the current state, never the history.
2. docs/План.md: normalize the «Состояние» cell of every R to the new statuses (open / передано / в работе / частично / сделано / установлено / проверено / заглушка / отложено / снято); old «готово», «done», «исправлено…» — decide per row from the registry and subproject reports; «проверено» only where the user confirmed (date + quote). The first table (R01–R49, 24.10) still says «open» everywhere — update it or point each row to its later entry. Then run `node "C:/Users/sa.zakhar/.claude/plugins/cache/xebcyp-plugins/sreda/1.13.0/skills/globalnyj-proekt/pokrytie.mjs" docs/План.md --write` to insert the TOC of open R. Do not change requirement quotes.
3. Run the script without flags; send the user (via your window) the «Передано, но не сделано» and «Сделано, но не установлено» lists in plain Russian.
4. Commit your files by name (not git add -A).

How to check (one line per requirement):
- «Текущее состояние (до ~150 строк, читается при старте)» → `wc -l docs/Передача_сессии.md` ≤ 150; a fresh session start reads only it.
- «Историю (только дописывается, при старте не читается)» → История_сессий.md contains all old text (diff of old journal vs history+current = nothing lost); CLAUDE.md doesn't tell to read it.
- «коммит журнала при передаче» → CLAUDE.md / your routine says so; no per-event commits.
- «оглавление открытых R» → block between the markers exists, produced by the script.
- «статусы передано → сделано → установлено → проверено вами» → script reports 0 «Статус не распознан» and 0 old «готово».
- «скрипт «передано, но не сделано»» → its output shown to the user.
- «Сначала образец на одном проекте, потом остальные» → report to the claude-plugins session (local_001f12e5-1859-4e96-80ee-55467f9ab06d) and do NOT send anything to subprojects yet.

Report back (5–15 lines, English) by message to local_001f12e5-1859-4e96-80ee-55467f9ab06d: line counts before/after, commit, script summary, anything decided per row that the user should confirm.

NOT NOW — for your information only; the claude-plugins session will send it after the user's OK on this sample. Packets 6–7 (ADR 0019 of claude-plugins). User's answer (verbatim, 28.10.2026) to the window «Работу внутри самих проектов плагин сделать не может: скрипты выкладки в FlowerCore и MobileData1C7, предфильтр фото скриптом в КарточкиРастений (размер, водяные знаки, дубли — до просмотра моделью), ускорение повторяющихся прогонов и карта кода помощника переноса в Export1c7. Когда их раздать?» — «После установки, с образцом 4–5 (рекомендую)». After the OK: journal transfer to all subprojects (same steps 1–4 above); deploy scripts for FlowerCore and MobileData1C7 from the template `sreda/skills/kak-rabotat/vykladka-shablon.ps1` (they change the production server — rollback script and the user's consent first); photo prefilter script in КарточкиРастений. Export1c7 is not your subproject — its own session gets it from claude-plugins.
