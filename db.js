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

  // ========== 错题表 ==========
  db.run(`
    CREATE TABLE IF NOT EXISTS error_problems (
      id              TEXT PRIMARY KEY,
      user_id         TEXT,
      subject         TEXT NOT NULL DEFAULT '数学',
      topic           TEXT DEFAULT '',
      question_text   TEXT NOT NULL,
      wrong_answer    TEXT DEFAULT '',
      error_type      TEXT DEFAULT '',
      correct_solution TEXT DEFAULT '',
      difficulty      INTEGER DEFAULT 3,
      notes           TEXT DEFAULT '',
      source          TEXT DEFAULT '',
      ai_raw          TEXT DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'done',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  // 知识点字典
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_points (
      id        TEXT PRIMARY KEY,
      subject   TEXT NOT NULL,
      name      TEXT NOT NULL,
      parent_id TEXT,
      category  TEXT DEFAULT ''
    );
  `);

  // 错题-知识点关联
  db.run(`
    CREATE TABLE IF NOT EXISTS error_knowledge_tags (
      error_id     TEXT NOT NULL,
      knowledge_id TEXT NOT NULL,
      PRIMARY KEY (error_id, knowledge_id)
    );
  `);

  // 种子：知识点数据（幂等）
  seedKnowledgePoints(db);

  // 索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON grading_records(created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_id ON grading_records(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_user ON error_problems(user_id, created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_subject ON error_problems(subject);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_kp_subject ON knowledge_points(subject);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ekt_error ON error_knowledge_tags(error_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ekt_kp ON error_knowledge_tags(knowledge_id);`);

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

// ========== 知识点种子数据 ==========

function seedKnowledgePoints(database) {
  const count = database.exec(`SELECT COUNT(*) as c FROM knowledge_points`)[0]?.values[0]?.[0] || 0;
  if (count > 0) return;

  const subjects = {
    '数学': [
      { name: '集合与逻辑', items: ['集合运算', '命题与条件', '充要条件'] },
      { name: '函数', items: ['函数概念与性质', '二次函数', '指数与对数', '三角函数', '函数图像变换', '函数与方程'] },
      { name: '数列', items: ['等差数列', '等比数列', '数列求和', '递推数列'] },
      { name: '不等式', items: ['一元二次不等式', '基本不等式', '绝对值不等式'] },
      { name: '平面向量', items: ['向量运算', '向量坐标表示', '向量应用'] },
      { name: '立体几何', items: ['空间位置关系', '体积与表面积', '空间向量'] },
      { name: '解析几何', items: ['直线与圆', '椭圆', '双曲线', '抛物线', '轨迹方程'] },
      { name: '概率统计', items: ['古典概型', '条件概率', '期望与方差', '统计图表'] },
      { name: '导数', items: ['导数概念与运算', '导数几何意义', '导数与单调性', '导数与极值最值'] },
      { name: '复数', items: ['复数运算', '复数几何意义'] }
    ],
    '物理': [
      { name: '运动学', items: ['匀变速直线运动', '抛体运动', '圆周运动', '相对运动'] },
      { name: '力学', items: ['牛顿运动定律', '万有引力', '功与能量', '动量守恒', '机械振动'] },
      { name: '电磁学', items: ['静电场', '恒定电流', '磁场', '电磁感应', '交变电流'] },
      { name: '热学', items: ['分子动理论', '热力学定律', '理想气体'] },
      { name: '光学', items: ['几何光学', '光的波动性'] },
      { name: '原子物理', items: ['光电效应', '原子结构', '核物理'] }
    ],
    '化学': [
      { name: '基本概念', items: ['物质的量', '氧化还原反应', '离子反应', '化学键与分子结构'] },
      { name: '元素化合物', items: ['金属元素', '非金属元素', '常见化合物性质'] },
      { name: '化学反应原理', items: ['反应热', '化学反应速率', '化学平衡', '电离平衡', '沉淀溶解平衡'] },
      { name: '有机化学', items: ['烃', '烃的衍生物', '有机合成', '同分异构体'] },
      { name: '化学实验', items: ['基本操作', '物质检验', '实验设计与评价'] },
      { name: '物质结构', items: ['原子结构', '元素周期律', '晶体结构'] }
    ],
    '英语': [
      { name: '语法', items: ['时态语态', '非谓语动词', '从句', '虚拟语气', '倒装强调'] },
      { name: '词汇', items: ['词义辨析', '固定搭配', '短语动词'] },
      { name: '阅读', items: ['主旨大意', '细节理解', '推理判断', '词义猜测'] },
      { name: '写作', items: ['应用文', '读后续写', '概要写作'] }
    ],
    '语文': [
      { name: '基础知识', items: ['字音字形', '词语成语', '病句辨析', '修辞手法'] },
      { name: '文言文', items: ['实词虚词', '文言句式', '翻译', '内容理解'] },
      { name: '诗歌鉴赏', items: ['意象意境', '表达技巧', '思想情感'] },
      { name: '现代文阅读', items: ['论述类', '文学类', '实用类'] }
    ]
  };

  const stmt = database.prepare('INSERT INTO knowledge_points (id, subject, name, parent_id, category) VALUES (?, ?, ?, ?, ?)');
  for (const [subject, categories] of Object.entries(subjects)) {
    for (const cat of categories) {
      const parentId = crypto.randomUUID().slice(0, 8);
      stmt.run([parentId, subject, cat.name, null, 'category']);
      for (const item of cat.items) {
        stmt.run([crypto.randomUUID().slice(0, 8), subject, item, parentId, 'item']);
      }
    }
  }
  stmt.free();
  saveDBDeferred();
  console.log('🌱 知识点种子数据已初始化');
}

