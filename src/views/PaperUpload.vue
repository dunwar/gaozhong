<template>
  <div class="max-w-3xl mx-auto py-6 md:py-10 px-4">
    <h1 class="text-2xl font-bold text-gray-900 mb-1">📄 错题上传</h1>
    <p class="text-gray-500 text-sm mb-6">上传已批改的试卷，AI 自动识别错题并整理到错题本</p>

    <!-- ===== 进行中的任务队列 ===== -->
    <div v-if="paperTasks.length > 0" class="mb-8">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
          <button
            v-for="t in taskTabs"
            :key="t.key"
            @click="taskFilter = t.key"
            :class="['px-3 py-1.5 rounded-md text-xs font-medium transition-all', taskFilter === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700']"
          >{{ t.label }}
            <span class="ml-0.5 opacity-60">({{ t.count }})</span>
          </button>
        </div>
        <router-link to="/error/list" class="text-xs text-blue-600 hover:text-blue-700">错题本 →</router-link>
      </div>

      <div class="space-y-2">
        <div
          v-for="task in activeTasks"
          :key="task.taskId"
          class="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3"
        >
          <!-- 排队/处理中 -->
          <div v-if="task.status === 'queued' || task.status === 'processing'" class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <span class="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                  :class="task.status === 'processing' ? 'bg-blue-400' : 'bg-yellow-400'"></span>
                <span class="relative inline-flex rounded-full h-2.5 w-2.5"
                  :class="task.status === 'processing' ? 'bg-blue-500' : 'bg-yellow-500'"></span>
              </span>
              <span class="text-sm text-gray-700 truncate">{{ task.topic || task.title || '试卷分析' }}</span>
              <span class="text-xs flex-shrink-0"
                :class="task.status === 'processing' ? 'text-blue-500' : 'text-yellow-600'"
              >{{ task.status === 'processing' ? (task.progress || '分析中…') : `排队第 ${task.queuePosition || '...'} 位` }}</span>
              <span v-if="task.etaSeconds > 0" class="text-xs text-gray-400 flex-shrink-0">预计 {{ formatEta(task.etaSeconds) }}</span>
            </div>
          </div>

          <!-- 已完成 -->
          <div v-else-if="task.status === 'done'" class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <span class="w-2.5 h-2.5 bg-green-500 rounded-full flex-shrink-0"></span>
              <span class="text-sm text-gray-700 truncate">{{ task.topic || task.title || '试卷分析' }}</span>
              <span class="text-sm text-green-600 font-medium flex-shrink-0">{{ task.totalErrors || 0 }} 道错题</span>
            </div>
            <router-link
              :to="`/review/${task.taskId}`"
              class="ml-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg text-sm font-medium hover:bg-green-100 flex-shrink-0 transition-colors"
            >查看 →</router-link>
          </div>

          <!-- 失败 -->
          <div v-else-if="task.status === 'failed'" class="flex items-center gap-3 text-sm text-red-600">
            <span class="w-2.5 h-2.5 bg-red-500 rounded-full flex-shrink-0"></span>
            <span class="truncate">{{ task.topic || task.title || '试卷分析' }}</span>
            <span class="text-xs text-red-400 flex-shrink-0">失败</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 上传表单 ===== -->
    <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 md:p-6">
      <!-- 科目选择 -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">科目</label>
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="s in subjects"
            :key="s"
            @click="subject = s"
            :class="[
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              subject === s ? 'bg-emerald-600 text-white shadow-sm' : 'bg-gray-50 text-gray-600 border border-gray-200 hover:border-emerald-300 hover:text-emerald-700'
            ]"
          >{{ s }}</button>
        </div>
      </div>

      <!-- 批改方式选择 -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">✏️ 批改方式</label>
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="m in markingMethods"
            :key="m.key"
            @click="markingMethod = m.key"
            :class="[
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              markingMethod === m.key ? 'bg-rose-600 text-white shadow-sm' : 'bg-gray-50 text-gray-600 border border-gray-200 hover:border-rose-300 hover:text-rose-700'
            ]"
          >
            <span class="mr-1">{{ m.icon }}</span>{{ m.label }}
          </button>
        </div>
        <p class="text-xs text-gray-400 mt-1.5">{{ markingMethodDesc }}</p>
      </div>

      <!-- 标题 -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-1.5">试卷标题（选填）</label>
        <input
          v-model="title"
          placeholder="如：2024上海英语一模"
          class="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:bg-white transition-all outline-none"
        />
      </div>

      <!-- 上传区域 -->
      <div
        class="border-2 border-dashed rounded-xl p-6 md:p-8 text-center cursor-pointer transition-all mb-4"
        :class="dragOver ? 'border-emerald-400 bg-emerald-50/50' : 'border-gray-200 hover:border-emerald-300 bg-gray-50/50'"
        @click="triggerFileInput"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="onDrop"
      >
        <input ref="fileInput" type="file" accept="image/*,.pdf,.doc,.docx" multiple class="hidden" @change="onFilesSelected" />
        <div class="flex flex-col items-center gap-2">
          <svg class="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
          <p class="text-sm text-gray-500">拖拽文件到此处，或<span class="text-emerald-600 font-medium">点击选择</span></p>
          <p class="text-xs text-gray-400">支持 JPG / PNG / PDF / Word，最多 {{ maxFiles }} 个文件</p>
          <p class="text-xs text-gray-400">已选 {{ images.length }}/{{ maxFiles }}</p>
          <!-- Upload progress bar -->
          <div v-if="images.length > 0" class="w-full max-w-xs h-1 bg-gray-200 rounded-full overflow-hidden">
            <div class="h-full bg-emerald-500 rounded-full transition-all duration-300" :style="{ width: (images.length / maxFiles * 100) + '%' }"></div>
          </div>
        </div>
      </div>

      <!-- 已选文件列表 -->
      <div v-if="images.length > 0" class="mb-5">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium text-gray-700">已选文件（{{ images.length }}/{{ maxFiles }}）</span>
          <button @click="clearImages" class="text-xs text-red-500 hover:text-red-700 transition-colors">清空全部</button>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          <div
            v-for="(img, i) in images"
            :key="i"
            class="relative group rounded-lg border border-gray-200 overflow-hidden bg-gray-50 aspect-square"
          >
            <!-- Image preview -->
            <img v-if="img.preview && img.isImage" :src="img.preview" class="w-full h-full object-cover" />
            <!-- Non-image file icon -->
            <div v-else class="w-full h-full flex flex-col items-center justify-center p-2">
              <svg class="w-8 h-8 text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              <p class="text-[10px] text-gray-500 text-center leading-tight truncate w-full">{{ img.file?.name || '文件' }}</p>
            </div>
            <!-- Remove button -->
            <button
              @click="removeImage(i)"
              class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-red-600"
            >✕</button>
            <!-- Page badge -->
            <span class="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded leading-none">{{ i + 1 }}</span>
          </div>
        </div>
      </div>

      <!-- 提交按钮 -->
      <button
        @click="submit"
        :disabled="submitting || images.length === 0"
        class="w-full py-3 rounded-xl font-medium text-white text-sm transition-all"
        :class="submitting || images.length === 0 ? 'bg-gray-300 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700 shadow-sm hover:shadow-md'"
      >
        <span v-if="submitting" class="flex items-center justify-center gap-2">
          <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          提交中…
        </span>
        <span v-else>📄 开始分析</span>
      </button>
    </div>

    <!-- 提交后即时状态（当前页面提交的） -->
    <div v-if="justSubmittedTask" class="mt-4">
      <div v-if="justSubmittedTask.status === 'queued' || justSubmittedTask.status === 'processing'" class="p-4 bg-blue-50 rounded-xl border border-blue-100">
        <p class="font-medium text-blue-800 text-sm mb-1">{{ justSubmittedTask.status === 'queued' ? '⏳ 已加入队列' : '🤖 AI 分析中…' }}</p>
        <p class="text-blue-600 text-xs">{{ justSubmittedTask.progress || '' }}</p>
        <p v-if="justSubmittedTask.status === 'queued' && justSubmittedTask.queuePosition > 0" class="text-blue-500 text-xs mt-1">
          第 {{ justSubmittedTask.queuePosition }} 位
          <span v-if="justSubmittedTask.etaSeconds > 0">· 预计还需 {{ formatEta(justSubmittedTask.etaSeconds) }}</span>
        </p>
      </div>
      <div v-if="justSubmittedTask.status === 'done'" class="p-4 bg-green-50 rounded-xl border border-green-100">
        <p class="font-medium text-green-800 text-sm mb-2">✅ 分析完成 — {{ justSubmittedTask.totalErrors }} 道疑似错题</p>
        <div class="flex gap-2">
          <router-link :to="`/confirm/${justSubmittedTask.taskId}`" class="inline-flex items-center gap-1 px-4 py-2 bg-amber-500 text-white rounded-lg text-sm hover:bg-amber-600 transition-colors">
            📋 确认错题 →
          </router-link>
          <router-link :to="`/review/${justSubmittedTask.taskId}`" class="inline-flex items-center gap-1 px-4 py-2 bg-gray-200 text-gray-600 rounded-lg text-sm hover:bg-gray-300 transition-colors">
            直接查看 →
          </router-link>
        </div>
      </div>
      <div v-if="justSubmittedTask.status === 'failed'" class="p-4 bg-red-50 rounded-xl border border-red-100">
        <p class="text-red-700 text-sm mb-1">❌ 分析失败{{ justSubmittedTask.error ? `：${justSubmittedTask.error}` : '' }}</p>
        <button
          @click="retryTask(justSubmittedTask.taskId)"
          :disabled="justSubmittedTask.retrying"
          class="mt-1 px-4 py-2 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 disabled:opacity-50 transition-colors"
        >{{ justSubmittedTask.retrying ? '重试中…' : '🔄 重试（不消耗上传额度）' }}</button>
      </div>
    </div>

    <div v-if="errorMessage" class="mt-4 p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 text-sm">{{ errorMessage }}</div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { authStore, authFetch } from '../utils/authStore.js'
