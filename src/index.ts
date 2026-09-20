import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserCapture } from "./auth/browser-capture.js";
import { SessionStore } from "./auth/session-store.js";
import { MonarchClient } from "./monarch/client.js";
import { LoopbackConfirmation } from "./rules/confirmation.js";
import { PreviewStore } from "./rules/preview-store.js";
import { AuthService } from "./tools/auth-tools.js";
import {
  applyRuleInput,
  connectInput,
  connectionStatusInput,
  getTransactionInput,
  listAccountsInput,
  listCategoriesInput,
  listRulesInput,
  listTagsInput,
  previewRuleInput,
  searchTransactionsInput,
  summarizeTransactionsInput,
} from "./tools/contracts.js";
import { ReadService } from "./tools/read-tools.js";
import { RuleService } from "./tools/rule-tools.js";
import { failure, response } from "./tools/shared.js";

export function createServer(deps?: {
  store?: SessionStore;
  capture?: BrowserCapture;
  confirmation?: LoopbackConfirmation;
  client?: MonarchClient;
}) {
  const store = deps?.store ?? new SessionStore();
  const client = deps?.client ?? new MonarchClient(store);
  const read = new ReadService(client);
  const auth = new AuthService(
    store,
    deps?.capture ?? new BrowserCapture(),
    client,
  );
  const rules = new RuleService(
    read,
    client,
    new PreviewStore(),
    deps?.confirmation ?? new LoopbackConfirmation(),
  );
  const server = new McpServer({
    name: "monarch-for-claude",
    version: "0.1.3",
  });
  server.registerTool(
    "get_monarch_connection_status",
    {
      description: "Return safe local Monarch connection status.",
      inputSchema: connectionStatusInput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return response(await auth.status());
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "connect_monarch",
    {
      description:
        "Open a dedicated browser profile for direct Monarch sign-in.",
      inputSchema: connectInput,
      annotations: { readOnlyHint: false },
    },
    async () => {
      try {
        return response(await auth.connect());
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "list_accounts",
    {
      description: "List household accounts without credentials.",
      inputSchema: listAccountsInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return response(
          await read.accounts(args.include_closed, args.include_hidden),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "search_transactions",
    {
      description: "Search a bounded, paged transaction history.",
      inputSchema: searchTransactionsInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return response(await read.search(args));
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "get_transaction",
    {
      description: "Get one transaction as read-only data.",
      inputSchema: getTransactionInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return response(
          await read.transaction(args.transaction_id, args.include_notes),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "summarize_transactions",
    {
      description:
        "Compute server-side transaction aggregates over a bounded date range.",
      inputSchema: summarizeTransactionsInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return response(
          await read.summary(args.start_date, args.end_date, args.group_by),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "list_categories",
    {
      description: "List existing Monarch categories.",
      inputSchema: listCategoriesInput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return response(await read.categories());
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "list_tags",
    {
      description: "List existing Monarch tags.",
      inputSchema: listTagsInput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return response(await read.tags());
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "list_classification_rules",
    {
      description:
        "List rules in execution order and mark unsupported rules non-editable.",
      inputSchema: listRulesInput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return response(await rules.list());
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "preview_classification_rule_change",
    {
      description:
        "Preview a safe classification-rule change without changing Monarch.",
      inputSchema: previewRuleInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return response(await rules.preview(args));
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "apply_classification_rule_change",
    {
      description:
        "Apply a single-use, user-confirmed classification-rule preview.",
      inputSchema: applyRuleInput,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        return response(await rules.apply(args.preview_id));
      } catch (e) {
        return failure(e);
      }
    },
  );
  return server;
}

async function start(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("server.cjs")) void start();
