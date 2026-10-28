import { CurrencyCode } from "./money";

export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense';
export type EntryDirection =  'debit' | 'credit';

export interface Account{
    readonly id:string;
    readonly merchantId:string | null;
    readonly code: string;
    readonly currencyCode: CurrencyCode;
    readonly accountType: AccountType;
    readonly isSystem: boolean;
    readonly allowNegative: boolean;
}

export interface BalanceTotals{
    readonly debits: bigint;
    readonly credits: bigint;
}

/** One line of an account statement: an entry plus the balance right after it. 
entryId is a string because the entry id column is a BIGINT, and 
pg returns bigints as strings. We only pass it around, never do maths on it, so a string is fine. */

export interface StatementLine {
    readonly entryId: string;
    readonly transactionId: string;
    readonly direction: EntryDirection;
    readonly amountMinor: bigint;
    readonly balanceAfterMinor: bigint;
    readonly createdAt: Date;
}

/** An account together with its current balance. */
export interface AccountBalance {
    readonly account: Account;
    readonly balanceMinor: bigint;
}

/** Ledger-wide check: in each currency, all debits must equal all credits. */
export interface TrialBalanceRow {
    readonly currencyCode: CurrencyCode;
    readonly debits: bigint;
    readonly credits: bigint;
}
//the side that increases an amount of this type, debit increases an asset, credit increases liability
export function normalSide(type:AccountType): EntryDirection{
    return type === 'asset' || type === 'expense' ? 'debit': 'credit';
}

/**
 * How one entry moves an account's balance.
 * Positive means "more of what this account holds" (for a merchant wallet: more money owed to them).
 * i.e. this is the balance effect, either positive or negative, 
 * if the direction(debit or credit) is in the normal side, then the effect is postive(e.gdebit on asset) else negative
 */
export function balanceEffect(
    type: AccountType,
    direction: EntryDirection,
    amountMinor: bigint
): bigint{
    return direction === normalSide(type) ? amountMinor : -amountMinor;
}

/** Turns raw totals into a balance, read from the account's own point of view. 
 * gets the balance of debits and credits, debit-credit or credit - debit depending on the normal side of the account type
 * e.g debit is normal side of asset, so its debits-credit, but for a liabilty where debit is not the normal side it is credits-debits
 * 
*/
export function balanceOf(type: AccountType, totals: BalanceTotals): bigint{
    return normalSide(type) === 'debit'
    ? totals.debits - totals.credits
    : totals.credits - totals.debits
}