import { PostingLine } from "./posting";

export type TransactionStatus = 'posted' | 'reversed';

export interface Transaction {
    readonly id:string;
    readonly externalRef: string | null;
    readonly idempotencyKey: string | null;
    readonly status: TransactionStatus;
    readonly reversesTransactionId: string | null;
    readonly createdAt: Date;
    readonly lines: readonly PostingLine[];
}