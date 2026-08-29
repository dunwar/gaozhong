<template>
  <div class="max-w-3xl mx-auto py-6 px-4 print:hidden">
    <!-- 筛选区（打印时隐藏） -->
    <div class="flex items-center justify-between mb-5">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">📄 生成错题卷</h1>
        <p class="text-gray-500 text-sm mt-1">筛选错题 → 打印/存PDF → 考前重做</p>
      </div>
      <router-link to="/error/list" class="text-sm text-gray-400 hover:text-gray-600">← 返回错题本</router-link>
    </div>

    <div class="bg-white rounded-xl border p-4 mb-5 space-y-3">
      <div class="flex flex-wrap gap-3">
        <div>
          <label class="text-xs text-gray-500 block mb-1">科目</label>
          <select v-model="subject" class="px-3 py-2 bg-gray-50 border rounded-lg text-sm">
            <option value="all">全部科目</option>
            <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-500 block mb-1">时间范围</label>
          <div class="flex gap-1">
            <button v-for="r in ranges" :key="r.key" @click="range=r.key; loadData()"
              :class="['px-3 py-2 rounded-lg text-sm', range===r.key ? 'bg-emerald-600 text-white' : 'bg-gray-50 border text-gray-600']">{{ r.label }}</button>
          </div>
        </div>
        <div v-if="range==='custom'" class="flex items-end gap-2">
          <div><label class="text-xs text-gray-500 block mb-1">起</label>
            <input type="date" v-model="dateFrom" @change="loadData" class="px-2 py-2 bg-gray-50 border rounded-lg text-sm" /></div>
          <div><label class="text-xs text-gray-500 block mb-1">止</label>
            <input type="date" v-model="dateTo" @change="loadData" class="px-2 py-2 bg-gray-50 border rounded-lg text-sm" /></div>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-4 pt-2 border-t">
        <label class="flex items-center gap-1.5 text-sm text-gray-600">
          <input type="checkbox" v-model="withAnswers" class="accent-emerald-600" /> 附答案页（做完后再看）
        </label>
        <label class="flex items-center gap-1.5 text-sm text-gray-600">
          <input type="checkbox" v-model="screenshotsFirst" class="accent-emerald-600" /> 优先使用题目截图
        </label>
        <span class="text-xs text-gray-400 ml-auto">共 {{ paperQuestions.length }} 题</span>
      </div>
      <div class="flex gap-2 pt-1">
        <button @click="print" :disabled="paperQuestions.length === 0"
          class="flex-1 py-3 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300 transition-colors">
          🖨️ 打印 / 保存为 PDF（{{ paperQuestions.length }} 题）
        </button>
      </div>
      <p class="text-xs text-gray-400">手机/Pad 上打印时选择"存储为 PDF"即可保存；微信内打开请用右上角菜单在浏览器中打印。</p>
    </div>

    <div v-if="loading" class="text-center py-10 text-gray-400 text-sm">加载中…</div>
    <div v-else-if="paperQuestions.length === 0" class="text-center py-10 bg-white rounded-xl border">
      <p class="text-gray-500">该条件下没有错题</p>
    </div>
  </div>

  <!-- ══ 卷面（屏幕预览 = 打印内容）══ -->
  <div v-if="paperQuestions.length > 0" class="bg-white rounded-xl border p-8 mb-10 print:border-0 print:p-0 print:rounded-none shadow-sm print:shadow-none max-w-3xl mx-auto">
    <!-- 卷头 -->
    <div class="text-center border-b-2 border-gray-800 pb-3 mb-6">
      <h1 class="text-xl font-bold">{{ subject === 'all' ? '' : subject }}错题重做卷</h1>
      <p class="text-xs text-gray-500 mt-1">
        {{ rangeLabel }} · 共 {{ paperQuestions.length }} 题 · 生成于 {{ today }}
      </p>
      <p class="text-xs text-gray-500 mt-2">姓名：____________　　班级：____________　　日期：____________</p>
    </div>

    <!-- 题目区 -->
    <div class="space-y-5">
      <div v-for="(q, i) in paperQuestions" :key="q.id" class="q-item break-inside-avoid">
        <div class="flex gap-2">
          <span class="font-bold text-gray-900 shrink-0">{{ q.questionNumber }}.</span>
          <div class="flex-1 min-w-0">
            <!-- 截图优先 -->
            <img v-if="screenshotsFirst && cropUrl(q) && !q._imgFail" :src="cropUrl(q)" @error="q._imgFail = true"
              class="max-w-full rounded border border-gray-200 mb-1" :alt="'Q'+q.questionNumber" />
            <!-- 文字退化模式 -->
            <template v-if="!screenshotsFirst || !cropUrl(q) || q._imgFail">
              <p v-if="q.passageText" class="text-xs text-gray-500 bg-gray-50 rounded p-2 mb-2 whitespace-pre-wrap">{{ q.passageText.slice(0, 600) }}{{ q.passageText.length > 600 ? '…' : '' }}</p>
              <p class="text-sm text-gray-800 whitespace-pre-wrap">{{ q.questionText || '(见原图)' }}</p>
              <div v-if="parsedOptions(q).length" class="mt-1 grid grid-cols-2 gap-x-4 text-sm text-gray-700">
                <span v-for="opt in parsedOptions(q)" :key="opt">{{ opt }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 答案页 -->
    <div v-if="withAnswers" class="answer-page">
      <div class="text-center border-b-2 border-gray-800 pb-2 mb-4 mt-8 pt-4">
        <h2 class="text-lg font-bold">参考答案（做完后再看）</h2>
      </div>
      <div class="grid grid-cols-5 gap-y-1 text-sm">
        <span v-for="q in paperQuestions" :key="'a'+q.id" class="border-b border-gray-100 pb-1">
          {{ q.questionNumber }}. <b>{{ q.correctAnswer || '?' }}</b><span v-if="q.wrongAnswer" class="text-gray-400 text-xs">（原选{{ q.wrongAnswer }}）</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { authFetch } from '../utils/authStore.js'

const subjects = ['英语', '数学', '语文', '物理', '化学', '生物']
const ranges = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' },
]
const subject = ref('all')
const range = ref('month')
const dateFrom = ref('')
const dateTo = ref('')
const withAnswers = ref(true)
const screenshotsFirst = ref(true)
const records = ref([])
const loading = ref(true)

