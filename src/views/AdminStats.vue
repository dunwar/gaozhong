<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900">📊 运营数据</h1>
      <p class="text-sm text-gray-500 mt-1">仅管理员可见 · 访问口径 = 当日独立 IP（会话级去重）</p>
    </div>

    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
    </div>

    <div v-else-if="denied" class="text-center py-16 bg-white rounded-2xl border">
      <p class="text-4xl mb-3">🔒</p>
      <p class="text-gray-500">仅管理员可访问</p>
    </div>

    <template v-else>
      <!-- 访问 -->
      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="bg-white rounded-2xl border p-6 text-center">
          <p class="text-4xl font-bold text-blue-600">{{ stats.visits.total }}</p>
          <p class="text-sm text-gray-500 mt-1">累计访问用户</p>
        </div>
        <div class="bg-white rounded-2xl border p-6 text-center relative">
          <p class="text-4xl font-bold text-emerald-600">{{ stats.visits.today }}</p>
          <p class="text-sm text-gray-500 mt-1">今日访问（{{ stats.visits.day || '今日无访问' }}）</p>
        </div>
      </div>

      <!-- 使用与注册 -->
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class="bg-white rounded-2xl border p-5 text-center">
          <p class="text-3xl font-bold text-orange-500">{{ stats.usage.essays }}</p>
          <p class="text-xs text-gray-500 mt-1">作文批改完成</p>
        </div>
        <div class="bg-white rounded-2xl border p-5 text-center">
          <p class="text-3xl font-bold text-teal-500">{{ stats.usage.papers }}</p>
          <p class="text-xs text-gray-500 mt-1">试卷整理完成</p>
        </div>
        <div class="bg-white rounded-2xl border p-5 text-center">
          <p class="text-3xl font-bold text-purple-500">{{ stats.users }}</p>
          <p class="text-xs text-gray-500 mt-1">注册用户</p>
        </div>
      </div>

      <!-- 转化速览 -->
      <div class="bg-white rounded-2xl border p-5">
        <h2 class="font-semibold text-gray-800 mb-3 text-sm">速览</h2>
        <div class="space-y-2 text-sm text-gray-600">
          <p>注册转化：{{ stats.visits.total > 0 ? (stats.users / stats.visits.total * 100).toFixed(1) : '0' }}% <span class="text-gray-400">（注册 {{ stats.users }} / 访问 {{ stats.visits.total }}）</span></p>
          <p>使用深度：人均 {{ stats.visits.total > 0 ? ((stats.usage.essays + stats.usage.papers) / stats.visits.total).toFixed(2) : '0' }} 次批改/整理</p>
          <p class="text-xs text-gray-400">转化数字在早期波动大，趋势比绝对值重要；每日看「今日访问」最直观。</p>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { authStore, authFetch } from '../utils/authStore.js'

const stats = ref(null)
const loading = ref(true)
const denied = ref(false)

onMounted(async () => {
  if (authStore.user?.role !== 'admin') { denied.value = true; loading.value = false; return }
  try {
    const res = await authFetch('/api/admin/stats')
    if (res.status === 403) { denied.value = true; return }
    const data = await res.json()
    if (data.success) stats.value = data
  } catch (e) { console.error('加载运营数据失败:', e) }
  finally { loading.value = false }
})
</script>
