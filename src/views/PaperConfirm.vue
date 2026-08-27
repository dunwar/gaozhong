<template>
  <div class="max-w-4xl mx-auto py-6 md:py-10 px-4">
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 mb-1">📋 确认错题</h1>
        <p class="text-gray-500 text-sm">系统已自动识别错题。请审核确认，确保准确无误。</p>
      </div>
      <router-link :to="`/review/${sessionId}`" class="text-sm text-gray-400 hover:text-gray-600">跳过确认 →</router-link>
    </div>

    <!-- v5.0 ①: 低质页提示 — LLM失败/备用引擎识别的页，请用户重点复核 -->
    <div v-if="lowQualityPages.length > 0" class="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
      <span class="text-xl leading-none mt-0.5">⚠️</span>
      <div class="text-sm text-amber-800">
        <p class="font-medium mb-0.5">第 {{ lowQualityPages.join('、') }} 页识别质量较低（已用备用引擎识别）</p>
        <p class="text-amber-700 text-xs">这些页的题目和判错可能不完整，建议结合<router-link :to="`/review/${sessionId}`" class="underline font-medium">原图复核</router-link>，漏掉的错题可在复核页手动添加。</p>
      </div>
    </div>

    <!-- Stats bar -->
    <div class="grid grid-cols-3 gap-3 mb-6">
      <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-3 text-center">
        <p class="text-2xl font-bold text-rose-600">{{ wrongCount }}</p>
        <p class="text-xs text-gray-500">系统判定错题</p>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-3 text-center">
        <p class="text-2xl font-bold text-amber-500">{{ unconfirmedCount }}</p>
        <p class="text-xs text-gray-500">待确认</p>
      </div>
      <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-3 text-center">
        <p class="text-2xl font-bold text-emerald-600">{{ confirmedCount }}</p>
        <p class="text-xs text-gray-500">已确认</p>
      </div>
    </div>

    <!-- Question list -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      <svg class="animate-spin w-8 h-8 mx-auto mb-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      加载中…
    </div>

    <div v-else-if="questions.length === 0" class="text-center py-12 text-gray-400">
      <p class="text-lg mb-2">🎉 未检测到错题</p>
      <p class="text-sm">该试卷可能没有需要整理的错题</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="q in questions"
        :key="q.questionNumber"
        class="bg-white rounded-xl border shadow-sm overflow-hidden transition-all"
        :class="q.confirmed ? 'border-emerald-200 bg-emerald-50/30' : q.removed ? 'border-red-200 bg-red-50/30 opacity-50' : 'border-gray-100'"
      >
        <div class="flex items-start gap-3 p-4">
          <!-- Status indicator -->
          <div class="flex-shrink-0 mt-0.5">
            <span v-if="q.confirmed" class="w-6 h-6 bg-emerald-500 text-white rounded-full flex items-center justify-center text-xs">✓</span>
            <span v-else-if="q.removed" class="w-6 h-6 bg-red-400 text-white rounded-full flex items-center justify-center text-xs">✕</span>
            <span v-else class="w-6 h-6 bg-amber-400 text-white rounded-full flex items-center justify-center text-xs">?</span>
          </div>

          <!-- Question content -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-semibold text-gray-900">Q{{ q.questionNumber }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded-full"
                :class="q.isError ? 'bg-rose-100 text-rose-700' : 'bg-gray-100 text-gray-500'"
              >{{ q.isError ? '系统判定错题' : '系统判定正确' }}</span>
              <span v-if="q.markCount > 0" class="text-xs text-gray-400">红笔标记: {{ q.markCount }}处</span>
              <span v-if="q.pageIndex" class="text-xs text-gray-400">第{{ q.pageIndex }}页</span>
            </div>
            <p class="text-sm text-gray-600 line-clamp-2 mb-2">{{ q.questionText }}</p>
            <div v-if="q.options && Object.keys(q.options).length > 0" class="flex gap-2 flex-wrap text-xs text-gray-500 mb-2">
              <span v-for="(v, k) in q.options" :key="k" class="px-1.5 py-0.5 bg-gray-50 rounded">{{ k }}. {{ v }}</span>
            </div>
            <p v-if="q.reason" class="text-xs text-gray-400">判定依据: {{ q.reason === 'no_red_marks' ? '无红笔标记' : q.reason }}</p>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-1 flex-shrink-0">
            <button
              v-if="!q.confirmed && !q.removed"
              @click="confirmQuestion(q)"
              class="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-medium hover:bg-emerald-100 transition-colors"
            >✓ 确认错题</button>
            <button
              v-if="!q.confirmed && !q.removed"
              @click="removeQuestion(q)"
              class="px-3 py-1.5 bg-gray-50 text-gray-500 rounded-lg text-xs font-medium hover:bg-gray-100 transition-colors"
            >这不是错题</button>
            <button
              v-if="q.confirmed || q.removed"
              @click="undoQuestion(q)"
              class="px-3 py-1.5 bg-gray-50 text-gray-500 rounded-lg text-xs font-medium hover:bg-gray-100 transition-colors"
            >撤销</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add question manually -->
    <div class="mt-6 bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">➕ 手动添加遗漏的错题</h3>
      <div class="flex gap-2">
        <input
          v-model="addQnum"
          type="number"
          placeholder="输入题号（如 21）"
          class="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
          @keyup.enter="addQuestion"
        />
        <button
          @click="addQuestion"
          :disabled="!addQnum"
          class="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300 transition-colors"
        >添加</button>
      </div>
      <!-- Manually added questions -->
      <div v-if="addedQuestions.length > 0" class="mt-3 space-y-1">
        <div v-for="aq in addedQuestions" :key="'added-' + aq.questionNumber" class="flex items-center justify-between px-3 py-2 bg-emerald-50 rounded-lg">
          <span class="text-sm text-emerald-800">Q{{ aq.questionNumber }}（手动添加）</span>
          <button @click="removeAddedQuestion(aq)" class="text-red-500 text-xs hover:text-red-700">删除</button>
        </div>
      </div>
    </div>

    <!-- Submit button -->
    <div class="mt-8 flex justify-end gap-3">
      <router-link :to="`/review/${sessionId}`" class="px-6 py-3 bg-gray-100 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-200 transition-colors">
        稍后处理
      </router-link>
      <button
        @click="submitConfirmation"
        :disabled="submitting"
        class="px-6 py-3 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 shadow-sm disabled:bg-gray-300 transition-colors flex items-center gap-2"
      >
        <span v-if="submitting" class="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
        {{ submitting ? '保存中…' : '✅ 确认并保存错题本' }}
      </button>
    </div>
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
const lowQualityPages = ref([])  // v5.0 ①: 低质页提示