const today = new Date().toLocaleDateString('zh-CN')
const rangeLabel = computed(() => {
  if (range.value === 'week') return '本周错题'
  if (range.value === 'month') return '本月错题'
  if (range.value === 'all') return '全部错题'
  return `${dateFrom.value || '…'} ~ ${dateTo.value || '…'}`
})

const paperQuestions = computed(() => records.value.filter(q => q.questionNumber))

function timeRange() {
  const now = new Date()
  if (range.value === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay() + 1); d.setHours(0, 0, 0, 0)  // 周一
    return { from: d.getTime(), to: null }
  }
  if (range.value === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1)
    return { from: d.getTime(), to: null }
  }
  if (range.value === 'custom') {
    const from = dateFrom.value ? new Date(dateFrom.value + 'T00:00:00').getTime() : null
    const to = dateTo.value ? new Date(dateTo.value + 'T23:59:59').getTime() : null
    return { from, to }
  }
  return { from: null, to: null }
}

async function loadData() {
  loading.value = true
  try {
    const params = new URLSearchParams({ view: 'list', limit: '200' })
    if (subject.value !== 'all') params.set('subject', subject.value)
    const { from, to } = timeRange()
    if (from) params.set('timeFrom', String(from))
    if (to) params.set('timeTo', String(to))
    const res = await authFetch(`/api/error/list?${params}`)
    const data = await res.json()
    records.value = data.records || []
    records.value.sort((a, b) => (a.questionNumber || 0) - (b.questionNumber || 0))
  } catch (e) {
    console.error('加载错题失败:', e)
  } finally {
    loading.value = false
  }
}

function cropUrl(q) {
  if (!q?.sessionId || !q.questionNumber) return null
  let pageNum = q.paperIndex || 0
  try {
    const raw = q.aiRaw ? JSON.parse(q.aiRaw) : null
    if (raw?.pageIndex) pageNum = raw.pageIndex
  } catch {}
  if (!pageNum) return null
  return `/api/paper/${q.sessionId}/region/p${pageNum}_q${q.questionNumber}.jpg`
}

function parsedOptions(q) {
  if (!q?.answerOptions) return []
  try {
    const p = typeof q.answerOptions === 'string' ? JSON.parse(q.answerOptions) : q.answerOptions
    if (Array.isArray(p)) return p.map((v, i) => `${String.fromCharCode(65 + i)}. ${v}`)
    return Object.entries(p).map(([k, v]) => `${k}. ${v}`)
  } catch { return [] }
}

function print() { window.print() }

onMounted(loadData)
</script>

<style scoped>
@media print {
  .q-item { break-inside: avoid; page-break-inside: avoid; }
  .answer-page { page-break-before: always; }
  @page { size: A4; margin: 14mm; }
}
</style>
