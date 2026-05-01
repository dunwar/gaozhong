<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 页面标题 -->
    <div class="text-center mb-12">
      <h1 class="text-3xl font-bold text-gray-900 mb-4">作文批改</h1>
      <p class="text-lg text-gray-600">上传你的作文，AI 将根据上海高考标准进行专业批改</p>
    </div>

    <!-- 输入方式切换 -->
    <div class="bg-white rounded-2xl shadow-lg p-8">
      <!-- 切换按钮 -->
      <div class="flex space-x-4 mb-6">
        <button 
          @click="inputMode = 'text'"
          :class="inputMode === 'text' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'"
          class="px-4 py-2 rounded-lg font-medium transition-all"
        >
          直接输入
        </button>
        <button 
          @click="inputMode = 'file'"
          :class="inputMode === 'file' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'"
          class="px-4 py-2 rounded-lg font-medium transition-all"
        >
          上传文件
        </button>
      </div>

      <!-- 文本输入模式 -->
      <div v-if="inputMode === 'text'">
        <label class="block text-sm font-medium text-gray-700 mb-2">作文内容</label>
        <textarea 
          v-model="essayText" 
          rows="12" 
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="请在此粘贴或输入你的作文内容..."
        ></textarea>
        <p class="mt-2 text-sm text-gray-500">字数: {{ essayText.length }}</p>
      </div>

      <!-- 文件上传模式 -->
      <div v-else>
        <UploadArea @file-selected="onFileSelected" />
        
        <!-- 文件预览 -->
        <div v-if="selectedFile" class="mt-4 p-4 bg-gray-50 rounded-lg">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <svg class="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
              </svg>
              <div>
                <p class="text-sm font-medium text-gray-900">{{ selectedFile.name }}</p>
                <p class="text-xs text-gray-500">{{ formatFileSize(selectedFile.size) }}</p>
              </div>
            </div>
            <button @click="clearFile" class="text-gray-400 hover:text-red-500">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 作文题目输入 -->
      <div class="mt-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">作文题目（选填）</label>
        <textarea 
          v-model="essayTopic" 
          rows="3" 
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="请输入作文题目或材料..."
        ></textarea>
      </div>

      <!-- 提交按钮 -->
      <div class="mt-6">
        <button 
          @click="submitEssay" 
          :disabled="isAnalyzing || !canSubmit"
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-4 rounded-xl transition-all"
        >
          <span v-if="isAnalyzing" class="flex items-center justify-center">
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ progressMessage || 'AI 正在批改中...' }}
          </span>
          <span v-else>提交批改</span>
        </button>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
        {{ errorMessage }}
      </div>
    </div>

    <!-- 评分标准说明 -->
    <div class="mt-8 bg-gray-50 rounded-xl p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">评分标准</h3>
      <p class="text-gray-600 text-sm">
        依据上海高考语文作文评分标准，满分 70 分，从内容、结构、语言、创新四大维度综合评定。
        AI 将给出详细评分和改进建议。
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import UploadArea from '../components/UploadArea.vue'

const router = useRouter()

const inputMode = ref('text') // 'text' 或 'file'
const essayText = ref('')
const selectedFile = ref(null)
const essayTopic = ref('')
const isAnalyzing = ref(false)
const errorMessage = ref('')
const progressMessage = ref('')

const canSubmit = computed(() => {
  if (inputMode.value === 'text') {
    return essayText.value.trim().length > 0
  }
  return selectedFile.value !== null
})

const onFileSelected = (file) => {
  selectedFile.value = file
  errorMessage.value = ''
}

const clearFile = () => {
  selectedFile.value = null
}

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const POLL_INTERVAL = 3000  // 每 3 秒轮询一次
const POLL_TIMEOUT = 300000 // 最多等 5 分钟

const submitEssay = async () => {
  if (!canSubmit.value) {
    errorMessage.value = inputMode.value === 'text' ? '请输入作文内容' : '请先选择要批改的文件'
    return
  }

  isAnalyzing.value = true
  errorMessage.value = ''
  progressMessage.value = '正在提交...'

  try {
    let taskId
    
    if (inputMode.value === 'text') {
      taskId = await submitTextTask(essayText.value.trim(), essayTopic.value)
    } else {
      const base64Data = await fileToBase64(selectedFile.value)
      taskId = await submitFileTask(base64Data, essayTopic.value)
    }
    
    // 轮询等待结果
    const result = await pollTask(taskId)
    
    // 跳转到结果页
    router.push({ name: 'Result', state: { result, taskId } })
  } catch (error) {
    errorMessage.value = error.message || '批改失败，请稍后重试'
  } finally {
    isAnalyzing.value = false
    progressMessage.value = ''
  }
}

// 提交文本批改任务
const submitTextTask = async (text, topic) => {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, topic })
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: '提交失败' }))
    throw new Error(err.error || 'AI 批改服务暂时不可用')
  }
  const data = await response.json()
  return data.taskId
}

// 提交图片批改任务
const submitFileTask = async (base64Data, topic) => {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: base64Data, topic })
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: '提交失败' }))
    throw new Error(err.error || 'AI 批改服务暂时不可用')
  }
  const data = await response.json()
  return data.taskId
}

// 轮询任务结果
const pollTask = async (taskId) => {
  const startTime = Date.now()
  
  while (Date.now() - startTime < POLL_TIMEOUT) {
    const response = await fetch(`/api/task/${taskId}`)
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: '查询失败' }))
      throw new Error(err.error || '查询任务状态失败')
    }
    
    const task = await response.json()
    
    if (task.status === 'done') {
      return task.result
    }
    
    if (task.status === 'failed') {
      throw new Error(task.error || '批改失败')
    }
    
    // 更新进度提示
    if (task.progress) {
      progressMessage.value = task.progress.message
    }
    if (task.status === 'queued' && task.queuePosition > 0) {
      progressMessage.value = `排队中...前方 ${task.queuePosition} 人`
    }
    
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
  }
  
  throw new Error('批改超时，请稍后重试')
}

const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ========== 旧同步接口（已移除） ==========
// 现已升级为异步队列模式：submitTextTask / submitFileTask / pollTask
</script>
