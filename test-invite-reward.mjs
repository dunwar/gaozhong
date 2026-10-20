// 邀请奖励逻辑单测 (临时DB, 不碰生产数据)
// 用法: node test-invite-reward.mjs
import fs from 'node:fs';
process.env.DB_DIR = '/tmp/gz-invite-test/data';
fs.rmSync('/tmp/gz-invite-test', { recursive: true, force: true });

const db = await import('./db.js');
await db.initDB();

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name); }
}

// 1. 注册推荐人: 欢迎点数 = 5
const referrer = db.createUser({ email: 'ref@test.com', passwordHash: 'x' });
assert(referrer.points === 5, `新用户欢迎点数=5 (实际 ${referrer.points})`);
assert(!!referrer.refCode, '推荐人有邀请码');

// 2. 新用户A注册 + 邀请记录 pending
const userA = db.createUser({ email: 'a@test.com', passwordHash: 'x' });
assert(userA.points === 5, `被邀请人欢迎点数=5 (实际 ${userA.points})`);
let r = db.createInviteReward({ referrerId: referrer.id, newUserId: userA.id, newUserEmail: userA.email, signupIp: '1.2.3.4' });
assert(r.ok === true, '正常邀请记录 pending 成功');

// 3. 发放前: 推荐人仍是5点
assert(db.getPoints(referrer.id) === 5, '发放前推荐人点数不变(延迟发放)');

// 4. 被邀请人完成首次批改 → 推荐人+5
const granted = db.grantPendingInviteReward(userA.id);
assert(granted === true, '首次批改触发发放');
assert(db.getPoints(referrer.id) === 10, `发放后推荐人=10 (实际 ${db.getPoints(referrer.id)})`);

// 5. 重复发放: 已granted, 再调不重复加分
db.grantPendingInviteReward(userA.id);
assert(db.getPoints(referrer.id) === 10, '重复调用不重复发放');

// 6. 同IP 24h内第二个邀请 → 拦截
const userB = db.createUser({ email: 'b@test.com', passwordHash: 'x' });
r = db.createInviteReward({ referrerId: referrer.id, newUserId: userB.id, newUserEmail: userB.email, signupIp: '1.2.3.4' });
assert(r.ok === false && r.reason === 'ip_limited', `同IP 24h内拦截 (实际 ${JSON.stringify(r)})`);
db.grantPendingInviteReward(userB.id);
assert(db.getPoints(referrer.id) === 10, '被拦截的邀请不发放');

// 7. 不同IP可正常邀请
const userC = db.createUser({ email: 'c@test.com', passwordHash: 'x' });
r = db.createInviteReward({ referrerId: referrer.id, newUserId: userC.id, newUserEmail: userC.email, signupIp: '5.6.7.8' });
assert(r.ok === true, '不同IP正常记录');
db.grantPendingInviteReward(userC.id);
assert(db.getPoints(referrer.id) === 15, `第二笔发放后推荐人=15 (实际 ${db.getPoints(referrer.id)})`);

// 8. 自邀拦截
const userD = db.createUser({ email: 'd@test.com', passwordHash: 'x' });
r = db.createInviteReward({ referrerId: userD.id, newUserId: userD.id, signupIp: '9.9.9.9' });
assert(r.ok === false && r.reason === 'self', `自邀拦截 (实际 ${JSON.stringify(r)})`);

// 9. 同一用户重复记录 → 拦截
const userE = db.createUser({ email: 'e@test.com', passwordHash: 'x' });
db.createInviteReward({ referrerId: referrer.id, newUserId: userE.id, signupIp: '7.7.7.7' });
r = db.createInviteReward({ referrerId: referrer.id, newUserId: userE.id, signupIp: '8.8.8.8' });
assert(r.ok === false && r.reason === 'duplicate_user', `同用户重复记录拦截 (实际 ${JSON.stringify(r)})`);

// 10. 汇总: 3笔记录(1 ip拦截不入表 + granted 2 + pending 1) — 入表的: A granted, C granted, E pending
const s = db.getInviteSummary(referrer.id);
assert(s.grantedCount === 2, `汇总 granted=2 (实际 ${s.grantedCount})`);
assert(s.pendingCount === 1, `汇总 pending=1 (实际 ${s.pendingCount})`);
assert(s.invitedCount === 3, `汇总 invited=3 (实际 ${s.invitedCount})`);
assert(s.rewardPoints === 10, `汇总 已到账点数=10 (实际 ${s.rewardPoints})`);

// 11. 无pending时发放是no-op
assert(db.grantPendingInviteReward('nonexistent') === false, '无记录发放no-op');

// 12. 点数流水含邀请奖励记录
const logs = db.listPointLogs(referrer.id, 50);
const inviteLogs = logs.filter(l => l.reason.includes('邀请奖励'));
assert(inviteLogs.length === 2 && inviteLogs.every(l => l.delta === 5), `流水2笔各+5 (实际 ${inviteLogs.length}笔)`);

console.log(`\n${fail === 0 ? '✅' : '❌'} 邀请奖励逻辑: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
