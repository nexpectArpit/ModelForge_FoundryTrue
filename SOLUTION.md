# ModelForge — Solution Writeup

**Theme: Agents That Act**

---

## Problem

Switching an AI application from one foundation model to another (e.g. GPT-4o → Llama 3.2) risks silent regressions: broken tool-calling schemas, degraded accuracy, or prompt fragility. Teams either vibe-check manually or deploy blind and hope. Both approaches break production.

## What the Agent Reaches

ModelForge autonomously executes a **full migration rehearsal lifecycle**:

1. **Inspects** the target repository via regex and pattern matching to map model references, SDK imports, and tool schemas.
2. **Benchmarks** the live baseline application with a deterministic 15-case evaluation suite (accuracy, latency p95, cost).
3. **Clones** the codebase into an isolated copy-on-write sandbox — zero production mutation.
4. **Patches** the candidate model into the sandbox, boots it, and runs the same benchmark.
5. **Compares** baseline vs. candidate evidence with a differential matrix. The LLM never self-evaluates; an independent engine decides PASS/FAIL.
6. **Diagnoses** regressions (e.g. tool-calling failure) and autonomously applies **Hybrid Routing** remediation — re-tests until 100% quality parity with >70% cost savings.
7. **Prepares** an immutable canary manifest (90/10 traffic split, circuit breakers, SHA digest).

## Where It Stops

Production routing **cannot mutate** without human approval. `apply_production_routing` is gated by TrueForge's native `require_approval_for_tools` policy — execution physically halts until an operator clicks **Allow** on the dashboard. A cryptographic HMAC-SHA256 artifact binds the approval to the exact session, canary, and manifest hash.

## Architecture

```
TrueForge Harness (:8790)
  ├─ rehearsal-mcp (:8951)  — 10 read/sandbox/eval tools
  └─ gateway-mcp   (:8952)  — 4 write/canary/routing tools (approval-gated)

Baseline App (:8950) ──benchmark──▶ Ground Truth
Sandbox App  (:8955) ──benchmark──▶ Candidate Evidence
                                     ▼
                              Differential Comparison
                                     ▼
                           Canary Manifest + Approval Gate
                                     ▼
                          Simulated Gateway Mutation + Verify
```

State is persisted to `node:sqlite` WAL for crash recovery. All sessions, evaluations, and approvals are durably auditable.

## How TrueForge Was Used

- **Agent orchestration**: TrueForge drives the LLM reasoning loop that calls ModelForge's MCP tools sequentially.
- **MCP connectors**: Two Streamable HTTP MCP servers (`rehearsal-mcp`, `gateway-mcp`) are registered as remote connectors.
- **Native approval gate**: `require_approval_for_tools: ["apply_production_routing"]` enforces the human-in-the-loop boundary at the TrueForge platform level.
- **Web UI**: Operators interact via `http://localhost:8790` — chat, observe live tool calls, and click Allow/Deny.

## Real vs. Mocked

| Component | Status |
|---|---|
| Repository source scanning | **Real** — scans and extracts patterns from actual source files |
| Baseline & candidate benchmarking | **Real** — live HTTP requests to running apps |
| Sandbox isolation (copy-on-write) | **Real** — filesystem clone + ephemeral process with env sanitization |
| Evaluation engine (accuracy, latency, cost) | **Real** — deterministic 15-case suite with zod validation |
| Hybrid routing remediation | **Real** — patches actual sandbox source files |
| HMAC-SHA256 approval artifacts | **Real** — cryptographic signatures verified |
| SQLite WAL state persistence | **Real** — `node:sqlite` durable store |
| AI gateway simulation | **Simulated** — file-persisted routing table (no external gateway like Kong/Envoy) |
| Customer-support demo app models | **Simulated** — deterministic mock responses (no live LLM API calls from the demo app itself) |

## Known Limits

- Sandbox execution uses local OS processes with environment variable sanitization, suitable for trusted benchmark applications/demos; not hardened for untrusted multi-tenant execution.
- Code patching uses pattern-based replacements; dynamic imports or complex metaprogramming require manual review.
- Automated remediation currently supports `hybrid_routing` and `abort_migration`; automated prompt rewriting or schema compilation requires dedicated adapters or manual intervention.
- The evaluation suite is fixed at 15 cases; statistical significance sampling is not yet implemented.
- Gateway routing table simulation is file-backed in `.modelforge-canaries/`; production deployment requires an adapter for external gateways (e.g. Kong, LiteLLM, Envoy).
- `nvm use 22` is required — Node ≥ 22 for native `node:sqlite`.
