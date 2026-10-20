<template>
  <div class="max-w-3xl mx-auto py-8 md:py-12 px-4">
    <!-- 404 -->
    <div v-if="!article" class="text-center py-20">
      <p class="text-4xl mb-4">📄</p>
      <p class="text-gray-600 mb-2">文章不存在或已下线</p>
      <router-link to="/" class="text-blue-600 hover:text-blue-700 text-sm font-medium">← 返回首页</router-link>
    </div>

    <article v-else>
      <!-- 文章头 -->
      <header class="mb-8 pb-6 border-b border-gray-200">
        <p class="text-xs font-semibold tracking-widest text-blue-600 uppercase mb-3">高中学习 · 干货</p>
        <h1 class="text-2xl md:text-3xl font-bold text-gray-900 leading-snug mb-4">{{ article.title }}</h1>
        <p class="text-xs text-gray-400">{{ article.date }} · 约 {{ article.minutes }} 分钟阅读 · gaozhong.online</p>
      </header>

      <!-- 正文 -->
      <div class="article-body text-[15px] md:text-base text-gray-700 leading-8" v-html="article.html"></div>

      <!-- 尾部 CTA -->
      <div class="mt-12 bg-gradient-to-br from-slate-900 to-blue-950 rounded-2xl p-6 md:p-8 text-center">
        <p class="text-white font-medium mb-1.5">作文每周细批 × 试卷考后秒变错题本</p>
        <p class="text-blue-200/70 text-sm mb-6">不抄一道题，不白错一次——把每次考试都变成进步的台阶</p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <router-link to="/upload" class="inline-flex items-center justify-center bg-blue-600 hover:bg-blue-500 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-all">✏️ 免费批改第一篇作文</router-link>
          <router-link to="/paper/upload" class="inline-flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-all">📄 上传试卷整错题</router-link>
        </div>
      </div>

      <!-- 返回 -->
      <div class="mt-8 text-center">
        <router-link to="/" class="text-sm text-gray-400 hover:text-gray-600">← 返回首页</router-link>
      </div>
    </article>
  </div>
</template>

