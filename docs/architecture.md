# Mantior Architecture

## High-Level Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Mantior                                                                   │
│                                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                        │
│  │     CLI     │  │   Server    │  │   Webhook   │                        │
│  │  Commands   │  │    Daemon   │  │   Handler   │                        │
│  └─────────────┘  └─────────────┘  └─────────────┘                        │
│         │                │                │                               │
│         └────────────────┼────────────────┘                               │
│                          ▼                                                │
│              ┌─────────────────────┐                                      │
│              │    Orchestrator     │                                      │
│              │      (Core)         │                                      │
│              └─────────────────────┘                                      │
│        ┌──────────────┼─────────────────┐                                 │
│        ▼              ▼                 ▼                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                          │
│  │    Diff     │ │   Scanner   │ │   Fixer     │                          │
│  │   Engine    │ │   (AST)     │ │   Engine    │                          │
│  └─────────────┘ └─────────────┘ └─────────────┘                          │
│        │              │                 │                                 │
│        └──────────────┼─────────────────┘                                 │
│                       ▼                                                   │
│              ┌─────────────────────┐                                      │
│              │     GitHub API      │                                      │
│              │     (PR Opener)     │                                      │
│              └─────────────────────┘                                      │
│                       │                                                    │
│                       ▼                                                    │
│              ┌─────────────────────┐                                      │
│              │       SQLite        │                                      │
│              │     Database        │                                      │
│              └─────────────────────┘                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### Orchestrator (`src/orchestrator.ts`)
Coordinates the entire pipeline: diff the specs, clone each consumer, locate
call sites, apply fixes, open deduplicated PRs, and record every run to SQLite.

### Diff Engine (`src/diff/engine.ts`)
Parses OpenAPI specs (JSON or YAML, URL or local path) and compares the live
spec against the pinned spec. Classifies changes by type and severity
(`breaking` / `risky` / `safe`) with confidence scores.

### Scanner / AST Walker (`src/scanner/`)
- `ast-walker.ts` — ts-morph walker for TypeScript/JavaScript: property access,
  destructuring, spread, import/type references.
- `ast-walker-python.ts` — CPython `ast` module via a child process (portable,
  no shell); Python 3 required.
- Other languages fall back to deterministic line-aware regex matching.
- `repo-cloner.ts` — shallow-clones consumer repos to temp dirs; cleans up after.

### Fixer Engine (`src/fixer/`)
- `deterministic.ts` — deterministic rule engine first (mapping-driven renames),
  complexity scoring (`low` / `medium` / `high` / `ambiguous`).
- `llm-fallback.ts` — OpenAI fallback for medium/high complexity, confidence
  gate ≥ 70%, cached responses.

### PR Opener (`src/github/`)
- `pr-opener.ts` — direct-branch strategy with automatic fork fallback.
- `pr-dedupe.ts` — never opens duplicate PRs; closes stale ones.
- `pr-monitor.ts` — waits for CI checks.
- `platforms/platform.interface.ts` — the seam GitLab (v2) and Bitbucket (v3)
  implementations will satisfy.

### Database (`src/state/database.ts`)
SQLite at `~/.mantior/mantior.db`. Tables: `scans`, `prs`, `errors`, `metrics`,
`configs`, `consumers`. Powers `status` and `logs`.

### Webhook (`src/webhook/`)
HMAC-SHA256 (constant-time) signature verification (fail-closed in production),
event routing (ping/push/pull_request/check_suite), rate limiting, and a
`setupGitHubWebhook` helper to register the hook.

### Quality (Phase 1 posture)
Jest (80% global / 90% diff / 85% fixer+scanner coverage), ESLint
(type-checked, zero-warning CI gate), Prettier, husky pre-commit/pre-push,
GitHub Actions CI.
