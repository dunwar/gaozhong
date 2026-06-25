<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 加载中 -->
    <div v-if="loading" class="flex items-center justify-center py-32">
      <div class="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      <p class="ml-3 text-gray-500">加载试卷数据…</p>
    </div>

    <div v-else-if="session">
      <!-- ====== 顶部导航栏 ====== -->
      <header class="bg-white border-b sticky top-0 z-30 shadow-sm">
        <div class="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between">
          <div class="flex items-center gap-4">
            <h1 class="text-lg font-bold text-gray-900">📝 错题复核</h1>
            <div class="hidden sm:flex items-center gap-2 text-sm text-gray-500">
              <span class="px-2 py-0.5 bg-blue-50 text-blue-700 rounded font-medium">{{ getSubjectLabel(session.subject) }}</span>
              <span>{{ session.title || '未命名试卷' }}</span>
              <span>·</span>
              <span>{{ session.imageCount }} 页</span>
              <span>·</span>
              <span>{{ allQuestions.length }} 题</span>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <!-- 统计徽章 -->
            <span class="px-2.5 py-1 bg-red-50 text-red-700 text-xs rounded-full font-medium">
              AI: {{ session.errorCount }}
            </span>
            <span class="px-2.5 py-1 bg-green-50 text-green-700 text-xs rounded-full font-medium">
              确认: {{ confirmedSet.size }}
            </span>
            <span class="px-2.5 py-1 bg-gray-100 text-gray-500 text-xs rounded-full font-medium">
              误判: {{ rejectedSet.size }}
            </span>
            <span class="px-2.5 py-1 bg-orange-50 text-orange-700 text-xs rounded-full font-medium">
              新增: {{ addedSet.size }}
            </span>

            <button
              @click="submitReviews"
              :disabled="submitting"
              class="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors font-medium text-sm"
            >
              {{ submitting ? '提交中…' : '✅ 提交复核结果' }}
            </button>
          </div>
        </div>
      </header>

      <!-- ====== 三栏布局 ====== -->
      <div class="max-w-[1800px] mx-auto p-4 grid grid-cols-12 gap-4" style="height: calc(100vh - 65px)">
        
        <!-- 左栏：试卷图片（只读 + 缩放） -->
        <div class="col-span-3 bg-white rounded-xl shadow-sm flex flex-col overflow-hidden">
          <!-- 页签 -->
          <div class="flex gap-1 p-3 border-b bg-gray-50 flex-wrap">
            <button
              v-for="img in images"
              :key="img.pageIndex"
              @click="currentPage = img.pageIndex"
              :class="currentPage === img.pageIndex ? 'bg-blue-600 text-white shadow' : 'bg-white text-gray-600 hover:bg-gray-100 border'"
              class="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            >
              第{{ img.pageIndex }}页
              <span v-if="getPageErrorCount(img.pageIndex)" class="ml-1 text-red-400">{{ getPageErrorCount(img.pageIndex) }}</span>
            </button>
          </div>

          <!-- 缩放控件 -->
          <div class="flex items-center gap-1 px-3 py-2 border-b bg-white">
            <button @click="zoomOut" class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 text-gray-600 text-lg" title="缩小">−</button>
            <span class="text-xs text-gray-400 w-12 text-center">{{ Math.round(zoom * 100) }}%</span>
            <button @click="zoomIn" class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 text-gray-600 text-lg" title="放大">+</button>
            <button @click="zoom = 1" class="text-xs text-blue-500 hover:text-blue-700 ml-2" title="重置">重置</button>
          </div>

          <!-- 图片区域 -->
          <div class="flex-1 overflow-auto bg-gray-100 flex items-start justify-center p-2"
               @wheel.prevent="handleWheel"
               ref="imageScroll">
            <div :style="{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.15s' }">
              <img
                v-if="currentImage"
                :src="currentImage.originalUrl"
                class="max-w-none rounded shadow-md"
                :alt="'第' + currentPage + '页'"
                @error="$event.target.style.display='none'"
              />
              <p v-else class="text-gray-400 text-sm py-20">暂无图片</p>
            </div>
          </div>

          <p class="text-[11px] text-gray-400 px-3 py-2 border-t bg-gray-50 text-center">
            💡 滚轮缩放 · 仅查看红笔位置
          </p>
        </div>

        <!-- 中栏：文字版试卷（全量题目） -->
        <div class="col-span-5 bg-white rounded-xl shadow-sm flex flex-col overflow-hidden">
          <div class="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-gray-700">
              📄 文字版试卷 · {{ allQuestions.length }} 题
            </h2>
            <div class="flex gap-2">
              <button @click="expandAll = !expandAll" class="text-xs text-blue-500 hover:text-blue-700">
                {{ expandAll ? '全部折叠' : '全部展开' }}
              </button>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-3" ref="textPanel">
            <template v-for="(group, gIdx) in paginatedQuestions" :key="'pg-'+gIdx">
              <div class="mb-4" :ref="el => pageRefs[group.pageIndex] = el">
                <!-- 页码标注 -->
                <div class="flex items-center gap-2 mb-2 sticky top-0 bg-white/90 backdrop-blur py-1 z-10">
                  <span class="text-[11px] font-bold text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
                    第 {{ group.pageIndex }} 页 · {{ group.questions.length }} 题
                  </span>
                  <div class="flex-1 h-px bg-gray-100"></div>
                </div>

                <!-- 题目卡片 -->
                <div
                  v-for="q in group.questions"
                  :key="`${group.pageIndex}-${q.questionNumber}`"
                  :class="[
                    'mb-2 p-3 rounded-lg border transition-all cursor-pointer',
                    isErrorQ(q) 
                      ? 'border-red-300 bg-red-50 hover:border-red-400' 
                      : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/30'
                  ]"
                  @click="toggleErrorQ(q)"
                >
                  <div class="flex items-start gap-2">
                    <!-- 题号 -->
                    <span :class="isErrorQ(q) ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'"
                          class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {{ q.questionNumber }}
                    </span>

                    <!-- 题目内容 -->
                    <div class="flex-1 min-w-0">
                      <!-- 题目文本 -->
                      <div :class="['text-sm leading-relaxed', !expandAll && !expandedQ.has(qKey(q)) ? 'line-clamp-2' : '']">
                        <span class="font-medium text-gray-800">{{ q.questionText || '(无题干)' }}</span>
                      </div>

                      <!-- 选项 -->
                      <div v-if="q.options && Object.keys(q.options).length > 0" class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        <span v-for="(opt, k) in q.options" :key="k"
                              class="text-xs text-gray-500 font-mono">{{ k }}. {{ opt }}</span>
                      </div>

                      <!-- 题目展开按钮 -->
                      <button
                        v-if="(q.questionText || '').length > 80 && !expandAll"
                        @click.stop="expandedQ.has(qKey(q)) ? expandedQ.delete(qKey(q)) : expandedQ.add(qKey(q))"
                        class="text-xs text-blue-400 hover:text-blue-600 mt-1"
                      >
                        {{ expandedQ.has(qKey(q)) ? '收起 ▲' : '展开 ▼' }}
                      </button>

                      <!-- 已提取的答案信息 -->
                      <div v-if="q.extractedAnswer" class="mt-2 pt-2 border-t border-gray-100 text-xs space-y-1">
                        <div class="flex gap-4">
                          <span class="text-gray-500">学生答案：<strong class="text-gray-800">{{ q.extractedAnswer.studentAnswer || '—' }}</strong></span>
                          <span class="text-gray-500">红笔答案：<strong class="text-green-700">{{ q.extractedAnswer.teacherAnswer || '—' }}</strong></span>
                        </div>
                      </div>

                      <!-- 提取中 -->
                      <div v-if="extractingQ.has(qKey(q))" class="mt-2 flex items-center gap-2 text-xs text-blue-500">
                        <div class="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        AI 正在识别答案…
                      </div>
                    </div>

                    <!-- 状态图标 -->
                    <div class="flex-shrink-0 flex items-center gap-0.5">
                      <span v-if="isErrorQ(q)" class="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded-full font-medium">AI错题</span>
                      <span v-else class="text-[10px] text-gray-400">正常</span>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 右栏：错题管理 -->
        <div class="col-span-4 bg-white rounded-xl shadow-sm flex flex-col overflow-hidden">
          <div class="px-4 py-3 border-b bg-gray-50">
            <h2 class="text-sm font-semibold text-gray-700">
              📋 错题清单 · {{ errorList.length }} 道
            </h2>
          </div>

          <div class="flex-1 overflow-y-auto">
            <!-- 空状态 -->
            <div v-if="errorList.length === 0" class="flex flex-col items-center justify-center py-16 text-gray-400">
              <span class="text-4xl mb-2">🎉</span>
              <p class="text-sm">没有错题</p>
              <p class="text-xs mt-1">点击文字版中的题目可标记为错题</p>
            </div>

            <!-- 错题列表 -->
            <div class="p-3 space-y-2">
              <div
                v-for="(err, ei) in errorList"
                :key="err._key"
                :class="[
                  'p-3 rounded-lg border transition-all',
                  confirmedSet.has(err._key) ? 'border-green-300 bg-green-50' :
                  rejectedSet.has(err._key) ? 'border-gray-200 bg-gray-50 opacity-50' :
                  'border-red-300 bg-red-50'
                ]"
              >
                <!-- 题号 + 类型 -->
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="w-6 h-6 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-xs font-bold">
                      {{ err.questionNumber }}
                    </span>
                    <span class="text-xs text-gray-500">
                      {{ err.isFromAI ? 'AI 识别' : '手动添加' }}
                    </span>
                  </div>
                </div>

                <!-- 题目文本 -->
                <p class="text-xs text-gray-600 line-clamp-2 mb-2">{{ err.questionText || '(无题干)' }}</p>

                <!-- 答案区域 -->
                <div class="space-y-1.5 mb-2 text-xs">
                  <div class="flex items-center gap-2">
                    <label class="text-gray-400 w-14 flex-shrink-0">学生答案</label>
                    <input
                      v-model="err.studentAnswer"
                      class="flex-1 px-2 py-1 border border-gray-200 rounded text-gray-700 focus:border-blue-400 focus:ring-1 focus:ring-blue-100 outline-none"
                      placeholder="识别或手动输入"
                    />
                    <button
                      v-if="!err.extractingAnswer && !err.extractedAnswer"
                      @click="extractAnswer(err, ei)"
                      class="text-[10px] px-1.5 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 flex-shrink-0"
                      title="AI识别答案"
                    >🔍 识别</button>
                  </div>
                  <div class="flex items-center gap-2">
                    <label class="text-gray-400 w-14 flex-shrink-0">正确答案</label>
                    <input
                      v-model="err.teacherAnswer"
                      class="flex-1 px-2 py-1 border border-gray-200 rounded text-green-700 focus:border-green-400 focus:ring-1 focus:ring-green-100 outline-none"
                      placeholder="红笔标注的正确答案"
                    />
                  </div>
                </div>

                <!-- 提取中 -->
                <div v-if="err.extractingAnswer" class="flex items-center gap-2 text-xs text-blue-500 mb-2">
                  <div class="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  AI 正在识别答案…
                </div>

                <!-- 操作按钮 -->
                <div class="flex items-center gap-1 pt-1 border-t border-gray-100">
                  <button
                    @click="confirmError(err)"
                    :class="confirmedSet.has(err._key) ? 'bg-green-600 text-white' : 'bg-white text-gray-400 hover:text-green-600 hover:bg-green-50'"
                    class="px-2 py-1 text-xs rounded transition-colors"
                    title="确认"
                  >✅</button>
                  <button
                    @click="rejectError(err)"
                    :class="rejectedSet.has(err._key) ? 'bg-gray-500 text-white' : 'bg-white text-gray-400 hover:text-red-600 hover:bg-red-50'"
                    class="px-2 py-1 text-xs rounded transition-colors"
                    title="误判"
                  >✗</button>
                  <span class="flex-1"></span>
                  <button
                    v-if="err.isFromAI"
                    @click="removeFromError(err)"
                    class="text-[10px] text-gray-400 hover:text-red-500 transition-colors"
                    title="移出错题清单"
                  >移除</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 错误 -->
    <div v-else class="text-center py-20 text-gray-400">
      <p class="text-lg">找不到该试卷</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authFetch } from '../utils/authStore.js'

