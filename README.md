# 🛡️ Mantior

**Self-Maintaining APIs.** AI agents that fix breaking API changes before they break your customers — eliminating the 30% Engineering Migration Tax.

[![CI](https://github.com/mantior/mantior/actions/workflows/ci.yml/badge.svg)](https://github.com/mantior/mantior/actions/workflows/ci.yml)

## What It Does

Mantior compares the **live spec** of your API (`reference_url`) against the **new spec** you're shipping (`spec`), detects the breaking changes, scans every **consumer repository**, applies **deterministic fixes** (with an LLM fallback for complex cases), and opens **production-ready PRs** — before your customers ever break.

## Quick Start

```bash
# 1. Install
npm install -g mantior

# 2. Scaffold config
mantior init

# 3. Set your token
echo "GITHUB_TOKEN=ghp_xxx" > .env

# 4. Preview the damage (read-only)
mantior scan

# 5. Fix and open PRs
mantior fix

# 6. Monitor
mantior status
```

Or with Docker:

```bash
docker run --rm \
  -v $(pwd)/mantior.yaml:/app/mantior.yaml \
  -v $(pwd)/specs:/app/specs \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  mantior/mantior:latest scan
```

## Commands

| Command | Purpose |
| :--- | :--- |
| `mantior init` | Generate a sample `mantior.yaml` |
| `mantior validate` | Validate your config |
| `mantior scan` | Find breaking changes (read-only) |
| `mantior fix` | Fix + open PRs (`--dry-run`, `--no-pr`, `--json`) |
| `mantior status` | Historical metrics from SQLite |
| `mantior logs` | Recent activity (`--tail N`, `--json`) |
| `mantior server` | Daemon: `/health`, `/metrics`, `/webhook` |

## How the fixes work

1. **Diff engine** — OpenAPI v1→v2 comparison (endpoints, schemas, properties, types, enums, required fields) with rename heuristics + confidence scores.
2. **Scanner** — ts-morph AST walker (TS/JS) and a CPython `ast` walker; regex fallback for other languages.
3. **Fixer** — deterministic rule engine first (config `mappings`), then an OpenAI fallback gated on ≥ 70% confidence. LLM spend is guarded by hard cost caps (per-scan/day/month, persisted to SQLite), cost-aware model routing (cheapest capable model, budget-based downgrades), rate limiting, and response caching. Anything uncertain lands in a manual-review bucket — Mantior never guesses silently.
4. **PR opener** — direct branch with automatic fork fallback; deduplicated; labels + reviewers; PRs are always human-reviewed before merging (no auto-merge, by design).

## Configuration

See `mantior.yaml` and [docs/index.md](docs/index.md) for the full reference. `${ENV_VAR}` values in the config are interpolated from the environment.

```yaml
api:
  name: "Payment Core API"
  spec: ./specs/payment-api-v2.yaml
  reference_url: "https://api.payment.io/v1/openapi.json"

consumers:
  - repo: "https://github.com/payment-corp/web-checkout.git"
    branch: "main"
    language: "typescript"

security:
  github_token: ${GITHUB_TOKEN}

rules:
  auto_pr: true
  default_reviewer: "@api-team"
  pr_labels: ["dependencies", "mantior"]

mappings:
  - old_path: "response.body.amount"
    new_path: "response.body.amount_cents"
```

## Security

- GitHub webhooks are **HMAC-SHA256 verified** (constant-time) — fail-closed in production (`GITHUB_WEBHOOK_SECRET`).
- GitHub App permissions are least-privilege: `contents: read` + `pull_requests: write`.
- **No consumer source code is stored** — clones are ephemeral temp dirs, cleaned up after each run.
- Scans/products never auto-merge; every PR is reviewable and reversible.

## Development

```bash
npm install
npm run dev          # ts-node
npm run type-check   # tsc --noEmit
npm run lint:ci      # zero-warning gate
npm test             # jest (unit + skipped integration/e2e)
npm run build        # tsc → dist/
```

## Docs

- [User documentation](docs/index.md)
- [Architecture](docs/architecture.md)

## Roadmap

- **v1 (now):** GitHub only · TS + Python consumers · 7 CLI commands · verified webhooks · SQLite state · Docker
- **v2:** GitLab · GitHub Enterprise · auto-merge · OpenTelemetry · config schema/watcher
- **v3:** Bitbucket · Azure DevOps · GraphQL/gRPC diffing · dashboard

## License

MIT — see [LICENSE](LICENSE). Mantior is an open-source project; PRs welcome.
