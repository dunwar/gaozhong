<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div v-if="loading" class="text-center py-16">
      <div class="inline-block w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-500 text-sm mt-3">加载中...</p>
    </div>

    <div v-else-if="!session" class="text-center py-16">
      <div class="text-5xl mb-4">🤔</div>
      <p class="text-gray-500 mb-4">练习不存在或无权查看</p>
      <router-link to="/error/list" class="text-blue-600 hover:text-blue-700 font-medium text-sm">← 返回错题本</router-link>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center justify-between mb-6 no-print">
        <button @click="$router.push('/error/list')" class="flex items-center gap-1 text-gray-500 hover:text-blue-600 transition-colors text-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
          返回错题本
        </button>
        <div class="flex items-center gap-2">
          <button v-if="session.status === 'done'" @click="printPaper" class="px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-900 transition-colors text-sm font-medium">🖨️ 打印练习卷</button>
          <button v-if="session.status === 'done' && session.status !== 'completed'" @click="markComplete" class="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium">✅ 我做完了</button>
        </div>
      </div>

      <!-- 头部 -->
      <div class="bg-white rounded-2xl shadow-lg px-6 py-5 mb-5">
        <div class="flex flex-wrap items-center gap-3">
          <span class="px-3 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-semibold">🎯 同类题练习</span>
          <span class="text-gray-800 font-semibold">{{ session.title }}</span>
          <span v-if="session.status === 'generating'" class="px-3 py-1 bg-blue-50 text-blue-600 rounded-full text-xs font-medium">⏳ AI 出题中...</span>
          <span v-else-if="session.status === 'failed'" class="px-3 py-1 bg-red-50 text-red-600 rounded-full text-xs font-medium">生成失败</span>
          <span v-else-if="session.status === 'completed'" class="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-medium">已完成 ✓</span>
        </div>
        <p class="text-sm text-gray-500 mt-2">
          {{ session.mode === 'single' ? '3 道变式题（易/平/难），针对同一考点' : `由 ${session.sourceErrorIds.length} 道错题生成的练习卷` }}
          <span v-if="session.items.length">· 覆盖 {{ knowledgeCount }} 个考点</span>
          <span class="no-print">· 免费（每天 5 次）</span>
        </p>
        <p v-if="session.status === 'generating'" class="text-xs text-blue-500 mt-2 animate-pulse">正在根据错题考点逐题生成，约需 10-60 秒，页面自动刷新...</p>
      </div>

      <!-- 题目列表 -->
      <div class="space-y-4">
        <div v-for="(it, i) in session.items" :key="it.id" class="bg-white rounded-2xl shadow-lg px-6 py-5">
          <div class="flex flex-wrap items-center gap-2 mb-3">
            <span class="w-7 h-7 bg-emerald-600 text-white rounded-lg flex items-center justify-center text-sm font-bold">{{ i + 1 }}</span>
            <span :class="diffClass(it.difficulty)" class="px-2 py-0.5 rounded text-xs font-medium">{{ diffLabel(it.difficulty) }}</span>
            <span v-if="it.knowledgePoint" class="px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-xs">{{ it.knowledgePoint }}</span>
          </div>
          <p class="text-gray-800 leading-relaxed whitespace-pre-wrap">{{ it.questionText }}</p>

          <!-- 屏幕交互: 点击显隐答案 -->
          <div class="no-print mt-4">
            <button v-if="!revealed.has(it.id)" @click="revealed.add(it.id); revealed = new Set(revealed)"
              class="text-sm text-emerald-600 hover:text-emerald-700 font-medium">👁️ 显示答案与解析</button>
            <div v-else class="bg-gray-50 rounded-xl p-4 border border-gray-100 space-y-2">
              <p class="text-sm"><span class="font-semibold text-green-700">✅ 答案：</span><span class="text-gray-800">{{ it.answerText || '--' }}</span></p>
              <p v-if="it.analysis" class="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap"><span class="font-semibold text-gray-700">解析：</span>{{ it.analysis }}</p>
            </div>
          </div>
        </div>
      </div>

      <div v-if="session.status === 'failed'" class="text-center py-8 no-print">
        <p class="text-gray-500 text-sm mb-3">生成失败（AI 服务波动），可返回错题本重试</p>
        <router-link to="/error/list" class="text-blue-600 hover:text-blue-700 text-sm font-medium">← 返回错题本</router-link>
      </div>

      <!-- 打印版: 题目卷 + 答案页（仅打印时可见） -->
      <div id="print-area" class="hidden print:block">
        <h2 class="text-lg font-bold text-center mb-1">{{ session.title }}</h2>
        <p class="text-xs text-gray-500 text-center mb-4">gaozhong.online · 姓名：__________ 日期：____月____日</p>
        <div v-for="(it, i) in session.items" :key="'p'+it.id" class="mb-4">
          <p class="text-sm leading-relaxed whitespace-pre-wrap"><span class="font-semibold">{{ i + 1 }}.</span>（{{ diffLabel(it.difficulty) }}）{{ it.questionText }}</p>
        </div>
        <div class="break-before-page pt-8">
          <h2 class="text-lg font-bold text-center mb-4">参考答案与解析</h2>
          <div v-for="(it, i) in session.items" :key="'a'+it.id" class="mb-3">
            <p class="text-sm"><span class="font-semibold">{{ i + 1 }}.</span> {{ it.answerText }}</p>
            <p v-if="it.analysis" class="text-xs text-gray-600 whitespace-pre-wrap">{{ it.analysis }}</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { authFetch } from '../utils/authStore.js'
import { trackEvent } from '../utils/analytics.js'

const route = useRoute()
const session = ref(null)
const loading = ref(true)
const revealed = ref(new Set())
let pollTimer = null

const knowledgeCount = computed(() => new Set(session.value?.items?.map(i => i.knowledgePoint).filter(Boolean)).size)

function diffLabel(d) {
  return d === 'easy' ? '基础' : d === 'hard' ? '挑战' : '提高'
}
function diffClass(d) {
  return d === 'easy' ? 'bg-green-50 text-green-600' : d === 'hard' ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'
}

async function loadSession() {
  try {
    const res = await authFetch(`/api/practice/${route.params.id}`)
    const data = await res.json()
    if (data.success) session.value = data.session
  } catch (err) { console.error('加载练习失败:', err) }
  finally { loading.value = false }
}

async function markComplete() {
  try {
    await authFetch(`/api/practice/${route.params.id}/complete`, { method: 'POST' })
    trackEvent('practice', 'complete', session.value?.mode)
    await loadSession()
  } catch (e) { console.error('标记完成失败:', e) }
}

function printPaper() {
  trackEvent('practice', 'print', session.value?.mode)
  window.print()
}

onMounted(async () => {
  await loadSession()
  // 生成中每 3 秒轮询，完成即停
  pollTimer = setInterval(async () => {
    if (session.value?.status === 'generating') await loadSession()
    else if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }, 3000)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
</script>
