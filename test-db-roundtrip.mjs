#!/usr/bin/env node
/** 阶段1 落库链路验证: passage_text/答案/aiRaw(pageIndex) 写入→读回 */
import { initDB, saveErrorProblem, getErrorProblem, listErrorProblems, deleteErrorProblem } from './db.js';

const TEST_ID = 'test1a1c';

const aiRaw = JSON.stringify({
  pipeline: 'v4.9-test', questionNumber: 63, pageIndex: 4,
  bbox: { x: 100, y: 200, w: 700, h: 150 },
  studentAnswer: 'B', correctAnswer: 'A'
});

await initDB();

saveErrorProblem({
  id: TEST_ID, userId: 'test-user', subject: '英语',
  topic: '错题 Q63',
  questionText: 'Which of the following statements about Stoptober is false? ' + 'x'.repeat(400),
  questionType: 'reading',
  answerOptions: JSON.stringify({ A: 'opt-a', B: 'opt-b' }),
  wrongAnswer: 'B', correctAnswer: 'A',
  passageText: 'Stoptober is an annual campaign... (fake passage for test)',
  errorType: '待分析', correctSolution: '', difficulty: 3,
  knowledgeExplanation: '{}', gradingEvidence: 'test',
  aiRaw, notes: '',
  sessionId: 'test-session', paperIndex: 4, status: 'done',
  reviewStatus: 'pending', createdAt: Date.now()
});

const rec = getErrorProblem(TEST_ID, 'test-user');
const list = listErrorProblems({ userId: 'test-user', sessionId: 'test-session' });

const checks = [
  ['passageText 读回', rec.passageText === 'Stoptober is an annual campaign... (fake passage for test)'],
  ['wrongAnswer 读回', rec.wrongAnswer === 'B'],
  ['correctAnswer 读回', rec.correctAnswer === 'A'],
  ['长题干不截断(>300)', (rec.questionText || '').length === 460],
  ['aiRaw 含 pageIndex', JSON.parse(rec.aiRaw).pageIndex === 4],
  ['list 视图含 passageText', (list.records || []).some(r => r.id === TEST_ID && r.passageText)],
  ['questionNumber 解析', rec.questionNumber === 63],
];

let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? '✅' : '❌') + ' ' + name); if (!ok) fail++; }

deleteErrorProblem(TEST_ID);
const after = getErrorProblem(TEST_ID, 'test-user');
console.log(after ? '❌ 清理失败' : '✅ 测试记录已清理');
process.exit(fail);
