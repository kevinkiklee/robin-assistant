import { createNodeEngines } from '@surrealdb/node';
import { Surreal } from 'surrealdb';

export async function connect({ engine = 'mem://', namespace = 'robin', database = 'main' } = {}) {
  const db = new Surreal({ engines: createNodeEngines() });
  await db.connect(engine);
  await db.use({ namespace, database });
  return db;
}

export async function close(db) {
  try {
    await db.close();
  } catch {
    /* idempotent */
  }
}
