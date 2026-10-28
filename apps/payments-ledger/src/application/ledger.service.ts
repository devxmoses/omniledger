import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Account, balanceOf } from '../domain/account';
import {
    AccountNotFoundError,
    AlreadyReversedError,
    CurrencyMismatchError,
    InsufficientFundsError,
    TransactionNotFoundError, 
    UnbalancedPostingError,   
} from '../domain/errors';

import { netChange, PostingLine, PostingRequest, reversalLines, validatePosting } from '../domain/posting';
import { Transaction } from '../domain/transaction';
import { LedgerRepository } from '../db/ledger.repository';
import { isConstraintViolation } from '../db/pg-errors';
import { TransactionRunner } from '../db/transaction-runner';
import { AccountBalance, StatementLine, TrialBalanceRow } from '../domain/account';

@Injectable()
export class LedgerService {
    constructor(
        private readonly db: TransactionRunner,
        private readonly repo: LedgerRepository,
    ){}

    /** Records one balanced transaction. Safe to call twice with the same idempotencyKey. 
     * postInTx is separate from post so that reverse() can reuse it inside its own transaction.
    */
    async post(request: PostingRequest): Promise<Transaction>{
        validatePosting(request);
        try{
            return await this.run((tx) => this.postInTx(tx, request));
        }catch(err){
            if(request.idempotencyKey && isConstraintViolation(err,'transaction_idempotency_key_key')){
                return this.run((tx)=> this.findByIdempotencyKey(tx, request.idempotencyKey as string));
            }
            throw err;
        }
    }

  /** Undoes a transaction by posting its mirror image. A transaction can be reversed once. */
    async reverse(transactionId:string): Promise<Transaction>{
        return this.run(async (tx)=> {
            const original = await this.repo.findTransaction(tx, transactionId);
            if(!original){
                throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
            }
            if(!(await this.repo.markReversed(tx, transactionId))){
                throw new AlreadyReversedError(`transaction ${transactionId} is already reversed`);
            }
            return this.postInTx(tx, {
                reversesTransactionId: transactionId,
                lines: reversalLines(original.lines),
            })
        })
    }

    
    private async postInTx(tx: PoolClient, request: PostingRequest): Promise<Transaction>{
        if(request.idempotencyKey){
            const existingId = await this.repo.findTransactionIdByIdempotencyKey(tx, request.idempotencyKey);
            if(existingId) return this.mustFindTransaction(tx,existingId);
        }

        const accounts = await this.lockAccounts(tx, request.lines);
        await this.assertNoOverdraw(tx, accounts, request.lines);

        const transactionId = await this.repo.insertTransaction(tx, request);
        await this.repo.insertJournalEntries(tx, transactionId, request.lines);
        return this.mustFindTransaction(tx, transactionId);
    }

