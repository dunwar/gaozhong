<template>
  <div class="essay-result-page">
    <!-- 页面标题 -->
    <header class="page-header">
      <h1 class="page-title">作文批改结果</h1>
      <p v-if="result?.title" class="essay-title">{{ result.title }}</p>
    </header>

    <!-- 返回按钮 -->
    <div class="back-button-container">
      <router-link to="/upload" class="back-button">
        ← 返回重新批改
      </router-link>
    </div>

    <!-- 总分和档位卡片 -->
    <div class="score-cards">
      <div class="total-score-card">
        <span class="score-label">最终得分</span>
        <div class="score-value">
          {{ result?.totalScore || 0 }}<span class="score-max">/70</span>
        </div>
      </div>
      
      <div class="grade-card">
        <span class="grade-label">档位评定</span>
        <div class="grade-value">{{ result?.grade || '未评定' }}</div>
        <div class="grade-info">
          <span v-if="result?.essayType">{{ result.essayType }}</span>
          <span v-if="result?.wordCount">· {{ result.wordCount }}字</span>
        </div>
      </div>
    </div>

    <!-- 一句话总结 -->
    <div v-if="oneSentenceSummary" class="quote-card">
      <blockquote>{{ oneSentenceSummary }}</blockquote>
    </div>

    <!-- 五维得分 -->
    <div v-if="hasDimensions" class="section-card dimensions-section">
      <h2 class="section-title">📊 分维度得分</h2>
      <div class="dimension-bars">
        <div 
          v-for="(dim, key) in dimensions" 
          :key="key"
          class="dimension-bar"
        >
          <div class="dimension-header">
            <span class="dimension-name">{{ key }}</span>
            <span class="dimension-score" :class="getScoreClass(dim.score, dim.full)">
              {{ dim.score }}/{{ dim.full }}
            </span>
          </div>
          <div class="progress-track">
            <div 
              class="progress-fill"
              :style="{ 
                width: `${getPercent(dim.score, dim.full)}%`,
                backgroundColor: getDimensionColor(key)
              }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 加减分项 -->
    <div v-if="hasAdjustments" class="section-card adjustments-section">
      <h2 class="section-title">⚖️ 加减分项说明</h2>
      <div class="adjustments-list">
        <div 
          v-for="(item, idx) in plusItems" 
          :key="'plus-' + idx"
          class="adjustment-item adjustment-plus"
        >
          <span class="adjustment-icon">✓</span>
          <span class="adjustment-reason">{{ item.reason }}</span>
          <span class="adjustment-points">+{{ item.points }}分</span>
        </div>
        <div 
          v-for="(item, idx) in minusItems" 
          :key="'minus-' + idx"
          class="adjustment-item adjustment-minus"
        >
          <span class="adjustment-icon">✗</span>
          <span class="adjustment-reason">{{ item.reason }}</span>
          <span class="adjustment-points">{{ item.points }}分</span>
        </div>
      </div>
      <div v-if="rawScore || adjustedScore" class="calculation-note">
        维度得分：{{ rawScore }}分 → 调整后：{{ adjustedScore }}分 → 换算70分制：{{ result?.totalScore }}分
      </div>
    </div>

    <!-- 分维度详细点评 -->
    <div v-if="hasDimensions" class="section-card collapsible-section">
      <h2 class="section-title">📝 分维度详细点评</h2>
      <div 
        v-for="(dim, key) in dimensions" 
        :key="key"
        class="collapsible-item"
      >
        <button 
          class="collapsible-trigger"
          @click="togglePanel(key)"
          :class="{ 'is-open': openPanels[key] }"
        >
          <span class="collapsible-name">{{ key }}</span>
          <span class="collapsible-score" :class="getScoreClass(dim.score, dim.full)">
            {{ dim.score }}/{{ dim.full }}
          </span>
          <span class="collapsible-arrow" :class="{ 'is-open': openPanels[key] }">▼</span>
        </button>
        <div 
          class="collapsible-content"
          :class="{ 'is-open': openPanels[key] }"
        >
          <div class="collapsible-inner">
            <p v-if="dim.evaluation" class="evaluation-text">{{ dim.evaluation }}</p>
            
            <!-- 扣分原因 -->
            <div v-if="dim.deductionReason" class="evaluation-block evaluation-deduction">
              <h4>📌 扣分原因</h4>
              <p>{{ dim.deductionReason }}</p>
            </div>
            
            <!-- 亮点 -->
            <div v-if="dim.strengths && dim.strengths.length > 0" class="evaluation-block evaluation-strengths">
              <h4>✨ 亮点</h4>
              <ul>
                <li v-for="(s, i) in dim.strengths" :key="i">{{ s }}</li>
              </ul>
            </div>
            
            <!-- 不足 -->
            <div v-if="dim.weaknesses && dim.weaknesses.length > 0" class="evaluation-block evaluation-weaknesses">
              <h4>🔍 不足</h4>
              <ul>
                <li v-for="(w, i) in dim.weaknesses" :key="i">{{ w }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 阅卷总结 -->
    <div v-if="hasSummary" class="section-card summary-section">
      <h2 class="section-title">📋 阅卷总结</h2>
      
      <div v-if="gradingReason" class="summary-block">
        <h3>定档理由</h3>
        <p>{{ gradingReason }}</p>
      </div>

      <div v-if="upgradePath" class="summary-block">
        <h3>升格路径</h3>
        <p v-if="upgradePath.toClass2"><strong>进入二类卷：</strong>{{ upgradePath.toClass2 }}</p>
        <p v-if="upgradePath.toClass1"><strong>进入一类卷：</strong>{{ upgradePath.toClass1 }}</p>
      </div>

      <div v-if="suggestions?.length" class="summary-block">
        <h3>具体建议</h3>
        <ul>
          <li v-for="(s, i) in suggestions" :key="i">{{ s }}</li>
        </ul>
      </div>
    </div>

    <!-- 具体修改建议 -->
    <div v-if="revisions?.length" class="section-card revisions-section">
      <h2 class="section-title">✏️ 具体修改建议</h2>
      <div 
        v-for="(rev, index) in revisions" 
        :key="index"
        class="revision-card"
      >
        <div class="revision-header">
          <span class="revision-badge">修改{{ index + 1 }}</span>
          <span class="revision-category">{{ rev.category }}</span>
          <span v-if="rev.location" class="revision-location">{{ rev.location }}</span>
        </div>
        
        <div class="revision-content">
          <div class="revision-original">
            <span class="revision-label">原文</span>
            <p class="revision-text original-text">{{ rev.original }}</p>
          </div>
          
          <div class="revision-arrow">↓</div>
          
          <div class="revision-suggested">
            <span class="revision-label suggested-label">修改建议</span>
            <p class="revision-text suggested-text">{{ rev.suggested }}</p>
          </div>
          
          <p v-if="rev.reason" class="revision-reason">{{ rev.reason }}</p>
        </div>
      </div>
    </div>

    <!-- 查看完整评语 -->
    <div v-if="rawMarkdown" class="section-card full-commentary-section">
      <button @click="showFullCommentary = !showFullCommentary" class="toggle-commentary-btn">
        {{ showFullCommentary ? '▲ 收起完整评语' : '▼ 查看完整评语' }}
      </button>
      
      <div v-if="showFullCommentary" class="full-commentary-content">
        <div v-html="renderMarkdown(rawMarkdown)" class="markdown-body"></div>
      </div>
    </div>

    <!-- 解析错误提示 -->
    <div v-if="parseError" class="parse-error-card">
      <strong>⚠️ 提示：</strong>{{ parseError }}
    </div>

    <!-- 作文原文 -->
    <div v-if="essayText" class="section-card essay-section">
      <h2 class="section-title">📄 作文原文</h2>
      <div v-if="highlights?.length" class="essay-legend">
        <span class="legend-item">
          <span class="legend-color legend-error"></span> 需修改
        </span>
        <span class="legend-item">
          <span class="legend-color legend-good"></span> 亮点
        </span>
      </div>
      <div class="essay-content">
        <p v-for="(paragraph, idx) in paragraphs" :key="idx" class="essay-paragraph">
          <template v-for="(segment, sIdx) in paragraph.segments" :key="sIdx">
            <span 
              v-if="segment.type === 'error'"
              class="highlight highlight-error"
              :title="segment.note"
            >{{ segment.text }}</span>
            <span 
              v-else-if="segment.type === 'good'"
              class="highlight highlight-good"
              :title="segment.note"
            >{{ segment.text }}</span>
            <span v-else>{{ segment.text }}</span>
          </template>
        </p>
      </div>
    </div>

    <!-- 底部按钮 -->
    <div class="action-footer">
      <router-link to="/upload" class="action-button">
        批改下一篇作文
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

// 模拟数据（开发用）
const mockData = {
  title: "创造转化文化，兼收并蓄美德",
  totalScore: 46,
  grade: "三类卷中上段",
  essayType: "议论文",
  wordCount: 650,
  dimensions: {
    审题立意: { score: 12, full: 20, evaluation: "扣住了'创造转化文化'，但几乎忽略了'兼收并蓄美德'", deductionReason: "审题偏差，漏掉题目后半句，扣8分" },
    思辨深度: { score: 16, full: 30, evaluation: "有《黑神话：悟空》等新颖素材，但思辨展开不够深入", deductionReason: "有亮点但思辨展开不够深入，扣14分" },
    结构布局: { score: 10, full: 20, evaluation: "卷面布局混乱，跨栏书写严重影响阅读", deductionReason: "卷面结构混乱，跨栏书写严重影响阅读体验，扣10分" },
    语言表达: { score: 10, full: 15, evaluation: "病句与错别字频出，多处语病", deductionReason: "多处语病和错别字，影响阅读，扣5分" },
    素材运用: { score: 12, full: 15, evaluation: "《黑神话：悟空》选材新颖，具有时代感", deductionReason: "素材单一，仅有《悟空》一个核心素材，扣3分" }
  },
  adjustments: {
    plus: [
      { reason: "素材新颖，《黑神话：悟空》具有时代感", points: 2 },
      { reason: "敢于质疑传统'死板保护'的观点", points: 1 }
    ],
    minus: [
      { reason: "审题偏差，漏掉'兼收并蓄美德'", points: -5 },
      { reason: "卷面结构混乱，跨栏书写", points: -4 },
      { reason: "多处语病和错别字", points: -2 }
    ]
  },
  rawScore: 60,
  adjustedScore: 52,
  gradingReason: "文章基本符合题意，立意尚可，材料选用新颖。但语言偶有语病，且卷面行文结构极度混乱，严重影响阅卷体验。综合来看，无法进入二类卷，属于典型的三类卷。",
  suggestions: [
    "审题必须完整：遇到并列式题目，必须找到A与B之间的内在逻辑",
    "先构思再动笔：动笔前列好提纲，避免卷面混乱",
    "锤炼语言基本功：减少生造词和错别字"
  ],
  upgradePath: {
    toClass2: "审题完整 + 卷面整洁 + 减少语病",
    toClass1: "在二类卷基础上，思辨更加深入，语言更有文采"
  },
  revisions: [
    {
      category: "审题偏差",
      location: "第三段",
      original: "文化，其本身也不是一个一成不变的物品，一味的传承原汁原味，也早会产生对先人文化的错误理解",
      suggested: "文化，其本身也不是一个一成不变的物品。一味的传承原汁原味，不仅会产生对先人文化的错误理解，更会让文化失去与时代对话的能力。因此，我们既需要创造性转化，更需要兼收并蓄——以开放的心态吸纳外来文化的精华。",
      reason: "补充了'兼收并蓄'的论述，回应题目要求"
    }
  ],
  oneSentenceSummary: "这是一篇具备一定现实思考和时代素材亮点的作文，但审题偏差、卷面混乱和语言瑕疵等硬伤使其只能停留在三类卷水平。",
  essayText: `文化，是一个民族的根与魂。在全球化浪潮席卷而来的今天，如何让传统文化焕发新生，是我们这一代青年必须思考的问题。

文化，其本身也不是一个一成不变的物品，一味的传承原汁原味，也早会产生对先人文化的错误理解。`,
  highlights: [],
  rawMarkdown: null
}

// 状态
const result = ref(null)
const openPanels = ref({})
const showFullCommentary = ref(false)

// 计算属性
const dimensions = computed(() => result.value?.dimensions || {})
const hasDimensions = computed(() => Object.keys(dimensions.value).length > 0)

const adjustments = computed(() => result.value?.adjustments || { plus: [], minus: [] })
const plusItems = computed(() => adjustments.value.plus || [])
const minusItems = computed(() => adjustments.value.minus || [])
const hasAdjustments = computed(() => plusItems.value.length > 0 || minusItems.value.length > 0)

const rawScore = computed(() => result.value?.rawScore || 0)
const adjustedScore = computed(() => result.value?.adjustedScore || 0)
const gradingReason = computed(() => result.value?.gradingReason)
const suggestions = computed(() => result.value?.suggestions)
const upgradePath = computed(() => result.value?.upgradePath)
const revisions = computed(() => result.value?.revisions)
const oneSentenceSummary = computed(() => result.value?.oneSentenceSummary)
const essayText = computed(() => result.value?.essayText)
const highlights = computed(() => result.value?.highlights)
const rawMarkdown = computed(() => result.value?.rawMarkdown || result.value?.fullCommentary || '')
const parseError = computed(() => result.value?.parseError)
const hasSummary = computed(() => gradingReason.value || upgradePath.value || suggestions.value?.length)

// 解析作文段落和高亮
const paragraphs = computed(() => {
  if (!essayText.value) return []
  
  const text = essayText.value
  const hl = highlights.value || []
  
  if (hl.length === 0) {
    return text.split('\n').filter(p => p.trim()).map(t => ({
      segments: [{ type: 'normal', text: t }]
    }))
  }

  const sorted = [...hl].sort((a, b) => a.start - b.start)
  const lines = text.split('\n').filter(p => p.trim())
  
  return lines.map(lineText => {
    const startIdx = text.indexOf(lineText)
    const segments = []
    let lastEnd = 0
    
    const relevant = sorted.filter(h => h.start >= startIdx && h.end <= startIdx + lineText.length)
    
    relevant.forEach(h => {
      const relStart = h.start - startIdx
      const relEnd = h.end - startIdx
      
      if (relStart > lastEnd) {
        segments.push({ type: 'normal', text: lineText.slice(lastEnd, relStart) })
      }
      
      segments.push({ type: h.type, text: lineText.slice(relStart, relEnd), note: h.note })
      lastEnd = relEnd
    })
    
    if (lastEnd < lineText.length) {
      segments.push({ type: 'normal', text: lineText.slice(lastEnd) })
    }
    
    return { segments }
  })
})

// 方法
const togglePanel = (key) => {
  openPanels.value[key] = !openPanels.value[key]
}

const getPercent = (score, full) => {
  if (!full) return 0
  return Math.round((score / full) * 100)
}

const getDimensionColor = (name) => {
  const colors = {
    审题立意: '#8B4513',
    思辨深度: '#B22222', 
    结构布局: '#CD853F',
    语言表达: '#2E8B57',
    素材运用: '#4682B4'
  }
  return colors[name] || '#666'
}

const getScoreClass = (score, full) => {
  if (!full) return 'score-medium'
  const ratio = score / full
  if (ratio >= 0.7) return 'score-good'
  if (ratio >= 0.5) return 'score-medium'
  return 'score-poor'
}

// 简单的 Markdown 渲染
const renderMarkdown = (text) => {
  if (!text) return ''
  return text
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^[•·\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>')
}

onMounted(() => {
  result.value = history.state?.result || mockData
  // 默认打开第一个维度
  const firstKey = Object.keys(result.value?.dimensions || {})[0]
  if (firstKey) {
    openPanels.value[firstKey] = true
  }
})
</script>

<style scoped>
/* ===== 页面基础 ===== */
.essay-result-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #fef9f0 0%, #fdf3e3 50%, #fef6ec 100%);
  padding: 2rem 1rem;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif;
  max-width: 64rem;
  margin: 0 auto;
}

/* ===== 页面标题 ===== */
.page-header {
  text-align: center;
  margin-bottom: 2rem;
}

.page-title {
  font-size: 2rem;
  font-weight: 700;
  color: #5c3a1e;
  margin: 0 0 0.5rem;
}

.essay-title {
  font-size: 1.125rem;
  color: #8b6f47;
  margin: 0;
}

/* ===== 返回按钮 ===== */
.back-button-container {
  margin-bottom: 1.5rem;
}

.back-button {
  display: inline-block;
  color: #8b5a2b;
  font-size: 0.875rem;
  text-decoration: none;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  transition: background-color 0.2s;
}

.back-button:hover {
  background: rgba(139, 90, 43, 0.1);
}

/* ===== 总分和档位卡片 ===== */
.score-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.total-score-card {
  background: linear-gradient(135deg, #b91c1c, #991b1b);
  border-radius: 1rem;
  padding: 1.5rem;
  color: white;
  text-align: center;
}

.score-label, .grade-label {
  display: block;
  font-size: 0.875rem;
  opacity: 0.9;
  margin-bottom: 0.25rem;
}

.score-value {
  font-size: 3rem;
  font-weight: 700;
  line-height: 1;
}

.score-max {
  font-size: 1.5rem;
  opacity: 0.7;
}

.grade-card {
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(8px);
  border-radius: 1rem;
  padding: 1.5rem;
  text-align: center;
  border: 1px solid #e8d5b7;
}

.grade-value {
  font-size: 1.875rem;
  font-weight: 700;
  color: #5c3a1e;
  margin: 0.25rem 0;
}

.grade-info {
  font-size: 0.875rem;
  color: #8b6f47;
}

/* ===== 一句话总结 ===== */
.quote-card {
  margin-bottom: 1.5rem;
  background: rgba(254, 243, 199, 0.8);
  border-radius: 1rem;
  padding: 1.25rem 1.5rem;
  border-left: 4px solid #f59e0b;
}

.quote-card blockquote {
  font-size: 0.9375rem;
  color: #5c3a1e;
  font-style: italic;
  line-height: 1.6;
  margin: 0;
}

/* ===== 通用区块卡片 ===== */
.section-card {
  margin-bottom: 1.5rem;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(8px);
  border-radius: 1rem;
  padding: 1.5rem;
  border: 1px solid #e8d5b7;
}

.section-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: #5c3a1e;
  margin: 0 0 1rem;
}

/* ===== 维度进度条 ===== */
.dimension-bars {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.dimension-bar {
  margin-bottom: 0.5rem;
}

.dimension-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
}

.dimension-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: #5c3a1e;
}

