<template>
  <div class="max-w-4xl mx-auto py-6 md:py-10 px-4">
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 mb-1">✅ 确认错题</h1>
        <p class="text-gray-500 text-sm">快速扫一眼黄灯题，绿灯题已自动确认。</p>
      </div>
      <router-link :to="`/review/${sessionId}`" class="text-sm text-gray-400 hover:text-gray-600">跳过确认 →</router-link>
    </div>

    <!-- A4: 低质页提示 + 快捷补题 -->
    <div v-if="lowQualityPages.length > 0" class="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
      <p class="text-sm text-amber-800 font-medium">⚠️ 第 {{ lowQualityPages.join('、') }} 页识别质量较低（已用备用引擎）</p>
      <p class="text-xs text-amber-700 mt-1">这些页可能漏题——对照原图，在下方"手动添加"里补上漏掉的题号即可。</p>
    </div>

    <!-- Stats bar -->
    <div class="grid grid-cols-3 gap-3 mb-6">
      <div class="bg-white rounded-xl border p-3 text-center">
        <p class="text-2xl font-bold text-emerald-600">{{ greenQuestions.length }}</p>
        <p class="text-xs text-gray-500">绿灯·自动确认</p>
      </div>
      <div class="bg-white rounded-xl border p-3 text-center">
        <p class="text-2xl font-bold text-amber-500">{{ yellowHandled }}/{{ yellowQuestions.length }}</p>
        <p class="text-xs text-gray-500">黄灯·需你确认</p>
      </div>
      <div class="bg-white rounded-xl border p-3 text-center">
        <p class="text-2xl font-bold text-gray-400">{{ grayQuestions.length }}</p>
        <p class="text-xs text-gray-500">灰灯·低置信</p>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400">
      <svg class="animate-spin w-8 h-8 mx-auto mb-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      加载中…
    </div>

    <template v-else>
      <!-- A2: 黄灯卡片流（主交互） -->
      <div v-if="currentYellow" class="mb-8">
        <div class="flex items-center justify-between mb-2 px-1">
          <span class="text-sm font-medium text-gray-700">这张是错题吗？</span>
          <span class="text-xs text-gray-400">{{ yellowIdx + 1 }} / {{ yellowQuestions.length }} · 左滑没错 / 右滑是错题</span>
        </div>
        <div
          class="bg-white rounded-2xl border-2 border-amber-200 shadow-sm overflow-hidden select-none"
          @touchstart="swipeStart" @touchend="swipeEnd"
        >
          <img v-if="cropUrl(currentYellow) && !currentYellow._imgFail" :src="cropUrl(currentYellow)" @error="currentYellow._imgFail = true"
            class="w-full max-h-72 object-contain bg-gray-50" alt="题目原图" />
          <div class="p-5">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-lg font-bold text-gray-900">Q{{ currentYellow.questionNumber }}</span>
              <span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">系统判定: 错题</span>
              <span class="text-xs text-gray-400">第{{ currentYellow.paperIndex || '?' }}页</span>
            </div>
            <p class="text-sm text-gray-700 line-clamp-3">{{ currentYellow.questionText }}</p>
            <p class="text-xs text-gray-400 mt-2">判定依据: {{ currentYellow.judgeReason || '红笔批改检测' }}</p>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3 mt-4">
          <button @click="judgeYellow(false)" class="py-4 bg-gray-100 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-200 active:scale-95 transition-all">❌ 没错</button>
          <button @click="skipYellow" class="py-4 bg-white border text-gray-400 rounded-xl text-sm hover:bg-gray-50 active:scale-95 transition-all">跳过</button>
          <button @click="judgeYellow(true)" class="py-4 bg-rose-500 text-white rounded-xl text-sm font-medium hover:bg-rose-600 active:scale-95 transition-all">✅ 是错题</button>
        </div>
      </div>
      <div v-else-if="yellowQuestions.length > 0" class="mb-8 bg-emerald-50 border border-emerald-200 rounded-xl p-5 text-center">
        <p class="text-emerald-700 font-medium">🎉 黄灯题全部过完！</p>
        <p class="text-xs text-emerald-600 mt-1">确认 {{ yellowQuestions.filter(q=>q.confirmed).length }} 题 · 排除 {{ yellowQuestions.filter(q=>q.removed).length }} 题 · 跳过 {{ yellowQuestions.filter(q=>!q.confirmed && !q.removed).length }} 题</p>
      </div>

      <!-- A3: 绿灯折叠区 -->
      <div v-if="greenQuestions.length > 0" class="mb-6 bg-white rounded-xl border border-emerald-100 overflow-hidden">
        <button @click="greenExpanded = !greenExpanded" class="w-full flex items-center justify-between px-5 py-4 hover:bg-emerald-50/40 transition-colors">
          <span class="text-sm font-medium text-emerald-700">✅ {{ greenQuestions.filter(q=>q.confirmed).length }} 题高置信已自动确认（学生答案 ≠ 红笔正确答案）</span>
          <span class="text-xs text-gray-400">{{ greenExpanded ? '收起 ▲' : '查看 ▼' }}</span>
        </button>
        <div v-if="greenExpanded" class="divide-y border-t border-emerald-50">
          <div v-for="q in greenQuestions" :key="q.id" class="flex items-center gap-3 px-5 py-3">
            <span class="text-sm font-semibold text-gray-800 w-12">Q{{ q.questionNumber }}</span>
            <p class="flex-1 text-xs text-gray-500 line-clamp-1">{{ q.questionText }}</p>
            <span v-if="q.wrongAnswer || q.correctAnswer" class="text-xs text-gray-400 whitespace-nowrap">{{ q.wrongAnswer || '?' }} → {{ q.correctAnswer || '?' }}</span>
            <button v-if="q.confirmed" @click="q.confirmed = false; q.removed = true" class="text-xs text-gray-400 hover:text-rose-500">这不是错题</button>
            <button v-else @click="q.removed = false; q.confirmed = true" class="text-xs text-gray-400 hover:text-emerald-600">恢复确认</button>
          </div>
        </div>
      </div>

      <!-- 灰灯：低置信列表 -->
      <div v-if="grayQuestions.length > 0" class="mb-6 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div class="px-5 py-3 bg-gray-50 border-b flex items-center justify-between">
          <span class="text-sm font-medium text-gray-600">⚪ 低置信题（识别有难度，请重点核对）</span>
        </div>
        <div class="divide-y">
          <div v-for="q in grayQuestions" :key="q.id" class="flex items-center gap-3 px-5 py-3">
            <span class="text-sm font-semibold text-gray-800 w-12">Q{{ q.questionNumber || '?' }}</span>
            <p class="flex-1 text-xs text-gray-500 line-clamp-1">{{ q.questionText || '(低质页题目)' }}</p>
            <div class="flex gap-1">
              <button v-if="!q.confirmed && !q.removed" @click="q.confirmed = true" class="px-2.5 py-1 bg-rose-50 text-rose-600 rounded-lg text-xs">是错题</button>
              <button v-if="!q.confirmed && !q.removed" @click="q.removed = true" class="px-2.5 py-1 bg-gray-50 text-gray-500 rounded-lg text-xs">没错</button>
              <button v-if="q.confirmed || q.removed" @click="q.confirmed = false; q.removed = false" class="px-2.5 py-1 text-gray-400 text-xs">撤销</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="questions.length === 0 && addedQuestions.length === 0" class="text-center py-12 text-gray-400">
        <p class="text-lg mb-2">🎉 未检测到错题</p>
        <p class="text-sm">该试卷可能没有需要整理的错题，或直接在下方添加</p>
      </div>

      <!-- Add question manually -->
      <div class="mt-6 bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">➕ 手动添加遗漏的错题</h3>
        <div class="flex gap-2">
          <input v-model="addQnum" type="number" placeholder="输入题号（如 21）"
            class="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
            @keyup.enter="addQuestion" />
          <button @click="addQuestion" :disabled="!addQnum"
            class="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300 transition-colors">添加</button>
        </div>
        <div v-if="addedQuestions.length > 0" class="mt-3 space-y-1">
          <div v-for="aq in addedQuestions" :key="'added-' + aq.questionNumber" class="flex items-center justify-between px-3 py-2 bg-emerald-50 rounded-lg">
            <span class="text-sm text-emerald-800">Q{{ aq.questionNumber }}（手动添加）</span>
            <button @click="addedQuestions = addedQuestions.filter(x => x !== aq)" class="text-red-500 text-xs hover:text-red-700">删除</button>
          </div>
        </div>
      </div>

      <!-- Submit -->
      <div class="mt-8 flex justify-end gap-3">
        <router-link :to="`/review/${sessionId}`" class="px-6 py-3 bg-gray-100 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-200 transition-colors">稍后处理</router-link>
        <button @click="submitConfirmation" :disabled="submitting"
          class="px-6 py-3 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 shadow-sm disabled:bg-gray-300 transition-colors flex items-center gap-2">
          <span v-if="submitting" class="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
          {{ submitting ? '保存中…' : '✅ 确认并保存错题本' }}
        </button>
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
const sessionId = route.params.sessionId