    private async lockAccounts(tx: PoolClient, lines: readonly PostingLine[]): Promise<Account[]>{
        const ids = [...new Set(lines.map((line) => line.accountId))];
        const accounts = await this.repo.lockAccounts(tx, ids);

        if (accounts.length !== ids.length){ //if some accounts where not found, asin you have less accounts returned compared to the id you put
            const found = new Set(accounts.map((a) => a.id)); //get the ids of the one you found
            throw new AccountNotFoundError(`Unknown account(s): ${ids.filter((id)=>!found.has(id)).join(', ')}`); //filter the ones you havent found by negating the ones you have found
        }

        const byId = new Map(accounts.map((a)=>[a.id,a])); //get accounts by id
        for (const line of lines){
            const account = byId.get(line.accountId) as Account;
            if(account.currencyCode !==  line.currency){
                throw new CurrencyMismatchError(
                    `account ${account.id} holds ${account.currencyCode}, line is ${line.currency}`
                )
            }
        }
        return accounts;
    }
    /** Must run AFTER lockAccounts: the lock is what makes this read trustworthy. */
    private async assertNoOverdraw(
        tx: PoolClient,
        accounts: readonly Account[],
        lines: readonly PostingLine[],
    ): Promise<void> {
        const guarded = accounts.filter((a) => !a.allowNegative);
        if (guarded.length === 0) return;
        
        const totals = await this.repo.getBalanceTotals(tx, guarded.map((a) => a.id));
        for (const account of guarded) {
            const current = balanceOf(account.accountType, totals.get(account.id) ?? {debits: 0n, credits: 0n });
            const after = current + netChange(account, lines);
            if(after < 0n){
                throw new InsufficientFundsError(
                    `account ${account.id} has ${current}, posting would leave ${after}`
                )
            }
        }
    }
    private async findByIdempotencyKey(tx:PoolClient, key:string): Promise<Transaction>{
        const id = await this.repo.findTransactionIdByIdempotencyKey(tx, key);
        if(!id) throw new TransactionNotFoundError(`no transaction for idempotency key ${key}`);
        return this.mustFindTransaction(tx, id);
    }
    private async mustFindTransaction(tx: PoolClient, id:string): Promise<Transaction>{
        const txn = await this.repo.findTransaction(tx, id);
        if(!txn) throw new TransactionNotFoundError( `transaction ${id} not found`);
        return txn;
    }
     /** Runs work in a DB transaction and turns database rule violations into domain errors. */
    private async run<T>(work:(tx:PoolClient) => Promise<T>): Promise<T> {
        try{
            return await this.db.run(work);
        } catch(err) {
            if (isConstraintViolation(err, 'journal_entry_balanced')){
                throw new UnbalancedPostingError(err.message);
            }
            if (
                isConstraintViolation(err, 'journal_entry_single_currency') ||
                isConstraintViolation(err, 'journal_entry_account_currency_fk')
            ){
                throw new CurrencyMismatchError(err.message);
            }
            throw err;
        }
    }

    async getBalance(accountId: string): Promise<AccountBalance> {
        return this.run(async (tx) => {
            const [account] = await this.repo.findAccounts(tx, [accountId]);
            if(!account) throw new AccountNotFoundError(`account ${accountId} not found`);
            const totals = await this.repo.getBalanceTotals(tx,[accountId]);
            return {
                account,
                balanceMinor: balanceOf(account.accountType, totals.get(accountId) ?? {debits:0n, credits: 0n}),
            };
        });
    }

    /** Bank-statement view of an account: newest entries first, each with its running balance. */
    async getStatement(
        accountId: string,
        options: {limit?: number; beforeEntryId?: string } = {},
    ): Promise<StatementLine[]> {
        const limit = Math.min(options.limit ?? 50, 500);
        return this.run(async(tx)=>{
            const [account] = await this.repo.findAccounts(tx, [accountId]);
            if(!account) throw new AccountNotFoundError(`account ${accountId} not found`);
            return this.repo.getStatement(tx, account, { limit, beforeEntryId:options.beforeEntryId});
        });
    }

    /** Every account a merchant owns (one per currency and purpose), with balances. */
    async getMerchantBalances(merchantId: string): Promise<AccountBalance[]> {
        return this.run(async(tx)=>{
            const rows = await this.repo.getMerchantBalanceTotals(tx, merchantId);
            return rows.map(({account, totals})=>({ //this ({account,totals is one parameter i,not two, {} unpacks the object by their property name from getBalanceTotals, if you want to use any letter then you do rows.map((r) then you can do r.account, then r.account.accountType, it is different from (account, totals), it is ({account, totals}) )})
                account,
                balanceMinor: balanceOf(account.accountType, totals),
            }));
        });
    }
    
    /** Per-currency debit and credit totals across the whole ledger. They must always be equal. */
    async getTrialBalance(): Promise<TrialBalanceRow[]>{
        return this.run((tx)=> this.repo.getTrialBalance(tx));
    }

}