<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 页面标题 -->
    <div class="text-center mb-12">
      <h1 class="text-3xl font-bold text-gray-900 mb-4">作文批改</h1>
      <p class="text-lg text-gray-600">上传你的作文，AI 将根据上海高考标准进行专业批改</p>
    </div>

    <!-- 上传区域 -->
    <div class="bg-white rounded-2xl shadow-lg p-8">
      <UploadArea @file-selected="onFileSelected" />

      <!-- 作文题目输入 -->
      <div v-if="selectedFile" class="mt-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">作文题目（选填）</label>
        <textarea 
          v-model="essayTopic" 
          rows="3" 
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="请输入作文题目或材料..."
        ></textarea>
      </div>

      <!-- 提交按钮 -->
      <div v-if="selectedFile" class="mt-6">
        <button 
          @click="submitEssay" 
          :disabled="isAnalyzing"
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-4 rounded-xl transition-all"
        >
          <span v-if="isAnalyzing" class="flex items-center justify-center">
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            AI 正在批改中...
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
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import UploadArea from '../components/UploadArea.vue'

const router = useRouter()

const selectedFile = ref(null)
const essayTopic = ref('')
const isAnalyzing = ref(false)
const errorMessage = ref('')

const onFileSelected = (file) => {
  selectedFile.value = file
  errorMessage.value = ''
}

const submitEssay = async () => {
  if (!selectedFile.value) {
    errorMessage.value = '请先选择要批改的文件'
    return
  }

  isAnalyzing.value = true
  errorMessage.value = ''

  try {
    // 将文件转换为 base64
    const base64Data = await fileToBase64(selectedFile.value)
    
    // 调用 AI 批改 API
    const result = await analyzeEssay(base64Data, essayTopic.value)
    
    // 跳转到结果页
    router.push({ name: 'Result', state: { result } })
  } catch (error) {
    errorMessage.value = error.message || '批改失败，请稍后重试'
  } finally {
    isAnalyzing.value = false
  }
}

const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const analyzeEssay = async (base64Data, topic) => {
  // 这里调用 OpenClaw 的 AI 批改接口
  // 暂时使用模拟数据，后续接入真实 API
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file: base64Data,
      topic: topic,
      region: 'shanghai'
    })
  })

  if (!response.ok) {
    throw new Error('AI 批改服务暂时不可用')
  }

  return await response.json()
}
</script>
