/**
 * 数据库模块 — SQLite via sql.js (WASM, 零原生依赖)
 *
 * 特性：
 * - 内存操作 + 按需持久化到磁盘
 * - 写后立即保存（单线程 Node.js 天然串行，无并发冲突）
 * - WAL 模式不复用（sql.js 内存数据库，每次都 atomically write）
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'grading.db');

let db = null;
let saveTimer = null;

// ========== 初始化 ==========

export async function initDB() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    try {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
      console.log(`📦 数据库已加载: ${DB_PATH} (${(buffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.warn('⚠️  数据库文件损坏，创建新库:', err.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    console.log('📦 创建新数据库');
  }

  // 建表（幂等）
  db.run(`
    CREATE TABLE IF NOT EXISTS grading_records (
      id            TEXT PRIMARY KEY,
      user_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'done',
      essay_text    TEXT NOT NULL,
      essay_topic   TEXT DEFAULT '',
      input_type    TEXT DEFAULT 'text',
      total_score   INTEGER DEFAULT 0,
      grade         TEXT DEFAULT '',
      word_count    INTEGER DEFAULT 0,
      dimensions    TEXT DEFAULT '{}',
      adjustments   TEXT DEFAULT '{}',
      revisions     TEXT DEFAULT '[]',
      suggestions   TEXT DEFAULT '[]',
      raw_markdown  TEXT DEFAULT '',
      raw_score     INTEGER DEFAULT 0,
      adjusted_score INTEGER DEFAULT 0,
      grading_reason TEXT DEFAULT '',
      one_sentence_summary TEXT DEFAULT '',
      upgrade_path  TEXT DEFAULT '{}',
      error_message TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  // 用户表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname      TEXT DEFAULT '',
      region        TEXT NOT NULL DEFAULT '上海',
      role          TEXT NOT NULL DEFAULT 'user',
      wechat_openid TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      grade         TEXT DEFAULT '',
      school        TEXT DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  // 迁移：补旧表缺失列
  try { db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';`); } catch (_) {}
  try { db.run(`ALTER TABLE users ADD COLUMN wechat_openid TEXT;`); } catch (_) {}
  try { db.run(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;`); } catch (_) {}
  try { db.run(`ALTER TABLE grading_records ADD COLUMN user_id TEXT;`); } catch (_) {}
  try { db.run(`ALTER TABLE grading_records ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;`); } catch (_) {}

  // 索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON grading_records(created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_id ON grading_records(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`);

  saveDB();
  console.log('✅ 数据库就绪');
  return db;
}

// ========== 持久化 ==========

export function saveDB() {
  if (!db) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const data = db.export();
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error('❌ 数据库保存失败:', err.message);
  }
}

export function saveDBDeferred(ms = 200) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDB, ms);
}

// ========== 用户 CRUD ==========

export function createUser({ email, passwordHash, nickname, region = '上海', role = 'user', wechatOpenid = null, mustChangePassword = 0, grade = '', school = '' }) {
  if (!db) throw new Error('数据库未初始化');
  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO users (id, email, password_hash, nickname, region, role, wechat_openid, must_change_password, grade, school, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email.toLowerCase().trim(), passwordHash, nickname || email.split('@')[0], region, role, wechatOpenid, mustChangePassword, grade, school, now, now]
  );
  saveDBDeferred();
  return getUserById(id);
}

export function getUserByEmail(email) {
  if (!db) return null;
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  stmt.bind([email.toLowerCase().trim()]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();
  return deserializeUser(row);
}

export function getUserById(id) {
  if (!db) return null;
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();
  return deserializeUser(row);
}

export function updateUser(id, fields) {
  if (!db) return null;
  // 字段名映射（JS camelCase → DB snake_case）
  const fieldMap = {
    nickname: 'nickname', region: 'region', grade: 'grade', school: 'school',
    role: 'role', wechatOpenid: 'wechat_openid', mustChangePassword: 'must_change_password',
    passwordHash: 'password_hash'
  };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = fieldMap[k] || k;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return getUserById(id);
  vals.push(Date.now(), id);
  db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  saveDBDeferred();
  return getUserById(id);
}

/** 修改密码 + 清除强制修改标记 */
export function changePassword(id, newPasswordHash) {
  return updateUser(id, { passwordHash: newPasswordHash, mustChangePassword: 0 });
}