import { registerPaperTask, paperTasks } from '../utils/paperTaskPoller.js'

const maxFiles = 10
const subjects = ['英语', '数学', '语文', '生物', '物理', '化学', '自动']
const subject = ref('英语')
const title = ref('')

// Marking method
const markingMethod = ref('red_pen')
const markingMethods = [
  { key: 'red_pen', label: '红笔批改', icon: '🔴', desc: '红笔标记位置=错题。适用于教师用红笔批改的场景。' },
  { key: 'cross_only', label: '打勾/打叉', icon: '❌', desc: '只认打叉标记为错题，打勾忽略。适用于勾叉批改。' },
  { key: 'mixed', label: '混合模式', icon: '🔀', desc: '打叉+手写字母=错题，打勾=正确。适用于复杂批改场景。' },
]
const markingMethodDesc = computed(() => markingMethods.find(m => m.key === markingMethod.value)?.desc || '')
const images = ref([])
const dragOver = ref(false)
const fileInput = ref(null)
const submitting = ref(false)
const errorMessage = ref('')
const justSubmittedTask = ref(null)

// 全局任务队列（响应式，跨页面同步 — 仅纸卷任务）
const taskFilter = ref('active') // 'active' | 'all' | 'done'
const taskTabs = computed(() => [
  { key: 'active', label: '进行中', count: paperTasks.value.filter(t => ['queued', 'processing'].includes(t.status)).length },
  { key: 'all', label: '全部', count: paperTasks.value.length },
  { key: 'done', label: '已完成', count: paperTasks.value.filter(t => t.status === 'done').length },
])
const activeTasks = computed(() => {
  const all = paperTasks.value
  if (taskFilter.value === 'active') return all.filter(t => ['queued', 'processing'].includes(t.status))
  if (taskFilter.value === 'done') return all.filter(t => t.status === 'done')
  return all
})

