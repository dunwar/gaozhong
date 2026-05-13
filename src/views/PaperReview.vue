<template>
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-20">
      <div class="inline-block animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full"></div>
      <p class="mt-4 text-gray-500">加载试卷数据…</p>
    </div>

    <!-- 复核界面 -->
    <div v-else-if="session">
      <!-- 顶部导航 -->
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-gray-900">
            📝 错题复核
          </h1>
          <p class="text-gray-600 mt-1">
            {{ getSubjectLabel(session.subject) }} · {{ session.title || '未命名试卷' }}
            <span class="mx-2">·</span>
            {{ session.imageCount }} 页
          </p>
        </div>
        <div class="flex gap-2">
          <button
            @click="submitReviews"
            :disabled="submitting"
            class="px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors font-medium"
          >
            {{ submitting ? '提交中…' : '✅ 提交复核结果' }}
          </button>
          <router-link
            to="/errors"
            class="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            ← 返回错题本
          </router-link>
        </div>
      </div>

      <!-- 统计栏 -->
      <div class="bg-white rounded-xl shadow-sm p-4 mb-6 flex flex-wrap gap-4 text-sm">
        <span class="px-3 py-1 bg-gray-100 rounded-lg">
          AI 识别：<strong>{{ session.errorCount }}</strong> 道错题
        </span>
        <span class="px-3 py-1 bg-green-50 text-green-700 rounded-lg">
          已确认：<strong>{{ confirmedCount }}</strong>
        </span>
        <span class="px-3 py-1 bg-red-50 text-red-700 rounded-lg">
          误判：<strong>{{ rejectedCount }}</strong>
        </span>
        <span class="px-3 py-1 bg-blue-50 text-blue-700 rounded-lg">
          已修正：<strong>{{ correctedCount }}</strong>
        </span>
        <span class="px-3 py-1 bg-orange-50 text-orange-700 rounded-lg">
          新增：<strong>{{ addedErrors.length }}</strong>
        </span>
      </div>

      <!-- 主内容：左图片 + 右错题列表 -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- 左侧：试卷图片 -->
        <div class="bg-white rounded-xl shadow-sm p-4">
          <div class="flex items-center gap-2 mb-3">
            <label class="text-sm font-medium text-gray-700">试卷图片：</label>
            <div class="flex gap-1">
              <button
                v-for="img in images"
                :key="img.pageIndex"
                @click="currentPage = img.pageIndex"
                :class="currentPage === img.pageIndex ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
                class="px-3 py-1 rounded text-sm transition-colors"
              >
                第{{ img.pageIndex }}页
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2 mb-3">
            <span class="text-xs text-gray-500">视图：</span>
            <button @click="viewMode='original'" :class="viewMode==='original'?'bg-gray-700 text-white':'bg-gray-100'" class="px-2 py-0.5 rounded text-xs">原图</button>
            <button @click="viewMode='red'" :class="viewMode==='red'?'bg-red-600 text-white':'bg-gray-100'" class="px-2 py-0.5 rounded text-xs">🔴红笔</button>
            <button @click="viewMode='annotated'" :class="viewMode==='annotated'?'bg-purple-600 text-white':'bg-gray-100'" class="px-2 py-0.5 rounded text-xs">🟣标注</button>
          </div>

          <div class="relative border border-gray-200 rounded-lg overflow-hidden bg-gray-50 cursor-crosshair"
               @click="addMarkByClick"
               ref="imageContainer">
            <img
              :src="currentViewUrl"
              class="w-full"
              alt="试卷图片"
              @load="onImageLoad"
              @error="onImageError"
            />
            <div v-if="imageLoadError" class="absolute inset-0 flex items-center justify-center bg-gray-100 text-gray-400 text-sm">
              {{ viewMode === 'red' ? '红笔图未生成' : viewMode === 'annotated' ? '标注图未生成' : '图片加载失败' }}
            </div>

            <!-- AI 标记的错题位置叠加层 -->
            <div
              v-for="(mark, mi) in currentImageMarks"
              :key="'ai-' + mi"
              class="absolute"
              :style="markStyle(mark)"
              @click.stop="scrollToError(mark.errorId)"
            >
              <div
                class="w-5 h-5 rounded-full bg-red-500 border-2 border-white shadow-md flex items-center justify-center cursor-pointer hover:scale-125 transition-transform animate-pulse"
                :title="mark.label"
              >
                <span class="text-white text-[10px] font-bold">×</span>
              </div>
            </div>

            <!-- 用户添加的新标记 -->
            <div
              v-for="(mark, mi) in userAddedMarks"
              :key="'user-' + mi"
              class="absolute"
              :style="{ left: mark.x + '%', top: mark.y + '%' }"
            >
              <div class="w-5 h-5 rounded-full bg-orange-500 border-2 border-white shadow-md flex items-center justify-center cursor-pointer hover:scale-125 transition-transform"
                   title="用户标记">
                <span class="text-white text-[10px] font-bold">+</span>
              </div>
            </div>
          </div>

          <p class="text-xs text-gray-400 mt-2 text-center">
            🔴 红点 = AI 识别位置 | 🟠 橙点 = 你添加的标记 | 点击图片可添加遗漏错题
          </p>
        </div>

        <!-- 右侧：错题列表 -->
        <div class="bg-white rounded-xl shadow-sm p-4 max-h-[75vh] overflow-y-auto">
          <h3 class="text-sm font-semibold text-gray-700 mb-3">
            AI 识别结果（{{ errors.length }} 道）
          </h3>

          <div v-if="errors.length === 0" class="text-center py-12 text-gray-400">
            <p class="text-lg mb-2">🎉 没有错题！</p>
            <p class="text-sm">如果发现遗漏，可以点击左侧图片手动添加</p>
          </div>

          <div class="space-y-3">
            <div
              v-for="(err, ei) in errors"
              :key="err.id"
              :ref="el => errorRefs[err.id] = el"
              :class="[
                'p-4 rounded-lg border transition-all',
                reviewStates[err.id] === 'confirmed' ? 'border-green-300 bg-green-50' :
                reviewStates[err.id] === 'rejected' ? 'border-red-300 bg-red-50 opacity-60' :
                reviewStates[err.id] === 'corrected' ? 'border-blue-300 bg-blue-50' :
                'border-gray-200 hover:border-gray-300'
              ]"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex-shrink-0">
                      {{ err.questionNumber || err.topic?.match(/\d+/)?.[0] || '?' }}
                    </span>
                    <span class="text-sm font-medium text-gray-900 line-clamp-1">
                      {{ err.topic || err.questionText?.substring(0, 40) || '未知题目' }}
                    </span>
                  </div>
                  <div class="text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
                    <span v-if="err.studentAnswer">学生答：<strong>{{ err.studentAnswer || err.wrongAnswer }}</strong></span>
                    <span v-if="err.correctAnswer">→ 正答：<strong class="text-green-700">{{ err.correctAnswer }}</strong></span>
                    <span v-if="err.gradingEvidence" class="text-red-600">「{{ err.gradingEvidence }}」</span>
                  </div>
                </div>

                <!-- 操作按钮 -->
                <div class="flex items-center gap-1 flex-shrink-0">
                  <button
                    @click="confirmError(err.id)"
                    :class="reviewStates[err.id] === 'confirmed' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-green-50 hover:text-green-600'"
                    class="p-1.5 rounded transition-colors text-xs"
                    title="确认准确"
                  >✅</button>
                  <button
                    @click="startCorrect(err, ei)"
                    :class="reviewStates[err.id] === 'corrected' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600'"
                    class="p-1.5 rounded transition-colors text-xs"
                    title="修正内容"
                  >✏️</button>
                  <button
                    @click="rejectError(err.id)"
                    :class="reviewStates[err.id] === 'rejected' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600'"
                    class="p-1.5 rounded transition-colors text-xs"
                    title="标记误判"
                  >✗</button>
                </div>
              </div>

              <!-- 修正表单（展开时） -->
              <div v-if="correctingId === err.id" class="mt-3 pt-3 border-t border-gray-200 space-y-2">
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="text-xs text-gray-500">正确答案</label>
                    <input v-model="correctForm.correctAnswer" class="w-full px-2 py-1 text-sm border rounded" placeholder="如 D" />
                  </div>
                  <div>
                    <label class="text-xs text-gray-500">错误类型</label>
                    <select v-model="correctForm.errorType" class="w-full px-2 py-1 text-sm border rounded">
                      <option value="">不变</option>
                      <option value="概念不清">概念不清</option>
                      <option value="计算失误">计算失误</option>
                      <option value="审题偏差">审题偏差</option>
                      <option value="方法错误">方法错误</option>
                      <option value="知识盲区">知识盲区</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label class="text-xs text-gray-500">批改标记</label>
                  <input v-model="correctForm.markDescription" class="w-full px-2 py-1 text-sm border rounded" placeholder="如：红笔打叉" />
                </div>
                <div class="flex gap-2">
                  <button @click="applyCorrection(err.id)" class="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700">应用</button>
                  <button @click="correctingId = null" class="px-3 py-1 bg-gray-100 text-gray-600 text-xs rounded hover:bg-gray-200">取消</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 用户新增的错题 -->
          <div v-if="addedErrors.length > 0" class="mt-6 pt-4 border-t">
            <h3 class="text-sm font-semibold text-orange-700 mb-3">
              🟠 你添加的遗漏错题（{{ addedErrors.length }} 道）
            </h3>
            <div v-for="(add, ai) in addedErrors" :key="'add-'+ai" class="p-3 bg-orange-50 rounded-lg mb-2 flex items-center justify-between">
              <div class="text-sm">
                <span v-if="add.questionNumber" class="font-medium">第{{ add.questionNumber }}题</span>
                <span class="text-gray-500 ml-2">{{ add.markType || '用户标注' }}</span>
              </div>
              <button @click="removeAdded(ai)" class="text-xs text-red-500 hover:text-red-700">移除</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 错误状态 -->
    <div v-else class="text-center py-20 text-gray-400">
      <p class="text-lg">找不到该试卷</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authFetch } from '../utils/authStore.js'