const questions = ref([])
const addedQuestions = ref([])
const loading = ref(true)
const submitting = ref(false)
const addQnum = ref('')
const lowQualityPages = ref([])
const greenExpanded = ref(false)
const yellowIdx = ref(0)
let touchStartX = null

const greenQuestions = computed(() => questions.value.filter(q => q.light === 'green'))
const yellowQuestions = computed(() => questions.value.filter(q => q.light !== 'green' && q.light !== 'gray' && q.isError))
const grayQuestions = computed(() => questions.value.filter(q => q.light === 'gray' || !q.isError))
const yellowHandled = computed(() => yellowQuestions.value.filter(q => q.confirmed || q.removed).length)
const currentYellow = computed(() => {
  const pending = yellowQuestions.value
  if (yellowIdx.value >= pending.length) return null
  return pending[yellowIdx.value]
})

// 题目裁剪图 URL（与 ErrorDetail 同源逻辑）
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

function judgeYellow(isError) {
  const q = currentYellow.value
  if (!q) return
  q.confirmed = isError
  q.removed = !isError
  yellowIdx.value++
}
function skipYellow() { yellowIdx.value++ }

function swipeStart(e) { touchStartX = e.changedTouches?.[0]?.clientX ?? null }
function swipeEnd(e) {
  if (touchStartX === null) return
  const dx = (e.changedTouches?.[0]?.clientX ?? 0) - touchStartX
  touchStartX = null
  if (dx > 60) judgeYellow(true)       // 右滑 = 是错题
  else if (dx < -60) judgeYellow(false) // 左滑 = 没错
}