/** 管理员：列出所有用户 */
export function listUsers(page = 1, limit = 50) {
  if (!db) return { users: [], total: 0 };
  const countStmt = db.prepare('SELECT COUNT(*) as total FROM users');
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();
  const offset = (page - 1) * limit;
  const stmt = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?');
  stmt.bind([limit, offset]);
  const users = [];
  while (stmt.step()) users.push(deserializeUser(stmt.getAsObject()));
  stmt.free();
  return { users, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ========== 批改记录 CRUD ==========

export function saveRecord(record) {
  if (!db) throw new Error('数据库未初始化');

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO grading_records (
      id, user_id, status, essay_text, essay_topic, input_type,
      total_score, grade, word_count,
      dimensions, adjustments, revisions, suggestions,
      raw_markdown, raw_score, adjusted_score,
      grading_reason, one_sentence_summary, upgrade_path,
      error_message, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  stmt.run([
    record.id,
    record.userId || null,
    record.status || 'done',
    record.essayText || '',
    record.essayTopic || '',
    record.inputType || 'text',
    record.totalScore || 0,
    record.grade || '',
    record.wordCount || 0,
    JSON.stringify(record.dimensions || {}),
    JSON.stringify(record.adjustments || { plus: [], minus: [] }),
    JSON.stringify(record.revisions || []),
    JSON.stringify(record.suggestions || []),
    record.rawMarkdown || '',
    record.rawScore || 0,
    record.adjustedScore || 0,
    record.gradingReason || '',
    record.oneSentenceSummary || '',
    JSON.stringify(record.upgradePath || {}),
    record.error || null,
    record.createdAt || Date.now(),
    Date.now()
  ]);

  stmt.free();
  saveDBDeferred();
}

export function getRecord(taskId, userId = null) {
  if (!db) return null;
  let query = 'SELECT * FROM grading_records WHERE id = ?';
  const params = [taskId];
  if (userId) { query += ' AND user_id = ?'; params.push(userId); }
  const stmt = db.prepare(query);
  stmt.bind(params);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();
  return deserializeRecord(row);
}

export function getHistory(userId = null, page = 1, limit = 20) {
  if (!db) return { records: [], total: 0, page, limit, totalPages: 0 };
  const conditions = ['status = ?'];
  const params = ['done'];
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }
  const where = conditions.join(' AND ');

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM grading_records WHERE ${where}`);
  countStmt.bind(params);
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();

  const offset = (page - 1) * limit;
  const stmt = db.prepare(`
    SELECT id, essay_topic, input_type, total_score, grade, word_count,
           one_sentence_summary, created_at
    FROM grading_records WHERE ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `);
  stmt.bind([...params, limit, offset]);

  const records = [];
  while (stmt.step()) records.push(stmt.getAsObject());
  stmt.free();

  return { records, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export function getStats(userId = null) {
  if (!db) return { total: 0, avgScore: 0, todayCount: 0 };
  const userClause = userId ? ' AND user_id = ?' : '';
  const userParam = userId ? [userId] : [];

  const total = db.exec(`SELECT COUNT(*) as c FROM grading_records WHERE status = ?${userClause}`, ['done', ...userParam])[0]?.values[0]?.[0] || 0;
  const avgScore = db.exec(`SELECT ROUND(AVG(total_score), 1) as s FROM grading_records WHERE status = ? AND total_score > 0${userClause}`, ['done', ...userParam])[0]?.values[0]?.[0] || 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = db.exec(`SELECT COUNT(*) as c FROM grading_records WHERE created_at >= ?${userClause}`, [todayStart.getTime(), ...userParam])[0]?.values[0]?.[0] || 0;

  return { total, avgScore, todayCount };
}

// ========== 工具 ==========

function deserializeUser(row) {
  return {
    id: row.id, email: row.email, nickname: row.nickname,
    region: row.region || '上海', role: row.role || 'user',
    wechatOpenid: row.wechat_openid || null,
    mustChangePassword: !!row.must_change_password,
    grade: row.grade || '', school: row.school || '',
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function deserializeRecord(row) {
  return {
    id: row.id, userId: row.user_id, status: row.status,
    essayText: row.essay_text, essayTopic: row.essay_topic,
    inputType: row.input_type, totalScore: row.total_score,
    grade: row.grade, wordCount: row.word_count,
    dimensions: safeParse(row.dimensions, {}),
    adjustments: safeParse(row.adjustments, { plus: [], minus: [] }),
    revisions: safeParse(row.revisions, []),
    suggestions: safeParse(row.suggestions, []),
    rawMarkdown: row.raw_markdown,
    rawScore: row.raw_score, adjustedScore: row.adjusted_score,
    gradingReason: row.grading_reason,
    oneSentenceSummary: row.one_sentence_summary,
    upgradePath: safeParse(row.upgrade_path, {}),
    error: row.error_message,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function safeParse(str, fallback) {
  try { return str && str !== '' ? JSON.parse(str) : fallback; }
  catch { return fallback; }
}
