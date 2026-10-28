import { Inject, Injectable} from '@nestjs/common';
import { Pool, PoolClient} from 'pg';
import { PG_POOL } from './pg-pool';

/**
 * Runs `work` inside BEGIN/COMMIT on a single pooled connection.
 * Any error (including a deferred-constraint failure raised by COMMIT) rolls back and is rethrown.
 */
@Injectable()
export class TransactionRunner {
    constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

    async run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T>{
        const client = await this.pool.connect();
        let brokenConnection: Error | undefined;
        try{
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch(err) {
            try{
                await client.query('ROLLBACK');
            }catch(rollbackError){
                brokenConnection = rollbackError as Error;
            }
            throw err;
        } finally {
            client.release(brokenConnection);
        }
    }
}