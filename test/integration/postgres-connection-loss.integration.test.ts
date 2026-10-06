import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { CommitOutcomeUnknownError, PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";

/*
 * A pooled client that is CHECKED OUT (inside withTransaction /
 * withAdvisoryLock) and loses its server connection must not surface as an
 * unhandled 'error' event: pg-pool removes its own listener on checkout, and
 * an unhandled EventEmitter error is a programmer error that server.ts turns
 * into process exit. The connection is killed for real with
 * pg_terminate_backend. Vitest fails the run on any unhandled error, so
 * these tests also fail if the event escapes.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

async function setup() {
  const handle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => handle.dispose());
  const admin = new pg.Client({ connectionString: handle.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-pg-loss-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const database = new PostgresDatabase(buildRuntimeTestEnv({ databaseUrl: handle.connectionString, storageRoot }));
  cleanups.push(() => database.close());
  const reported: Error[] = [];
  database.onConnectionError((error) => reported.push(error));
  const terminate = async (pid: number) => {
    await admin.query("select pg_terminate_backend($1)", [pid]);
  };
  return { database, terminate, reported };
}

const backendPid = async (client: pg.PoolClient): Promise<number> =>
  (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

describe("checked-out PostgreSQL client loses its connection", () => {
  it("inside a transaction: the work fails normally, no uncaught error, the pool recovers", async () => {
    const { database, terminate, reported } = await setup();

    await expect(
      database.withTransaction(async (client) => {
        await terminate(await backendPid(client));
        await waitFor(() => reported.length > 0, 5_000);
        await client.query("select 1");
      })
    ).rejects.toThrow();

    expect(reported.length).toBeGreaterThan(0);
    // The broken client was discarded: the next transaction gets a live connection.
    expect(await database.withTransaction(async (client) => (await client.query<{ ok: number }>("select 1 as ok")).rows[0]!.ok)).toBe(1);
  });

  it("before COMMIT: the commit failure is reported as CommitOutcomeUnknownError, never as a crash", async () => {
    const { database, terminate, reported } = await setup();

    await expect(
      database.withTransaction(async (client) => {
        await terminate(await backendPid(client));
        await waitFor(() => reported.length > 0, 5_000);
      })
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);

    expect((await database.query<{ ok: number }>("select 1 as ok")).rows[0]!.ok).toBe(1);
  });

  it("while holding an advisory lock: the work fails normally, no uncaught error", async () => {
    const { database, terminate, reported } = await setup();

    await expect(
      database.withAdvisoryLock(4242, async () => {
        const holders = await database.query<{ pid: number }>(
          "select pid from pg_locks where locktype = 'advisory' and objid = 4242 and granted"
        );
        await terminate(holders.rows[0]!.pid);
        await waitFor(() => reported.length > 0, 5_000);
        return "done";
      })
    ).resolves.toMatchObject({ acquired: true, result: "done" });

    expect(reported.length).toBeGreaterThan(0);
    expect((await database.query<{ ok: number }>("select 1 as ok")).rows[0]!.ok).toBe(1);
  });
});
