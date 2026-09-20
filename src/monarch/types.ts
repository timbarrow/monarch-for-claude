export interface Account {
  id: string;
  display_name: string;
  institution: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: number | null;
  closed: boolean | null;
  hidden: boolean | null;
  include_in_net_worth: boolean | null;
}
export interface Category {
  id: string;
  name: string;
  group: string | null;
  active: boolean | null;
  archived: boolean | null;
}
export interface Tag {
  id: string;
  name: string;
  color: string | null;
}
export interface Transaction {
  id: string;
  date: string;
  amount: number;
  merchant: string | null;
  original_statement: string | null;
  account: { id: string; display_name: string } | null;
  category: { id: string; name: string } | null;
  tags: Tag[];
  pending: boolean | null;
  recurring: boolean | null;
  reviewed: boolean | null;
  hidden: boolean | null;
  notes?: string | null;
  splits: { id: string; amount: number }[];
}
export interface ClassificationRule {
  id: string;
  order: number;
  criteria: unknown;
  actions: unknown;
  last_applied_at: string | null;
}