<script setup>
// 内容文章(SEO承载): 文章内容硬编码于此, 新增文章 = 加一个对象 + sitemap补一条URL
// 正文只放真实内容(站内真实批改案例), 不编造数据
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const articles = {
  'school-vs-ai': {
    title: '学校老师怎么批作文，AI 细批差在哪？——高中家长该知道的事',
    date: '2026-09',
    minutes: 5,
    description: '一个班四五十本作文，老师批一篇平均一两分钟；AI细批五维评分、逐句点评、升格示范。用一篇真实的高一作文批改，看清两者的差别。',
    html: `
      <p>很多家长都有这个疑问：孩子的作文每周都写、每次都交，为什么分数就是不见涨？</p>
      <p>答案往往不在"写得多不多"，而在<strong>反馈的质量</strong>。我们拿一篇真实的高一作文（《创造转化文化，兼收并蓄美德》，约850字），分别看看学校批改和 AI 细批给出的反馈差在哪。</p>

      <h2>一、学校批改的现实：等第 + 分数 + 一句总评</h2>
      <p>这不是老师不负责，而是物理限制：一个班四五十本作文，认真批完一轮要好几个小时。大多数情况下，孩子拿回的是——</p>
      <ul>
        <li>一个分数或等第（比如"42分，三类卷"）</li>
        <li>一两句总评（"审题有偏差，卷面需改进"）</li>
        <li>偶尔几个红圈，标出错别字</li>
      </ul>
      <p>孩子知道"不好"，但不知道<strong>具体哪一句不好、怎么改才算好</strong>。下一篇作文，大概率重复同样的问题。</p>

      <h2>二、AI 细批长什么样：同一篇作文的真实批改</h2>
      <p>这是本站（gaozhong.online）对上面那篇作文的真实批改输出，按上海高考 70 分制评分：</p>
      <p><strong>总分：50/70（三类卷上段）</strong>　审题立意 16/20 · 思辨深度 14/20 · 结构布局 13/20 · 语言表达 12/20 · 素材运用 12/20</p>
      <p>分数只是一个入口，真正有用的是逐句点评——全文共 <strong>10 处原文引用点评</strong>。比如：</p>
      <blockquote>
        <p>"文化或许能保留在文化馆、博物馆之中，却很难传进人的心中"——空间与心灵的对照，<strong>全篇最出彩的一句</strong>。</p>
        <p>"与文化最好的相处方式，是被创造出来的"——<strong>主谓搭配不当，全篇最严重的语病</strong>。</p>
      </blockquote>
      <p>每一处点评都引用原文，孩子翻开报告就知道：这句好在哪、那句错在哪。最后还有<strong>升格示范</strong>，直接给出修改后的句子：</p>
      <blockquote>
        <p><span style="color:#f87171">与文化最好的相处方式，是被创造出来的</span><br>
        → <span style="color:#059669">文化本来就是被创造出来的——它是一个时代的人们在共同生活中逐渐形成的</span></p>
      </blockquote>
      <p>加减分也写得明白：素材有时代感不落俗套（+1分），但只列举未分析、"以例代证"（-1分）。全文还有 <strong>6 条升格修改建议</strong>，每条附改法与理由。孩子下一次写作文，手里是有清单的，不是凭感觉。</p>

      <h2>三、怎么用才有用：每周一篇 + 细批反馈循环</h2>
      <p>作文是高中语文里<strong>最能靠练习提分</strong>的部分，前提是每篇都有高质量反馈。一个可执行的节奏：</p>
      <ol>
        <li><strong>每周固定一篇</strong>（跟着学校进度或考试节奏）</li>
        <li><strong>手机拍照上传，2分钟出细批报告</strong>——五维分数看清强弱项，逐句点评定位问题</li>
        <li><strong>对照升格示范改一遍</strong>，重点改掉点评指出的语病和结构问题</li>
        <li>考前翻看几篇的分数走势，弱项一目了然</li>
      </ol>
      <p>细批的价值不在"打分准"，而在<strong>把每一次写作变成一次有反馈的训练</strong>。学校老师给不了的密度，工具可以补上。</p>

      <h2>四、写在最后</h2>
      <p>考试季还有一件事同样费时间：试卷考完，错题要抄、要订正、要给老师检查。本站也支持已批改试卷拍照上传，AI 自动识别错题、生成错题本和可打印的订正纸——不抄一道题。</p>
      <p>新用户注册送 5 点（1点=1次作文批改或1份试卷整理），第一篇作文免费体验。</p>
    `
  },

  'paper-demo': {
    title: '一份真实试卷的错题整理实测：从拍照到订正纸',
    date: '2026-09',
    minutes: 6,
    description: '用一份真实高一英语试卷实测AI错题整理：拍照上传、AI识别28题17道疑似错题、确认核对、生成订正纸的全过程与真实效果。',
    html: `
      <p>孩子考完试，卷子上红笔批改一片。接下来是每个高中生家庭的"标准流程"：抄错题、写订正、错因分析——一份数学卷动辄两小时，英语卷的阅读理解抄起来更是灾难。</p>
      <p>这篇文章用一份<strong>真实的高一英语试卷</strong>，完整走一遍 AI 错题整理的流程。所有数字都是真实识别结果，不是演示数据。</p>

      <h2>一、试卷与上传</h2>
      <p>测试卷：高一英语训练卷，A3 双页 4 张，共 28 题，老师红笔批改。</p>
      <p>手机拍照上传（4 张按页序），之后就是等待——系统会先做图像矫正（歪斜、书缝、阴影都会处理），再逐页识别题目和红笔批改。几分钟后出结果。</p>

      <h2>二、识别结果：28 题，17 道疑似错题</h2>
      <p>AI 从 4 张照片里识别出 <strong>28 道题</strong>，并标记了 <strong>17 道疑似错题</strong>。关键是接下来的设计——它不是直接扔给你一份错题清单，而是<strong>分级让你确认</strong>：</p>
      <ul>
        <li><strong>绿灯题</strong>：证据充分（学生答案和红笔正确答案对得上不一致），自动确认</li>
        <li><strong>黄灯题</strong>：AI 判定"像是错题"但需要你扫一眼确认——每题附<strong>原题截图</strong>，左滑"没错"、右滑"是错题"，像刷卡片一样</li>
        <li>发现漏题？页脚有"手动添加题号"，10 秒补上</li>
      </ul>
      <p>为什么要有这一步？因为识别再准也有误差（红笔花掉、答案写在答题卡上）。<strong>确认权在你手里</strong>，AI 负责把抄题、找题、排版这些苦活干完。</p>

      <h2>三、确认之后：错题本 + 订正纸</h2>
      <p>确认完成，错题入库。每道错题带：原题截图（不用抄题）、你的答案、正确答案、错因标签（词汇辨析/时态语态/阅读理解…）。</p>
      <p>期末或考前，一键生成两种纸：</p>
      <ul>
        <li><strong>订正纸</strong>：题目印好，只写订正和错因（□审题 □知识 □粗心 □其他）——学校要检查的格式</li>
        <li><strong>重做卷</strong>：只印题目不印答案，考前自测，做完对错题本</li>
      </ul>

      <h2>四、几个家长最关心的问题</h2>
      <p><strong>识别准吗？</strong>英语卷的题目检测准确率在 95% 以上（这份 28/28），错题判定靠红笔批改+语义比对双重证据，拿不准的都进黄灯让你确认，不会悄悄漏掉或错收。</p>
      <p><strong>多久出结果？</strong>4 页试卷约几分钟，10 页以内都能一次传。</p>
      <p><strong>哪些科目？</strong>目前支持英语（识别管线针对英语卷深度优化），语文数学在开发中。</p>

      <h2>五、写在最后</h2>
      <p>错题整理的价值不在"整理"本身，而在<strong>让每份试卷的错题真正进入复习循环</strong>：考后当天入库，平时订正打卡，考前打重做卷。中间所有抄题、排版、归类的活，交给工具。</p>
      <p>想先看效果？本站首页有<strong>免注册的示例卷体验</strong>——就是这份试卷的真实识别结果，点开即看。觉得有用再注册上传自己孩子的试卷（新用户送 5 点）。</p>
    `
  },

  'september-parents': {
    title: '开学第一个月，高中家长最该做的三件事',
    date: '2026-09',
    minutes: 5,
    description: '高一家长开学指南：建立作文反馈循环、错题当日入库、固定学习节奏。三件小事决定一学期的走向，附可落地的工具做法。',
    html: `
      <p>九月初，新高一的家长比孩子还紧张：分班考、月考、选科，每一件事都像大事。但开学第一个月真正决定学期走向的，往往不是这些大节点，而是三件小事。</p>

      <h2>第一件：给作文装上"反馈循环"</h2>
      <p>高中语文和初中最大的差别：作文分差被急剧拉大，而反馈却变少了。一个班四五十本作文，老师批一篇平均一两分钟，孩子拿到的往往只有一个分数。</p>
      <p>没有具体反馈的练习，等于白练。可行的做法：</p>
      <ol>
        <li><strong>每周固定一篇</strong>，跟着学校进度走</li>
        <li>写完<strong>当天拿到细批</strong>：哪句好、哪句病、怎么改——现在用工具拍照就能做到（本站按上海 70 分制批改，五维评分+逐句点评+升格示范）</li>
        <li><strong>对照点评改一遍</strong>再归档，下次翻看</li>
      </ol>
      <p>一个月四篇带反馈的作文，胜过一学期裸写。</p>

      <h2>第二件：错题"当日入库"，别攒</h2>
      <p>错题的价值随时间指数衰减。考后一周再整理，错因已经想不起来；攒到期末，面对的是三摞卷子直接放弃。</p>
      <p>正确姿势是<strong>考后当天或第二天</strong>：试卷拍照上传，AI 识别错题入本（确认一遍只需几分钟），当天订正。之后平时打卡、考前打"重做卷"。</p>
      <p>家长要做的只有一件事：把"整理错题"从孩子的负担变成例行流程——工具解决抄题排版，孩子只负责订正和错因。</p>

      <h2>第三件：固定节奏，而不是加码</h2>
      <p>开学第一个月最忌讳的是"什么都想补"。更有效的是建立固定节奏：</p>
      <ul>
        <li><strong>周中</strong>：一篇作文（带反馈）</li>
        <li><strong>考后</strong>：错题当日入库+订正</li>
        <li><strong>考前</strong>：错题重做卷过一遍，看作文分数曲线</li>
      </ul>
      <p>这个循环跑顺了，10 月的第一次大考会给你答案。节奏感本身就是最好的学习习惯——高中三年拼的不是突击，是复利。</p>

      <h2>写在最后</h2>
      <p>这三件事，本站（gaozhong.online）恰好都能支撑：作文每周细批、试卷拍照变错题本、考前一键重做卷。新用户注册送 5 点，首页可免注册体验示例卷。</p>
      <p>祝孩子们开学顺利，第一次月考都超预期。</p>
    `
  }
}

