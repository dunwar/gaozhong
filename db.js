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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'grading.db');

let db = null;
let saveTimer = null;

// ========== 初始化 ==========

export async function initDB() {
  // 确保目录存在
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const SQL = await initSqlJs();

  // 尝试从磁盘加载
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

  // 索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON grading_records(created_at DESC);`);

  // 立即保存表结构
  saveDB();
  console.log('✅ 数据库就绪');

  return db;
}

// ========== 持久化 ==========

export function saveDB() {
  if (!db) return;
  // 清除待处理的定时器
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

  try {
    const data = db.export();
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error('❌ 数据库保存失败:', err.message);
  }
}

// 延迟保存（合并短时间内的多次写操作）
export function saveDBDeferred(ms = 200) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDB, ms);
}

// ========== CRUD ==========

/**
 * 保存批改记录
 */
export function saveRecord(record) {
  if (!db) throw new Error('数据库未初始化');

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO grading_records (
      id, status, essay_text, essay_topic, input_type,
      total_score, grade, word_count,
      dimensions, adjustments, revisions, suggestions,
      raw_markdown, raw_score, adjusted_score,
      grading_reason, one_sentence_summary, upgrade_path,
      error_message, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  stmt.run([
    record.id,
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

  // 异步延迟保存（合并高频写入）
  saveDBDeferred();
}

/**
 * 查询单条记录
 */
export function getRecord(taskId) {
  if (!db) return null;

  const stmt = db.prepare('SELECT * FROM grading_records WHERE id = ?');
  stmt.bind([taskId]);

  if (!stmt.step()) {
    stmt.free();
    return null;
  }

  const row = stmt.getAsObject();
  stmt.free();
  return deserializeRecord(row);
}

/**
 * 分页查询历史（按时间倒序）
 */
export function getHistory(page = 1, limit = 20) {
  if (!db) return { records: [], total: 0, page, limit };

  // 总数
  const countStmt = db.prepare('SELECT COUNT(*) as total FROM grading_records WHERE status = ?');
  countStmt.bind(['done']);
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();

  // 分页
  const offset = (page - 1) * limit;
  const stmt = db.prepare(`
    SELECT id, essay_topic, input_type, total_score, grade, word_count,
           one_sentence_summary, created_at
    FROM grading_records
    WHERE status = 'done'
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  stmt.bind([limit, offset]);

  const records = [];
  while (stmt.step()) {
    records.push(stmt.getAsObject());
  }
  stmt.free();

  return { records, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * 获取统计信息
 */
export function getStats() {
  if (!db) return { total: 0, avgScore: 0, todayCount: 0 };

  const total = db.exec('SELECT COUNT(*) as c FROM grading_records WHERE status = ?', ['done'])[0]?.values[0]?.[0] || 0;
  const avgScore = db.exec('SELECT ROUND(AVG(total_score), 1) as s FROM grading_records WHERE status = ? AND total_score > 0', ['done'])[0]?.values[0]?.[0] || 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = db.exec('SELECT COUNT(*) as c FROM grading_records WHERE created_at >= ?', [todayStart.getTime()])[0]?.values[0]?.[0] || 0;

  return { total, avgScore, todayCount };
}

// ========== 工具 ==========

function deserializeRecord(row) {
  return {
    id: row.id,
    status: row.status,
    essayText: row.essay_text,
    essayTopic: row.essay_topic,
    inputType: row.input_type,
    totalScore: row.total_score,
    grade: row.grade,
    wordCount: row.word_count,
    dimensions: safeParse(row.dimensions, {}),
    adjustments: safeParse(row.adjustments, { plus: [], minus: [] }),
    revisions: safeParse(row.revisions, []),
    suggestions: safeParse(row.suggestions, []),
    rawMarkdown: row.raw_markdown,
    rawScore: row.raw_score,
    adjustedScore: row.adjusted_score,
    gradingReason: row.grading_reason,
    oneSentenceSummary: row.one_sentence_summary,
    upgradePath: safeParse(row.upgrade_path, {}),
    error: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeParse(str, fallback) {
  try {
    if (!str || str === '') return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
