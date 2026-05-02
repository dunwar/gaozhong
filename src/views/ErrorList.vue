<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 标题行 -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">📒 我的错题本</h1>
        <p class="text-gray-500 text-sm mt-1" v-if="total > 0">共 {{ total }} 道错题</p>
      </div>
      <router-link
        to="/error-upload"
        class="mt-3 sm:mt-0 inline-flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
        </svg>
        录入错题
      </router-link>
    </div>

    <!-- 学科筛选标签 -->
    <div class="flex flex-wrap gap-2 mb-6">
      <button
        @click="currentSubject = ''; currentPage = 1"
        :class="!currentSubject ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
      >全部</button>
      <button
        v-for="s in subjects"
        :key="s.value"
        @click="currentSubject = s.value; currentPage = 1"
        :class="currentSubject === s.value ? s.activeClass : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
      >{{ s.label }}</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-500 text-sm mt-3">加载中...</p>
    </div>

    <!-- 空状态 -->
    <div v-else-if="records.length === 0" class="text-center py-16">
      <div class="text-5xl mb-4">📝</div>
      <p class="text-gray-500 mb-4">还没有错题记录</p>
      <router-link
        to="/error-upload"
        class="text-blue-600 hover:text-blue-700 font-medium text-sm"
      >去录入第一道错题 →</router-link>
    </div>

    <!-- 错题列表 -->
    <div v-else class="space-y-3">
      <div
        v-for="err in records"
        :key="err.id"
        @click="goDetail(err.id)"
        class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer group"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <!-- 学科 + 主题 -->
            <div class="flex items-center gap-2 mb-2">
              <span :class="subjectBadgeClass(err.subject)" class="px-2 py-0.5 rounded text-xs font-medium">
                {{ err.subject }}
              </span>
              <span v-if="err.topic" class="text-xs text-gray-400">{{ err.topic }}</span>
            </div>

            <!-- 题目摘要 -->
            <p class="text-gray-800 text-sm font-medium line-clamp-2 mb-2 group-hover:text-blue-700 transition-colors">
              {{ err.questionText }}
            </p>

            <!-- 底部标签行 -->
            <div class="flex flex-wrap items-center gap-3 text-xs">
              <span v-if="err.errorType" :class="errorTypeTagClass(err.errorType)" class="px-2 py-0.5 rounded-full font-medium">
                {{ err.errorType }}
              </span>
              <span class="flex items-center gap-0.5 text-gray-400">
                <span v-for="i in 5" :key="i" :class="i <= err.difficulty ? 'text-yellow-500' : 'text-gray-300'" class="text-xs">★</span>
              </span>
              <span class="text-gray-400">{{ fmtTime(err.createdAt) }}</span>
            </div>
          </div>

          <!-- 箭头 -->
          <svg class="w-5 h-5 text-gray-300 group-hover:text-blue-500 flex-shrink-0 mt-1 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
          </svg>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 mt-8">
      <button
        @click="currentPage--"
        :disabled="currentPage <= 1"
        class="px-3 py-2 text-sm rounded-lg border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 transition-colors"
      >上一页</button>
      <span class="text-sm text-gray-500 px-2">{{ currentPage }} / {{ totalPages }}</span>
      <button
        @click="currentPage++"
        :disabled="currentPage >= totalPages"
        class="px-3 py-2 text-sm rounded-lg border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 transition-colors"
      >下一页</button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { authFetch } from '../utils/authStore.js'

const router = useRouter()

const subjects = [
  { value: '数学', label: '📐 数学', activeClass: 'bg-blue-600 text-white' },
  { value: '物理', label: '⚡ 物理', activeClass: 'bg-purple-600 text-white' },
  { value: '化学', label: '🧪 化学', activeClass: 'bg-green-600 text-white' },
  { value: '英语', label: '🌍 英语', activeClass: 'bg-orange-600 text-white' },
  { value: '语文', label: '📖 语文', activeClass: 'bg-red-600 text-white' },
]

const records = ref([])
const total = ref(0)
const totalPages = ref(0)
const currentPage = ref(1)
const currentSubject = ref('')
const loading = ref(false)
const limit = 20

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

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${m}/${day}`
}

function goDetail(id) {
  router.push(`/error/${id}`)
}

async function fetchList() {
  loading.value = true
  try {
    const params = new URLSearchParams({ page: currentPage.value, limit })
    if (currentSubject.value) params.set('subject', currentSubject.value)
    const res = await authFetch(`/api/error/list?${params}`)
    const data = await res.json()
    if (data.success) {
      records.value = data.records
      total.value = data.total
      totalPages.value = data.totalPages
    }
  } catch (err) {
    console.error('加载错题列表失败:', err)
  } finally {
    loading.value = false
  }
}

watch([currentPage, currentSubject], () => fetchList())

onMounted(() => fetchList())
</script>