const route = useRoute()
const router = useRouter()
const sessionId = route.params.sessionId

// ===== 状态 =====
const loading = ref(true)
const submitting = ref(false)
const session = ref(null)
const images = ref([])
const allQuestions = ref([])
const errors = ref([])       // DB 中的错题记录（带 id）
const reviews = ref([])

const currentPage = ref(1)
const zoom = ref(1)
const expandAll = ref(false)
const expandedQ = reactive(new Set())
const extractingQ = reactive(new Set())

const textPanel = ref(null)
const imageScroll = ref(null)
const pageRefs = reactive({})

// 用户操作状态
const confirmedSet = reactive(new Set())
const rejectedSet = reactive(new Set())
const addedSet = reactive(new Set())     // 用户手动添加的错题 key
const errorAnswers = reactive({})         // key → { studentAnswer, teacherAnswer }

// ===== 计算属性 =====

/** 按页分组的全量题目 */
const paginatedQuestions = computed(() => {
  const groups = []
  const maxPage = Math.max(...allQuestions.value.map(q => q.pageIndex || 1), 1)
  for (let i = 1; i <= maxPage; i++) {
    const qs = allQuestions.value.filter(q => (q.pageIndex || 1) === i)
    if (qs.length > 0) groups.push({ pageIndex: i, questions: qs })
  }
  return groups
})

