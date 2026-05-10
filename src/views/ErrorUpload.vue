<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 页面标题 -->
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-3">📄 错题上传</h1>
      <p class="text-lg text-gray-600">上传整张试卷照片，AI 自动识别错题并分析。可连续添加，后台排队处理。</p>
    </div>

    <!-- 上传表单区 -->
    <div class="bg-white rounded-2xl shadow-lg p-6 sm:p-8 mb-6">
      <!-- 学科选择 -->
      <div class="mb-5">
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

      <!-- 试卷名称 -->
      <div class="mb-5">
        <label class="block text-sm font-medium text-gray-700 mb-2">
          试卷名称
          <span class="text-gray-400 font-normal">（选填）</span>
        </label>
        <input
          v-model="form.title"
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="如「2024 上海一模数学」..."
        />
      </div>

      <!-- 图片上传 -->
      <div class="mb-5">
        <label class="block text-sm font-medium text-gray-700 mb-3">
          选择试卷图片
          <span class="text-gray-400 font-normal">（支持 JPG/PNG，单次最多 {{ MAX_IMAGES }} 张）</span>
        </label>

        <!-- 预览网格 -->
        <div v-if="previews.length > 0" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4">
          <div
            v-for="(preview, idx) in previews"
            :key="idx"
            class="relative group rounded-lg overflow-hidden border-2 border-gray-200"
          >
            <img :src="preview" class="w-full h-32 object-cover" alt="预览" />
            <button
              @click="removePreview(idx)"
              class="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
            >✕</button>
            <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-1">
              第 {{ idx + 1 }} 页
            </div>
          </div>

          <label
            v-if="previews.length < MAX_IMAGES"
            class="border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center h-32 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-all"
          >
            <svg class="w-7 h-7 text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
            </svg>
            <span class="text-xs text-gray-400">添加</span>
            <input type="file" accept="image/*" multiple class="hidden" @change="addPreviews" />
          </label>
        </div>

        <!-- 空状态上传区 -->
        <label
          v-else
          class="border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center justify-center py-12 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-all"
        >
          <svg class="w-10 h-10 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
          </svg>
          <p class="text-gray-500 font-medium mb-1">点击选择试卷图片</p>
          <p class="text-gray-400 text-sm">支持 JPG、PNG，可多选</p>
          <input type="file" accept="image/*" multiple class="hidden" @change="addPreviews" />
        </label>
      </div>

      <!-- 加入队列按钮 -->
      <button
        @click="enqueueTask"
        :disabled="previews.length === 0"
        class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-4 rounded-xl transition-all"
      >
        <span v-if="previews.length > 0">📥 加入分析队列 · {{ form.subject }} · {{ previews.length }} 页</span>
        <span v-else>请先选择试卷图片</span>
      </button>

      <div v-if="errorMessage" class="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
        {{ errorMessage }}
      </div>
    </div>

    <!-- 队列卡片列表 -->
    <div v-if="queue.length > 0" class="space-y-4">
      <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
        📋 分析队列
        <span class="text-sm font-normal text-gray-400">（{{ queue.length }} 份试卷）</span>
      </h2>

      <div
        v-for="(item, qi) in queue"
        :key="item.localId"
        class="bg-white rounded-xl shadow-md p-5 transition-all"
        :class="item.status === 'done' ? 'border-l-4 border-green-400' : item.status === 'failed' ? 'border-l-4 border-red-400' : 'border-l-4 border-blue-400'"
      >
        <!-- 卡片头部 -->
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-3">
            <!-- 状态图标 -->
            <div class="flex-shrink-0">
              <div v-if="item.status === 'queued'" class="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
              </div>
              <div v-else-if="item.status === 'processing'" class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                <svg class="animate-spin w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <div v-else-if="item.status === 'done'" class="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                <svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
              </div>
              <div v-else-if="item.status === 'failed'" class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </div>
            </div>

            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-gray-900 text-lg">
                  {{ getSubjectLabel(item.subject) }}
                </span>
                <span class="text-sm text-gray-500">{{ item.title || '未命名试卷' }}</span>
              </div>
              <p class="text-sm text-gray-400 mt-0.5">
                {{ item.pageCount }} 页试卷
                <span v-if="item.createdAt" class="mx-1">·</span>
                <span v-if="item.createdAt">{{ formatTime(item.createdAt) }}</span>
              </p>
            </div>
          </div>

          <!-- 右侧：操作按钮 -->
          <div class="flex-shrink-0 flex items-center gap-2">
            <button
              v-if="item.status === 'done'"
              @click="viewErrors(item)"
              class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              查看错题
            </button>
            <button
              @click="removeFromQueue(qi)"
              class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="移除"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
              </svg>
            </button>
          </div>
        </div>

        <!-- 进度信息 -->
        <div v-if="item.status === 'queued' || item.status === 'processing'" class="space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-600">
              <template v-if="item.status === 'queued'">🕐 排队中…</template>
              <template v-else>{{ item.progress?.message || '🔄 处理中…' }}</template>
            </span>
            <span v-if="item.etaText" class="text-gray-400">{{ item.etaText }}</span>
          </div>
          <!-- 进度条 -->
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div
              class="h-2 rounded-full transition-all duration-1000"
              :class="item.status === 'processing' ? 'bg-blue-500 animate-pulse' : 'bg-gray-300'"
              :style="{ width: progressWidth(item) }"
            ></div>
          </div>
        </div>

        <!-- 完成摘要 -->
        <div v-if="item.status === 'done' && item.result" class="mt-3">
          <div class="flex flex-wrap gap-2 items-center">
            <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg text-sm font-medium">
              ✅ 分析完成
            </span>
            <span class="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm">
              共 {{ item.result.totalQuestions || item.result.totalErrors || 0 }} 道错题
            </span>
            <span v-if="item.result.pipeline" class="px-2 py-1 bg-gray-100 text-gray-500 rounded text-xs">
              {{ item.result.pipeline }}
            </span>
          </div>
        </div>

        <!-- 失败信息 -->
        <div v-if="item.status === 'failed'" class="mt-3">
          <p class="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
            ❌ {{ item.error || '分析失败，请重试' }}
          </p>
          <button
            @click="retryTask(qi)"
            class="mt-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            🔄 重新分析
          </button>
        </div>
      </div>

      <!-- 全部完成提示 -->
      <div
        v-if="queue.length > 0 && queue.every(q => q.status === 'done' || q.status === 'failed')"
        class="mt-6 p-6 bg-green-50 rounded-xl text-center"
      >
        <p class="text-green-700 font-medium text-lg">🎉 队列全部处理完成！</p>
        <div class="mt-3 flex flex-wrap gap-3 justify-center">
          <router-link
            to="/errors"
            class="inline-flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            查看错题本 →
          </router-link>
          <router-link
            to="/knowledge"
            class="inline-flex items-center gap-2 bg-white text-blue-600 px-5 py-2.5 rounded-lg hover:bg-blue-50 transition-colors font-medium border border-blue-200"
          >
            知识点分析 →
          </router-link>
        </div>
      </div>
    </div>

    <!-- 空状态提示 -->
    <div v-if="queue.length === 0 && !errorMessage" class="mt-6 text-center py-12">
      <div class="text-4xl mb-3">📋</div>
      <p class="text-gray-400">还没有上传试卷，选择图片加入队列即可自动分析</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { authFetch } from '../utils/authStore.js'