const route = useRoute()
const router = useRouter()
const sessionId = route.params.sessionId

const loading = ref(true)
const submitting = ref(false)
const session = ref(null)
const images = ref([])
const errors = ref([])
const currentPage = ref(1)
const viewMode = ref('original')
const imageContainer = ref(null)
const imageNatural = ref({ w: 1, h: 1 })

// 复核状态
const reviewStates = reactive({})
const correctingId = ref(null)
const correctForm = reactive({ correctAnswer: '', errorType: '', markDescription: '' })
const addedErrors = ref([])
const userAddedMarks = ref([])
const errorRefs = reactive({})

const confirmedCount = computed(() => Object.values(reviewStates).filter(s => s === 'confirmed').length)
const rejectedCount = computed(() => Object.values(reviewStates).filter(s => s === 'rejected').length)
const correctedCount = computed(() => Object.values(reviewStates).filter(s => s === 'corrected').length)

const currentImage = computed(() => images.value.find(i => i.pageIndex === currentPage.value))

const currentViewUrl = computed(() => {
  const img = currentImage.value
  if (!img) return ''
  if (viewMode.value === 'red') return img.redMarksUrl || img.originalUrl
  if (viewMode.value === 'annotated') return img.annotatedUrl || img.redMarksUrl || img.originalUrl
  return img.originalUrl
})

