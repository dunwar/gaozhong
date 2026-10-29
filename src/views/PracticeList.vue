<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex flex-wrap items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">🎯 我的练习</h1>
        <p class="text-sm text-gray-500 mt-1">从错题生成的同类题练习卷 · 每天 {{ info.dailyLimit }} 次免费（今日已用 {{ info.todayUsed }} 次）</p>
      </div>
      <router-link to="/error/list" class="text-blue-600 hover:text-blue-700 text-sm font-medium">去错题本出题 →</router-link>
    </div>

    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
    </div>

    <div v-else-if="sessions.length === 0" class="bg-white rounded-2xl shadow-lg text-center py-14 px-6">
      <div class="text-5xl mb-4">📝</div>
      <p class="text-gray-600 font-medium mb-2">还没有练习卷</p>
      <p class="text-sm text-gray-500 mb-5">打开错题本，挑几道错题，一键生成同类题练习卷</p>
      <router-link to="/error/list" class="inline-block bg-emerald-600 text-white px-5 py-2.5 rounded-lg hover:bg-emerald-700 text-sm font-medium">去错题本出题</router-link>
    </div>

    <div v-else class="space-y-3">
      <router-link v-for="s in sessions" :key="s.id" :to="`/practice/${s.id}`"
        class="flex items-center justify-between bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow px-5 py-4">
        <div>
          <p class="font-medium text-gray-800">{{ s.title }}</p>
          <p class="text-xs text-gray-400 mt-1">{{ fmtDate(s.createdAt) }} · {{ s.itemCount }} 道题</p>
        </div>
        <span :class="statusClass(s.status)" class="px-3 py-1 rounded-full text-xs font-medium">{{ statusLabel(s.status) }}</span>
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { authFetch } from '../utils/authStore.js'

const sessions = ref([])
const info = ref({ dailyLimit: 5, todayUsed: 0 })
const loading = ref(true)

function statusLabel(s) {
  return { generating: '生成中', done: '待练习', completed: '已完成 ✓', failed: '失败' }[s] || s
}
function statusClass(s) {
  return { generating: 'bg-blue-50 text-blue-600', done: 'bg-amber-50 text-amber-700', completed: 'bg-green-50 text-green-700', failed: 'bg-red-50 text-red-600' }[s] || 'bg-gray-50 text-gray-500'
}
function fmtDate(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(async () => {
  try {
    const res = await authFetch('/api/practice')
    const data = await res.json()
    if (data.success) {
      sessions.value = data.records || []
      info.value = { dailyLimit: data.dailyLimit, todayUsed: data.todayUsed }
    }
  } catch (e) { console.error('加载练习列表失败:', e) }
  finally { loading.value = false }
})
</script>