// ========== 错题 CRUD ==========

export function saveErrorProblem(record) {
  if (!db) throw new Error('数据库未初始化');
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO error_problems (
      id, user_id, subject, topic, question_text, wrong_answer,
      error_type, correct_solution, difficulty, notes, source, ai_raw, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    record.id,
    record.userId || null,
    record.subject || '数学',
    record.topic || '',
    record.questionText || '',
    record.wrongAnswer || '',
    record.errorType || '',
    record.correctSolution || '',
    record.difficulty || 3,
    record.notes || '',
    record.source || '',
    record.aiRaw || '',
    record.status || 'done',
    record.createdAt || Date.now(),
    Date.now()
  ]);
  stmt.free();
  saveDBDeferred();
}

export function saveErrorKnowledgeTags(errorId, knowledgeIds) {
  if (!db || !knowledgeIds?.length) return;
  const stmt = db.prepare('INSERT OR REPLACE INTO error_knowledge_tags (error_id, knowledge_id) VALUES (?, ?)');
  for (const kid of knowledgeIds) {
    stmt.run([errorId, kid]);
  }
  stmt.free();
  saveDBDeferred();
}

export function getErrorProblem(id, userId = null) {
  if (!db) return null;
  let query = 'SELECT * FROM error_problems WHERE id = ?';
  const params = [id];
  if (userId) { query += ' AND user_id = ?'; params.push(userId); }
  const stmt = db.prepare(query);
  stmt.bind(params);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();
  const tags = getErrorTags(id);
  return { ...deserializeError(row), knowledgeTags: tags };
}