const imageLoadError = ref(false)
function onImageError() {
  if (viewMode.value !== 'original') {
    imageLoadError.value = true
  }
}
watch([currentPage, viewMode], () => { imageLoadError.value = false })

const currentImageMarks = computed(() => {
  return errors.value
    .filter(e => {
      if (reviewStates[e.id] === 'rejected') return false
      const pd = e.positionData
      if (!pd || pd === '{}' || pd === '') return false
      try {
        const p = typeof pd === 'string' ? JSON.parse(pd) : pd
        return (p.pageIndex || 1) === currentPage.value
      } catch { return false }
    })
    .map(e => {
      try {
        const p = typeof e.positionData === 'string' ? JSON.parse(e.positionData) : e.positionData
        return { errorId: e.id, x: p.x || 50, y: p.y || 50, label: e.topic || '' }
      } catch { return { errorId: e.id, x: 50, y: 50, label: '' } }
    })
})

function markStyle(mark) {
  return { left: mark.x + '%', top: mark.y + '%' }
}

const subjectMap = {
  '数学': '📐 数学', '物理': '⚡ 物理', '化学': '🧪 化学',
  '生物': '🧬 生物', '英语': '🌍 英语', '语文': '📖 语文'
}
function getSubjectLabel(subject) {
  return subjectMap[subject] || subject
}

function onImageLoad(e) {
  imageNatural.value = { w: e.target.naturalWidth, h: e.target.naturalHeight }
}

