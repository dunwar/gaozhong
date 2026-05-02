<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-500 text-sm mt-3">加载中...</p>
    </div>

    <div v-else-if="!record" class="text-center py-16">
      <div class="text-5xl mb-4">🔍</div>
      <p class="text-gray-500 mb-4">错题记录不存在或无权查看</p>
      <router-link to="/errors" class="text-blue-600 hover:text-blue-700 font-medium text-sm">← 返回错题本</router-link>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center justify-between mb-6">
        <button @click="goBack" class="flex items-center gap-1 text-gray-500 hover:text-blue-600 transition-colors text-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
          返回错题本
        </button>
        <div class="flex items-center gap-2 text-sm text-gray-400">
          <span>{{ fmtFullDate(record.createdAt) }}</span>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg overflow-hidden">
        <!-- 头部 -->
        <div class="border-b border-gray-100 px-6 py-5">
          <div class="flex flex-wrap items-center gap-3 mb-2">
            <span :class="subjectBadge(record.subject)" class="px-3 py-1 rounded-lg text-sm font-semibold">{{ record.subject }}</span>
            <span v-if="record.questionType" class="px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs">{{ record.questionType }}</span>
            <span v-if="record.errorType" :class="errTypeTag(record.errorType)" class="px-3 py-1 rounded-full text-xs font-medium">{{ record.errorType }}</span>
            <span class="flex items-center gap-0.5"><span v-for="i in 5" :key="i" :class="i <= record.difficulty ? 'text-yellow-500' : 'text-gray-200'" class="text-sm">★</span></span>
          </div>
          <div v-if="record.topic" class="text-sm text-gray-400">{{ record.topic }}</div>
        </div>

        <!-- 题目 + 选项 -->
        <div class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">📋 题目</h3>
          <p class="text-gray-800 leading-relaxed whitespace-pre-wrap mb-4">{{ record.questionText }}</p>
          <!-- 选项列表 -->
          <div v-if="options.length > 0" class="space-y-1.5 mt-3">
            <div v-for="(opt, i) in options" :key="i"
              :class="[
                'px-4 py-2.5 rounded-lg text-sm border transition-colors',
                optLetter(opt) === record.correctAnswer ? 'border-green-300 bg-green-50 text-green-800' :
                optLetter(opt) === record.wrongAnswer ? 'border-red-300 bg-red-50 text-red-800' :
                'border-gray-200 bg-gray-50 text-gray-700'
              ]"
            >
              <span class="font-medium mr-2">{{ optLetter(opt) }}.</span>{{ optText(opt) }}
              <span v-if="optLetter(opt) === record.correctAnswer" class="ml-2 text-xs text-green-600">✓ 正确答案</span>
              <span v-if="optLetter(opt) === record.wrongAnswer" class="ml-2 text-xs text-red-600">✗ 你的选择</span>
            </div>
          </div>
        </div>

        <!-- 作答对比 -->
        <div v-if="record.wrongAnswer || record.correctAnswer" class="px-6 py-5 border-b border-gray-50 bg-amber-50/50">
          <h3 class="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-3">⚖️ 作答对比</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="bg-red-50 rounded-lg p-4 border border-red-100">
              <p class="text-xs text-red-500 font-medium mb-1">❌ 你的答案</p>
              <p class="text-red-800 font-semibold">{{ record.wrongAnswer || '（未作答）' }}</p>
            </div>
            <div class="bg-green-50 rounded-lg p-4 border border-green-100">
              <p class="text-xs text-green-500 font-medium mb-1">✅ 正确答案</p>
              <p class="text-green-800 font-semibold">{{ record.correctAnswer || record.correctSolution?.split('\n')[0] || '--' }}</p>
            </div>
          </div>
          <p v-if="record.gradingEvidence" class="text-xs text-gray-500 mt-3">📝 批改标记：{{ record.gradingEvidence }}</p>
        </div>

        <!-- 错误分析 -->
        <div class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">🔍 错误分析</h3>
          <p class="text-gray-700 leading-relaxed">{{ formatReason(record) }}</p>
        </div>

        <!-- 正确解法 -->
        <div v-if="record.correctSolution" class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">✅ 正确解法</h3>
          <div class="bg-gray-50 rounded-xl p-5">
            <p class="text-gray-700 leading-relaxed whitespace-pre-wrap">{{ record.correctSolution }}</p>
          </div>
        </div>

        <!-- 知识点详解 -->
        <div v-if="knowledgeExpls.length > 0" class="px-6 py-5">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">🏷️ 知识点详解</h3>
          <div class="space-y-4">
            <div v-for="kp in knowledgeExpls" :key="kp.name" class="bg-blue-50/50 rounded-xl p-4 border border-blue-100">
              <div class="flex items-center gap-2 mb-2">
                <span class="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">{{ kp.name }}</span>
                <span v-if="record.knowledgeTags?.find(t => t.name === kp.name)" class="text-xs text-blue-400">📚 已关联</span>
              </div>
              <p class="text-sm text-gray-700 leading-relaxed">{{ kp.explanation }}</p>
            </div>
          </div>
        </div>

        <!-- 仅标签（无详解时） -->
        <div v-else-if="record.knowledgeTags?.length" class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">🏷️ 关联知识点</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="tag in record.knowledgeTags" :key="tag.id" class="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium">{{ tag.name }}</span>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between mt-6">
        <router-link to="/error-upload" class="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
          + 上传试卷
        </router-link>
        <router-link to="/errors" class="text-gray-500 hover:text-blue-600 transition-colors text-sm">返回错题本 →</router-link>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authFetch } from '../utils/authStore.js'