const currentImage = computed(() => images.value.find(i => i.pageIndex === currentPage.value))

/** 唯一键：页+题号 */
function qKey(q) {
  return `${q.pageIndex || 1}-${q.questionNumber}`
}

/** 是否标记为错题（AI + 用户手动） */
function isErrorQ(q) {
  const key = qKey(q)
  // 如果被拒绝，不算错题
  if (rejectedSet.has(key)) return false
  // AI 标记的
  if (q.isError) return true
  // 用户手动添加的
  if (addedSet.has(key)) return true
  return false
}

/** 错题列表（合并 AI + 手动） */
const errorList = computed(() => {
  const list = []
  const seen = new Set()

  // AI 识别的错题
  for (const q of allQuestions.value) {
    const key = qKey(q)
    if (q.isError && !rejectedSet.has(key) && !seen.has(key)) {
      seen.add(key)
      const dbErr = errors.value.find(e => {
        const ePage = (e.paperIndex || e.positionData?.pageIndex) || 
                       (() => { try { const p = JSON.parse(e.positionData||'{}'); return p.pageIndex } catch { return 1 } })()
        return ePage === (q.pageIndex||1) && e.topic?.includes(String(q.questionNumber))
      })
      list.push({
        _key: key,
        questionNumber: q.questionNumber,
        questionText: q.questionText || '',
        options: q.options || {},
        pageIndex: q.pageIndex || 1,
        isFromAI: true,
        errorId: dbErr?.id || null,
        studentAnswer: errorAnswers[key]?.studentAnswer || dbErr?.wrongAnswer || '',
        teacherAnswer: errorAnswers[key]?.teacherAnswer || dbErr?.correctAnswer || '',
        extractingAnswer: extractingQ.has(key),
        extractedAnswer: errorAnswers[key] || null,
        dbError: dbErr
      })
    }
  }

  // 用户手动添加的
  for (const q of allQuestions.value) {
    const key = qKey(q)
    if (addedSet.has(key) && !seen.has(key)) {
      seen.add(key)
      list.push({
        _key: key,
        questionNumber: q.questionNumber,
        questionText: q.questionText || '',
        options: q.options || {},
        pageIndex: q.pageIndex || 1,
        isFromAI: false,
        errorId: null,
        studentAnswer: errorAnswers[key]?.studentAnswer || '',
        teacherAnswer: errorAnswers[key]?.teacherAnswer || '',
        extractingAnswer: extractingQ.has(key),
        extractedAnswer: errorAnswers[key] || null
      })
    }
  }

  return list
})

