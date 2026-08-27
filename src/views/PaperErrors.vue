<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-500 text-sm mt-3">加载中...</p>
    </div>

    <!-- 试卷不存在 -->
    <div v-else-if="!paper" class="text-center py-16">
      <div class="text-5xl mb-4">📄</div>
      <p class="text-gray-500 mb-4">试卷不存在或无权查看</p>
      <router-link to="/error/list" class="text-blue-600 hover:text-blue-700 font-medium text-sm">← 返回错题本</router-link>
    </div>

    <template v-else>
      <!-- 顶部导航 -->
      <div class="flex items-center justify-between mb-6">
        <button @click="$router.push('/error/list')" class="flex items-center gap-1 text-gray-500 hover:text-blue-600 transition-colors text-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
          返回错题本
        </button>
        <div class="text-sm text-gray-400">{{ fmtDate(paper.createdAt) }}</div>
      </div>

      <!-- 试卷概览卡片 -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-8">
        <div class="flex flex-wrap items-center gap-3 mb-3">
          <span :class="subBadge(paper.subject)" class="px-3 py-1 rounded-lg text-sm font-semibold">{{ paper.subject }}</span>
          <span class="text-xs text-gray-400">📷 {{ paper.imageCount }} 页</span>
          <span class="text-xs text-gray-400">📝 {{ paper.totalQuestions || 0 }} 题</span>
        </div>
        <h1 class="text-xl font-bold text-gray-900">{{ paper.title || '未命名试卷' }}</h1>
        <div class="flex flex-wrap gap-2 mt-3">
          <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-700 rounded-lg text-sm font-medium">
            ❌ {{ errors.length }} 道错题
          </span>
          <span v-if="paper.correctCount > 0" class="inline-flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg text-sm">
            ✅ {{ paper.correctCount }} 道正确
          </span>
          <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-sm">
            {{ (paper.correctCount > 0 && paper.totalQuestions > 0) ? Math.round(paper.correctCount/paper.totalQuestions*100) + '%' : '—' }} 正确率
          </span>
        </div>

        <!-- 错误类型分布 -->
        <div v-if="errorTypeStats.length > 0" class="flex flex-wrap gap-2 mt-4 pt-4 border-t border-gray-100">
          <span v-for="s in errorTypeStats" :key="s.type" :class="errBadge(s.type)" class="px-2 py-1 rounded-full text-xs font-medium">{{ s.type }} ×{{ s.count }}</span>
        </div>
      </div>

      <!-- 错题卡片列表 -->
      <div v-if="errors.length === 0" class="text-center py-12 bg-white rounded-2xl border border-gray-100">
        <div class="text-5xl mb-4">🎉</div>
        <p class="text-gray-500 text-lg">这张卷子全对，没有错题！</p>
        <router-link to="/error/list" class="inline-block mt-3 text-blue-600 hover:text-blue-700 font-medium text-sm">← 返回错题本</router-link>
      </div>

      <div v-else class="space-y-4">
        <div
          v-for="(err, idx) in errors"
          :key="err.id"
          class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"
        >
          <!-- 题号 + 标签头 -->
          <div class="border-b border-gray-100 px-6 py-4 bg-gray-50/50">
            <div class="flex flex-wrap items-center gap-3">
              <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex-shrink-0">
                {{ err.questionNumber || idx + 1 }}
              </span>
              <span :class="subBadge(err.subject)" class="px-2 py-0.5 rounded text-xs font-medium">{{ err.subject }}</span>
              <span v-if="err.questionType" class="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">{{ err.questionType }}</span>
              <span v-if="err.errorType" :class="errBadge(err.errorType)" class="px-3 py-1 rounded-full text-xs font-medium">{{ err.errorType }}</span>
              <span class="flex items-center gap-0.5 ml-auto"><span v-for="i in 5" :key="i" :class="i <= (err.difficulty || 1) ? 'text-yellow-500' : 'text-gray-200'" class="text-sm">★</span></span>
            </div>
            <div v-if="err.topic" class="text-xs text-gray-400 mt-1">{{ err.topic }}</div>
          </div>

          <!-- 题目 + 选项 -->
          <div v-if="err.questionText || err.answerOptions" class="px-6 py-4 border-b border-gray-50">
            <div class="flex items-start gap-4">
              <!-- 题目原图缩略（阶段1d） -->
              <img
                v-if="cropUrl(err) && !cropFailed[err.id]"
                :src="cropUrl(err)"
                @error="cropFailed[err.id] = true"
                class="w-32 sm:w-44 shrink-0 rounded-lg border border-gray-200 object-contain bg-gray-50 cursor-zoom-in"
                alt="题目原图"
                @click="previewImage = cropUrl(err)"
              />
              <div class="min-w-0 flex-1">
                <h4 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">📋 题目</h4>
                <p v-if="err.questionText" class="text-gray-800 leading-relaxed whitespace-pre-wrap mb-3">{{ err.questionText }}</p>
              </div>
            </div>
            <!-- 阅读原文（阶段1a） -->
            <details v-if="err.passageText" class="mb-3">
              <summary class="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer select-none">📖 阅读原文（点击展开/收起）</summary>
              <p class="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-lg p-3 mt-2 max-h-60 overflow-y-auto">{{ err.passageText }}</p>
            </details>
            <!-- 选项列表 -->
            <div v-if="parsedOptions(err).length > 0" class="space-y-1.5">
              <div v-for="(opt, oi) in parsedOptions(err)" :key="oi"
                :class="[
                  'px-4 py-2.5 rounded-lg text-sm border transition-colors',
                  letter(opt) === err.correctAnswer ? 'border-green-300 bg-green-50 text-green-800' :
                  letter(opt) === err.wrongAnswer ? 'border-red-300 bg-red-50 text-red-800' :
                  'border-gray-200 bg-gray-50 text-gray-700'
                ]"
              >
                <span class="font-medium mr-2">{{ letter(opt) }}.</span>{{ text(opt) }}
                <span v-if="letter(opt) === err.correctAnswer" class="ml-2 text-xs text-green-600">✓ 正确</span>
                <span v-if="letter(opt) === err.wrongAnswer" class="ml-2 text-xs text-red-600">✗ 你的选择</span>
              </div>
            </div>
          </div>

          <!-- 作答对比 -->
          <div v-if="err.wrongAnswer || err.correctAnswer" class="px-6 py-4 border-b border-gray-50 bg-amber-50/50">
            <h4 class="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-3">⚖️ 作答对比</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="bg-red-50 rounded-lg p-4 border border-red-100">
                <p class="text-xs text-red-500 font-medium mb-1">❌ 你的答案</p>
                <p class="text-red-800 font-semibold text-lg">{{ err.wrongAnswer || '（未作答）' }}</p>
              </div>
              <div class="bg-green-50 rounded-lg p-4 border border-green-100">
                <p class="text-xs text-green-500 font-medium mb-1">✅ 正确答案</p>
                <p class="text-green-800 font-semibold text-lg">{{ err.correctAnswer || '—' }}</p>
              </div>
            </div>
            <p v-if="err.gradingEvidence" class="text-xs text-gray-500 mt-2">📝 批改标记：{{ err.gradingEvidence }}</p>
          </div>

          <!-- 错误分析 -->
          <div v-if="formatDiagnosis(err)" class="px-6 py-4 border-b border-gray-50">
            <h4 class="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">❌ 为什么会错？</h4>
            <p class="text-gray-700 leading-relaxed text-sm">{{ formatDiagnosis(err) }}</p>
          </div>

          <!-- 正确解法 -->
          <div v-if="err.correctSolution" class="px-6 py-4 border-b border-gray-50">
            <h4 class="text-xs font-semibold text-green-400 uppercase tracking-wide mb-2">✅ 应该怎么做？</h4>
            <div class="bg-green-50/50 rounded-xl p-4 border border-green-100">
              <p class="text-gray-700 leading-relaxed text-sm whitespace-pre-wrap">{{ err.correctSolution }}</p>
            </div>
          </div>

          <!-- 记忆口诀 -->
          <div v-if="err.notes" class="px-6 py-4 border-b border-gray-50 bg-yellow-50/30">
            <h4 class="text-xs font-semibold text-yellow-500 uppercase tracking-wide mb-2">🧠 记住这个！</h4>
            <div class="bg-yellow-100/50 rounded-xl p-4 border border-yellow-200">
              <p class="text-yellow-800 font-medium text-sm leading-relaxed">{{ err.notes }}</p>
            </div>
          </div>

          <!-- 知识点 -->
          <div v-if="err.knowledgeTags?.length" class="px-6 py-3 bg-blue-50/30">
            <h4 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">🏷️ 关联知识点</h4>
            <div class="flex flex-wrap gap-2">
              <span v-for="tag in err.knowledgeTags" :key="tag.id" class="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{{ tag.name }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="flex justify-between items-center mt-8">
        <router-link
          :to="`/review/${paper.id}`"
          class="px-4 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 text-sm font-medium transition-colors"
        >
          🔍 复核试卷
        </router-link>
        <router-link to="/paper/upload" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors">
          + 上传新试卷
        </router-link>
      </div>
    </template>

    <!-- 题目图全屏预览 -->
    <div v-if="previewImage" class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-zoom-out" @click="previewImage = null">
      <img :src="previewImage" class="max-w-full max-h-full rounded-lg shadow-2xl" alt="题目原图预览" />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { authFetch } from '../utils/authStore.js'

