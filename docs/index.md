# 🛡️ Mantior Documentation

Mantior is an AI agent that automatically fixes breaking API changes in consumer codebases.

## What is Mantior?

Mantior:

1. **Scans** your API specification changes (live spec vs. your pinned spec)
2. **Detects** breaking changes (renamed fields, removed endpoints, type changes)
3. **Scans** your consumer repositories (web apps, backends, microservices)
4. **Automatically fixes** the affected code (deterministic rules, LLM fallback)
5. **Opens PRs** with production-ready fixes

## Quick Start

### 1. Install

```bash
npm install -g mantior
```

Or run with Docker:

```bash
docker pull mantior/mantior:latest
```

### 2. Initialize Configuration

```bash
mantior init
```

This creates `mantior.yaml` in your current directory.

### 3. Set Up Your GitHub Token

```bash
echo "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx" > .env
```

### 4. Configure Your API

Edit `mantior.yaml`:

```yaml
api:
  name: "Payment API"
  spec: ./specs/payment-api-v2.yaml
  reference_url: "https://api.payment.io/v1/openapi.json"

consumers:
  - repo: "https://github.com/your-org/web-checkout.git"
    branch: "main"
    language: "typescript"
```

### 5. Run Your First Scan

```bash
mantior scan
```

### 6. Auto-Fix and Open PRs

```bash
mantior fix
```

### 7. Monitor

```bash
mantior status
```

## Configuration Reference

### `mantior.yaml`

| Field | Required | Description |
| :--- | :--- | :--- |
| `api.name` | ✅ | Human-readable API name |
| `api.spec` | ✅ | Path to new OpenAPI spec file |
| `api.reference_url` | ✅ | URL (or local path) to the current/live spec |
| `consumers[]` | ✅ | List of consumer repositories |
| `consumers[].repo` | ✅ | Git URL of the consumer repo |
| `consumers[].branch` | ✅ | Branch to target for PRs |
| `consumers[].language` | ✅ | `typescript`, `python`, `go`, `java`, `ruby` |
| `security.github_token` | ⚠️ | GitHub PAT (or `GITHUB_TOKEN` env) |
| `rules.auto_pr` | ❌ | Auto-open PRs (default `true`) |
| `rules.default_reviewer` | ❌ | GitHub user to request as reviewer |
| `rules.pr_labels` | ❌ | Labels to add to PRs |
| `mappings[]` | ❌ | Custom property mapping rules |
| `notifications.slack_webhook` | ❌ | Slack webhook URL for alerts |

### Environment Variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `GITHUB_TOKEN` | ✅ | GitHub Personal Access Token |
| `GITHUB_WEBHOOK_SECRET` | ⚠️ | Webhook signature secret (production) |
| `SLACK_WEBHOOK` | ❌ | Slack alert webhook |
| `LOG_LEVEL` | ❌ | `debug`, `info`, `warn`, `error` (default `info`) |
| `HEALTH_PORT` | ❌ | Health server port (default `8080`) |
| `OPENAI_API_KEY` | ❌ | LLM fixer fallback |
| `ENABLE_TRACING` | ❌ | OpenTelemetry stub toggle (Phase 2) |

## Commands

| Command | What it does |
| :--- | :--- |
| `mantior init` | Generates a sample `mantior.yaml` |
| `mantior validate` | Checks config syntax and required fields |
| `mantior scan` | Lists breaking changes (read-only) |
| `mantior fix` | Fixes changes and opens PRs |
| `mantior status` | Shows historical metrics and health |
| `mantior logs` | Shows recent activity |
| `mantior autonomy` | Manage autonomy level (1-5) and view decisions |
| `mantior server` | Runs as a daemon (health + metrics + webhooks) |

## Troubleshooting

- **"GITHUB_TOKEN is not set"** — create a `.env` file with `GITHUB_TOKEN=ghp_...`
- **"Config file not found"** — run `mantior init`, or pass `--config ./path/to/mantior.yaml`
- **"No breaking changes detected"** — check that `reference_url` points at the live spec, your local spec is the new version, and you have read access
- **"Failed to clone repository"** — verify the URL, that the token has read access, and that the branch exists

## Security

Mantior verifies GitHub webhooks using HMAC-SHA256 (`X-Hub-Signature-256`). Always set:

```bash
GITHUB_WEBHOOK_SECRET=your-secret-here
```

In production, requests without a valid signature are rejected.

## Cost Controls (LLM)Mantior guards OpenAI spend with hard caps — LLM calls **stop entirely** once a limit is hit:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MANTIOR_MAX_COST_PER_SCAN` | `10` | Max LLM cost per scan run (USD) |
| `MANTIOR_MAX_COST_PER_DAY` | `100` | Max LLM cost per day (HARD STOP, USD) |
| `MANTIOR_MAX_COST_PER_MONTH` | `500` | Max LLM cost per month (USD) |
| `MANTIOR_COST_ALERT_THRESHOLD` | `0.8` | Alert at this fraction of the daily limit |
| `LLM_MAX_CONCURRENT` | `2` | Max concurrent LLM calls |
| `LLM_CALLS_PER_MINUTE` | `120` | Max LLM calls per minute |

Costs are persisted in SQLite (`metrics` table, `llm_cost`) so limits survive restarts. The fixer also routes each call to the **cheapest capable model** (gpt-4o-mini → gpt-4o → gpt-4-turbo-preview by complexity) and downgrades when a call would exceed 10% of the remaining daily budget.

## Autonomy Levels

Mantior's autonomy is a 1–5 dial — start at Level 1 or 2, build trust, climb as confidence grows:

| Level | Name | What Mantior does |
| :--- | :--- | :--- |
| 1 | Observe | Monitor only — no changes, no fixes |
| 2 | Recommend | Analyze + locate call sites, propose fixes — nothing applied |
| 3 | Simulate | Apply fixes in the isolated clone, generate diffs — no PRs |
| 4 | Execute with Approval | Open PRs for human review — never auto-merge |
| 5 | Execute Automatically | Auto-execute low-risk, high-confidence (≥90%) changes |

Every decision (change type → effective level → action → confidence) is written to the `autonomy_logs` audit trail in SQLite.

```bash
mantior autonomy --list           # show configuration
mantior autonomy --set 4          # set level (persisted)
mantior autonomy --logs --tail 20 # recent decisions
mantior autonomy --export r.json  # audit report
```

Change-type overrides and per-level confidence thresholds (30/50/70/90) ship in `src/autonomy/levels.ts`; `alwaysRequireApproval` (schema/endpoint removal) and `neverAutomate` lists are enforced regardless of level.

## Database

Mantior stores scan history, PR history, and error logs in `~/.mantior/mantior.db`.
**No source code is ever stored** — all consumer processing is ephemeral (temp clones, then cleanup).

## CI/CD Integration

```yaml
# .github/workflows/mantior.yml
name: Mantior Scan
on:
  push:
    paths:
      - 'specs/**/*.yaml'
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run Mantior
        uses: mantior/action@v1   # published once the action ships
        with:
          config: mantior.yaml
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Migration Guides

- Mantior supports both OpenAPI 2.0 and 3.0 specifications (JSON or YAML).
- Keep your live spec at a stable URL; place the new spec in your repository.

## Support

- Issues: github.com/mantior/mantior/issues
- Email: support@mantior.dev

Mantior is MIT licensed. See `LICENSE` for details.