.dimension-score {
  font-size: 0.875rem;
  font-weight: 700;
}

.dimension-score.score-good { color: #15803d; }
.dimension-score.score-medium { color: #b45309; }
.dimension-score.score-poor { color: #dc2626; }

.progress-track {
  height: 0.5rem;
  background: #fde8d0;
  border-radius: 9999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 9999px;
  transition: width 1s ease-out;
  opacity: 0.85;
}

/* ===== 加减分项 ===== */
.adjustments-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.adjustment-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0;
  font-size: 0.875rem;
}

.adjustment-item.adjustment-plus { color: #15803d; }
.adjustment-item.adjustment-minus { color: #dc2626; }

.adjustment-icon {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  font-weight: 700;
}

.adjustment-reason { flex: 1; }
.adjustment-points { font-weight: 700; margin-left: auto; }

.calculation-note {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e8d5b7;
  font-size: 0.8125rem;
  color: #8b6f47;
}

/* ===== 可折叠面板 ===== */
.collapsible-section {
  padding: 1.5rem;
}

.collapsible-item {
  border-bottom: 1px solid #e8d5b7;
}

.collapsible-item:last-child { border-bottom: none; }

.collapsible-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 0;
  background: none;
  border: none;
  cursor: pointer;
  gap: 0.75rem;
}

.collapsible-trigger:hover { opacity: 0.8; }

.collapsible-name {
  font-weight: 500;
  color: #5c3a1e;
  font-size: 0.9375rem;
}

.collapsible-score {
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  white-space: nowrap;
}

.collapsible-score.score-good { background: #dcfce7; color: #15803d; }
.collapsible-score.score-medium { background: #fef3c7; color: #b45309; }
.collapsible-score.score-poor { background: #fee2e2; color: #dc2626; }

.collapsible-arrow {
  font-size: 0.625rem;
  color: #b8976a;
  transition: transform 0.2s;
}

.collapsible-arrow.is-open { transform: rotate(180deg); }

.collapsible-content {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.collapsible-content.is-open {
  max-height: 800px;
}

.collapsible-inner {
  padding: 0 0 1rem;
  color: #6b5b4a;
  line-height: 1.6;
  font-size: 0.875rem;
}

.evaluation-text { margin: 0 0 0.75rem; }

.evaluation-block { margin-top: 0.75rem; }

.evaluation-block h4 {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #5c3a1e;
  margin: 0 0 0.375rem;
}

.evaluation-block p {
  font-size: 0.8125rem;
  color: #b91c1c;
  line-height: 1.5;
  margin: 0;
}

.evaluation-block ul {
  margin: 0;
  padding-left: 1.25rem;
}

.evaluation-block li {
  margin-bottom: 0.25rem;
}

/* ===== 阅卷总结 ===== */
.summary-block {
  margin-bottom: 1rem;
}

.summary-block:last-child { margin-bottom: 0; }

.summary-block h3 {
  font-size: 0.875rem;
  font-weight: 600;
  color: #5c3a1e;
  margin: 0 0 0.375rem;
}

.summary-block p {
  font-size: 0.875rem;
  color: #6b5b4a;
  line-height: 1.6;
  margin: 0;
}

.summary-block ul {
  margin: 0;
  padding-left: 1.25rem;
}

.summary-block li {
  font-size: 0.875rem;
  color: #6b5b4a;
  margin-bottom: 0.25rem;
}

/* ===== 修改建议 ===== */
.revision-card {
  background: rgba(255, 255, 255, 0.6);
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 0.75rem;
  border-left: 4px solid #f87171;
}

.revision-card:last-child { margin-bottom: 0; }

.revision-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.revision-badge {
  background: #fee2e2;
  color: #b91c1c;
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
}

.revision-category {
  font-size: 0.8125rem;
  color: #8b6f47;
}

.revision-location {
  font-size: 0.75rem;
  color: #b8976a;
}

.revision-content {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.revision-original {
  background: #fef2f2;
  border-radius: 0.375rem;
  padding: 0.625rem;
}

.revision-suggested {
  background: #f0fdf4;
  border-radius: 0.375rem;
  padding: 0.625rem;
}

.revision-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: #b91c1c;
  text-transform: uppercase;
}

.suggested-label { color: #15803d; }

.revision-text {
  font-size: 0.8125rem;
  margin: 0.25rem 0 0;
  line-height: 1.5;
}

.original-text {
  color: #991b1b;
  text-decoration: line-through;
  opacity: 0.8;
}

.suggested-text { color: #15803d; }

.revision-arrow {
  text-align: center;
  color: #b8976a;
  font-size: 1rem;
}

.revision-reason {
  font-size: 0.75rem;
  color: #8b6f47;
  font-style: italic;
  margin: 0;
}

/* ===== 完整评语 ===== */
.full-commentary-section {
  padding: 1.25rem;
}

.toggle-commentary-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: none;
  border: 1px dashed #d4b896;
  color: #8b5a2b;
  font-weight: 500;
  padding: 0.75rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.toggle-commentary-btn:hover {
  background: #fef3e2;
  border-color: #8b5a2b;
}

.full-commentary-content {
  margin-top: 1rem;
  background: white;
  border-radius: 0.5rem;
  padding: 1.25rem;
  max-height: 500px;
  overflow-y: auto;
  border: 1px solid #e8d5b7;
}

.markdown-body {
  color: #5c3a1e;
  line-height: 1.7;
  font-size: 0.875rem;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3 {
  color: #5c3a1e;
  margin: 1rem 0 0.5rem;
  font-weight: 600;
}

.markdown-body h1 { font-size: 1.125rem; }
.markdown-body h2 { font-size: 1rem; }
.markdown-body h3 { font-size: 0.9375rem; }

.markdown-body strong { color: #8b5a2b; }

.markdown-body li {
  margin-left: 1rem;
  margin-bottom: 0.25rem;
}

/* ===== 解析错误提示 ===== */
.parse-error-card {
  margin-bottom: 1.5rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-size: 0.8125rem;
  color: #b91c1c;
}

/* ===== 作文原文 ===== */
.essay-section {
  background: rgba(255, 255, 255, 0.8);
}

.essay-legend {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  font-size: 0.75rem;
  color: #8b6f47;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.legend-color {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 0.125rem;
}

.legend-color.legend-error {
  background: #fee2e2;
  border-bottom: 2px solid #fca5a5;
}

.legend-color.legend-good {
  background: #dcfce7;
  border-bottom: 2px solid #86efac;
}

.essay-content {
  line-height: 1.8;
  color: #5c3a1e;
}

.essay-paragraph {
  margin: 0 0 0.75rem;
  text-indent: 2em;
  font-size: 0.875rem;
}

.highlight {
  padding: 0.0625rem 0.25rem;
  border-radius: 0.125rem;
  border-bottom: 2px solid;
  cursor: help;
}

.highlight-error {
  background: #fee2e2;
  color: #b91c1c;
  border-color: #fca5a5;
}

.highlight-good {
  background: #dcfce7;
  color: #15803d;
  border-color: #86efac;
}

/* ===== 底部按钮 ===== */
.action-footer {
  text-align: center;
  margin-top: 2rem;
}

.action-button {
  display: inline-block;
  background: #8b5a2b;
  color: white;
  font-weight: 500;
  padding: 0.875rem 2rem;
  border-radius: 0.75rem;
  text-decoration: none;
  transition: all 0.2s;
}

.action-button:hover {
  background: #6b4226;
  transform: translateY(-1px);
}

/* ===== 响应式 ===== */
@media (max-width: 640px) {
  .essay-result-page {
    padding: 1rem 0.75rem;
  }

  .page-title { font-size: 1.5rem; }

  .score-cards { grid-template-columns: 1fr; }

  .score-value { font-size: 2.5rem; }

  .section-card {
    padding: 1rem;
    border-radius: 0.75rem;
  }

  .collapsible-section { padding: 1rem; }
}
</style>
