<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 标题 -->
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">批改历史</h1>
      <p class="text-gray-600">查看所有已完成的作文批改记录</p>
    </div>

    <!-- 未登录提示 -->
    <div v-if="!authStore.isLoggedIn" class="bg-blue-50 border border-blue-200 rounded-2xl p-8 text-center mb-8">
      <h3 class="text-lg font-semibold text-blue-700 mb-2">登录以查看历史记录</h3>
      <p class="text-blue-600 text-sm mb-4">登录后可以查看和管理您的所有批改记录。</p>
      <div class="flex justify-center gap-3">
        <router-link
          :to="`/login?redirect=${encodeURIComponent($route.fullPath)}`"
          class="bg-blue-600 text-white px-6 py-2 rounded-xl font-medium hover:bg-blue-700 transition"
        >登录</router-link>
        <router-link
          to="/register"
          class="bg-white text-blue-600 border border-blue-300 px-6 py-2 rounded-xl font-medium hover:bg-blue-50 transition"
        >注册</router-link>
      </div>
    </div>

    <template v-else>
      <!-- 统计卡片 -->
      <div v-if="stats" class="grid grid-cols-3 gap-4 mb-8">
        <div class="bg-white rounded-xl p-4 text-center shadow-sm">
          <div class="text-2xl font-bold text-blue-600">{{ stats.total }}</div>
          <div class="text-sm text-gray-500">总批改数</div>
        </div>
        <div class="bg-white rounded-xl p-4 text-center shadow-sm">
          <div class="text-2xl font-bold text-green-600">{{ stats.avgScore }}</div>
          <div class="text-sm text-gray-500">平均分</div>
        </div>
        <div class="bg-white rounded-xl p-4 text-center shadow-sm">
          <div class="text-2xl font-bold text-purple-600">{{ stats.todayCount }}</div>
          <div class="text-sm text-gray-500">今日批改</div>
        </div>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="text-center py-12 text-gray-500">
        加载中...
      </div>

      <!-- 空状态 -->
      <div v-else-if="records.length === 0" class="text-center py-12">
        <p class="text-gray-500 mb-4">暂无批改记录</p>
        <router-link to="/upload" class="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700">
          去批改一篇作文
        </router-link>
      </div>

      <!-- 记录列表 -->
      <div v-else class="space-y-3">
        <router-link
          v-for="record in records"
          :key="record.id"
          :to="`/result/${record.id}`"
          class="block bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow border border-gray-100"
        >
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-medium text-gray-900 truncate">
                {{ record.essay_topic || '(无题目)' }}
              </h3>
              <p v-if="record.one_sentence_summary" class="text-xs text-gray-500 mt-1 line-clamp-1">
                {{ record.one_sentence_summary }}
              </p>
            </div>
            <div class="ml-4 flex items-center gap-4">
              <div class="text-right">
                <span
                  class="text-lg font-bold"
                  :class="getScoreColor(record.total_score)"
                >{{ record.total_score }}<span class="text-sm text-gray-400">/70</span></span>
              </div>
              <span
                class="px-2 py-1 rounded text-xs font-medium"
                :class="getGradeClass(record.grade)"
              >{{ record.grade || '未评定' }}</span>
            </div>
          </div>
          <div class="mt-2 flex items-center gap-3 text-xs text-gray-400">
            <span>{{ record.word_count || 0 }}字</span>
            <span>·</span>
            <span>{{ formatTime(record.created_at) }}</span>
          </div>
        </router-link>
      </div>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex justify-center gap-2 mt-8">
        <button
          v-for="p in totalPages"
          :key="p"
          @click="loadPage(p)"
          :class="p === page ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'"
          class="px-4 py-2 rounded-lg text-sm font-medium transition"
        >{{ p }}</button>
      </div>

      <!-- 返回按钮 -->
      <div class="text-center mt-8">
        <router-link to="/upload" class="text-blue-600 hover:text-blue-700 text-sm">
          → 去批改新作文
        </router-link>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { authStore, authFetch } from '../utils/authStore.js'

const router = useRouter()
const records = ref([])
const loading = ref(true)
const stats = ref(null)
const page = ref(1)
const totalPages = ref(1)

const loadPage = async (p) => {
  loading.value = true
  page.value = p
  try {
    const res = await authFetch(`/api/history?page=${p}&limit=20`)
    if (res.status === 401) {
      authStore.logout()
      return
    }
    if (res.ok) {
      const data = await res.json()
      records.value = data.records
      totalPages.value = data.totalPages
    }
  } catch (err) {
    console.error('加载历史失败:', err)
  }
  loading.value = false
}

const loadStats = async () => {
  try {
    const res = await authFetch('/api/stats')
    if (res.ok) {
      stats.value = await res.json()
    }
  } catch {}
}

const getScoreColor = (score) => {
  if (score >= 56) return 'text-green-600'
  if (score >= 42) return 'text-yellow-600'
  return 'text-red-600'
}

const getGradeClass = (grade) => {
  if (grade?.includes('一')) return 'bg-green-100 text-green-700'
  if (grade?.includes('二')) return 'bg-blue-100 text-blue-700'
  if (grade?.includes('三')) return 'bg-yellow-100 text-yellow-700'
  if (grade?.includes('四')) return 'bg-orange-100 text-orange-700'
  if (grade?.includes('五')) return 'bg-red-100 text-red-700'
  return 'bg-gray-100 text-gray-600'
}

const formatTime = (ts) => {
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

onMounted(() => {
  if (authStore.isLoggedIn) {
    loadPage(1)
    loadStats()
  } else {
    loading.value = false
  }
})
</script>
