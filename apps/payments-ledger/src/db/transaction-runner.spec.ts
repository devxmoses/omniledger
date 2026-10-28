import type { Pool, PoolClient } from 'pg';
import { TransactionRunner } from './transaction-runner';

function fakePool(failOn?: string) {
  const queries: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql === failOn) throw new Error(`${sql} failed`);
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as unknown as Pool;
  return { runner: new TransactionRunner(pool), client, queries };
}

describe('TransactionRunner', () => {
  it('commits and returns the result when work succeeds', async () => {
    const { runner, client, queries } = fakePool();
    const result = await runner.run(async (tx: PoolClient) => {
      await tx.query('INSERT 1');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(queries).toEqual(['BEGIN', 'INSERT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back and rethrows when work throws', async () => {
    const { runner, client, queries } = fakePool();
    await expect(
      runner.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('treats a failing COMMIT (deferred constraint) like any other error', async () => {
    const { runner, queries } = fakePool('COMMIT');
    await expect(runner.run(async () => 'never returned')).rejects.toThrow('COMMIT failed');
    expect(queries).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
  });

  it('destroys the connection if ROLLBACK itself fails', async () => {
    const { runner, client } = fakePool('ROLLBACK');
    await expect(
      runner.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });
});
