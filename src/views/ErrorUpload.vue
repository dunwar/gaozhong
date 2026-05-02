<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 页面标题 -->
    <div class="text-center mb-12">
      <h1 class="text-3xl font-bold text-gray-900 mb-4">📄 错题上传</h1>
      <p class="text-lg text-gray-600">上传整张试卷照片（含批改答案），AI 自动识别错题并分析</p>
    </div>

    <!-- 上传表单 -->
    <div class="bg-white rounded-2xl shadow-lg p-8">
      <!-- 学科选择 -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-3">选择学科</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="s in subjects"
            :key="s.value"
            @click="form.subject = s.value"
            :class="form.subject === s.value ? s.activeClass : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
            class="px-4 py-2 rounded-lg font-medium transition-all"
          >
            {{ s.label }}
          </button>
        </div>
      </div>

      <!-- 试卷名称（可选） -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">
          试卷名称
          <span class="text-gray-400 font-normal">（选填，如"2024 上海一模数学"）</span>
        </label>
        <input
          v-model="form.title"
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="可选：给这次上传起个名字..."
        />
      </div>

      <!-- 图片上传区 -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-3">
          上传试卷图片
          <span class="text-gray-400 font-normal">（支持 JPG/PNG，单次最多 10 张）</span>
        </label>

        <!-- 已选图片预览 -->
        <div v-if="previews.length > 0" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4">
          <div
            v-for="(preview, idx) in previews"
            :key="idx"
            class="relative group rounded-lg overflow-hidden border-2 border-gray-200"
          >
            <img :src="preview" class="w-full h-32 object-cover" alt="试卷预览" />
            <button
              @click="removeImage(idx)"
              class="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              title="移除"
            >✕</button>
            <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-1">
              第 {{ idx + 1 }} 张
            </div>
          </div>

          <!-- 添加按钮 -->
          <label
            v-if="previews.length < MAX_IMAGES"
            class="border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center h-32 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-all"
          >
            <svg class="w-8 h-8 text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
            </svg>
            <span class="text-xs text-gray-400">添加更多</span>
            <input type="file" accept="image/*" multiple class="hidden" @change="addImages" />
          </label>
        </div>

        <!-- 空状态下的大上传区 -->
        <label
          v-else
          class="border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center justify-center py-16 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-all"
        >
          <svg class="w-12 h-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
          </svg>
          <p class="text-gray-500 font-medium mb-1">点击选择试卷图片</p>
          <p class="text-gray-400 text-sm">支持 JPG、PNG，可多选</p>
          <input type="file" accept="image/*" multiple class="hidden" @change="addImages" />
        </label>
      </div>

      <!-- 提交按钮 -->
      <div class="mt-6">
        <button
          @click="submitPaper"
          :disabled="isSubmitting || previews.length === 0"
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-4 rounded-xl transition-all"
        >
          <span v-if="isSubmitting" class="flex items-center justify-center">
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            正在处理...
          </span>
          <span v-else>提交分析 · {{ previews.length }} 张试卷</span>
        </button>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
        {{ errorMessage }}
      </div>
    </div>

    <!-- 分析进度 -->
    <div v-if="isProcessing" class="mt-8 bg-white rounded-2xl shadow-lg p-8 text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
        <svg class="animate-spin h-8 w-8 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>
      <p class="text-gray-700 font-medium text-lg">{{ progressMessage }}</p>
      <p class="text-gray-500 text-sm mt-1">{{ progressDetail }}</p>

      <!-- 进度条 -->
      <div class="mt-4 w-full max-w-md mx-auto bg-gray-200 rounded-full h-2.5">
        <div class="bg-blue-600 h-2.5 rounded-full transition-all duration-700" :style="{ width: progressPercent + '%' }"></div>
      </div>
    </div>

    <!-- 完成结果 -->
    <div v-if="showResult" class="mt-8 bg-white rounded-2xl shadow-lg p-8">
      <div class="text-center mb-6">
        <div class="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
          <svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
          </svg>
        </div>
        <h2 class="text-xl font-bold text-gray-900">分析完成！</h2>
        <p class="text-gray-600 mt-2">
          从 {{ form.subject }} 试卷中识别出 <span class="text-blue-600 font-bold text-lg">{{ analysisResult.totalErrors }}</span> 道错题
        </p>
      </div>

      <!-- 错题概览 -->
      <div v-if="analysisResult.errors?.length" class="mb-6">
        <h3 class="text-sm font-semibold text-gray-700 mb-3">错题清单</h3>
        <div class="space-y-2 max-h-80 overflow-y-auto">
          <div
            v-for="(err, i) in analysisResult.errors.slice(0, 20)"
            :key="i"
            class="flex items-start gap-3 p-3 bg-gray-50 rounded-lg"
          >
            <span class="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
              {{ err.questionIndex }}
            </span>
            <div class="flex-1 min-w-0">
              <p class="text-sm text-gray-800 line-clamp-2">{{ err.questionTitle || err.questionText }}</p>
              <div class="flex items-center gap-2 mt-1">
                <span :class="errorTypeClass(err.errorType)" class="px-2 py-0.5 rounded-full text-xs font-medium">{{ err.errorType }}</span>
                <span class="text-xs text-gray-400">难度 ★{{ err.difficulty || 3 }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="flex flex-wrap gap-3 justify-center mt-8 pt-6 border-t">
        <router-link
          to="/errors"
          class="inline-flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors font-medium"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
          </svg>
          查看错题本
        </router-link>
        <button
          @click="resetForm"
          class="inline-flex items-center gap-2 bg-gray-100 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-200 transition-colors font-medium"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
          </svg>
          继续上传
        </button>
        <router-link
          to="/knowledge"
          class="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium"
        >
          查看知识点分析 →
        </router-link>
      </div>
    </div>

    <!-- 旧版逐题录入（兜底） -->
    <div class="mt-12 pt-8 border-t text-center">
      <p class="text-gray-400 text-sm mb-2">只想录一道题？</p>
      <router-link to="/error-upload" class="text-gray-500 hover:text-gray-700 text-sm underline">
        使用逐题录入模式（旧版）
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { authFetch } from '../utils/authStore.js'

const subjects = [
  { value: '数学', label: '📐 数学', activeClass: 'bg-blue-600 text-white' },
  { value: '物理', label: '⚡ 物理', activeClass: 'bg-purple-600 text-white' },
  { value: '化学', label: '🧪 化学', activeClass: 'bg-green-600 text-white' },
  { value: '生物', label: '🧬 生物', activeClass: 'bg-teal-600 text-white' },
  { value: '英语', label: '🌍 英语', activeClass: 'bg-orange-600 text-white' },
  { value: '语文', label: '📖 语文', activeClass: 'bg-red-600 text-white' },
]

const MAX_IMAGES = 10
const POLL_INTERVAL = 3000
const MAX_POLL_TIME = 300000 // 5 分钟（OCR + AI 耗时较长）

const form = reactive({ subject: '数学', title: '', images: [] })
const previews = ref([])
const isSubmitting = ref(false)
const isProcessing = ref(false)
const progressMessage = ref('')
const progressDetail = ref('')
const progressPercent = ref(0)
const errorMessage = ref('')
const showResult = ref(false)
const analysisResult = ref({ totalErrors: 0, errors: [] })

function errorTypeClass(type) {
  const map = {
    '概念不清': 'bg-red-50 text-red-700', '计算失误': 'bg-yellow-50 text-yellow-700',
    '审题偏差': 'bg-purple-50 text-purple-700', '方法错误': 'bg-orange-50 text-orange-700',
    '粗心马虎': 'bg-blue-50 text-blue-700', '知识盲区': 'bg-gray-100 text-gray-700',
    '表达不规范': 'bg-pink-50 text-pink-700', '逻辑错误': 'bg-indigo-50 text-indigo-700',
    '未知': 'bg-gray-100 text-gray-600'
  }
  return map[type] || map['未知']
}

function addImages(e) {
  const files = Array.from(e.target.files || [])
  const remaining = MAX_IMAGES - form.images.length
  if (remaining <= 0) return

  const toAdd = files.slice(0, remaining)
  for (const file of toAdd) {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const base64 = ev.target.result
      form.images.push(base64)
      previews.value.push(base64)
    }
    reader.readAsDataURL(file)
  }
  e.target.value = '' // 重置以便重复选择同一文件
}

