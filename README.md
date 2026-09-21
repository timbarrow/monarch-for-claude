# Monarch for Claude

This is a local, single-user Windows connector for Claude Desktop. It exposes the exact tool inventory described in `src/tools/contracts.ts`: read-only account/transaction/category/tag/rule tools plus an audited, preview-and-confirm path for classification rules.

Rule management supports create, update, delete, and reorder; merchant/original-statement, account, category, and amount criteria; category, tag, merchant-name, report-visibility, and review-status actions; and an explicit `apply_to_existing_transactions` option for create/update previews. Historical application is never implicit: the preview scans the full available transaction history, reports the matching count and examples, and the apply step still requires local confirmation.

## Install

Download the `.mcpb` file from the [latest GitHub release](https://github.com/timbarrow/monarch-for-claude/releases/latest), verify it against the accompanying `.sha256` file, and install it using Claude Desktop's Extensions UI.

## Build

```powershell
npm ci
npm run ci
```

The resulting bundle and SHA-256 file are in `dist/`. No Node installation should be needed at runtime because Claude Desktop supplies Node.

## Connect and reauthenticate

Call `connect_monarch` in Claude. It opens a dedicated browser profile; sign in directly with Monarch. No password, token, cookie, or OTP is accepted by an MCP tool. `get_monarch_connection_status` reports safe diagnostic codes only. Expired sessions are removed and require reconnecting.

## Uninstall

Remove the extension in Claude Desktop. If desired, separately delete `%LOCALAPPDATA%\MonarchForClaude\auth.bin` and `%LOCALAPPDATA%\MonarchForClaude\logs` to remove encrypted local session data and diagnostics.

## Authentication diagnostics

Sanitized authentication events are returned by `get_monarch_connection_status` in `diagnostic_trace`. A best-effort file copy is also written inside the extension runtime at `%LOCALAPPDATA%\MonarchForClaude\logs\authentication.log` and rotated at 1 MiB, but Claude Desktop's isolation may make that path inaccessible from the host. Every file entry carries a timestamp and the extension version. Diagnostics contain stages (browser discovery and launch, DevTools attachment, cookie and request observation, session save, verification, cleanup), safe error codes, PowerShell exit codes and a fixed error class for DPAPI failures, Monarch API host/path and HTTP status codes, header names, header-presence booleans, and cookie names, domain, path and flags only. If the log file cannot be written, `get_monarch_connection_status` reports `AUTH_LOG_FILE_WRITE_FAILED` with the error code. They never record passwords, OTPs, authorization tokens, cookie values, CSRF values, GraphQL response data, or financial data.

## Live testing

Live tests are intentionally absent from the default commands. Before use with a real account, validate the browser capture with the owner present and use an impossible, generated merchant criterion for rule write acceptance tests. Never commit real data or credentials.

This is an independent community project and is not affiliated with or endorsed by Monarch Money or Anthropic.