const route = useRoute()
const paper = ref(null)
const errors = ref([])
const loading = ref(true)

// 阶段1d: 题目裁剪图
const cropFailed = reactive({})
const previewImage = ref(null)
function cropUrl(err) {
  if (!err?.sessionId || !err.questionNumber) return null
  let pageNum = err.paperIndex || 0
  try {
    const raw = err.aiRaw ? JSON.parse(err.aiRaw) : null
    if (raw?.pageIndex) pageNum = raw.pageIndex
  } catch {}
  if (!pageNum) return null
  return `/api/paper/${err.sessionId}/region/p${pageNum}_q${err.questionNumber}.jpg`
}

const errorTypeStats = ref([])

function subBadge(s) {
  const m = { '数学': 'bg-blue-50 text-blue-700', '物理': 'bg-purple-50 text-purple-700', '化学': 'bg-green-50 text-green-700', '生物': 'bg-teal-50 text-teal-700', '英语': 'bg-orange-50 text-orange-700', '语文': 'bg-red-50 text-red-700' }
  return m[s] || 'bg-gray-50 text-gray-600'
}

function errBadge(t) {
  const m = { '概念不清': 'bg-red-50 text-red-700', '计算失误': 'bg-yellow-50 text-yellow-700', '审题偏差': 'bg-purple-50 text-purple-700', '方法错误': 'bg-orange-50 text-orange-700', '粗心马虎': 'bg-blue-50 text-blue-700', '知识盲区': 'bg-gray-100 text-gray-700', '表达不规范': 'bg-pink-50 text-pink-700', '逻辑错误': 'bg-indigo-50 text-indigo-700' }
  return m[t] || 'bg-gray-50 text-gray-600'
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function parsedOptions(err) {
  if (!err?.answerOptions) return []
  try {
    const parsed = typeof err.answerOptions === 'string' ? JSON.parse(err.answerOptions) : err.answerOptions
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'object') return Object.entries(parsed).map(([k, v]) => `${k}. ${v}`)
    return []
  } catch { return [] }
}