function getPageErrorCount(pageIdx) {
  return errorList.value.filter(e => e.pageIndex === pageIdx).length
}

const subjectMap = {
  '数学': '📐 数学', '物理': '⚡ 物理', '化学': '🧪 化学',
  '生物': '🧬 生物', '英语': '🌍 英语', '语文': '📖 语文'
}
function getSubjectLabel(subject) {
  return subjectMap[subject] || subject
}

// ===== 图片缩放 =====
function zoomIn() { zoom.value = Math.min(3, zoom.value + 0.25) }
function zoomOut() { zoom.value = Math.max(0.25, zoom.value - 0.25) }
function handleWheel(e) {
  if (e.deltaY < 0) zoomIn()
  else zoomOut()
}

// ===== 错误标记操作 =====
function toggleErrorQ(q) {
  const key = qKey(q)

  // 如果已经是 AI 识别的错题，允许标记为误判
  if (q.isError && !rejectedSet.has(key)) {
    rejectedSet.add(key)
    confirmedSet.delete(key)
    return
  }

  // 如果已被误判，恢复为错题
  if (q.isError && rejectedSet.has(key)) {
    rejectedSet.delete(key)
    return
  }

  // 正常题目：标记为遗漏错题
  if (!q.isError) {
    if (addedSet.has(key)) {
      addedSet.delete(key)
    } else {
      addedSet.add(key)
    }
  }
}

