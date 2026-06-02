/**
 * 整卷分析任务追踪 — localStorage
 *
 * 学生提交整卷分析后，taskId 存入本地，刷新页面不丢失。
 * PaperReview / Upload 页面读取此数据轮询服务端状态。
 */

const STORAGE_KEY = 'gaozhong_paper_tasks'
const MAX_TASKS = 50
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function loadPaperTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function savePaperTasks(tasks) {
  const now = Date.now()
  const cleaned = tasks
    .filter(t => now - t.createdAt < TASK_TTL_MS)
    .slice(0, MAX_TASKS)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
}

export function addPaperTask({ taskId, subject = '', title = '', pageCount = 0 }) {
  const tasks = loadPaperTasks()
  // 去重
  const exists = tasks.find(t => t.taskId === taskId)
  if (exists) return
  tasks.unshift({
    taskId,
    status: 'queued',
    subject,
    title: title || `未命名试卷 · ${subject}`,
    pageCount,
    progress: null,
    errorCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  savePaperTasks(tasks)
}

export function updatePaperTask(taskId, patch) {
  const tasks = loadPaperTasks()
  const idx = tasks.findIndex(t => t.taskId === taskId)
  if (idx === -1) return
  tasks[idx] = { ...tasks[idx], ...patch, updatedAt: Date.now() }
  savePaperTasks(tasks)
}

export function getPaperTasks(filter = 'all') {
  const tasks = loadPaperTasks()
  if (filter === 'pending') return tasks.filter(t => t.status === 'queued' || t.status === 'processing')
  if (filter === 'done') return tasks.filter(t => t.status === 'done')
  return tasks
}

export function getPaperPendingCount() {
  return getPaperTasks('pending').length
}

export function hasPaperUnread() {
  return loadPaperTasks().some(t => t.status === 'done' && !t.viewed)
}

export function getPaperUnreadCount() {
  return loadPaperTasks().filter(t => t.status === 'done' && !t.viewed).length
}

export function markPaperViewed(taskId) {
  updatePaperTask(taskId, { viewed: true })
}

export function markAllPaperViewed() {
  const tasks = loadPaperTasks()
  tasks.forEach(t => { if (t.status === 'done') t.viewed = true })
  savePaperTasks(tasks)
}

export function getPaperTask(taskId) {
  return loadPaperTasks().find(t => t.taskId === taskId) || null
}

export function removePaperTask(taskId) {
  const tasks = loadPaperTasks().filter(t => t.taskId !== taskId)
  savePaperTasks(tasks)
}
