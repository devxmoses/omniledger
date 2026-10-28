import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Account, AccountType, BalanceTotals, EntryDirection } from '../domain/account';
import { PostingLine } from '../domain/posting';
import { Transaction, TransactionStatus } from '../domain/transaction';
import { StatementLine, TrialBalanceRow, normalSide } from '../domain/account';

type AccountRow = {
    id: string;
    merchant_id: string |  null;
    code: string;
    currency_code: string;
    account_type: AccountType;
    is_system: boolean;
    allow_negative:boolean;
}

type TransactionRow = {
    id: string;
    external_ref: string | null;
    idempotency_key: string | null;
    status: TransactionStatus;
    reverses_transaction_id: string | null;
    created_at: Date;
}

type JournalEntryRow = {
    account_id: string;
    direction: EntryDirection;
    amount_minor: string;
    currency_code: string;
}

const ACCOUNT_COLUMNS = 
    'id, merchant_id, code, currency_code, account_type, is_system, allow_negative';

export interface NewAccount extends Omit<Account, 'id' | 'isSystem' | 'allowNegative'>, Partial<Pick<Account, 'allowNegative'>>{}
export type NewTransaction = Partial<Pick<Transaction, 'idempotencyKey' | 'externalRef' | 'reversesTransactionId'>>

@Injectable()
export class LedgerRepository {
    async createAccount(tx: PoolClient, account: NewAccount): Promise<Account> {
        const { rows } = await tx.query<AccountRow>(
            `INSERT INTO account (merchant_id, code, currency_code, account_type, is_system, allow_negative)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING ${ACCOUNT_COLUMNS}`,
            [
                account.merchantId,
                account.code,
                account.currencyCode,
                account.accountType,
                account.merchantId === null,
                account.allowNegative ?? false,
            ]
        );
        return toAccount(rows[0]);
    }

    async findAccounts(tx: PoolClient, ids: readonly string[]):Promise<Account[]>{
        const {rows} = await tx.query<AccountRow>(
            `SELECT ${ACCOUNT_COLUMNS} FROM account WHERE id = ANY($1::uuid[])`,
            [ids],
        );
        return rows.map(toAccount);
    }