const router = useRouter()

const subjects = [
  { value: '数学', label: '📐 数学', activeClass: 'bg-blue-600 text-white' },
  { value: '物理', label: '⚡ 物理', activeClass: 'bg-purple-600 text-white' },
  { value: '化学', label: '🧪 化学', activeClass: 'bg-green-600 text-white' },
  { value: '生物', label: '🧬 生物', activeClass: 'bg-teal-600 text-white' },
  { value: '英语', label: '🌍 英语', activeClass: 'bg-orange-600 text-white' },
  { value: '语文', label: '📖 语文', activeClass: 'bg-red-600 text-white' },
]
const subjectMap = {}
subjects.forEach(s => { subjectMap[s.value] = s.label })

function getSubjectLabel(subject) {
  return subjectMap[subject] || subject
}

const MAX_IMAGES = 10
const POLL_INTERVAL = 4000
const MAX_POLL_TIME = 360000 // 6 分钟

const form = reactive({ subject: '数学', title: '', images: [] })
const previews = ref([])
const errorMessage = ref('')

// 队列项结构
function createQueueItem(subject, title, images, previews) {
  return {
    localId: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    subject,
    title,
    images: [...images],
    previews: [...previews],
    pageCount: images.length,
    taskId: null,
    status: 'queued',    // queued | processing | done | failed
    progress: null,
    result: null,
    error: null,
    etaText: '',
    createdAt: Date.now(),
    pollTimer: null
  }
}

const queue = ref([])
const pollingMap = {} // taskId → timer

// 从 sessionStorage 恢复队列状态
function saveQueue() {
  try {
    const slim = queue.value.map(q => ({
      localId: q.localId,
      subject: q.subject,
      title: q.title,
      pageCount: q.pageCount,
      taskId: q.taskId,
      status: q.status,
      progress: q.progress,
      result: q.result,
      error: q.error,
      etaText: q.etaText,
      createdAt: q.createdAt
    }))
    sessionStorage.setItem('gaozhong_upload_queue', JSON.stringify(slim))
  } catch (_) {}
}

function restoreQueue() {
  try {
    const raw = sessionStorage.getItem('gaozhong_upload_queue')
    if (!raw) return
    const data = JSON.parse(raw)
    // 恢复已完成/失败的任务（不含图片数据，不可重试）
    const restored = data.map(d => ({
      ...d,
      images: [],
      previews: [],
      pollTimer: null,
      status: d.status === 'processing' ? 'queued' : d.status // processing 恢复为 queued
    }))
    if (restored.length > 0) {
      queue.value = restored
      // 为未完成的任务恢复轮询
      for (const item of queue.value) {
        if (item.status === 'queued' && item.taskId) {
          startPolling(item)
        }
      }
    }
  } catch (_) {}
}

