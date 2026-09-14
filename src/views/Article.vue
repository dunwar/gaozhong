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
      <p>新用户注册送 3 点（1点=1次作文批改或1份试卷整理），第一篇作文免费体验。</p>
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
