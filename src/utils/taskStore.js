/**
 * 客户端任务追踪 — localStorage
 *
 * 用户提交批改后，taskId 存入本地，刷新页面不丢失。
 * Tasks 页面读取此数据轮询服务端状态。
 */

const STORAGE_KEY = 'gaozhong_tasks'
const MAX_TASKS = 100
const TASK_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveTasks(tasks) {
  // 清理过期 + 限制数量
  const now = Date.now()
  const cleaned = tasks
    .filter(t => now - t.createdAt < TASK_TTL_MS)
    .slice(0, MAX_TASKS)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
}

export function addTask({ taskId, topic = '', inputType = 'text' }) {
  const tasks = loadTasks()
  tasks.unshift({
    taskId,
    status: 'queued',
    topic,
    inputType,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  saveTasks(tasks)
}

export function updateTask(taskId, patch) {
  const tasks = loadTasks()
  const idx = tasks.findIndex(t => t.taskId === taskId)
  if (idx === -1) return
  tasks[idx] = { ...tasks[idx], ...patch, updatedAt: Date.now() }
  saveTasks(tasks)
}

export function getTasks(filter = 'all') {
  const tasks = loadTasks()
  if (filter === 'pending') return tasks.filter(t => t.status === 'queued' || t.status === 'processing')
  if (filter === 'done') return tasks.filter(t => t.status === 'done')
  return tasks
}

export function getPendingCount() {
  return getTasks('pending').length
}

export function hasUnread() {
  return loadTasks().some(t => t.status === 'done' && !t.viewed)
}

export function getUnreadCount() {
  return loadTasks().filter(t => t.status === 'done' && !t.viewed).length
}

export function markViewed(taskId) {
  updateTask(taskId, { viewed: true })
}

export function markAllViewed() {
  const tasks = loadTasks()
  tasks.forEach(t => { if (t.status === 'done') t.viewed = true })
  saveTasks(tasks)
}