async function loadData() {
  try {
    const res = await authFetch(`/api/paper/${sessionId}/review`)
    if (!res.ok) throw new Error('加载失败')
    const data = await res.json()
    session.value = data.session
    images.value = data.images
    errors.value = data.errors || []
    // 恢复已有复核状态
    if (data.reviews) {
      for (const r of data.reviews) {
        if (r.reviewAction === 'added') {
          addedErrors.value.push(r.correctionData || {})
        } else {
          reviewStates[r.errorId] = r.reviewAction
        }
      }
    }
  } catch (err) {
    console.error('加载复核数据失败', err)
  } finally {
    loading.value = false
  }
}

function confirmError(errorId) {
  if (reviewStates[errorId] === 'confirmed') {
    delete reviewStates[errorId]
  } else {
    reviewStates[errorId] = 'confirmed'
    if (reviewStates[errorId] === 'rejected') delete reviewStates[errorId]
  }
}

function rejectError(errorId) {
  if (reviewStates[errorId] === 'rejected') {
    delete reviewStates[errorId]
  } else {
    reviewStates[errorId] = 'rejected'
  }
}

function startCorrect(err) {
  correctingId.value = err.id
  correctForm.correctAnswer = err.correctAnswer || ''
  correctForm.errorType = err.errorType || ''
  correctForm.markDescription = err.gradingEvidence || ''
}

function applyCorrection(errorId) {
  reviewStates[errorId] = 'corrected'
  // 本地更新数据
  const err = errors.value.find(e => e.id === errorId)
  if (err) {
    if (correctForm.correctAnswer) err.correctAnswer = correctForm.correctAnswer
    if (correctForm.errorType) err.errorType = correctForm.errorType
    if (correctForm.markDescription) err.gradingEvidence = correctForm.markDescription
  }
  correctingId.value = null
}

const corrections = reactive({})

watch(() => reviewStates, () => {
  for (const [errorId, state] of Object.entries(reviewStates)) {
    if (state === 'corrected') {
      const err = errors.value.find(e => e.id === errorId)
      if (err) {
        corrections[errorId] = {
          correctAnswer: err.correctAnswer,
          errorType: err.errorType,
          marking: err.gradingEvidence
        }
      }
    }
  }
}, { deep: true })

// 点击图片添加遗漏错题
function addMarkByClick(e) {
  if (!imageContainer.value) return
  const rect = imageContainer.value.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(1)
  const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(1)

  const qn = prompt('题号？（如 12）')
  if (!qn) return
  const markType = prompt('标记类型：✗打叉 / 红笔写正确答案 / 划掉 / 圈选 / 其他', '✗打叉')
  if (!markType) return

  addedErrors.value.push({
    pageIndex: currentPage.value,
    position: { x: parseFloat(x), y: parseFloat(y) },
    questionNumber: parseInt(qn) || qn,
    markType
  })
  userAddedMarks.value.push({ x, y })
}

function removeAdded(idx) {
  addedErrors.value.splice(idx, 1)
  userAddedMarks.value.splice(idx, 1)
}

function scrollToError(errorId) {
  const el = errorRefs[errorId]
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function submitReviews() {
  submitting.value = true
  try {
    const reviews = Object.entries(reviewStates).map(([errorId, action]) => ({
      errorId,
      action,
      correction: action === 'corrected' ? {
        correctAnswer: corrections[errorId]?.correctAnswer,
        errorType: corrections[errorId]?.errorType
      } : undefined,
      note: action === 'rejected' ? '用户标记为误判' : undefined
    }))

    const additions = addedErrors.value.map(a => ({
      pageIndex: a.pageIndex || 1,
      position: a.position || {},
      questionNumber: a.questionNumber,
      markType: a.markType,
      note: '用户手动添加遗漏错题'
    }))

    const res = await authFetch(`/api/paper/${sessionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviews, additions })
    })

    if (!res.ok) throw new Error('提交失败')
    const data = await res.json()
    alert(`复核结果已保存！\n确认 ${data.results.confirmed} · 误判 ${data.results.rejected} · 修正 ${data.results.corrected} · 新增 ${data.results.added}`)
    router.push('/errors')
  } catch (err) {
    alert('提交失败: ' + err.message)
  } finally {
    submitting.value = false
  }
}

onMounted(loadData)
</script>