const wrongCount = computed(() => questions.value.filter(q => q.isError).length)
const confirmedCount = computed(() => questions.value.filter(q => q.confirmed).length + addedQuestions.value.length)
const unconfirmedCount = computed(() => questions.value.filter(q => !q.confirmed && !q.removed).length)

onMounted(async () => {
  try {
    const res = await authFetch(`/api/paper/${sessionId}/confirm`)
    const data = await res.json()
    if (data.questions) {
      questions.value = data.questions.map(q => ({
        ...q,
        confirmed: false,
        removed: false
      }))
    }
    if (Array.isArray(data.lowQualityPages)) {
      lowQualityPages.value = data.lowQualityPages
    }
  } catch (e) {
    console.error('Failed to load confirmation data:', e)
  } finally {
    loading.value = false
  }
})

function confirmQuestion(q) {
  q.confirmed = true
  q.removed = false
}

function removeQuestion(q) {
  q.removed = true
  q.confirmed = false
}

function undoQuestion(q) {
  q.confirmed = false
  q.removed = false
}

function addQuestion() {
  const num = parseInt(addQnum.value)
  if (!num || num < 1) return
  // Check if already exists
  if (questions.value.find(q => q.questionNumber === num)) {
    addQnum.value = ''
    return
  }
  if (addedQuestions.value.find(q => q.questionNumber === num)) {
    addQnum.value = ''
    return
  }
  addedQuestions.value.push({ questionNumber: num, isError: true, questionText: '', manuallyAdded: true })
  addQnum.value = ''
}

function removeAddedQuestion(aq) {
  addedQuestions.value = addedQuestions.value.filter(q => q.questionNumber !== aq.questionNumber)
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
    if (data.success) {
      router.push(`/review/${sessionId}`)
    }
  } catch (e) {
    console.error('Confirmation failed:', e)
  } finally {
    submitting.value = false
  }
}
</script>
