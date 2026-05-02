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
      question_type   TEXT DEFAULT '',
      answer_options  TEXT DEFAULT '',
      wrong_answer    TEXT DEFAULT '',
      correct_answer  TEXT DEFAULT '',
      error_type      TEXT DEFAULT '',
      correct_solution TEXT DEFAULT '',
      difficulty      INTEGER DEFAULT 3,
      knowledge_explanation TEXT DEFAULT '',
      grading_evidence TEXT DEFAULT '',
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

  // ========== V2 新增：试卷会话表 ==========
  db.run(`
    CREATE TABLE IF NOT EXISTS paper_sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      subject     TEXT NOT NULL,
      title       TEXT DEFAULT '',
      image_count INTEGER DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'pending',
      ai_raw      TEXT DEFAULT '',
      error_count INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  // 迁移：error_problems 增加 session 关联字段
  try { db.run(`ALTER TABLE error_problems ADD COLUMN session_id TEXT REFERENCES paper_sessions(id);`); } catch (_) {}
  try { db.run(`ALTER TABLE error_problems ADD COLUMN paper_index INTEGER DEFAULT 1;`); } catch (_) {}
  // V3 迁移：新增字段
  try { db.run(`ALTER TABLE error_problems ADD COLUMN question_type TEXT DEFAULT '';`); } catch (_) {}
  try { db.run(`ALTER TABLE error_problems ADD COLUMN answer_options TEXT DEFAULT '';`); } catch (_) {}
  try { db.run(`ALTER TABLE error_problems ADD COLUMN correct_answer TEXT DEFAULT '';`); } catch (_) {}
  try { db.run(`ALTER TABLE error_problems ADD COLUMN knowledge_explanation TEXT DEFAULT '';`); } catch (_) {}
  try { db.run(`ALTER TABLE error_problems ADD COLUMN grading_evidence TEXT DEFAULT '';`); } catch (_) {}
  // paper_sessions 新增统计字段
  try { db.run(`ALTER TABLE paper_sessions ADD COLUMN total_questions INTEGER DEFAULT 0;`); } catch (_) {}
  try { db.run(`ALTER TABLE paper_sessions ADD COLUMN correct_count INTEGER DEFAULT 0;`); } catch (_) {}

  // 索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_paper_sessions_user ON paper_sessions(user_id, created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_paper_sessions_subject ON paper_sessions(subject);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_session ON error_problems(session_id);`);

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
    '生物': [
      { name: '细胞生物学', items: ['细胞结构与功能', '细胞代谢', '细胞分裂', '细胞分化'] },
      { name: '遗传与进化', items: ['遗传规律', '变异与育种', '基因表达', '生物进化'] },
      { name: '稳态与调节', items: ['内环境稳态', '神经调节', '体液调节', '免疫调节'] },
      { name: '生态学', items: ['种群与群落', '生态系统', '生态平衡', '生物多样性'] },
      { name: '生物技术', items: ['基因工程', '细胞工程', '发酵工程', '实验设计'] }
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
      id, user_id, subject, topic, question_text, question_type, answer_options,
      wrong_answer, correct_answer,
      error_type, correct_solution, difficulty,
      knowledge_explanation, grading_evidence,
      notes, source, ai_raw, status,
      session_id, paper_index,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    record.id,
    record.userId || null,
    record.subject || '数学',
    record.topic || '',
    record.questionText || '',
    record.questionType || '',
    record.answerOptions || '',
    record.wrongAnswer || '',
    record.correctAnswer || '',
    record.errorType || '',
    record.correctSolution || '',
    record.difficulty || 3,
    record.knowledgeExplanation || '',
    record.gradingEvidence || '',
    record.notes || '',
    record.source || '',
    record.aiRaw || '',
    record.status || 'done',
    record.sessionId || null,
    record.paperIndex || 1,
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

// ========== V2 试卷会话 CRUD ==========

export function createPaperSession({ id, userId, subject, title, imageCount = 1, status = 'pending' }) {
  if (!db) throw new Error('数据库未初始化');
  const now = Date.now();
  db.run(
    `INSERT INTO paper_sessions (id, user_id, subject, title, image_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, subject, title || '', imageCount, status, now, now]
  );
  saveDBDeferred();
  return getPaperSession(id);
}

export function updatePaperSession(id, fields) {
  if (!db) return null;
  const fieldMap = { status: 'status', errorCount: 'error_count', aiRaw: 'ai_raw', imageCount: 'image_count', title: 'title', totalQuestions: 'total_questions', correctCount: 'correct_count' };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = fieldMap[k] || k;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return getPaperSession(id);
  vals.push(Date.now(), id);
  db.run(`UPDATE paper_sessions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  saveDBDeferred();
  return getPaperSession(id);
}

export function getPaperSession(id) {
  if (!db) return null;
  const stmt = db.prepare('SELECT * FROM paper_sessions WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();
  return deserializePaper(row);
}

export function listPaperSessions(userId, { page = 1, limit = 20, subject = null } = {}) {
  if (!db) return { sessions: [], total: 0 };
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (subject && subject !== 'all') { conditions.push('subject = ?'); params.push(subject); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM paper_sessions ${where}`);
  countStmt.bind(params);
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();

  const offset = (page - 1) * limit;
  const stmt = db.prepare(`SELECT * FROM paper_sessions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`);
  stmt.bind([...params, limit, offset]);
  const sessions = [];
  while (stmt.step()) sessions.push(deserializePaper(stmt.getAsObject()));
  stmt.free();
  return { sessions, total, page, limit, totalPages: Math.ceil(total / limit) };
}

function deserializePaper(row) {
  return {
    id: row.id, userId: row.user_id, subject: row.subject,
    title: row.title, imageCount: row.image_count, status: row.status,
    aiRaw: row.ai_raw, errorCount: row.error_count,
    totalQuestions: row.total_questions || 0, correctCount: row.correct_count || 0,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

// ========== V2 错题视图查询 ==========

/** 按试卷分组：返回试卷列表，每份试卷包含错题汇总 */
export function listErrorsByPaper(userId, { page = 1, limit = 20 } = {}) {
  if (!db) return { papers: [], total: 0 };
  const countStmt = db.prepare('SELECT COUNT(*) as total FROM paper_sessions WHERE user_id = ?');
  countStmt.bind([userId]);
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();

  const offset = (page - 1) * limit;
  const stmt = db.prepare(`
    SELECT ps.*, 
      COUNT(ep.id) as error_count,
      SUM(CASE WHEN ep.error_type = '概念不清' THEN 1 ELSE 0 END) as concept_errors,
      SUM(CASE WHEN ep.error_type = '计算失误' THEN 1 ELSE 0 END) as calc_errors,
      SUM(CASE WHEN ep.error_type = '审题偏差' THEN 1 ELSE 0 END) as reading_errors,
      SUM(CASE WHEN ep.error_type = '方法错误' THEN 1 ELSE 0 END) as method_errors,
      SUM(CASE WHEN ep.error_type = '知识盲区' THEN 1 ELSE 0 END) as knowledge_errors
    FROM paper_sessions ps
    LEFT JOIN error_problems ep ON ps.id = ep.session_id
    WHERE ps.user_id = ?
    GROUP BY ps.id
    ORDER BY ps.created_at DESC LIMIT ? OFFSET ?
  `);
  stmt.bind([userId, limit, offset]);
  const papers = [];
  while (stmt.step()) papers.push(stmt.getAsObject());
  stmt.free();
  return { papers, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/** 按时间段分组：返回各时间段的错题统计 */
export function listErrorsByTime(userId, { period = 'month' } = {}) {
  if (!db) return [];
  let groupExpr, labelExpr;
  if (period === 'semester') {
    // 简单学期划分：9-2月为上，3-8月为下
    groupExpr = `CASE WHEN CAST(strftime('%m', ep.created_at / 1000, 'unixepoch') AS INTEGER) BETWEEN 3 AND 8 THEN strftime('%Y', ep.created_at / 1000, 'unixepoch') || '-下' ELSE strftime('%Y', ep.created_at / 1000, 'unixepoch') || '-上' END`;
  } else if (period === 'year') {
    groupExpr = `strftime('%Y', ep.created_at / 1000, 'unixepoch')`;
  } else {
    // month
    groupExpr = `strftime('%Y-%m', ep.created_at / 1000, 'unixepoch')`;
  }
  const rows = db.exec(`
    SELECT ${groupExpr} as time_label, MIN(ep.created_at) as start_ts, MAX(ep.created_at) as end_ts,
      COUNT(*) as error_count,
      COUNT(DISTINCT ep.subject) as subject_count,
      COUNT(DISTINCT ep.session_id) as paper_count
    FROM error_problems ep
    WHERE ep.user_id = '${userId.replace(/'/g, "''")}'
    GROUP BY time_label
    ORDER BY start_ts DESC
    LIMIT 50
  `);
  if (!rows[0]) return [];
  return rows[0].values.map(row => ({
    timeLabel: row[0], startTs: row[1], endTs: row[2],
    errorCount: row[3], subjectCount: row[4], paperCount: row[5]
  }));
}

/** 按科目分组：返回各科目的错题统计 */
export function listErrorsBySubject(userId) {
  if (!db) return [];
  const rows = db.exec(`
    SELECT ep.subject, COUNT(*) as error_count,
      COUNT(DISTINCT ep.session_id) as paper_count,
      GROUP_CONCAT(DISTINCT ep.error_type) as error_types
    FROM error_problems ep
    WHERE ep.user_id = '${(userId || '').replace(/'/g, "''")}'
    GROUP BY ep.subject
    ORDER BY error_count DESC
  `);
  if (!rows[0]) return [];
  return rows[0].values.map(row => ({
    subject: row[0], errorCount: row[1], paperCount: row[2],
    errorTypes: row[3] ? row[3].split(',') : []
  }));
}

/** 获取某科目的错题列表（用于 AI 学习指导） */
export function listErrorsForGuidance(userId, subject, fromTs, toTs) {
  if (!db) return [];
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (subject) { conditions.push('subject = ?'); params.push(subject); }
  if (fromTs) { conditions.push('created_at >= ?'); params.push(fromTs); }
  if (toTs) { conditions.push('created_at <= ?'); params.push(toTs); }
  const where = conditions.join(' AND ');
  const stmt = db.prepare(`SELECT * FROM error_problems WHERE ${where} ORDER BY created_at DESC LIMIT 200`);
  stmt.bind(params);
  const errors = [];
  while (stmt.step()) errors.push(deserializeError(stmt.getAsObject()));
  stmt.free();
  return errors;
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
    questionType: row.question_type || '',
    answerOptions: row.answer_options || '',
    wrongAnswer: row.wrong_answer, correctAnswer: row.correct_answer || '',
    errorType: row.error_type,
    correctSolution: row.correct_solution, difficulty: row.difficulty,
    knowledgeExplanation: row.knowledge_explanation || '',
    gradingEvidence: row.grading_evidence || '',
    notes: row.notes, source: row.source, aiRaw: row.ai_raw,
    status: row.status, sessionId: row.session_id, paperIndex: row.paper_index,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