const article = computed(() => articles[route.params.slug] || null)

onMounted(() => {
  if (article.value) {
    document.title = `${article.value.title}｜高中在线`
    let desc = document.querySelector('meta[name="description"]')
    if (!desc) {
      desc = document.createElement('meta')
      desc.setAttribute('name', 'description')
      document.head.appendChild(desc)
    }
    desc.setAttribute('content', article.value.description)
  }
})
</script>

<style scoped>
.article-body :deep(h2) {
  font-size: 1.15rem;
  font-weight: 700;
  color: #1d2129;
  margin: 2rem 0 0.75rem;
}
.article-body :deep(p) { margin: 0 0 1rem; }
.article-body :deep(ul), .article-body :deep(ol) {
  margin: 0 0 1rem;
  padding-left: 1.5rem;
}
.article-body :deep(ul) { list-style: disc; }
.article-body :deep(ol) { list-style: decimal; }
.article-body :deep(li) { margin-bottom: 0.4rem; }
.article-body :deep(blockquote) {
  border-left: 3px solid #93c5fd;
  background: #f0f7ff;
  padding: 0.75rem 1rem;
  border-radius: 0 0.5rem 0.5rem 0;
  margin: 0 0 1.25rem;
}
.article-body :deep(blockquote p) { margin-bottom: 0.5rem; }
.article-body :deep(blockquote p:last-child) { margin-bottom: 0; }
.article-body :deep(strong) { color: #1d2129; }
</style>