// 添加预览图片
function addPreviews(e) {
  const files = Array.from(e.target.files || [])
  const remaining = MAX_IMAGES - previews.value.length
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
  e.target.value = ''
}

function removePreview(idx) {
  form.images.splice(idx, 1)
  previews.value.splice(idx, 1)
}

// 加入队列
async function enqueueTask() {
  if (previews.value.length === 0) return
  errorMessage.value = ''

  const item = createQueueItem(form.subject, form.title, form.images, previews.value)
  queue.value.push(item)
  saveQueue()

  // 清空表单
  form.images = []
  previews.value = []
  form.title = ''

  // 提交 API
  try {
    const res = await authFetch('/api/paper/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: item.subject,
        images: item.images,
        title: item.title || ''
      })
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || '提交失败')
    }

    const data = await res.json()
    item.taskId = data.taskId
    item.status = 'queued'
    item.etaText = formatEta(data.etaSeconds || 90)
    saveQueue()

    // 开始轮询
    startPolling(item)
  } catch (err) {
    item.status = 'failed'
    item.error = err.message || '提交失败'
    saveQueue()
  }
}

// ETA 格式化
function formatEta(seconds) {
  if (seconds <= 0) return ''
  const min = Math.ceil(seconds / 60)
  if (min <= 1) return '预计 1 分钟内'
  if (min <= 5) return `预计 ${min} 分钟`
  return `预计 ${min} 分钟`
}

// 进度条宽度
function progressWidth(item) {
  if (item.status === 'queued') return '8%'
  if (item.status === 'processing') {
    const prog = item.progress
    if (prog?.stage === 'preprocess') return '15%'
    if (prog?.stage === 'scan-v5') return `${15 + Math.round(((prog.current || 0) / (prog.total || 1)) * 50)}%`
    if (prog?.stage === 'analyze-deepseek') return '85%'
    return '40%'
  }
  if (item.status === 'done') return '100%'
  return '0%'
}

// 轮询单个任务
function startPolling(item) {
  let startTime = Date.now()

  const poll = async () => {
    if (!item.taskId) return stopPolling(item)
    if (Date.now() - startTime > MAX_POLL_TIME) {
      item.status = 'failed'
      item.error = '分析超时，请重试'
      saveQueue()
      return stopPolling(item)
    }

    try {
      const res = await authFetch(`/api/paper/task/${item.taskId}`)
      if (!res.ok) return
      const data = await res.json()

      item.etaText = data.etaSeconds > 0 ? formatEta(data.etaSeconds) : ''

      if (data.status === 'processing') {
        item.status = 'processing'
        item.progress = data.progress || null
        saveQueue()
      } else if (data.status === 'done') {
        item.status = 'done'
        item.result = data.result
        item.progress = null
        item.etaText = ''
        saveQueue()
        stopPolling(item)
        notifyComplete(item)
      } else if (data.status === 'failed') {
        item.status = 'failed'
        item.error = data.error || '分析失败'
        saveQueue()
        stopPolling(item)
      }
    } catch (_) {
      // 网络异常，继续重试
    }
  }

  // 立即执行一次
  poll()
  // 定时轮询
  const timer = setInterval(poll, POLL_INTERVAL)
  item._pollTimer = timer
  pollingMap[item.localId] = timer
}

function stopPolling(item) {
  if (item._pollTimer) {
    clearInterval(item._pollTimer)
    item._pollTimer = null
    delete pollingMap[item.localId]
  }
}

// 浏览器通知
function notifyComplete(item) {
  const subject = getSubjectLabel(item.subject)
  const errors = item.result?.totalErrors || item.result?.totalQuestions || 0

  // Web Notification API
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`${subject} 分析完成`, {
      body: `识别出 ${errors} 道错题，点击查看`,
      icon: '/favicon.ico'
    })
  }

  // 请求通知权限（仅在首次时）
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

// 查看错题
function viewErrors(item) {
  router.push('/errors')
}

function removeFromQueue(idx) {
  const item = queue.value[idx]
  stopPolling(item)
  queue.value.splice(idx, 1)
  saveQueue()
}

function retryTask(qi) {
  const item = queue.value[qi]
  item.status = 'queued'
  item.error = null
  item.result = null
  saveQueue()
  // 重新提交
  authFetch('/api/paper/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: item.subject,
      images: item.images,
      title: item.title || ''
    })
  }).then(async res => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || '提交失败')
    }
    const data = await res.json()
    item.taskId = data.taskId
    saveQueue()
    startPolling(item)
  }).catch(err => {
    item.status = 'failed'
    item.error = err.message
    saveQueue()
  })
}

function formatTime(ts) {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// 初始化
onMounted(() => {
  restoreQueue()
  // 请求通知权限
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
})

// 清理
onUnmounted(() => {
  for (const item of queue.value) {
    stopPolling(item)
  }
})
</script>
