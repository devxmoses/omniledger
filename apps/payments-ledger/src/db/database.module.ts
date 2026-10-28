import { Module, Inject, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { LedgerRepository } from './ledger.repository';
import { createPool, PG_POOL } from './pg-pool';
import { TransactionRunner } from './transaction-runner';

@Module({
    providers: [{ provide: PG_POOL, useFactory: createPool}, TransactionRunner, LedgerRepository],
    exports: [PG_POOL, TransactionRunner, LedgerRepository]
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown{
    private readonly logger = new Logger(DatabaseModule.name);
    
    constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

    async onModuleInit(): Promise<void> {
        await this.pool.query('SELECT 1');
        this.logger.log('Connected to Postgres');
    }

    async onApplicationShutdown(): Promise<void> {
        await this.pool.end();
    }
}
