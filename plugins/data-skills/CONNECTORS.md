# Connectors

## How tool references work

Skill files use `~~category` as a placeholder for whatever tool is connected in that category. In this
marketplace the plugin ships **without** its own `.mcp.json` (the original Snowflake/BigQuery/Hex/Amplitude/Jira
connectors were removed, see AUDIT.md) — the data comes from the database plugins of the same marketplace or from
any MCP server you connect yourself.

## Connectors in xebcyp-plugins

| Category | Placeholder | Use | What it gives |
|----------|-------------|-----|---------------|
| Data warehouse (SQL) | `~~data warehouse` | `dbhub@xebcyp-plugins` | Read-only SQL: PostgreSQL, MySQL, MariaDB, MS SQL, Oracle, SQLite (up to 1000 rows) |
| 1C:Enterprise 8.x data | `~~data warehouse` | `onec-odata@xebcyp-plugins` | Catalogs, documents, registers, entries of a live 1C base over standard OData |

Both are disabled until a connection is set: enable them in `/plugin` and Claude Code asks for the DSN or the
OData address, user and password.

Not connected here: `~~notebook`, `~~product analytics`, `~~project tracker`. Without a connector, paste query
results or attach CSV/Excel files — the skills work with them too.
