import { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

export function createPool(): Pool{
    const connectionString = process.env.DATABASE_URL;
    if(!connectionString){
        throw new Error('DATABASE_URL is not set')
    }
    return new Pool({ connectionString, max:10, application_name: 'payments-ledger'});
}