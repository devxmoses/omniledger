import { Account, balanceEffect, EntryDirection } from "./account";
import { CurrencyMismatchError, InvalidAmountError, InvalidPostingError, UnbalancedPostingError } from "./errors";
import { CurrencyCode } from "./money";

export interface PostingLine{
    readonly accountId:string;
    readonly direction: EntryDirection;
    readonly amountMinor: bigint;
    readonly currency: CurrencyCode;
}

/** What a caller asks the ledger to record: one transaction and its journal entries. */
export interface PostingRequest {
    readonly idempotencyKey?: string;
    readonly externalRef?: string;
    readonly reversesTransactionId?: string;
    readonly lines: readonly PostingLine[];
}

/**
 * The same invariants the database triggers enforce, checked up front so callers
 * get a typed error before any locks are taken or rows written.
 */
export function validatePosting(request: PostingRequest): void {
    const { lines } = request;

    if (lines.length < 2){
        throw new InvalidPostingError ('a posting needs at least two lines');
    }

    for (const line of lines){
        if(line.amountMinor <= 0n){
            throw new InvalidAmountError(`line amounts must be positive, got ${line.amountMinor}`);
        }
    }

    const currencies = new Set(lines.map((line) => line.currency));
    if(currencies.size > 1){
        throw new CurrencyMismatchError(
            `a posting must use a single currency, got ${[...currencies].join(',')}`,  
        );
    }

    let debits = 0n;
    let credits = 0n;
    for (const line of lines){
        if(line.direction === 'debit') debits += line.amountMinor;
        else credits += line.amountMinor;
    }
    if(debits !== credits){
        throw new UnbalancedPostingError(`debits ${debits} do not equal credits ${credits}`);
    }
}

/** The lines that undo a posting: same accounts and amounts, opposite directions. */
export function reversalLines(lines: readonly PostingLine[]): PostingLine[]{
    return lines.map((line) => ({
        ...line,
        direction: line.direction === 'debit' ? 'credit' : 'debit',
    }));
}

/** The total amount this posting would add to (or remove from) one account's balance. */
export function netChange(account:Account, lines: readonly PostingLine[]): bigint{
    return lines
        .filter((line)=>line.accountId === account.id)
        .reduce(
            (sum, line)=> sum + balanceEffect(account.accountType, line.direction, line.amountMinor),
            0n,
        );
}