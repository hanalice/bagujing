import sqlite3 from 'sqlite3';

/**
 * Lightweight SQLite connection pool for Node (sqlite3).
 *
 * Notes:
 * - Pooling is about reusing open handles, not true parallel writes.
 * - With pm2 multi-process, each process has its own pool.
 */

const DEFAULT_PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA busy_timeout = 5000;",
];

function openDatabase(filename, pragmas = DEFAULT_PRAGMAS) {
  // verbose() improves stack traces and logs some debug info.
  // It is safe to call multiple times.
  const sqlite = typeof sqlite3.verbose === 'function' ? sqlite3.verbose() : sqlite3;
  const db = new sqlite.Database(filename);

  // Apply pragmas on open; exec is serialized.
  db.exec(pragmas.join('\n'));

  return db;
}

function wrapStatement(stmt) {
  return {
    run(params = []) {
      return new Promise((resolve, reject) => {
        stmt.run(params, function onRun(err) {
          if (err) return reject(err);
          resolve({ changes: this.changes, lastID: this.lastID });
        });
      });
    },
    get(params = []) {
      return new Promise((resolve, reject) => {
        stmt.get(params, (err, row) => (err ? reject(err) : resolve(row)));
      });
    },
    all(params = []) {
      return new Promise((resolve, reject) => {
        stmt.all(params, (err, rows) => (err ? reject(err) : resolve(rows)));
      });
    },
    finalize() {
      return new Promise((resolve, reject) => {
        stmt.finalize((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function wrapDb(db) {
  return {
    raw: db,
    exec(sql) {
      return new Promise((resolve, reject) => {
        db.exec(sql, (err) => (err ? reject(err) : resolve()));
      });
    },
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
          if (err) return reject(err);
          resolve({ changes: this.changes, lastID: this.lastID });
        });
      });
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
      });
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
      });
    },
    prepare(sql) {
      return new Promise((resolve, reject) => {
        const stmt = db.prepare(sql, (err) => {
          if (err) return reject(err);
          resolve(wrapStatement(stmt));
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export function createSqlitePool({ filename, max = 4, pragmas } = {}) {
  if (!filename) throw new Error('createSqlitePool: filename is required');
  if (!Number.isFinite(max) || max <= 0) throw new Error('createSqlitePool: max must be a positive number');

  // 当前空闲的连接
  const idle = [];
  // 池里创建过的所有链接
  const all = new Set();
  // 等待连接的队列，里面存的是resolve 函数；当没有连接空闲时，把怎么唤醒等待者的方法先存起来
  const waiters = [];

  async function acquire() {
    if (idle.length > 0) return idle.pop();

    if (all.size < max) {
      const db = wrapDb(openDatabase(filename, pragmas));
      all.add(db);
      return db;
    }

    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  // 释放连接，如果有人在等，直接给他，否则放到空闲列表里
  function release(db) {
    const resolve = waiters.shift();
    if (resolve) resolve(db);
    else idle.push(db);
  }

  async function withConnection(fn) {
    const db = await acquire();
    try {
      return await fn(db);
    } finally {
      release(db);
    }
  }

  async function closeAll() {
    const closing = [];
    for (const db of all) closing.push(db.close());
    await Promise.allSettled(closing);

    idle.length = 0;
    all.clear();
    waiters.length = 0;
  }

  return { withConnection, closeAll };
}
