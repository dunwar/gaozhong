<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 页面标题 -->
    <div class="text-center mb-12">
      <h1 class="text-3xl font-bold text-gray-900 mb-4">作文批改</h1>
      <p class="text-lg text-gray-600">上传你的作文，AI 将根据上海高考标准进行专业批改</p>
    </div>

    <!-- 输入区域 -->
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
          :disabled="isSubmitting || !canSubmit"
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-4 rounded-xl transition-all"
        >
          <span v-if="isSubmitting" class="flex items-center justify-center">
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            正在提交...
          </span>
          <span v-else>提交批改</span>
        </button>
      </div>

      <!-- 提交成功提示 -->
      <div v-if="justSubmitted" class="mt-4 p-4 bg-green-50 text-green-700 rounded-lg flex items-center justify-between">
        <span>✅ 已提交，任务正在排队处理中</span>
        <router-link to="/tasks" class="text-green-700 underline font-medium text-sm">查看任务 →</router-link>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
        {{ errorMessage }}
      </div>
    </div>

    <!-- 进行中的任务 -->
    <div v-if="activeTasks.length > 0" class="mt-8">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-gray-900">
          进行中的任务
          <span class="ml-2 px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">{{ activeTasks.length }}</span>
        </h3>
        <router-link to="/tasks" class="text-sm text-blue-600 hover:text-blue-700">查看全部 →</router-link>
      </div>

      <div class="space-y-3">
        <div
          v-for="task in activeTasks"
          :key="task.taskId"
          class="bg-white rounded-xl border border-gray-100 shadow-sm p-4"
        >
          <!-- 进行中 -->
          <div v-if="task.status === 'queued' || task.status === 'processing'" class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <span class="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                  :class="task.status === 'processing' ? 'bg-blue-400' : 'bg-yellow-400'"
                ></span>
                <span class="relative inline-flex rounded-full h-2.5 w-2.5"
                  :class="task.status === 'processing' ? 'bg-blue-500' : 'bg-yellow-500'"
                ></span>
              </span>
              <span class="text-sm text-gray-700 truncate">{{ task.topic || '(无题目)' }}</span>
              <span class="text-xs flex-shrink-0"
                :class="task.status === 'processing' ? 'text-blue-500' : 'text-yellow-500'"
              >{{ task.status === 'processing' ? '批改中...' : '排队...' }}</span>
            </div>
            <router-link
              :to="`/result/${task.taskId}`"
              v-if="task.status === 'done'"
              class="ml-3 text-sm text-green-600 font-medium hover:text-green-700 flex-shrink-0"
            >查看结果 →</router-link>
          </div>

          <!-- 已完成 -->
          <div v-else-if="task.status === 'done'" class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-2.5 h-2.5 bg-green-500 rounded-full flex-shrink-0"></span>
              <span class="text-sm text-gray-700 truncate">{{ task.topic || '(无题目)' }}</span>
              <span class="text-sm font-bold flex-shrink-0" :class="getScoreColor(task.totalScore)">
                {{ task.totalScore || '—' }}分
              </span>
            </div>
            <router-link
              :to="`/result/${task.taskId}`"
              class="ml-3 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg text-sm font-medium hover:bg-green-100 flex-shrink-0"
            >查看结果 →</router-link>
          </div>

          <!-- 失败 -->
          <div v-else-if="task.status === 'failed'" class="flex items-center gap-3 text-sm text-red-600">
            <span class="w-2.5 h-2.5 bg-red-500 rounded-full flex-shrink-0"></span>
            <span>{{ task.topic || '(无题目)' }}</span>
            <span class="text-xs text-red-400">失败</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 评分标准说明 -->
    <div class="mt-8 bg-gray-50 rounded-xl p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">评分标准</h3>
      <p class="text-gray-600 text-sm">
        依据上海高考语文作文评分标准，满分 70 分，从审题立意、思辨深度、结构布局、语言表达、素材运用五大维度综合评定。
        AI 将给出详细评分和改进建议。
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import UploadArea from '../components/UploadArea.vue'
import { addTask, updateTask, loadTasks } from '../utils/taskStore.js'

const inputMode = ref('text')
const essayText = ref('')
const selectedFile = ref(null)
const essayTopic = ref('')
const isSubmitting = ref(false)
const errorMessage = ref('')
const justSubmitted = ref(false)

// 进行中的任务列表
const activeTasks = ref([])
let pollTimer = null

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

const POLL_INTERVAL = 3000

const submitEssay = async () => {
  if (!canSubmit.value) {
    errorMessage.value = inputMode.value === 'text' ? '请输入作文内容' : '请先选择要批改的文件'
    return
  }

  isSubmitting.value = true
  errorMessage.value = ''
  justSubmitted.value = false

  try {
    let taskId
    
    if (inputMode.value === 'text') {
      taskId = await submitTextTask(essayText.value.trim(), essayTopic.value)
    } else {
      const base64Data = await fileToBase64(selectedFile.value)
      taskId = await submitFileTask(base64Data, essayTopic.value)
    }
    
    // 注册到 localStorage 任务追踪
    addTask({
      taskId,
      topic: essayTopic.value || essayText.value.trim().slice(0, 50),
      inputType: inputMode.value
    })
    
    // 刷新进行中任务列表
    await refreshActiveTasks()
    
    justSubmitted.value = true
    
    // 清空表单，允许继续提交
    essayText.value = ''
    selectedFile.value = null
    essayTopic.value = ''
    
    // 后台轮询该任务
    pollSingleTask(taskId)
  } catch (error) {
    errorMessage.value = error.message || '提交失败，请稍后重试'
  } finally {
    isSubmitting.value = false
  }
}

// 后台轮询单个任务直到完成
async function pollSingleTask(taskId) {
  const maxTime = 300000
  const startTime = Date.now()
  
  while (Date.now() - startTime < maxTime) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    
    try {
      const res = await fetch(`/api/task/${taskId}`)
      if (!res.ok) break
      
      const data = await res.json()
      if (data.status === 'done') {
        updateTask(taskId, {
          status: 'done',
          totalScore: data.result?.totalScore,
          grade: data.result?.grade,
          summary: data.result?.oneSentenceSummary
        })
        await refreshActiveTasks()
        return
      }
      if (data.status === 'failed') {
        updateTask(taskId, { status: 'failed', error: data.error })
        await refreshActiveTasks()
        return
      }
      if (data.progress?.message) {
        updateTask(taskId, { progress: data.progress.message, status: data.status })
      }
    } catch {
      break
    }
  }
}

// 刷新进行中/刚完成的任务
async function refreshActiveTasks() {
  const all = loadTasks()
  activeTasks.value = all.filter(t =>
    t.status === 'queued' || t.status === 'processing' || t.status === 'done'
  ).slice(0, 5)
}

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

const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const getScoreColor = (score) => {
  if (!score && score !== 0) return 'text-gray-400'
  if (score >= 56) return 'text-green-600'
  if (score >= 42) return 'text-yellow-600'
  return 'text-red-600'
}

onMounted(() => {
  refreshActiveTasks()
  // 轮询进行中任务
  pollTimer = setInterval(refreshActiveTasks, 5000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