// Allowed file types
const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.doc', '.docx']
const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']

function isImageFile(name) {
  const ext = '.' + name.split('.').pop()?.toLowerCase()
  return imageExtensions.includes(ext)
}

function triggerFileInput() { fileInput.value?.click() }

function onFilesSelected(e) { addFiles(e.target.files); e.target.value = '' }
function onDrop(e) { dragOver.value = false; addFiles(e.dataTransfer.files) }

function addFiles(files) {
  let pending = 0
  for (const f of files) {
    if (images.value.length >= maxFiles) {
      errorMessage.value = `最多只能上传 ${maxFiles} 个文件`
      return
    }
    const ext = '.' + f.name.split('.').pop()?.toLowerCase()
    if (!allowedExtensions.includes(ext)) {
      errorMessage.value = `不支持的文件类型：${f.name}`
      continue
    }
    errorMessage.value = ''

    const isImg = isImageFile(f.name)
    if (isImg) {
      const reader = new FileReader()
      pending++
      reader.onload = (e) => {
        images.value.push({
          file: f,
          preview: e.target.result,
          base64: e.target.result.split(',')[1],
          isImage: true
        })
        if (--pending === 0) sortImages()
      }
      reader.readAsDataURL(f)
    } else {
      // PDF/Word — store file for later base64 conversion
      const reader = new FileReader()
      pending++
      reader.onload = (e) => {
        images.value.push({
          file: f,
          base64: e.target.result.split(',')[1],
          isImage: false,
          preview: null
        })
        if (--pending === 0) sortImages()
      }
      reader.readAsDataURL(f)
    }
  }
  if (pending === 0) sortImages()
}