export function listErrorProblems({ userId, subject, page = 1, limit = 20 } = {}) {
  if (!db) return { records: [], total: 0, page, limit, totalPages: 0 };
  const conditions = [];
  const params = [];
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }
  if (subject && subject !== 'all') { conditions.push('subject = ?'); params.push(subject); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM error_problems ${where}`);
  countStmt.bind(params);
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();

  const offset = (page - 1) * limit;
  const stmt = db.prepare(`
    SELECT * FROM error_problems ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `);
  stmt.bind([...params, limit, offset]);
  const records = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const tags = getErrorTags(row.id);
    records.push({ ...deserializeError(row), knowledgeTags: tags });
  }
  stmt.free();
  return { records, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export function getErrorStats(userId = null) {
  if (!db) return { total: 0, bySubject: {}, byErrorType: {}, todayCount: 0 };
  const userClause = userId ? ' AND user_id = ?' : '';
  const userParam = userId ? [userId] : [];

  const total = db.exec(`SELECT COUNT(*) as c FROM error_problems WHERE 1=1${userClause}`, userParam)[0]?.values[0]?.[0] || 0;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayCount = db.exec(`SELECT COUNT(*) as c FROM error_problems WHERE created_at >= ?${userClause}`, [todayStart.getTime(), ...userParam])[0]?.values[0]?.[0] || 0;

  const bySubject = {};
  const subjectRows = db.exec(`SELECT subject, COUNT(*) as c FROM error_problems WHERE 1=1${userClause} GROUP BY subject`, userParam);
  if (subjectRows[0]) for (const row of subjectRows[0].values) bySubject[row[0]] = row[1];

  const byErrorType = {};
  const typeRows = db.exec(`SELECT error_type, COUNT(*) as c FROM error_problems WHERE error_type != ''${userClause} GROUP BY error_type`, userParam);
  if (typeRows[0]) for (const row of typeRows[0].values) byErrorType[row[0]] = row[1];

  return { total, bySubject, byErrorType, todayCount };
}

/** 按知识点聚合：每个知识点关联的错题数 */
export function getKnowledgeStats(userId = null) {
  if (!db) return [];
  const userClause = userId ? ' AND ep.user_id = ?' : '';
  const userParam = userId ? [userId] : [];
  const rows = db.exec(`
    SELECT kp.id, kp.name, kp.subject, kp.category, COUNT(ekt.error_id) as error_count
    FROM knowledge_points kp
    JOIN error_knowledge_tags ekt ON kp.id = ekt.knowledge_id
    JOIN error_problems ep ON ekt.error_id = ep.id${userClause}
    GROUP BY kp.id
    ORDER BY error_count DESC
    LIMIT 50
  `, userParam);
  if (!rows[0]) return [];
  return rows[0].values.map(row => ({
    id: row[0], name: row[1], subject: row[2], category: row[3], errorCount: row[4]
  }));
}

/** 搜索知识点（模糊匹配） */
export function searchKnowledgePoints(q, subject = null) {
  if (!db || !q) return [];
  let query = 'SELECT * FROM knowledge_points WHERE name LIKE ?';
  const params = [`%${q}%`];
  if (subject) { query += ' AND subject = ?'; params.push(subject); }
  query += ' LIMIT 20';
  const stmt = db.prepare(query);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function getErrorTags(errorId) {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT kp.* FROM knowledge_points kp
    JOIN error_knowledge_tags ekt ON kp.id = ekt.knowledge_id
    WHERE ekt.error_id = ?
  `);
  stmt.bind([errorId]);
  const tags = [];
  while (stmt.step()) tags.push(stmt.getAsObject());
  stmt.free();
  return tags;
}

// ========== 工具 ==========

function deserializeUser(row) {
  return {
    id: row.id, email: row.email, nickname: row.nickname,
    region: row.region || '上海', role: row.role || 'user',
    wechatOpenid: row.wechat_openid || null,
    mustChangePassword: !!row.must_change_password,
    grade: row.grade || '', school: row.school || '',
    passwordHash: row.password_hash,
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

function deserializeError(row) {
  return {
    id: row.id, userId: row.user_id, subject: row.subject,
    topic: row.topic, questionText: row.question_text,
    wrongAnswer: row.wrong_answer, errorType: row.error_type,
    correctSolution: row.correct_solution, difficulty: row.difficulty,
    notes: row.notes, source: row.source, aiRaw: row.ai_raw,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