function removeImage(idx) {
  form.images.splice(idx, 1)
  previews.value.splice(idx, 1)
}

async function submitPaper() {
  if (previews.value.length === 0) return
  isSubmitting.value = true
  isProcessing.value = true
  showResult.value = false
  errorMessage.value = ''
  progressMessage.value = '正在提交...'
  progressDetail.value = ''
  progressPercent.value = 5

  try {
    const res = await authFetch('/api/paper/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: form.subject,
        images: form.images,
        title: form.title || ''
      })
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || '提交失败')
    }

    const data = await res.json()
    progressMessage.value = '排队中...'
    progressDetail.value = `前面还有 ${data.queuePosition} 个任务`
    progressPercent.value = 10

    await pollTask(data.taskId)
  } catch (err) {
    errorMessage.value = err.message || '分析失败，请稍后重试'
    isProcessing.value = false
  } finally {
    isSubmitting.value = false
  }
}

async function pollTask(taskId) {
  const startTime = Date.now()

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))

    try {
      const res = await authFetch(`/api/paper/task/${taskId}`)
      if (!res.ok) continue
      const data = await res.json()

      if (data.status === 'processing') {
        const prog = data.progress || {}
        if (prog.stage === 'ocr') {
          progressMessage.value = `正在识别试卷文字 (${prog.current || '?'}/${prog.total || '?'})`
          progressDetail.value = prog.message || ''
          progressPercent.value = 10 + Math.round(((prog.current || 0) / (prog.total || 1)) * 60)
        } else if (prog.stage === 'analyzing') {
          progressMessage.value = 'AI 正在分析错题...'
          progressDetail.value = '这可能需要 1-2 分钟'
          progressPercent.value = 75
        }
      } else if (data.status === 'done') {
        analysisResult.value = data.result
        showResult.value = true
        isProcessing.value = false
        progressPercent.value = 100
        return
      } else if (data.status === 'failed') {
        throw new Error(data.error || '分析失败')
      }
    } catch (err) {
      if (err.message && !err.message.includes('Failed to fetch')) throw err
    }
  }

  throw new Error('分析超时，请稍后重试。较大试卷可能需要更长时间。')
}

function resetForm() {
  showResult.value = false
  isProcessing.value = false
  errorMessage.value = ''
  form.images = []
  previews.value = []
  form.title = ''
}
</script>
