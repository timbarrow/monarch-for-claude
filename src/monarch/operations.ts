/** Handwritten current operation documents, cross-checked against local MIT references. */
export const GRAPHQL_OPERATIONS = {
  GetAccounts: `query GetAccounts { accounts { id displayName deactivatedAt isHidden isAsset currentBalance displayBalance includeInNetWorth updatedAt displayLastUpdatedAt type { name display } subtype { name display } institution { id name } credential { institution { id name } } } }`,
  GetTransactionsList: `query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) { allTransactions(filters: $filters) { totalCount results(offset: $offset, limit: $limit, orderBy: $orderBy) { id amount pending date hideFromReports plaidName notes isRecurring reviewStatus needsReview isSplitTransaction category { id name } merchant { id name } account { id displayName } tags { id name color } } } }`,
  GetTransactionDrawer: `query GetTransactionDrawer($id: UUID!, $redirectPosted: Boolean) { getTransaction(id: $id, redirectPosted: $redirectPosted) { id amount pending isRecurring date hideFromReports needsReview reviewedAt plaidName notes hasSplitTransactions isSplitTransaction splitTransactions { id amount merchant { id name } category { id name } } account { id displayName mask subtype { display } } category { id name } merchant { id name } tags { id name color } } }`,
  GetCategories: `query GetCategories { categories { id name group { id name } } }`,
  GetHouseholdTransactionTags: `query GetHouseholdTransactionTags { householdTransactionTags { id name color } }`,
  GetTransactionRules: `query GetTransactionRules { transactionRules { id order merchantCriteriaUseOriginalStatement merchantCriteria { operator value } originalStatementCriteria { operator value } merchantNameCriteria { operator value } amountCriteria { operator isExpense value valueRange { lower upper } } categoryIds accountIds setCategoryAction { id name } addTagsAction { id name color } setMerchantAction { id name } linkGoalAction { id } linkSavingsGoalAction { id } setHideFromReportsAction reviewStatusAction sendNotificationAction splitTransactionsAction { amountType } recentApplicationCount lastAppliedAt } }`,
  Web_TransactionDrawerUpdateTransaction: `mutation Web_TransactionDrawerUpdateTransaction($input: UpdateTransactionMutationInput!) { updateTransaction(input: $input) { transaction { id } errors { fieldErrors { field messages } message code } } }`,
  Web_SetTransactionTags: `mutation Web_SetTransactionTags($input: SetTransactionTagsInput!) { setTransactionTags(input: $input) { transaction { id tags { id name color } } errors { fieldErrors { field messages } message code } } }`,
  Common_CreateTransactionRuleMutationV2: `mutation Common_CreateTransactionRuleMutationV2($input: CreateTransactionRuleInput!) { createTransactionRuleV2(input: $input) { transactionRule { id order } errors { fieldErrors { field messages } message code } } }`,
  Common_UpdateTransactionRuleMutationV2: `mutation Common_UpdateTransactionRuleMutationV2($input: UpdateTransactionRuleInput!) { updateTransactionRuleV2(input: $input) { transactionRule { id order } errors { fieldErrors { field messages } message code } } }`,
  Common_DeleteTransactionRule: `mutation Common_DeleteTransactionRule($id: ID!) { deleteTransactionRule(id: $id) { deleted errors { fieldErrors { field messages } message code } } }`,
  Web_UpdateRuleOrderMutation: `mutation Web_UpdateRuleOrderMutation($id: ID!, $order: Int!) { updateTransactionRuleOrderV2(id: $id, order: $order) { transactionRules { id order } errors { fieldErrors { field messages } message code } } }`,
} as const;

export type OperationName = keyof typeof GRAPHQL_OPERATIONS;
export const READ_OPERATIONS = new Set<OperationName>([
  "GetAccounts",
  "GetTransactionsList",
  "GetTransactionDrawer",
  "GetCategories",
  "GetHouseholdTransactionTags",
  "GetTransactionRules",
]);
export const ALLOWED_MUTATIONS = new Set<OperationName>([
  "Web_TransactionDrawerUpdateTransaction",
  "Web_SetTransactionTags",
  "Common_CreateTransactionRuleMutationV2",
  "Common_UpdateTransactionRuleMutationV2",
  "Common_DeleteTransactionRule",
  "Web_UpdateRuleOrderMutation",
]);
