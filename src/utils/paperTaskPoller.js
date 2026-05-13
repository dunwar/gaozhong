/**
 * 全局试卷任务轮询器
 * 在 App.vue 挂载后持续运行，跨页面保持活跃
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { authStore, authFetch } from './authStore.js'
import { loadTasks, addTask, updateTask } from './taskStore.js'

const POLL_INTERVAL = 4000
const MAX_ACTIVE = 8

// 响应式任务列表，任何页面都能引用
export const paperTasks = ref([])
export const paperPolling = ref(false)

let pollTimer = null

/** 刷新所有进行中的试卷任务 */
async function refreshPaperTasks() {
  const all = loadTasks()
  const paperJobs = all.filter(t => t.inputType === 'paper' && ['queued', 'processing'].includes(t.status))

  // 没有活跃任务就跳过
  if (paperJobs.length === 0) {
    // 仍保留最近完成的任务
    paperTasks.value = all.filter(t => ['queued', 'processing', 'done'].includes(t.status)).slice(0, MAX_ACTIVE)
    return
  }

  // 批量轮询服务端状态
  const updates = await Promise.allSettled(
    paperJobs.map(async (t) => {
      try {
        const res = await authFetch(`/api/paper/task/${t.taskId}`)
        const data = await res.json()
        return { taskId: t.taskId, data }
      } catch { return null }
    })
  )

  for (const u of updates) {
    if (!u || u.status !== 'fulfilled' || !u.value) continue
    const { taskId, data } = u.value
    if (data.status === 'done') {
      updateTask(taskId, { status: 'done', totalErrors: data.result?.totalErrors || 0, progress: data.progress?.message })
    } else if (data.status === 'failed') {
      updateTask(taskId, { status: 'failed' })
    } else {
      updateTask(taskId, {
        status: data.status,
        progress: data.progress?.message,
        queuePosition: data.queuePosition,
        etaSeconds: data.etaSeconds
      })
    }
  }

  // 更新响应式列表（仅纸卷任务，排除作文批改）
  paperTasks.value = loadTasks()
    .filter(t => t.inputType === 'paper' && ['queued', 'processing', 'done'].includes(t.status))
    .slice(0, MAX_ACTIVE)
}

/** 提交试卷后注册并立即加入轮询 */
export function registerPaperTask(taskId, title, subject) {
  addTask({ taskId, topic: title, title, inputType: 'paper', subject })
  refreshPaperTasks()
}

/** 启动全局轮询（App.vue onMounted 调用） */
export function startPaperPolling() {
  if (paperPolling.value) return
  paperPolling.value = true
  refreshPaperTasks()
  pollTimer = setInterval(refreshPaperTasks, POLL_INTERVAL)
}

/** 停止轮询（App.vue onUnmounted 调用） */
export function stopPaperPolling() {
  paperPolling.value = false
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
