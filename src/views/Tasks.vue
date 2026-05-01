<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">我的任务</h1>
      <p class="text-gray-600">追踪你的作文批改进度，查看已完成的结果</p>
    </div>

    <!-- Tab 切换 -->
    <div class="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        :class="[
          'flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all',
          activeTab === tab.key
            ? 'bg-white text-gray-900 shadow-sm'
            : 'text-gray-500 hover:text-gray-700'
        ]"
      >
        {{ tab.label }}
        <span
          v-if="tab.key === 'pending' && pendingCount > 0"
          class="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs bg-blue-600 text-white rounded-full"
        >{{ pendingCount }}</span>
      </button>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="text-center py-16 text-gray-400">
      <svg class="animate-spin h-8 w-8 mx-auto mb-3 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
      加载中...
    </div>

    <!-- 空状态 -->
    <div v-else-if="displayTasks.length === 0" class="text-center py-16">
      <div class="text-5xl mb-4">📝</div>
      <p class="text-gray-500 mb-4" v-if="activeTab === 'all'">还没有提交过批改任务</p>
      <p class="text-gray-500 mb-4" v-else-if="activeTab === 'pending'">没有进行中的任务</p>
      <p class="text-gray-500 mb-4" v-else>还没有完成的批改</p>
      <router-link
        to="/upload"
        class="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700 transition"
      >去提交作文</router-link>
    </div>

    <!-- 任务列表 -->
    <div v-else class="space-y-3">
      <div
        v-for="task in displayTasks"
        :key="task.taskId"
        class="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-all overflow-hidden"
      >
        <!-- 进行中任务 -->
        <div v-if="task.status === 'queued' || task.status === 'processing'" class="p-5">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-medium text-gray-900 truncate">
                  {{ task.topic || '(无题目)' }}
                </span>
                <span class="px-1.5 py-0.5 text-[10px] rounded font-medium uppercase"
                  :class="task.inputType === 'image' ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'"
                >{{ task.inputType === 'image' ? '图片' : '文本' }}</span>
              </div>
              <div class="text-xs text-gray-400">{{ formatTime(task.createdAt) }}</div>
            </div>
            <div class="ml-4 flex items-center gap-3">
              <div class="flex items-center gap-2">
                <span class="relative flex h-2.5 w-2.5">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                    :class="task.status === 'processing' ? 'bg-blue-400' : 'bg-yellow-400'"
                  ></span>
                  <span class="relative inline-flex rounded-full h-2.5 w-2.5"
                    :class="task.status === 'processing' ? 'bg-blue-500' : 'bg-yellow-500'"
                  ></span>
                </span>
                <span class="text-sm font-medium"
                  :class="task.status === 'processing' ? 'text-blue-600' : 'text-yellow-600'"
                >{{ task.status === 'processing' ? '批改中...' : '排队中...' }}</span>
              </div>
            </div>
          </div>
          <!-- 进度 -->
          <div v-if="task.progress" class="mt-3 text-xs text-gray-500">
            {{ task.progress }}
          </div>
        </div>

        <!-- 失败任务 -->
        <div v-else-if="task.status === 'failed'" class="p-5 border-l-4 border-red-400">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <span class="text-sm font-medium text-gray-900 truncate">{{ task.topic || '(无题目)' }}</span>
              <div class="text-xs text-red-500 mt-1">{{ task.error || '批改失败' }}</div>
            </div>
            <span class="text-sm text-red-500">失败</span>
          </div>
        </div>

        <!-- 已完成任务 -->
        <router-link
          v-else-if="task.status === 'done'"
          :to="`/result/${task.taskId}`"
          @click="onViewResult(task.taskId)"
          class="block p-5 hover:bg-gray-50 transition-colors"
          :class="{ 'bg-blue-50/50': !task.viewed }"
        >
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-medium text-gray-900 truncate">{{ task.topic || '(无题目)' }}</span>
                <span
                  v-if="!task.viewed"
                  class="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0"
                  title="新结果"
                ></span>
              </div>
              <div class="text-xs text-gray-400">{{ formatTime(task.createdAt) }}</div>
            </div>
            <div class="ml-4 flex items-center gap-3">
              <span class="text-lg font-bold" :class="getScoreColor(task.totalScore)">
                {{ task.totalScore || '—' }}
              </span>
              <span
                class="px-2 py-0.5 rounded text-xs font-medium"
                :class="getGradeClass(task.grade)"
              >{{ task.grade || '查看' }}</span>
              <svg class="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
              </svg>
            </div>
          </div>
          <div v-if="task.summary" class="mt-2 text-xs text-gray-500 line-clamp-1">
            {{ task.summary }}
          </div>
        </router-link>
      </div>
    </div>

    <!-- 返回 -->
    <div class="text-center mt-8">
      <router-link to="/upload" class="text-blue-600 hover:text-blue-700 text-sm">→ 提交新作文</router-link>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { loadTasks, getPendingCount, updateTask, markViewed } from '../utils/taskStore.js'

const tabs = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '进行中' },
  { key: 'done', label: '已完成' },
]

const activeTab = ref('all')
const loading = ref(true)
const tasks = ref([])
const pendingCount = ref(0)
let pollTimer = null

const POLL_INTERVAL = 3000

const displayTasks = computed(() => {
  if (activeTab.value === 'all') return tasks.value
  if (activeTab.value === 'pending') return tasks.value.filter(t => t.status === 'queued' || t.status === 'processing')
  return tasks.value.filter(t => t.status === 'done')
})

// 从 localStorage 加载 + 从服务端同步状态
async function refreshTasks() {
  const local = loadTasks()
  pendingCount.value = getPendingCount()

  // 轮询进行中任务
  const pending = local.filter(t => t.status === 'queued' || t.status === 'processing')
  for (const task of pending) {
    try {
      const res = await fetch(`/api/task/${task.taskId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.status === 'done') {
          // 获取结果摘要
          updateTask(task.taskId, {
            status: 'done',
            totalScore: data.result?.totalScore,
            grade: data.result?.grade,
            summary: data.result?.oneSentenceSummary
          })
        } else if (data.status === 'failed') {
          updateTask(task.taskId, {
            status: 'failed',
            error: data.error
          })
        } else {
          // 更新进度
          const patch = { status: data.status }
          if (data.progress?.message) patch.progress = data.progress.message
          updateTask(task.taskId, patch)
        }
      } else if (res.status === 404) {
        // 任务已过期
        updateTask(task.taskId, { status: 'expired', error: '任务已过期' })
      }
    } catch {
      // 网络错误，跳过
    }
  }

  tasks.value = loadTasks()
}

function onViewResult(taskId) {
  markViewed(taskId)
}

function getScoreColor(score) {
  if (!score && score !== 0) return 'text-gray-400'
  if (score >= 56) return 'text-green-600'
  if (score >= 42) return 'text-yellow-600'
  return 'text-red-600'
}

function getGradeClass(grade) {
  if (!grade) return 'bg-gray-100 text-gray-600'
  if (grade.includes('一')) return 'bg-green-100 text-green-700'
  if (grade.includes('二')) return 'bg-blue-100 text-blue-700'
  if (grade.includes('三')) return 'bg-yellow-100 text-yellow-700'
  return 'bg-red-100 text-red-700'
}

function formatTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  await refreshTasks()
  loading.value = false
  pollTimer = setInterval(refreshTasks, POLL_INTERVAL)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
