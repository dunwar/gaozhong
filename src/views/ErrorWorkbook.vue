<template>
  <div class="max-w-5xl mx-auto py-8 px-4">
    <h1 class="text-2xl font-bold text-gray-900 mb-2">📔 错题本</h1>
    <p class="text-gray-500 mb-6">按试卷、时间或科目查看已整理的错题</p>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-3 gap-4 mb-6" v-if="stats">
      <div class="bg-white rounded-xl p-4 border text-center">
        <p class="text-3xl font-bold text-blue-600">{{ stats.total || 0 }}</p>
        <p class="text-sm text-gray-500">总错题数</p>
      </div>
      <div class="bg-white rounded-xl p-4 border text-center">
        <p class="text-3xl font-bold text-green-600">{{ stats.todayCount || 0 }}</p>
        <p class="text-sm text-gray-500">今日新增</p>
      </div>
      <div class="bg-white rounded-xl p-4 border text-center">
        <p class="text-3xl font-bold text-purple-600">{{ Object.keys(stats.bySubject || {}).length || 0 }}</p>
        <p class="text-sm text-gray-500">知识点</p>
      </div>
    </div>

    <!-- 分组切换 -->
    <div class="flex gap-2 mb-4 flex-wrap">
      <button
        v-for="v in views"
        :key="v.key"
        @click="view = v.key; page = 1"
        :class="['px-4 py-2 rounded-lg text-sm font-medium transition-colors', view === v.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border hover:border-blue-300']"
      >{{ v.label }}</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      <svg class="animate-spin w-8 h-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      加载中…
    </div>

    <!-- 空状态 -->
    <div v-else-if="isEmpty" class="text-center py-12 bg-white rounded-xl border">
      <p class="text-4xl mb-2">📭</p>
      <p class="text-gray-500">还没有错题记录</p>
      <router-link to="/paper/upload" class="inline-block mt-3 text-blue-600 hover:underline text-sm">去上传试卷 →</router-link>
    </div>

    <!-- 按试卷视图 -->
    <template v-else-if="view === 'paper'">
      <div v-for="group in groupedItems" :key="group.key" class="bg-white rounded-xl border mb-3 overflow-hidden">
        <div
          class="px-5 py-3 bg-gray-50 border-b flex items-center justify-between cursor-pointer hover:bg-gray-100 transition-colors"
          @click="$router.push(`/paper/${group.key}/errors`)"
        >
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            <span class="font-medium text-gray-900">{{ group.title }}</span>
            <span class="text-xs text-gray-500">{{ group.subject }}</span>
            <span class="text-xs text-gray-400">{{ group.date }}</span>
          </div>
          <span class="text-sm text-red-500 font-medium">{{ group.errorCount }} 道错题</span>
        </div>
      </div>
    </template>

    <!-- 按时间视图 -->
    <template v-else-if="view === 'time'">
      <div class="bg-white rounded-xl border overflow-hidden">
        <div
          v-for="t in timeGroups" :key="t.timeLabel"
          class="px-5 py-4 border-b last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
          :class="{ 'bg-blue-50': expandedId === t.timeLabel }"
          @click="drillTime(t)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-gray-400 transition-transform" :class="{ 'rotate-90': expandedId === t.timeLabel }" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
              <span class="font-medium text-gray-900">{{ t.timeLabel }}</span>
            </div>
            <div class="flex gap-4 text-sm">
              <span class="text-red-500">{{ t.errorCount }} 道错题</span>
              <span class="text-gray-400">{{ t.paperCount }} 张试卷</span>
              <span class="text-gray-400">{{ t.subjectCount }} 个科目</span>
            </div>
          </div>
          <!-- 展开的错题列表 -->
          <div v-if="expandedId === t.timeLabel" class="mt-3 border-t pt-3">
            <div v-if="drillLoading" class="py-4 text-center text-gray-400 text-sm">加载中…</div>
            <div v-else class="divide-y -mx-5">
              <div v-for="err in drillItems" :key="err.id" class="px-5 py-3 hover:bg-white cursor-pointer" @click.stop="selectedError = err">
                <div class="flex items-start gap-3">
                  <span class="text-xs font-bold text-gray-400 min-w-[40px] pt-1">Q{{ err.questionNumber || err.topic?.replace('错题 ','') }}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-800">{{ err.questionText || err.topic || '' }}</p>
                    <div class="flex gap-2 mt-1 flex-wrap text-xs">
                      <span class="bg-red-100 text-red-700 px-1.5 rounded">{{ err.wrongAnswer || err.studentAnswer }} → {{ err.correctAnswer || err.correct_answer }}</span>
                      <span v-if="err.errorType || err.error_type" class="bg-gray-100 text-gray-600 px-1.5 rounded">{{ err.errorType || err.error_type }}</span>
                      <span class="text-gray-400">{{ err.subject }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 按科目视图 -->
    <template v-else-if="view === 'subject'">
      <div class="bg-white rounded-xl border overflow-hidden">
        <div
          v-for="s in subjectGroups" :key="s.subject"
          class="px-5 py-4 border-b last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
          :class="{ 'bg-blue-50': expandedId === s.subject }"
          @click="drillSubject(s)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-gray-400 transition-transform" :class="{ 'rotate-90': expandedId === s.subject }" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
              <span class="font-medium text-gray-900">{{ s.subject }}</span>
            </div>
            <div class="flex gap-4 text-sm">
              <span class="text-red-500">{{ s.errorCount }} 道错题</span>
              <span class="text-gray-400">{{ s.paperCount }} 张试卷</span>
            </div>
          </div>
          <!-- 展开的错题列表 -->
          <div v-if="expandedId === s.subject" class="mt-3 border-t pt-3">
            <div v-if="drillLoading" class="py-4 text-center text-gray-400 text-sm">加载中…</div>
            <div v-else class="divide-y -mx-5">
              <div v-for="err in drillItems" :key="err.id" class="px-5 py-3 hover:bg-white cursor-pointer" @click.stop="selectedError = err">
                <div class="flex items-start gap-3">
                  <span class="text-xs font-bold text-gray-400 min-w-[40px] pt-1">Q{{ err.questionNumber || err.topic?.replace('错题 ','') }}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-800">{{ err.questionText || err.topic || '' }}</p>
                    <div class="flex gap-2 mt-1 flex-wrap text-xs">
                      <span class="bg-red-100 text-red-700 px-1.5 rounded">{{ err.wrongAnswer || err.studentAnswer }} → {{ err.correctAnswer || err.correct_answer }}</span>
                      <span v-if="err.errorType || err.error_type" class="bg-gray-100 text-gray-600 px-1.5 rounded">{{ err.errorType || err.error_type }}</span>
                      <span class="text-gray-400">{{ err.subject }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 列表视图 -->
    <template v-else>
      <div class="bg-white rounded-xl border overflow-hidden">
        <div class="divide-y">
          <div v-for="err in items" :key="err.id" class="px-5 py-3 hover:bg-gray-50 cursor-pointer" @click="$router.push(`/paper/${err.sessionId || err.session_id}/errors`)">
            <div class="flex items-start gap-3">
              <span class="text-xs font-bold text-gray-400 min-w-[40px] pt-1">Q{{ err.questionNumber || err.id?.slice(0,6) }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-800">{{ err.questionText || err.topic || '题目内容' }}</p>
                <div class="flex gap-2 mt-1 flex-wrap text-xs">
                  <span class="bg-red-100 text-red-700 px-1.5 rounded">{{ err.studentAnswer || err.wrong_answer }} → {{ err.correctAnswer || err.correct_answer }}</span>
                  <span v-if="err.errorType || err.error_type" class="bg-gray-100 text-gray-600 px-1.5 rounded">{{ err.errorType || err.error_type }}</span>
                  <span class="text-gray-400">{{ err.subject || err.error_subject }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex justify-center gap-2 mt-4">
        <button @click="page--" :disabled="page <= 1" class="px-3 py-1.5 border rounded text-sm disabled:opacity-30">上一页</button>
        <span class="px-3 py-1.5 text-sm text-gray-500">{{ page }} / {{ totalPages }}</span>
        <button @click="page++" :disabled="page >= totalPages" class="px-3 py-1.5 border rounded text-sm disabled:opacity-30">下一页</button>
      </div>
    </template>

    <!-- 错题详情弹窗（仅用于时间/科目视图下钻） -->
    <div v-if="selectedError && (view === 'time' || view === 'subject')" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="selectedError = null">
      <div class="bg-white rounded-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6">
        <div class="flex items-start justify-between mb-4">
          <h3 class="font-bold text-lg">错题详情</h3>
          <button @click="selectedError = null" class="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        <div class="space-y-3 text-sm">
          <div><span class="text-gray-500">题号：</span>{{ selectedError.questionNumber || '-' }}</div>
          <div><span class="text-gray-500">题目：</span>{{ selectedError.questionText || selectedError.topic || '-' }}</div>
          <div><span class="text-gray-500">学生答案：</span><span class="text-red-600 font-medium">{{ selectedError.studentAnswer || selectedError.wrong_answer || selectedError.wrongAnswer || '-' }}</span></div>
          <div><span class="text-gray-500">正确答案：</span><span class="text-green-600 font-medium">{{ selectedError.correctAnswer || selectedError.correct_answer || '-' }}</span></div>
          <div><span class="text-gray-500">错误类型：</span>{{ selectedError.errorType || selectedError.error_type || '未知' }}</div>
          <div v-if="selectedError.error_analysis || selectedError.correctSolution || selectedError.correct_solution">
            <span class="text-gray-500">解析：</span>
            <p class="mt-1 text-gray-700">{{ selectedError.error_analysis || selectedError.correctSolution || selectedError.correct_solution }}</p>
          </div>
          <div v-if="selectedError.answerOptions || selectedError.options">
            <span class="text-gray-500">选项：</span>
            <div class="mt-1 space-y-1">
              <div v-for="(v, k) in (selectedError.answerOptions || selectedError.options || {})" :key="k" class="text-gray-700">
                <span class="font-medium">{{ k }}.</span> {{ v }}
              </div>
            </div>
          </div>
        </div>
        <div class="mt-4 pt-4 border-t">
          <router-link :to="`/paper/${selectedError.sessionId || selectedError.session_id}/errors`" class="text-blue-600 hover:text-blue-700 text-sm font-medium">查看整卷错题 →</router-link>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { authStore } from '../utils/authStore.js'

const views = [
  { key: 'paper', label: '📄 按试卷' },
  { key: 'time', label: '🕐 按时间' },
  { key: 'subject', label: '📚 按科目' },
  { key: 'list', label: '📋 列表' },
]
const view = ref('paper')
const page = ref(1)
const items = ref([])
const paperResults = ref({ papers: [], total: 0 })
const timeResults = ref([])
const subjectResults = ref([])
const stats = ref(null)
const selectedError = ref(null)
const loading = ref(true)
const expandedId = ref(null)
const drillItems = ref([])
const drillLoading = ref(false)

const isEmpty = computed(() => {
  if (view.value === 'paper') return !paperResults.value.papers || paperResults.value.papers.length === 0
  if (view.value === 'time') return timeResults.value.length === 0
  if (view.value === 'subject') return subjectResults.value.length === 0
  return items.value.length === 0
})

const pageSize = 20
const totalPages = computed(() => Math.max(1, Math.ceil(items.value.length / pageSize)))

// Group by paper session (for paper view)
const groupedItems = computed(() => {
  if (view.value === 'paper') {
    // API returns { papers: [{ id, subject, title, error_count, status, created_at }], total }
    return (paperResults.value.papers || []).map(p => ({
      key: p.id,
      title: p.title || p.id?.slice(0,8) || '未知试卷',
      subject: p.subject || '',
      date: p.created_at ? new Date(p.created_at).toLocaleDateString('zh-CN') : '',
      errors: [], // paper view shows summaries, not individual errors
      errorCount: p.error_count || 0
    }))
  }
  // Legacy: group items by sessionId
  const groups = {}
  for (const item of items.value) {
    const key = item.sessionId || item.session_id || item.paper_title || item.source || '未知试卷'
    if (!groups[key]) groups[key] = { key, title: key, subject: item.subject || '', date: item.created_at?.slice(0,10) || '', errors: [] }
    groups[key].errors.push(item)
  }
  return Object.values(groups)
})

// Time view: API returns { results: [{ timeLabel, errorCount, subjectCount, paperCount }] }
const timeGroups = computed(() => timeResults.value)

// Subject view: API returns { results: [{ subject, errorCount, paperCount, errorTypes }] }
const subjectGroups = computed(() => subjectResults.value)

async function fetchData() {
  loading.value = true
  try {
    const sr = await fetch('/api/error/stats', { headers: { 'Authorization': `Bearer ${authStore.token}` } })
    stats.value = await sr.json()

    const params = new URLSearchParams({ view: view.value })
    const lr = await fetch(`/api/error/list?${params}`, { headers: { 'Authorization': `Bearer ${authStore.token}` } })
    const listData = await lr.json()

    if (view.value === 'paper') {
      paperResults.value = listData
      items.value = []
    } else if (view.value === 'time') {
      timeResults.value = listData.results || []
      items.value = []
    } else if (view.value === 'subject') {
      subjectResults.value = listData.results || []
      items.value = []
    } else {
      // list view
      items.value = listData.records || listData.errors || listData.items || []
      paperResults.value = { papers: [], total: 0 }
      timeResults.value = []
      subjectResults.value = []
    }
  } catch (e) {
    console.error('Failed to fetch errors:', e)
    items.value = []
  } finally {
    loading.value = false
  }
}

watch(view, () => { expandedId.value = null; page.value = 1; fetchData() })
onMounted(fetchData)

async function drillTime(t) {
  if (expandedId.value === t.timeLabel) { expandedId.value = null; return }
  expandedId.value = t.timeLabel
  drillLoading.value = true
  drillItems.value = []
  try {
    const params = new URLSearchParams({ view: 'list' })
    if (t.startTs) params.set('timeFrom', String(t.startTs))
    if (t.endTs) params.set('timeTo', String(t.endTs))
    const r = await fetch(`/api/error/list?${params}`, {
      headers: { 'Authorization': `Bearer ${authStore.token}` }
    })
    const data = await r.json()
    drillItems.value = data.records || data.errors || data.items || []
  } catch (e) { console.error(e) }
  finally { drillLoading.value = false }
}

async function drillSubject(s) {
  if (expandedId.value === s.subject) { expandedId.value = null; return }
  expandedId.value = s.subject
  drillLoading.value = true
  drillItems.value = []
  try {
    const params = new URLSearchParams({ view: 'list', subject: s.subject })
    const r = await fetch(`/api/error/list?${params}`, {
      headers: { 'Authorization': `Bearer ${authStore.token}` }
    })
    const data = await r.json()
    drillItems.value = data.records || data.errors || data.items || []
  } catch (e) { console.error(e) }
  finally { drillLoading.value = false }
}
</script>