    async insertTransaction(tx: PoolClient, txn: NewTransaction):Promise<string>{
        const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO transaction (idempotency_key, external_ref, reverses_transaction_id)
            VALUES ($1, $2, $3)
            RETURNING id`,
            [txn.idempotencyKey ?? null, txn.externalRef ?? null, txn.reversesTransactionId ?? null]
        );
        return rows[0].id;
    }

    async insertJournalEntries(
        tx: PoolClient,
        transactionId: string,
        lines: readonly PostingLine[],
    ): Promise<void> {
        //even though you do not use the result here, you await so that it waits until the insert is finished
        //always await database calls, even when you don't use the result.
        await tx.query(
            `INSERT INTO journal_entry (transaction_id, account_id, direction, amount_minor, currency_code)
            SELECT $1::uuid, account_id, direction, amount_minor, currency_code
                FROM unnest($2::uuid[], $3::entry_direction[], $4::bigint[], $5::text[])
                    AS line (account_id, direction, amount_minor, currency_code)`,
            [
                transactionId,
                lines.map((l) => l.accountId),
                lines.map((l) => l.direction),
                lines.map((l) => l.amountMinor.toString()),
                lines.map((l) => l.currency),              
                
            ],
            
        );
    }

    async findTransaction(tx: PoolClient, id:string): Promise<Transaction | null>{
        const { rows } = await tx.query<TransactionRow>(
            `SELECT id, external_ref, idempotency_key, status, reverses_transaction_id, created_at
                FROM transaction WHERE id = $1`,
            [id],
        );

        const row = rows[0];
        if (!row) return null;

        const { rows: entries } = await tx.query<JournalEntryRow>(
            `SELECT account_id, direction, amount_minor, currency_code
                FROM journal_entry WHERE transaction_id = $1 ORDER BY id`,
            [id],
        );

        return {
            id: row.id,
            externalRef: row.external_ref,
            idempotencyKey: row.idempotency_key,
            status: row.status,
            reversesTransactionId: row.reverses_transaction_id,
            createdAt: row.created_at,
            lines: entries.map((e) => ({
                accountId: e.account_id,
                direction: e.direction,
                amountMinor: BigInt(e.amount_minor),
                currency: e.currency_code,
            })),
        };
    }

    async findTransactionIdByIdempotencyKey(tx:PoolClient, key:string):Promise<string | null>{
        const { rows } = await tx.query<{ id:string }>(
            `SELECT id FROM transaction WHERE idempotency_key = $1 `,
            [key],
        );
        return rows[0]?.id ?? null;
    }

    async markReversed(tx: PoolClient, id:string):Promise<boolean>{
        const { rowCount } = await tx.query(
            `UPDATE transaction SET status = 'reversed' WHERE id = $1 AND status = 'posted'`,
            [id],
        );
        return rowCount === 1;
    }

    /**
   * Locks the accounts' rows until this transaction ends.
   * ORDER BY id makes every caller lock in the same order, which prevents deadlocks.
   */
  async lockAccounts(tx: PoolClient, ids: readonly string[]): Promise<Account[]>{
    const { rows } = await tx.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM account
            WHERE id = ANY($1::uuid[])
            ORDER BY id
            FOR UPDATE`,
        [ids]
    );
    return rows.map(toAccount);
  }

  /** Total debits and credits per account. Accounts with no entries are left out (= zero). */
  async getBalanceTotals(
    tx: PoolClient,
    ids: readonly string[],
  ): Promise<Map<string, BalanceTotals>>{
    const { rows } = await tx.query<{account_id:string; debits: string; credits: string }>(
        `SELECT account_id,
            coalesce(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0) AS debits,
            coalesce(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0) AS credits
            FROM journal_entry
            WHERE account_id = ANY($1::uuid[])
            GROUP BY account_id`,
        [ids],
    );
    return new Map(
        rows.map((r) => [r.account_id,{debits: BigInt(r.debits), credits: BigInt(r.credits)}]),
    );
  }

  async getStatement(
    tx: PoolClient,
    account: Account,
    options: { limit: number; beforeEntryId?: string },
  ): Promise<StatementLine[]>{
    const { rows } = await tx.query<{
        id: string;
        transaction_id: string;
        direction: EntryDirection;
        amount_minor: string;
        balance_after: string;
        created_at: Date;
    }>(
        `SELECT * FROM (
            SELECT id, transaction_id, direction, amount_minor, created_at, 
                    sum(CASE WHEN direction = $2::entry_direction THEN amount_minor ELSE -amount_minor END)
                        OVER(ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as balance_after
                    FROM journal_entry
                WHERE account_id = $1
        ) AS statement
        WHERE $3::bigint IS NULL OR id < $3::bigint
        ORDER BY id DESC
        LIMIT $4`,
        [account.id, normalSide(account.accountType), options.beforeEntryId ?? null, options.limit],
    );

    return rows.map((r) => ({
        entryId: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        amountMinor: BigInt(r.amount_minor),
        balanceAfterMinor: BigInt(r.balance_after),
        createdAt: r.created_at,
    }));
  }

    /** Every account a merchant owns, with its debit/credit totals. */
    async getMerchantBalanceTotals(
        tx: PoolClient,
        merchantId: string,
    ): Promise<{account: Account; totals: BalanceTotals}[]>{
      const { rows }  = await tx.query<AccountRow & { debits: string, credits: string }>(
        `SELECT a.id, a.merchant_id, a.code, a.currency_code, a.account_type, a.is_system, a.allow_negative,
                coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'debit'),0) AS debits,
                coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'credit'),0) AS credits
            FROM account a
            LEFT JOIN journal_entry e ON e.account_id = a.id
            WHERE a.merchant_id = $1
            GROUP BY a.id
            ORDER BY a.currency_code, a.code`,
        [merchantId],
      );
      return rows.map((r) => ({
        account: toAccount(r),
        totals: {debits: BigInt(r.debits), credits: BigInt(r.credits)},
      }))
    }

     /** Total debits and credits per currency across the whole ledger. */
     async getTrialBalance(tx: PoolClient): Promise<TrialBalanceRow[]>{
        const { rows } = await tx.query<{currency_code:string, debits: string; credits:string}>(
            `SELECT currency_code,
                coalesce(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0) AS debits,
                coalesce(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0) AS credits
            FROM journal_entry
            GROUP BY currency_code
            ORDER BY currency_code`,
        );
        
        return rows.map((r) => ({
            currencyCode: r.currency_code,
            debits: BigInt(r.debits),
            credits: BigInt(r.credits)
        }));
     }
}
 function toAccount(row:AccountRow): Account{
        return {
            id:row.id,
            merchantId: row.merchant_id,
            code: row.code,
            currencyCode:row.currency_code,
            accountType:row.account_type,
            isSystem: row.is_system,
            allowNegative: row.allow_negative,
        };
    }

