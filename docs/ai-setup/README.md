# AI setup

How this team used AI on the FilsPay audit, and the configuration behind it.

| Piece | Where | What it does |
|---|---|---|
| Agent instructions | `CLAUDE.md` and `AGENTS.md` | Rewritten during the audit: the inherited versions stated false rules (money in cents, UTC settlement days, `Math.random` for tokens, `INTEGER` money columns, "never change a test") that would have produced several of the bugs fixed here. Now follow the ADRs. `.cursorrules` still carries the old rules and needs the same update |
| Permission rules | `settings.json` (proposed, install as `.claude/settings.json`) | Tests, typecheck, builds and read-only git run freely; changing `packages/money`, committing, pushing, seeding and deploying need a human; secret files can't be read; force-push and hard reset are denied |
| Custom commands | `commands/` (install as `.claude/commands/`) | `/verify-fix` (failing test first, then full suites), `/audit-area` (ADR-checked audit, reproduce before claiming), `/findings-entry` (submission-format entry from facts only) |
| Tool configuration | `mcp.json` (install as `.mcp.json`) | Dilmune Cloud MCP server, used to inspect the hosting server (firewall, alerts, plan limits). GitHub access came from the Claude Code GitHub integration |
| Helper scripts | `scripts/set_passwords.ts`, `ops/deploy.sh`, `ops/loadtest/checkout.js`, `ops/loadtest/scenario.js` | Replace public demo passwords; one-command redeploy; k6 checkout throughput test and fixed simulated-user scenario |

These files sit here rather than in `.claude/` because the AI is not allowed
to edit its own permission settings: a human reviews and installs them:

```bash
mkdir -p .claude && cp docs/ai-setup/settings.json .claude/settings.json
cp -r docs/ai-setup/commands .claude/commands
cp docs/ai-setup/mcp.json .mcp.json
```
