<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-500 text-sm mt-3">加载中...</p>
    </div>

    <!-- 不存在 -->
    <div v-else-if="!record" class="text-center py-16">
      <div class="text-5xl mb-4">🔍</div>
      <p class="text-gray-500 mb-4">错题记录不存在或无权查看</p>
      <router-link to="/errors" class="text-blue-600 hover:text-blue-700 font-medium text-sm">← 返回错题本</router-link>
    </div>

    <!-- 错题详情 -->
    <template v-else>
      <!-- 顶部导航 -->
      <div class="flex flex-wrap items-center justify-between mb-6">
        <button @click="goBack" class="flex items-center gap-1 text-gray-500 hover:text-blue-600 transition-colors text-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
          </svg>
          返回错题本
        </button>
        <div class="flex items-center gap-2 text-sm text-gray-400">
          <span>{{ fmtFullDate(record.createdAt) }}</span>
        </div>
      </div>

      <!-- 主内容卡片 -->
      <div class="bg-white rounded-2xl shadow-lg overflow-hidden">
        <!-- 头部：学科 + 标签 -->
        <div class="border-b border-gray-100 px-6 py-5">
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <span :class="subjectBadgeClass(record.subject)" class="px-3 py-1 rounded-lg text-sm font-semibold">
              {{ record.subject }}
            </span>
            <span v-if="record.errorType" :class="errorTypeTagClass(record.errorType)" class="px-3 py-1 rounded-full text-xs font-medium">
              {{ record.errorType }}
            </span>
            <span class="flex items-center gap-0.5" title="难度">
              <span v-for="i in 5" :key="i" :class="i <= record.difficulty ? 'text-yellow-500' : 'text-gray-200'" class="text-sm">★</span>
            </span>
          </div>
          <div v-if="record.topic" class="text-sm text-gray-400">{{ record.topic }}</div>
        </div>

        <!-- 题目 -->
        <div class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">📋 原题</h3>
          <p class="text-gray-800 leading-relaxed whitespace-pre-wrap">{{ record.questionText }}</p>
        </div>

        <!-- 错误答案 -->
        <div v-if="record.wrongAnswer" class="px-6 py-5 border-b border-gray-50 bg-red-50/30">
          <h3 class="text-xs font-semibold text-red-400 uppercase tracking-wide mb-3">❌ 你的答案</h3>
          <p class="text-red-800 leading-relaxed whitespace-pre-wrap">{{ record.wrongAnswer }}</p>
        </div>

        <!-- 错误分析 -->
        <div class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">🔍 错误分析</h3>
          <p class="text-gray-700 leading-relaxed">{{ record.errorType === '知识盲区' && !record.wrongAnswer ? '未作答，可能完全不了解该知识点。' : '' }}{{ formatReason(record) }}</p>
        </div>

        <!-- 正确解法（来自 AI 原始输出） -->
        <div class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">✅ 正确解法</h3>
          <div class="bg-gray-50 rounded-xl p-5">
            <pre class="text-gray-700 font-mono text-sm leading-relaxed whitespace-pre-wrap font-sans">{{ record.correctSolution || '暂无」' }}</pre>
          </div>
        </div>

        <!-- 知识点 -->
        <div v-if="record.knowledgeTags?.length" class="px-6 py-5 border-b border-gray-50">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">🏷️ 关联知识点</h3>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="tag in record.knowledgeTags"
              :key="tag.id"
              class="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium"
            >{{ tag.name }}</span>
          </div>
        </div>

        <!-- 巩固建议 -->
        <div v-if="similarTips" class="px-6 py-5">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">💡 巩固建议</h3>
          <p class="text-gray-600 text-sm leading-relaxed">{{ similarTips }}</p>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="flex flex-wrap items-center justify-between mt-6">
        <router-link
          to="/error-upload"
          class="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
          </svg>
          再录一题
        </router-link>
        <router-link to="/errors" class="text-gray-500 hover:text-blue-600 transition-colors text-sm">
          返回错题本 →
        </router-link>
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

const similarTips = computed(() => {
  // 从 AI raw 中提取 similarTips
  if (!record.value?.correctSolution) return ''
  try {
    // 如果 correctSolution 末尾包含类似 "巩固建议" 的内容，尝试提取
    const text = record.value.correctSolution || ''
    // 也可以从 aiRaw 中尝试提取
    if (record.value.aiRaw) {
      const parsed = JSON.parse(record.value.aiRaw)
      return parsed.similarTips || ''
    }
  } catch {}
  return ''
})

function subjectBadgeClass(subject) {
  const map = {
    '数学': 'bg-blue-50 text-blue-700',
    '物理': 'bg-purple-50 text-purple-700',
    '化学': 'bg-green-50 text-green-700',
    '英语': 'bg-orange-50 text-orange-700',
    '语文': 'bg-red-50 text-red-700',
  }
  return map[subject] || 'bg-gray-50 text-gray-600'
}

function errorTypeTagClass(type) {
  const map = {
    '概念不清': 'bg-red-50 text-red-700',
    '计算失误': 'bg-yellow-50 text-yellow-700',
    '审题偏差': 'bg-purple-50 text-purple-700',
    '方法错误': 'bg-orange-50 text-orange-700',
    '粗心': 'bg-blue-50 text-blue-700',
    '知识盲区': 'bg-gray-100 text-gray-700',
  }
  return map[type] || 'bg-gray-50 text-gray-600'
}

function formatReason(rec) {
  if (!rec) return ''
  // 尝试从 aiRaw 中提取 reason
  if (rec.aiRaw) {
    try {
      const parsed = JSON.parse(rec.aiRaw)
      return parsed.reason || ''
    } catch {}
  }
  return rec.errorType || ''
}

function fmtFullDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const h = `${d.getHours()}`.padStart(2, '0')
  const min = `${d.getMinutes()}`.padStart(2, '0')
  return `${m}/${day} ${h}:${min}`
}

function goBack() {
  router.push('/errors')
}

async function loadDetail() {
  loading.value = true
  try {
    const res = await authFetch(`/api/error/${route.params.id}`)
    const data = await res.json()
    if (data.success) {
      record.value = data.record
    }
  } catch (err) {
    console.error('加载错题详情失败:', err)
  } finally {
    loading.value = false
  }
}

onMounted(() => loadDetail())
</script>
