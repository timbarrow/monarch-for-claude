import { access, readFile } from "node:fs/promises";

const source = await readFile("src/monarch/operations.ts", "utf8");
const permitted = new Set([
  "Common_CreateTransactionRuleMutationV2",
  "Common_UpdateTransactionRuleMutationV2",
  "Common_DeleteTransactionRule",
  "Web_UpdateRuleOrderMutation",
  "Web_TransactionDrawerUpdateTransaction",
  "Web_SetTransactionTags",
]);
const found = [...source.matchAll(/mutation\s+(\w+)/g)].map(
  (match) => match[1],
);
const unexpected = found.filter((name) => !permitted.has(name));
if (
  unexpected.length ||
  found.length !== permitted.size ||
  new Set(found).size !== permitted.size
)
  throw new Error(
    `GraphQL mutation inventory failed: ${unexpected.join(", ") || "missing or duplicate approved mutation"}`,
  );
const forbiddenWords = [
  "createTransaction(",
  "deleteTransaction(",
  "refreshInstitution",
  "createAccount(",
  "updateAccount(",
];
for (const word of forbiddenWords)
  if (source.includes(word))
    throw new Error(`Forbidden operation marker found: ${word}`);
await access("dist/server.cjs");
const compiled = await readFile("dist/server.cjs", "utf8");
const compiledMutations = [...compiled.matchAll(/mutation\s+(\w+)/g)].map(
  (match) => match[1],
);
if (
  compiledMutations.some((name) => !permitted.has(name)) ||
  new Set(compiledMutations).size !== permitted.size
)
  throw new Error("Compiled GraphQL mutation inventory failed");
process.stdout.write(`GraphQL inventory OK: ${found.join(", ")}\n`);
