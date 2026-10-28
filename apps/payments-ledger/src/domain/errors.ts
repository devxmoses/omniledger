/**
 * Base for every rule violation the ledger can report.
 * `code` is stable and machine-readable; the API layer (M2) maps it to an HTTP status.
 */
export abstract class LedgerError extends Error{
    abstract readonly code: string;

    constructor(message: string){
        super(message);
        this.name = new.target.name;
    }
}

export class InvalidAmountError extends LedgerError{
    readonly code = 'INVALID_AMOUNT';
}

export class CurrencyMismatchError extends LedgerError{
    readonly code = 'CURRENCY_MISMATCH';
}

export class UnbalancedPostingError extends LedgerError {
    readonly code = 'UNBALANCED_POSTING';
}

export class InvalidPostingError extends LedgerError {
    readonly code = 'INVALID_POSTING';
}

export class InsufficientFundsError extends LedgerError {
    readonly code = 'INSUFFICIENT_FUNDS';
}

export class AccountNotFoundError extends LedgerError {
  readonly code = 'ACCOUNT_NOT_FOUND';
}

export class TransactionNotFoundError extends LedgerError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class AlreadyReversedError extends LedgerError {
  readonly code = 'ALREADY_REVERSED';
}
