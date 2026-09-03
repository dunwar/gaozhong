<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-14">
    <!-- 标题 -->
    <div class="text-center mb-10">
      <h1 class="text-2xl md:text-3xl font-bold text-gray-900">充值 / 我的点数</h1>
      <p class="mt-2 text-gray-500 text-sm md:text-base">1 点 = 1 次作文批改，或 1 份试卷错题整理</p>
    </div>

    <!-- 我的余额 -->
    <div v-if="authStore.isLoggedIn" class="bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl p-6 mb-8 text-white shadow-lg shadow-blue-200">
      <div class="flex items-center justify-between flex-wrap gap-4">
        <div>
          <p class="text-blue-100 text-sm">当前余额（{{ authStore.user?.nickname || authStore.user?.email }}）</p>
          <p class="text-4xl font-bold mt-1">{{ points }} <span class="text-base font-normal text-blue-200">点</span></p>
        </div>
        <div class="text-right text-sm text-blue-100 leading-6">
          <p>✏️ 作文批改：1 点 / 次</p>
          <p>📄 试卷整理：1 点 / 份</p>
          <p>❌ 失败自动退点</p>
        </div>
      </div>
    </div>
    <div v-else class="bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-8 text-center">
      <p class="text-amber-800 text-sm">登录后查看余额 · <router-link to="/register" class="font-medium underline">新用户注册即送 3 点</router-link></p>
    </div>

    <!-- 充值流程 + 收款码 -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
      <!-- 收款码 -->
      <div class="bg-white rounded-2xl border-2 border-gray-100 p-6 text-center shadow-sm">
        <h3 class="font-semibold text-gray-900 mb-1">① 微信扫码付款</h3>
        <p class="text-xs text-gray-400 mb-4">付款时请备注注册手机号或昵称</p>
        <img src="/qr-wechat.jpg" alt="微信收款码" class="w-52 h-auto mx-auto rounded-xl border border-gray-100" />
        <p class="mt-4 text-xs text-gray-500">参考价：<span class="font-medium text-gray-700">¥9.9 / 20 点</span>（约 20 次批改或 20 份试卷）</p>
      </div>

      <!-- 流程 -->
      <div class="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm flex flex-col">
        <h3 class="font-semibold text-gray-900 mb-4">② 付款后人工开通</h3>
        <div class="space-y-4 flex-1">
          <div class="flex gap-3">
            <span class="w-6 h-6 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-xs font-bold shrink-0">1</span>
            <div>
              <p class="text-sm font-medium text-gray-800">截图付款记录</p>
              <p class="text-xs text-gray-500 mt-0.5">微信付款详情页截图（含金额和时间）</p>
            </div>
          </div>
          <div class="flex gap-3">
            <span class="w-6 h-6 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-xs font-bold shrink-0">2</span>
            <div>
              <p class="text-sm font-medium text-gray-800">发送到公众号后台</p>
              <p class="text-xs text-gray-500 mt-0.5">关注公众号，把截图和注册手机号/昵称一起发来</p>
            </div>
          </div>
          <div class="flex gap-3">
            <span class="w-6 h-6 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-xs font-bold shrink-0">3</span>
            <div>
              <p class="text-sm font-medium text-gray-800">管理员核实后开通（通常 12 小时内）</p>
              <p class="text-xs text-gray-500 mt-0.5">点数到账后本页余额自动更新</p>
            </div>
          </div>
        </div>
        <div class="mt-5 bg-gray-50 rounded-xl p-3.5 text-xs text-gray-500 leading-5">
          <p>· 点数永久有效，不做期限</p>
          <p>· 批改/分析失败自动全额退点</p>
          <p>· 大额或学校团购请在公众号留言</p>
        </div>
      </div>
    </div>

    <!-- 点数流水 -->
    <div v-if="authStore.isLoggedIn && logs.length > 0" class="bg-white rounded-2xl border border-gray-100 p-6">
      <h3 class="font-semibold text-gray-900 mb-4">最近点数记录</h3>
      <div class="space-y-2">
        <div v-for="log in logs.slice(0, 10)" :key="log.id" class="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
          <div>
            <p class="text-gray-800">{{ log.reason }}</p>
            <p class="text-xs text-gray-400">{{ formatTime(log.created_at) }}</p>
          </div>
          <span :class="log.delta > 0 ? 'text-emerald-600 font-semibold' : 'text-gray-400 font-semibold'">
            {{ log.delta > 0 ? '+' : '' }}{{ log.delta }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { authStore, authFetch } from '../utils/authStore.js'

const points = ref(0)
const logs = ref([])

function formatTime(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(async () => {
  if (!authStore.isLoggedIn) return
  try {
    const res = await authFetch('/api/points/me')
    const data = await res.json()
    if (res.ok) {
      points.value = data.points
      logs.value = data.logs || []
    }
  } catch (_) { /* 静默 */ }
})
</script>
