# Security boundary

This local Windows server permits Monarch reads, four classification-rule mutations (create, update, delete, and reorder), and two individual-transaction update mutations (field update and tag replacement). It has no generic HTTP or GraphQL MCP tool and no path to delete transactions or modify accounts, budgets, categories, tag definitions, credentials, or any other Monarch object.

```text
Claude Desktop --stdio--> MCP tool handlers --fixed GraphQL client--> app.monarch.com
                                  |                         ^
                                  v                         |
                    preview store + loopback confirmation ---+
                                  |
                                  v
                   DPAPI CurrentUser encrypted auth.bin
```

Authentication opens a dedicated temporary Edge/Chrome profile with a random loopback-only DevTools port. Credentials are never MCP arguments, logs, process arguments, environment variables, or files in plaintext. Captured session data is encrypted with Windows DPAPI `CurrentUser`; encryption failure is fatal. Loopback confirmations use a random nonce, `127.0.0.1` binding, Host/Origin checks, short expiry, and one-time use.

Rule changes must be previewed first. The apply call contains only a single-use ID, rechecks the current rule state, opens a local user confirmation page, validates again, makes at most one approved mutation, then reads rules back. Retroactive application is accepted only as the explicit `apply_to_existing_transactions` boolean on a create/update preview; that preview scans the full available history and displays the matching count and representative transactions before confirmation. Mutations are never retried automatically.

Individual transaction updates use the same preview, single-use ID, stale-state recheck, local confirmation, fixed-mutation allowlist, no-retry behavior, and read-back verification. Tag replacement must be previewed separately from other fields so an approved change always maps to exactly one mutation. No transaction-delete document exists in source or compiled output, and the build checks enforce that boundary.

Monarch has no supported public API. API changes or browser authentication changes may require maintenance. Do not file real financial data, session material, headers, or production responses in bug reports or tests.
