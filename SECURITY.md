# Security boundary

This local Windows server permits Monarch reads and exactly four classification-rule mutations: create, update, delete, and reorder. It has no generic HTTP or GraphQL MCP tool and no path to edit individual transactions, accounts, budgets, categories, tags, credentials, or any other Monarch object.

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

Monarch has no supported public API. API changes or browser authentication changes may require maintenance. Do not file real financial data, session material, headers, or production responses in bug reports or tests.