const route = useRoute()
const router = useRouter()
const record = ref(null)
const loading = ref(true)

const options = computed(() => {
  if (!record.value?.answerOptions) return []
  try { return JSON.parse(record.value.answerOptions) } catch { return [] }
})

const knowledgeExpls = computed(() => {
  if (!record.value?.knowledgeExplanation) return []
  try {
    const exp = JSON.parse(record.value.knowledgeExplanation)
    return Object.entries(exp).map(([name, explanation]) => ({ name, explanation }))
  } catch { return [] }
})

function optLetter(opt) {
  const m = (opt || '').match(/^([A-Z])/)
  return m ? m[1] : ''
}

function optText(opt) {
  return (opt || '').replace(/^[A-Z][.、\s)]*\s*/, '')
}

function subjectBadge(s) {
  const m = { '数学': 'bg-blue-50 text-blue-700', '物理': 'bg-purple-50 text-purple-700', '化学': 'bg-green-50 text-green-700', '生物': 'bg-teal-50 text-teal-700', '英语': 'bg-orange-50 text-orange-700', '语文': 'bg-red-50 text-red-700' }
  return m[s] || 'bg-gray-50 text-gray-600'
}

function errTypeTag(t) {
  const m = { '概念不清': 'bg-red-50 text-red-700', '计算失误': 'bg-yellow-50 text-yellow-700', '审题偏差': 'bg-purple-50 text-purple-700', '方法错误': 'bg-orange-50 text-orange-700', '粗心马虎': 'bg-blue-50 text-blue-700', '知识盲区': 'bg-gray-100 text-gray-700', '表达不规范': 'bg-pink-50 text-pink-700', '逻辑错误': 'bg-indigo-50 text-indigo-700' }
  return m[t] || 'bg-gray-50 text-gray-600'
}

function formatReason(rec) {
  if (!rec) return ''
  try {
    if (rec.aiRaw) {
      const p = JSON.parse(rec.aiRaw)
      // 新格式：aiRaw = { scan: {...}, analysis: {...} }
      if (p.analysis?.reason) return p.analysis.reason
      if (p.reason) return p.reason
    }
  } catch {}
  return rec.errorType || ''
}

function fmtFullDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function goBack() { router.push('/errors') }

async function loadDetail() {
  loading.value = true
  try {
    const res = await authFetch(`/api/error/${route.params.id}`)
    const data = await res.json()
    if (data.success) record.value = data.record
  } catch (err) { console.error('加载错题详情失败:', err) }
  finally { loading.value = false }
}

onMounted(() => loadDetail())
</script>
