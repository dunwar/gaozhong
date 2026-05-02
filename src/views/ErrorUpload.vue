<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 页面标题 -->
    <div class="text-center mb-12">
      <h1 class="text-3xl font-bold text-gray-900 mb-4">错题诊断</h1>
      <p class="text-lg text-gray-600">录入你的错题，AI 将诊断错误原因、给出正确解法并标注知识点</p>
    </div>

    <!-- 录入表单 -->
    <div class="bg-white rounded-2xl shadow-lg p-8">
      <!-- 学科选择 -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-3">学科</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="s in subjects"
            :key="s.value"
            @click="subject = s.value"
            :class="subject === s.value ? s.activeClass : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
            class="px-4 py-2 rounded-lg font-medium transition-all"
          >
            {{ s.label }}
          </button>
        </div>
      </div>

      <!-- 章节/主题 -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">章节 / 主题（选填）</label>
        <input
          v-model="topic"
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="如：二次函数、电磁感应..."
        />
      </div>

      <!-- 题目内容 -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">题目</label>
        <textarea
          v-model="questionText"
          rows="5"
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="请输入原题内容..."
        ></textarea>
      </div>

      <!-- 错误答案 -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">
          你的错误答案
          <span class="text-gray-400 font-normal">（可选，未作答可以不填）</span>
        </label>
        <textarea
          v-model="wrongAnswer"
          rows="4"
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="输入你做错时的答案..."
        ></textarea>
      </div>

      <!-- 提交按钮 -->
      <div class="mt-6">
        <button
          @click="submitError"
          :disabled="isSubmitting || !canSubmit"
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-4 rounded-xl transition-all"
        >
          <span v-if="isSubmitting" class="flex items-center justify-center">
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            AI 正在诊断...
          </span>
          <span v-else>提交诊断</span>
        </button>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
        {{ errorMessage }}
      </div>
    </div>

    <!-- 诊断结果 -->
    <div v-if="diagnosisResult" class="mt-8 bg-white rounded-2xl shadow-lg p-8">
      <h2 class="text-xl font-bold text-gray-900 mb-6 flex items-center gap-2">
        <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        诊断结果
      </h2>

      <!-- 错误类型 + 难度 -->
      <div class="flex flex-wrap items-center gap-3 mb-6">
        <span :class="errorTypeClass" class="px-3 py-1 rounded-full text-sm font-medium">
          {{ diagnosisResult.errorType }}
        </span>
        <span class="flex items-center gap-1 text-sm text-gray-500">
          难度：
          <span v-for="i in 5" :key="i" class="text-lg" :class="i <= diagnosisResult.difficulty ? 'text-yellow-500' : 'text-gray-300'">★</span>
        </span>
      </div>

      <!-- 错误原因 -->
      <div class="mb-6">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">错误原因</h3>
        <p class="text-gray-600 leading-relaxed">{{ diagnosisResult.reason || diagnosisResult.errorAnalysis }}</p>
      </div>

      <!-- 正确解法 -->
      <div class="mb-6">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">正确解法</h3>
        <div class="bg-gray-50 rounded-lg p-4 text-gray-700 whitespace-pre-wrap font-mono text-sm leading-relaxed">{{ diagnosisResult.correctSolution }}</div>
      </div>

      <!-- 知识点标签 -->
      <div v-if="diagnosisResult.knowledgePoints?.length" class="mb-6">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">关联知识点</h3>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="(kp, i) in diagnosisResult.knowledgePoints"
            :key="i"
            class="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium"
          >{{ typeof kp === 'string' ? kp : kp.name }}</span>
        </div>
      </div>

      <!-- 同类题提示 -->
      <div v-if="diagnosisResult.similarTips">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">巩固建议</h3>
        <p class="text-gray-600 text-sm">{{ diagnosisResult.similarTips }}</p>
      </div>

      <!-- 再录一题 -->
      <div class="mt-8 pt-6 border-t">
        <button @click="resetForm" class="text-blue-600 hover:text-blue-700 font-medium text-sm flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
          </svg>
          再录一题
        </button>
      </div>
    </div>

    <!-- 诊断中状态 -->
    <div v-if="isDiagnosing" class="mt-8 bg-white rounded-2xl shadow-lg p-8 text-center">
      <div class="inline-flex items-center justify-center w-12 h-12 bg-blue-100 rounded-full mb-4">
        <svg class="animate-spin h-6 w-6 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>
      <p class="text-gray-700 font-medium">AI 正在诊断你的错题...</p>
      <p class="text-gray-500 text-sm mt-1">{{ diagnosisProgress }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { authFetch } from '../utils/authStore.js'

const subjects = [
  { value: '数学', label: '📐 数学', activeClass: 'bg-blue-600 text-white' },
  { value: '物理', label: '⚡ 物理', activeClass: 'bg-purple-600 text-white' },
  { value: '化学', label: '🧪 化学', activeClass: 'bg-green-600 text-white' },
  { value: '英语', label: '🌍 英语', activeClass: 'bg-orange-600 text-white' },
  { value: '语文', label: '📖 语文', activeClass: 'bg-red-600 text-white' },
]

const subject = ref('数学')
const topic = ref('')
const questionText = ref('')
const wrongAnswer = ref('')
const isSubmitting = ref(false)
const isDiagnosing = ref(false)
const diagnosisProgress = ref('')
const errorMessage = ref('')
const diagnosisResult = ref(null)

const canSubmit = computed(() => questionText.value.trim().length > 0)

const errorTypeClass = computed(() => {
  const map = {
    '概念不清': 'bg-red-100 text-red-700',
    '计算失误': 'bg-yellow-100 text-yellow-700',
    '审题偏差': 'bg-purple-100 text-purple-700',
    '方法错误': 'bg-orange-100 text-orange-700',
    '粗心': 'bg-blue-100 text-blue-700',
    '知识盲区': 'bg-gray-100 text-gray-700',
  }
  return map[diagnosisResult.value?.errorType] || 'bg-gray-100 text-gray-700'
})

const POLL_INTERVAL = 3000
const MAX_POLL_TIME = 120000

async function submitError() {
  if (!canSubmit.value) return
  isSubmitting.value = true
  isDiagnosing.value = true
  diagnosisResult.value = null
  errorMessage.value = ''
  diagnosisProgress.value = '正在提交...'

  try {
    const res = await authFetch('/api/error/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: subject.value,
        topic: topic.value,
        questionText: questionText.value.trim(),
        wrongAnswer: wrongAnswer.value.trim()
      })
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '提交失败' }))
      throw new Error(err.error || '诊断服务暂时不可用')
    }

    const data = await res.json()
    diagnosisProgress.value = '排队中...'

    // 轮询直到完成
    await pollTask(data.taskId)
  } catch (err) {
    errorMessage.value = err.message || '诊断失败，请稍后重试'
    isDiagnosing.value = false
  } finally {
    isSubmitting.value = false
  }
}

async function pollTask(taskId) {
  const startTime = Date.now()

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))

    try {
      const res = await authFetch(`/api/error/task/${taskId}`)
      if (!res.ok) continue

      const data = await res.json()

      if (data.status === 'processing') {
        diagnosisProgress.value = data.progress?.message || 'AI 正在分析...'
      } else if (data.status === 'done') {
        diagnosisResult.value = data.result
        isDiagnosing.value = false
        return
      } else if (data.status === 'failed') {
        throw new Error(data.error || '诊断失败')
      }
    } catch (err) {
      if (err.message && !err.message.includes('Failed to fetch')) {
        throw err
      }
    }
  }

  throw new Error('诊断超时，请稍后重试')
}

function resetForm() {
  diagnosisResult.value = null
  errorMessage.value = ''
  questionText.value = ''
  wrongAnswer.value = ''
  topic.value = ''
  // 学科保持不变，方便连续录入同科题目
}
</script>
