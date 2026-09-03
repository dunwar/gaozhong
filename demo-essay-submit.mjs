// 提交一篇高一议论文跑真实批改，结果存 demo-grading-result.json
const B = 'http://localhost:3001';

const essay = `技术的发展改变着生活的方方面面。有人说，技术让生活更便利；也有人说，技术让人变得懒惰。在我看来，技术本身并无好坏，关键在于人如何使用技术。

诚然，技术带来的便利是显而易见的。从洗衣机到扫地机器人，从计算器到人工智能，技术把人们从繁琐重复的劳动中解放出来，让我们有更多时间去思考、去创造。正如一位科学家所说："工具的价值，在于延伸人的能力，而不是取代人的思考。"当技术承担了机械性的劳动，人才能把精力投入到更有价值的领域。

然而，便利的另一面确实是懒惰的诱惑。当导航软件替我们记住路线，我们不再用心辨认方向；当搜索引擎随时可以查询，我们不再费力记忆知识；当AI可以代写文章，一些人甚至懒得组织自己的语言。久而久之，人的某些能力在便利中悄然退化。古罗马人发明了先进的供水系统，贵族们却因此不再珍惜水源，奢靡之风盛行。技术的进步如果没有相应的自觉来平衡，便利就会变成懒惰的温床。

那么，问题的关键究竟在哪里？我认为，技术是镜子，照出的是使用者自己的态度。同样拥有计算器，有人用它验证自己心算的结果，有人连简单的加法都懒于思考；同样拥有互联网，有人用它查阅文献、开阔视野，有人用它无止境地刷短视频。技术给了所有人同样的便利，而不同的使用方式，造就了不同的结果。

因此，我们要做技术的主人，而不是技术的奴隶。做主人，意味着主动地驾驭技术：用导航之前先看一眼地图，用搜索之前先独立思考，用AI辅助写作而不是代替思考。只有这样，技术带来的每一分便利，才会转化为我们成长的助力，而不是能力退化的推手。

技术的发展不会停步，摆在我们每个人面前的选择题却始终不变：让便利成就更好的自己，还是让懒惰侵蚀原本的能力？答案，就在我们每一次使用技术的选择之中。`;

const topic = '技术的发展改变着生活的方方面面。有人说，技术让生活更便利；也有人说，技术让人变得懒惰。请写一篇文章，谈谈你的思考。';

const r = await fetch(`${B}/analyze`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: essay, topic })
});
const d = await r.json();
console.log('提交:', r.status, d.taskId || d.error);
if (!d.taskId) process.exit(1);

for (let i = 0; i < 100; i++) {
  await new Promise(s => setTimeout(s, 5000));
  const t = await (await fetch(`${B}/task/${d.taskId}`)).json();
  if (i % 6 === 0) console.log(`  [${i * 5}s] ${t.status} ${t.progress?.message || ''}`);
  if (t.status === 'done') {
    const fs = await import('fs');
    fs.writeFileSync('demo-grading-result.json', JSON.stringify(t.result, null, 2), 'utf-8');
    console.log('✅ 完成! 总分:', t.result?.totalScore, '| 等级:', t.result?.grade);
    console.log('已存 demo-grading-result.json');
    process.exit(0);
  }
  if (t.status === 'failed') {
    console.log('❌ 失败:', t.error);
    process.exit(1);
  }
}
console.log('超时未完成');