function confirmError(err) {
  if (confirmedSet.has(err._key)) {
    confirmedSet.delete(err._key)
  } else {
    confirmedSet.add(err._key)
    rejectedSet.delete(err._key)
    
    // 如果还没提取答案，自动触发
    if (!err.extractedAnswer && !err.extractingAnswer) {
      extractAnswer(err)
    }
  }
}

function rejectError(err) {
  if (rejectedSet.has(err._key)) {
    rejectedSet.delete(err._key)
  } else {
    rejectedSet.add(err._key)
    confirmedSet.delete(err._key)
  }
}

function removeFromError(err) {
  if (err.isFromAI) {
    rejectedSet.add(err._key)
  } else {
    addedSet.delete(err._key)
  }
}

// ===== 答案提取 =====
async function extractAnswer(err) {
  const key = err._key
  if (extractingQ.has(key)) return
  
  extractingQ.add(key)

  // 找到对应的全量题目以获取 pageIndex
  const aq = allQuestions.value.find(q => qKey(q) === key)
  if (!aq) {
    extractingQ.delete(key)
    return
  }

  try {
    const res = await authFetch(`/api/paper/${sessionId}/extract-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageIndex: aq.pageIndex || 1,
        questionNumber: aq.questionNumber,
        bbox: aq.bbox || null
      })
    })

    if (!res.ok) throw new Error('识别失败')

    const data = await res.json()
    
    // 保存到 errorAnswers
    errorAnswers[key] = {
      studentAnswer: data.studentAnswer || '',
      teacherAnswer: data.teacherAnswer || '',
      confidence: data.confidence || 'low'
    }

    // 同时更新 errorList 中的条目
    const el = errorList.value.find(e => e._key === key)
    if (el) {
      el.studentAnswer = data.studentAnswer || ''
      el.teacherAnswer = data.teacherAnswer || ''
      el.extractedAnswer = { studentAnswer: data.studentAnswer || '', teacherAnswer: data.teacherAnswer || '', confidence: data.confidence || 'low' }
    }
  } catch (err) {
    console.error('答案提取失败', err)
  } finally {
    extractingQ.delete(key)
  }
}

// ===== 数据加载 =====
async function loadData() {
  try {
    const res = await authFetch(`/api/paper/${sessionId}/review`)
    if (!res.ok) throw new Error('加载失败')
    const data = await res.json()

    session.value = data.session
    images.value = data.images
    allQuestions.value = data.allQuestions || []
    errors.value = data.errors || []
    reviews.value = data.reviews || []

    // 恢复已有复核状态
    for (const r of data.reviews) {
      if (r.reviewAction === 'confirmed') {
        // 找到对应的 question key
        const dbErr = errors.value.find(e => e.id === r.errorId)
        if (dbErr) {
          const aq = allQuestions.value.find(q => {
            const ePage = dbErr.paperIndex || 1
            return (q.pageIndex || 1) === ePage && dbErr.topic?.includes(String(q.questionNumber))
          })
          if (aq) confirmedSet.add(qKey(aq))
        }
      } else if (r.reviewAction === 'rejected') {
        const dbErr = errors.value.find(e => e.id === r.errorId)
        if (dbErr) {
          const aq = allQuestions.value.find(q => {
            const ePage = dbErr.paperIndex || 1
            return (q.pageIndex || 1) === ePage && dbErr.topic?.includes(String(q.questionNumber))
          })
          if (aq) rejectedSet.add(qKey(aq))
        }
      } else if (r.reviewAction === 'added') {
        const cd = r.correctionData || {}
        const key = `${cd.pageIndex || 1}-${cd.questionNumber}`
        addedSet.add(key)
      }
    }
  } catch (err) {
    console.error('加载复核数据失败', err)
  } finally {
    loading.value = false
  }
}

// ===== 提交 =====
async function submitReviews() {
  submitting.value = true
  try {
    const reviewActions = []

    for (const q of allQuestions.value) {
      const key = qKey(q)

      if (confirmedSet.has(key)) {
        const dbErr = errors.value.find(e => {
          const ePage = e.paperIndex || 1
          return (q.pageIndex || 1) === ePage && e.topic?.includes(String(q.questionNumber))
        })
        reviewActions.push({
          errorId: dbErr?.id || null,
          action: 'confirmed',
          questionKey: key,
          questionData: {
            questionNumber: q.questionNumber,
            questionText: q.questionText || '',
            pageIndex: q.pageIndex || 1,
            studentAnswer: errorAnswers[key]?.studentAnswer || '',
            correctAnswer: errorAnswers[key]?.teacherAnswer || ''
          }
        })
      } else if (rejectedSet.has(key) && q.isError) {
        const dbErr = errors.value.find(e => {
          const ePage = e.paperIndex || 1
          return (q.pageIndex || 1) === ePage && e.topic?.includes(String(q.questionNumber))
        })
        reviewActions.push({
          errorId: dbErr?.id || null,
          action: 'rejected',
          questionKey: key
        })
      }
    }

    // 手动添加的错题
    for (const key of addedSet) {
      const q = allQuestions.value.find(q => qKey(q) === key)
      if (!q) continue
      reviewActions.push({
        action: 'added',
        questionKey: key,
        questionData: {
          questionNumber: q.questionNumber,
          questionText: q.questionText || '',
          questionType: q.questionType || 'choice',
          options: q.options || {},
          pageIndex: q.pageIndex || 1,
          studentAnswer: errorAnswers[key]?.studentAnswer || '',
          correctAnswer: errorAnswers[key]?.teacherAnswer || ''
        }
      })
    }

    if (reviewActions.length === 0) {
      alert('请先标记至少一道错题')
      submitting.value = false
      return
    }

    const res = await authFetch(`/api/paper/${sessionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewActions })
    })

    if (!res.ok) throw new Error('提交失败')
    const data = await res.json()

    alert(`复核提交成功！\n确认 ${data.results?.confirmed || 0} · 误判 ${data.results?.rejected || 0} · 新增 ${data.results?.added || 0}`)
    router.push('/error/list')
  } catch (err) {
    alert('提交失败: ' + err.message)
  } finally {
    submitting.value = false
  }
}

// ===== 图片页签点击 → 文字版同步滚动 =====
watch(currentPage, async (page) => {
  await nextTick()
  const el = pageRefs[page]
  if (el && textPanel.value) {
    textPanel.value.scrollTo({ top: el.offsetTop - 40, behavior: 'smooth' })
  }
})

// ===== 初始化 =====
onMounted(loadData)
</script>