function sortImages() {
  // 自动排序：按文件名中的数字提取页码
  images.value.sort((a, b) => {
    const numA = extractPageNumber(a.file?.name || '')
    const numB = extractPageNumber(b.file?.name || '')
    return numA - numB
  })
}

function extractPageNumber(filename) {
  // 优先匹配常见命名模式：第1页、page1、p1、-001、_02 等
  const patterns = [
    /第\s*(\d+)\s*页/i,
    /page[_\s-]*(\d+)/i,
    /[pP][_\s-]*(\d+)/,
    /[-_](\d+)(?:\.\w+)?$/,
    /^(\d+)[._\s-]/,
  ]
  for (const p of patterns) {
    const m = filename.match(p)
    if (m) return parseInt(m[1], 10)
  }
  // 兜底：提取文件名中所有数字，取最后一组（通常为页码）
  const allNums = filename.match(/\d+/g)
  if (allNums) {
    return parseInt(allNums[allNums.length - 1], 10)
  }
  return 0
}

function removeImage(i) { images.value.splice(i, 1) }
function clearImages() { images.value = [] }

function formatEta(seconds) {
  if (seconds < 60) return `${seconds}秒`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}分${s}秒` : `${m}分钟`
}

async function submit() {
  if (images.value.length === 0) return
  submitting.value = true
  errorMessage.value = ''

  try {
    const payload = {
      subject: subject.value,
      title: title.value || `${subject.value}试卷 ${new Date().toLocaleDateString('zh-CN')}`,
      markingMethod: markingMethod.value,
      images: images.value.map(i => `data:${i.file?.type || 'image/jpeg'};base64,${i.base64}`)
    }

    const res = await authFetch('/api/paper/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '提交失败')

    const taskId = data.taskId
    registerPaperTask(taskId, title.value || `${subject.value}试卷`, subject.value)

    justSubmittedTask.value = {
      taskId,
      status: 'queued',
      progress: '',
      queuePosition: data.queuePosition || 0,
      totalErrors: 0
    }

    // Clear form immediately — user can start next task right away
    images.value = []
    title.value = ''
    errorMessage.value = ''

    // Poll just this task for the inline status display
    pollSingleTask(taskId)
  } catch (e) {
    errorMessage.value = e.message
  } finally {
    submitting.value = false
  }
}

// Poll only the just-submitted task for inline status display
const POLL_INTERVAL = 3000
const MAX_POLL_TIME = 600000 // 10 min

async function pollSingleTask(taskId) {
  const startTime = Date.now()
  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    try {
      const res = await authFetch(`/api/paper/task/${taskId}`)
      const data = await res.json()
      if (!justSubmittedTask.value || justSubmittedTask.value.taskId !== taskId) return
      justSubmittedTask.value.status = data.status
      if (data.progress?.message) justSubmittedTask.value.progress = data.progress.message
      if (data.queuePosition) justSubmittedTask.value.queuePosition = data.queuePosition
      if (data.etaSeconds) justSubmittedTask.value.etaSeconds = data.etaSeconds
      if (data.status === 'done') {
        justSubmittedTask.value.totalErrors = data.result?.totalErrors || 0
        return
      }
      if (data.status === 'failed') {
        justSubmittedTask.value.error = data.error || ''
        return
      }
    } catch { break }
  }
}

// P0-2: 失败重试 — 复用服务端已持久化的原图，不重复消耗上传额度
async function retryTask(taskId) {
  if (!justSubmittedTask.value || justSubmittedTask.value.retrying) return
  justSubmittedTask.value.retrying = true
  justSubmittedTask.value.error = ''
  try {
    const res = await authFetch(`/api/paper/${taskId}/retry`, { method: 'POST' })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '重试失败')
    justSubmittedTask.value.status = 'queued'
    justSubmittedTask.value.progress = '重试已加入队列…'
    justSubmittedTask.value.queuePosition = data.queuePosition || 0
    pollSingleTask(taskId)
  } catch (e) {
    justSubmittedTask.value.error = e.message
  } finally {
    justSubmittedTask.value.retrying = false
  }
}
</script>