function letter(opt) {
  const m = (opt || '').match(/^([A-Z])/)
  return m ? m[1] : ''
}

function text(opt) {
  return (opt || '').replace(/^[A-Z][.、\s)]*\s*/, '')
}

function formatDiagnosis(err) {
  if (!err) return ''
  // Try aiRaw first (JSON with diagnosis field)
  try {
    if (err.aiRaw) {
      const p = typeof err.aiRaw === 'string' ? JSON.parse(err.aiRaw) : err.aiRaw
      if (p.diagnosis) return p.diagnosis
      if (p.analysis?.diagnosis) return p.analysis.diagnosis
      if (p.analysis?.reason) return p.analysis.reason
      if (p.reason) return p.reason
    }
  } catch {}
  return err.errorType || ''
}

async function loadData() {
  loading.value = true
  const sessionId = route.params.sessionId
  try {
    // 并行加载试卷信息和错题列表
    const [paperRes, errorsRes] = await Promise.all([
      authFetch(`/api/paper/${sessionId}`),
      authFetch(`/api/error/list?view=list&sessionId=${encodeURIComponent(sessionId)}&limit=200`)
    ])

    if (paperRes.ok) {
      const pd = await paperRes.json()
      if (pd.success) paper.value = pd.session
    }

    if (errorsRes.ok) {
      const ed = await errorsRes.json()
      if (ed.success) errors.value = ed.records || []
    }

    // 统计错误类型
    const typeMap = {}
    for (const e of errors.value) {
      const t = e.errorType || '未分类'
      typeMap[t] = (typeMap[t] || 0) + 1
    }
    errorTypeStats.value = Object.entries(typeMap).map(([type, count]) => ({ type, count }))
  } catch (err) {
    console.error('加载试卷错题失败:', err)
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>
