import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const TOP_COUNT = 10;

export class ScoreStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS scores (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        defeated INTEGER NOT NULL CHECK (defeated BETWEEN 0 AND 100),
        difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS scores_ranking
        ON scores (difficulty, defeated DESC, sequence ASC);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    this.db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run('server_id', randomUUID());
    this.serverId = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('server_id').value;
    this.topQuery = this.db.prepare(`
      SELECT run_id AS runId, name, defeated, created_at AS createdAt
      FROM scores WHERE difficulty = ?
      ORDER BY defeated DESC, sequence ASC LIMIT ${TOP_COUNT}
    `);
    this.rankQuery = this.db.prepare('SELECT COUNT(*) + 1 AS rank FROM scores WHERE difficulty = ? AND defeated >= ?');
    this.existingQuery = this.db.prepare('SELECT * FROM scores WHERE run_id = ?');
    this.existingRankQuery = this.db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM scores
      WHERE difficulty = ? AND (defeated > ? OR (defeated = ? AND sequence < ?))
    `);
    this.insertQuery = this.db.prepare('INSERT INTO scores (run_id, name, defeated, difficulty, created_at) VALUES (?, ?, ?, ?, ?)');
  }

  leaderboard(difficulty) {
    return this.topQuery.all(difficulty).map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  qualification(difficulty, defeated) {
    const { rank } = this.rankQuery.get(difficulty, defeated);
    return { qualified: rank <= TOP_COUNT, rank };
  }

  register({ runId, name, difficulty, defeated }) {
    // Qualification and insertion share one write transaction, including when
    // a second server process happens to use the same local database.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.existingQuery.get(runId);
      let result;
      if (existing) {
        if (existing.name !== name || existing.difficulty !== difficulty || existing.defeated !== defeated) {
          result = { status: 409, code: 'RUN_CONFLICT', error: 'This run was already registered with different values.' };
        } else {
          const { rank } = this.existingRankQuery.get(difficulty, defeated, defeated, existing.sequence);
          result = { status: 200, qualified: true, rank, entry: { runId, name, difficulty, defeated, createdAt: existing.created_at, rank } };
        }
      } else {
        const qualification = this.qualification(difficulty, defeated);
        if (!qualification.qualified) {
          result = { status: 409, code: 'NOT_QUALIFIED', ...qualification };
        } else {
          const createdAt = new Date().toISOString();
          this.insertQuery.run(runId, name, defeated, difficulty, createdAt);
          result = { status: 201, ...qualification, entry: { runId, name, difficulty, defeated, createdAt, rank: qualification.rank } };
        }
      }
      const entries = this.leaderboard(difficulty);
      this.db.exec('COMMIT');
      return { ...result, difficulty, entries };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
}