function addQuestion() {
  const num = parseInt(addQnum.value)
  if (!num || num < 1) return
  if (questions.value.find(q => q.questionNumber === num)) { addQnum.value = ''; return }
  if (addedQuestions.value.find(q => q.questionNumber === num)) { addQnum.value = ''; return }
  addedQuestions.value.push({ questionNumber: num, isError: true, questionText: '', manuallyAdded: true })
  addQnum.value = ''
}

async function submitConfirmation() {
  submitting.value = true
  try {
    const confirmedErrors = [
      ...questions.value.filter(q => q.confirmed && q.isError),
      ...addedQuestions.value
    ]
    const removedErrors = questions.value.filter(q => q.removed && q.isError)
    const res = await authFetch(`/api/paper/${sessionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmed: confirmedErrors.map(q => q.questionNumber),
        removed: removedErrors.map(q => q.questionNumber),
        added: addedQuestions.value.map(q => q.questionNumber)
      })
    })
    const data = await res.json()
    if (data.success) router.push(`/review/${sessionId}`)
  } catch (e) {
    console.error('Confirmation failed:', e)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  try {
    const res = await authFetch(`/api/paper/${sessionId}/confirm`)
    const data = await res.json()
    if (data.questions) {
      questions.value = data.questions.map(q => ({
        ...q,
        // A3: 绿灯默认自动确认
        confirmed: q.light === 'green',
        removed: false
      }))
    }
    if (Array.isArray(data.lowQualityPages)) lowQualityPages.value = data.lowQualityPages
  } catch (e) {
    console.error('Failed to load confirmation data:', e)
  } finally {
    loading.value = false
  }
})
</script>
