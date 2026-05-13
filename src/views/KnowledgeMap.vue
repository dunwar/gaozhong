<template>
  <div class="max-w-5xl mx-auto py-6 md:py-10 px-4">
    <h1 class="text-2xl font-bold text-gray-900 mb-1">🧠 知识点</h1>
    <p class="text-gray-500 text-sm mb-6">按科目查看薄弱知识点，针对性查漏补缺</p>

    <!-- 搜索 -->
    <div class="mb-6">
      <div class="flex gap-2">
        <input
          v-model="searchQuery"
          @keyup.enter="doSearch"
          placeholder="搜索知识点，如：定语从句、非谓语…"
          class="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
        <button @click="doSearch" class="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">搜索</button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      <svg class="animate-spin w-8 h-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      加载中…
    </div>

    <!-- 搜索结果 -->
    <div v-else-if="searchResults.length > 0">
      <div class="flex items-center gap-2 mb-4">
        <button @click="searchResults = []; searchQuery = ''" class="text-sm text-blue-600 hover:underline">← 返回全部</button>
        <span class="text-sm text-gray-400">搜索结果（{{ searchResults.length }}）</span>
      </div>
      <div class="bg-white rounded-xl border overflow-hidden">
        <div
          v-for="kp in searchResults" :key="kp.id || kp.name"
          class="px-5 py-4 border-b last:border-0 hover:bg-gray-50 cursor-pointer"
          :class="{ 'bg-blue-50': expandedId === kp.id }"
          @click="drillKp(kp)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-gray-400 transition-transform" :class="{ 'rotate-90': expandedId === kp.id }" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
              <span class="font-medium text-gray-900">{{ kp.name || kp.topic }}</span>
              <span class="text-xs bg-gray-100 text-gray-500 px-1.5 rounded">{{ kp.subject }}</span>
            </div>
            <span class="text-sm text-red-500 font-medium">{{ kp.errorCount || 0 }} 次</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="allKPs.length === 0 && !searchQuery" class="text-center py-12 bg-white rounded-xl border">
      <p class="text-4xl mb-2">📚</p>
      <p class="text-gray-500">还没有知识点数据</p>
      <p class="text-gray-400 text-sm mt-1">上传试卷并完成错题分析后，知识点会自动汇总</p>
      <router-link to="/paper/upload" class="inline-block mt-3 text-blue-600 hover:underline text-sm">去上传试卷 →</router-link>
    </div>

    <!-- 按科目分组展示 -->
    <div v-else v-for="subj in subjects" :key="subj.name" class="mb-6">
      <div class="flex items-center gap-2 mb-3">
        <h3 class="text-base font-semibold text-gray-800">{{ subj.name }}</h3>
        <span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{{ subj.kps.length }} 个知识点 · {{ subj.totalErrors }} 次错误</span>
      </div>

      <div class="bg-white rounded-xl border overflow-hidden">
        <div v-if="subj.kps.length === 0" class="px-5 py-6 text-gray-400 text-sm text-center">暂无</div>
        <div
          v-for="kp in subj.kps" :key="kp.id"
          class="px-5 py-3.5 border-b last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
          :class="{ 'bg-blue-50 border-blue-200': expandedId === kp.id }"
          @click="drillKp(kp)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 min-w-0">
              <svg class="w-4 h-4 text-gray-400 flex-shrink-0 transition-transform" :class="{ 'rotate-90': expandedId === kp.id }" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
              <span class="font-medium text-gray-900 text-sm truncate">{{ kp.name }}</span>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <!-- Error count bar -->
              <div class="hidden sm:flex items-center gap-1.5">
                <div class="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div class="h-full bg-red-400 rounded-full" :style="{ width: Math.min(100, (kp.errorCount / maxErrors * 100)) + '%' }"></div>
                </div>
              </div>
              <span class="text-sm font-medium" :class="kp.errorCount >= 3 ? 'text-red-600' : 'text-gray-500'">{{ kp.errorCount }} 次</span>
            </div>
          </div>

          <!-- 展开：关联错题 -->
          <div v-if="expandedId === kp.id" class="mt-3 border-t pt-3">
            <div v-if="drillLoading" class="py-4 text-center text-gray-400 text-sm">加载中…</div>
            <div v-else-if="drillItems.length === 0" class="py-4 text-gray-400 text-sm text-center">暂无关联错题</div>
            <div v-else class="divide-y -mx-5">
              <div v-for="err in drillItems" :key="err.id" class="px-5 py-3 hover:bg-white cursor-pointer" @click.stop="selectedError = err">
                <div class="flex items-start gap-3">
                  <span class="text-xs font-bold text-gray-400 min-w-[40px] pt-1">Q{{ err.questionNumber || err.topic?.replace('错题 ','') }}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-800">{{ err.questionText || err.topic || '' }}</p>
                    <div class="flex gap-2 mt-1 flex-wrap text-xs">
                      <span class="bg-red-100 text-red-700 px-1.5 rounded">{{ err.wrongAnswer || err.studentAnswer }} → {{ err.correctAnswer || err.correct_answer }}</span>
                      <span v-if="err.errorType || err.error_type" class="bg-gray-100 text-gray-600 px-1.5 rounded">{{ err.errorType || err.error_type }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 错题详情弹窗 -->
    <div v-if="selectedError" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="selectedError = null">
      <div class="bg-white rounded-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6">
        <div class="flex items-start justify-between mb-4">
          <h3 class="font-bold text-lg">错题详情</h3>
          <button @click="selectedError = null" class="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        <div class="space-y-3 text-sm">
          <div><span class="text-gray-500">题号：</span>{{ selectedError.questionNumber || '-' }}</div>
          <div><span class="text-gray-500">题目：</span>{{ selectedError.questionText || selectedError.topic || '-' }}</div>
          <div><span class="text-gray-500">学生答案：</span><span class="text-red-600 font-medium">{{ selectedError.wrongAnswer || selectedError.studentAnswer || '-' }}</span></div>
          <div><span class="text-gray-500">正确答案：</span><span class="text-green-600 font-medium">{{ selectedError.correctAnswer || selectedError.correct_answer || '-' }}</span></div>
          <div><span class="text-gray-500">错误类型：</span>{{ selectedError.errorType || selectedError.error_type || '未知' }}</div>
          <div v-if="selectedError.correctSolution || selectedError.correct_solution">
            <span class="text-gray-500">解析：</span>
            <p class="mt-1 text-gray-700 whitespace-pre-wrap text-xs">{{ selectedError.correctSolution || selectedError.correct_solution }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { authStore } from '../utils/authStore.js'

const searchQuery = ref('')
const searchResults = ref([])
const allKPs = ref([])
const loading = ref(true)
const expandedId = ref(null)
const drillItems = ref([])
const drillLoading = ref(false)
const selectedError = ref(null)

// Group KPs by subject, sorted by error count
const subjects = computed(() => {
  const map = {}
  for (const kp of allKPs.value) {
    const subj = kp.subject || '未知'
    if (!map[subj]) map[subj] = { name: subj, kps: [], totalErrors: 0 }
    map[subj].kps.push(kp)
    map[subj].totalErrors += kp.errorCount || 0
  }
  // Sort KPs within each subject by error count desc
  for (const s of Object.values(map)) {
    s.kps.sort((a, b) => (b.errorCount || 0) - (a.errorCount || 0))
  }
  // Sort subjects by total errors desc
  return Object.values(map).sort((a, b) => b.totalErrors - a.totalErrors)
})

const maxErrors = computed(() => {
  let max = 1
  for (const kp of allKPs.value) { if (kp.errorCount > max) max = kp.errorCount }
  return max
})

async function doSearch() {
  if (!searchQuery.value.trim()) return
  try {
    const r = await fetch(`/api/knowledge/search?q=${encodeURIComponent(searchQuery.value)}`, {
      headers: { 'Authorization': `Bearer ${authStore.token}` }
    })
    const data = await r.json()
    searchResults.value = data.results || data.stats || []
  } catch (e) { console.error(e) }
}

async function drillKp(kp) {
  if (expandedId.value === kp.id) { expandedId.value = null; return }
  expandedId.value = kp.id
  drillLoading.value = true
  drillItems.value = []
  try {
    // Search for errors by knowledge point name
    const r = await fetch(`/api/knowledge/errors?kpId=${encodeURIComponent(kp.id)}`, {
      headers: { 'Authorization': `Bearer ${authStore.token}` }
    })
    const data = await r.json()
    drillItems.value = data.errors || data.records || data.results || []
  } catch (e) { console.error(e) }
  finally { drillLoading.value = false }
}

onMounted(async () => {
  try {
    // Fetch tagged knowledge points
    const kpR = await fetch('/api/knowledge/stats', { headers: { 'Authorization': `Bearer ${authStore.token}` } })
    const kpData = await kpR.json()
    const taggedKPs = kpData.stats || kpData.results || []

    // Fetch error stats as fallback (byErrorType)
    const errR = await fetch('/api/error/stats', { headers: { 'Authorization': `Bearer ${authStore.token}` } })
    const errData = await errR.json()

    if (taggedKPs.length >= 5) {
      // Use tagged KPs directly
      allKPs.value = taggedKPs
    } else {
      // Merge tagged KPs + error types from stats
      const kpMap = {}
      // Start with tagged KPs
      for (const kp of taggedKPs) {
        kpMap[kp.name] = { ...kp, source: 'tagged' }
      }
      // Add error types from stats
      const bySubject = errData.bySubject || {}
      const byErrorType = errData.byErrorType || {}
      for (const [typeName, count] of Object.entries(byErrorType)) {
        if (typeName === '未知' || count < 1) continue
        if (kpMap[typeName]) {
          kpMap[typeName].errorCount = Math.max(kpMap[typeName].errorCount, count)
        } else {
          // Try to infer subject from context
          const id = 'et_' + typeName.replace(/\s+/g, '_').substring(0, 40)
          kpMap[typeName] = {
            id, name: typeName, errorCount: count, source: 'errorType',
            subject: Object.keys(bySubject)[0] || '未知'
          }
        }
      }
      allKPs.value = Object.values(kpMap).sort((a, b) => (b.errorCount || 0) - (a.errorCount || 0))
    }
  } catch (e) {
    console.error('Stats failed:', e)
  } finally {
    loading.value = false
  }
})
</script>
