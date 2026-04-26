<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <!-- 返回按钮 -->
    <router-link to="/upload" class="inline-flex items-center text-blue-600 hover:text-blue-700 mb-8">
      <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
      </svg>
      返回重新批改
    </router-link>

    <!-- 总分展示 -->
    <div class="bg-white rounded-2xl shadow-lg p-8 mb-8">
      <div class="text-center">
        <h1 class="text-2xl font-bold text-gray-900 mb-6">作文批改结果</h1>
        
        <div class="inline-flex items-center justify-center w-32 h-32 bg-blue-100 rounded-full mb-6">
          <div>
            <span class="text-5xl font-bold text-blue-600">{{ result?.totalScore || 0 }}</span>
            <span class="text-lg text-gray-600">/70</span>
          </div>
        </div>
        
        <p class="text-lg text-gray-600">
          评级：<span class="font-semibold text-blue-600">{{ result?.grade || '一类卷' }}</span>
        </p>
      </div>
    </div>

    <!-- 维度评分 -->
    <div class="bg-white rounded-2xl shadow-lg p-8 mb-8">
      <h2 class="text-xl font-bold text-gray-900 mb-6">维度分析</h2>
      
      <div class="space-y-6">
        <div v-for="(score, dimension) in result?.dimensions" :key="dimension" class="flex items-center">
          <span class="w-20 text-sm font-medium text-gray-700">{{ dimension }}</span>
          <div class="flex-1 mx-4 bg-gray-200 rounded-full h-2">
            <div 
              class="bg-blue-600 h-2 rounded-full transition-all duration-500" 
              :style="{ width: `${(score / 20) * 100}%` }"
            ></div>
          </div>
          <span class="w-12 text-right text-sm font-medium text-gray-900">{{ score }}/20</span>
        </div>
      </div>
    </div>

    <!-- 详细评语 -->
    <div class="bg-white rounded-2xl shadow-lg p-8 mb-8">
      <h2 class="text-xl font-bold text-gray-900 mb-6">详细评语</h2>
      
      <div class="space-y-6">
        <div v-if="result?.strengths" class="p-4 bg-green-50 rounded-lg">
          <h3 class="text-lg font-semibold text-green-800 mb-2">✨ 亮点</h3>
          <ul class="list-disc list-inside text-gray-700 space-y-1">
            <li v-for="(item, index) in result.strengths" :key="index">{{ item }}</li>
          </ul>
        </div>

        <div v-if="result?.weaknesses" class="p-4 bg-red-50 rounded-lg">
          <h3 class="text-lg font-semibold text-red-800 mb-2">🔍 不足</h3>
          <ul class="list-disc list-inside text-gray-700 space-y-1">
            <li v-for="(item, index) in result.weaknesses" :key="index">{{ item }}</li>
          </ul>
        </div>

        <div v-if="result?.suggestions" class="p-4 bg-blue-50 rounded-lg">
          <h3 class="text-lg font-semibold text-blue-800 mb-2">💡 改进建议</h3>
          <ul class="list-disc list-inside text-gray-700 space-y-1">
            <li v-for="(item, index) in result.suggestions" :key="index">{{ item }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 总评 -->
    <div v-if="result?.overallComment" class="bg-white rounded-2xl shadow-lg p-8 mb-8">
      <h2 class="text-xl font-bold text-gray-900 mb-4">总评</h2>
      <p class="text-gray-700 leading-relaxed">{{ result.overallComment }}</p>
    </div>

    <!-- 再次批改按钮 -->
    <div class="text-center">
      <router-link 
        to="/upload" 
        class="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium px-8 py-4 rounded-xl transition-all"
      >
        批改下一篇作文
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const result = ref(null)

onMounted(() => {
  // 从路由状态获取结果
  result.value = history.state?.result || null
  
  if (!result.value) {
    // 如果没有结果，显示模拟数据
    result.value = {
      totalScore: 58,
      grade: '二类上',
      dimensions: {
        '内容': 15,
        '结构': 14,
        '语言': 16,
        '创新': 13
      },
      strengths: [
        '立意明确，中心思想突出',
        '语言表达流畅，用词准确',
        '结构完整，层次分明'
      ],
      weaknesses: [
        '部分段落过渡不够自然',
        '个别语句表达略显平淡',
        '创新角度可以更加独特'
      ],
      suggestions: [
        '增加过渡句，使段落衔接更流畅',
        '尝试使用更丰富的修辞手法',
        '多从不同角度思考问题，增加文章深度'
      ],
      overallComment: '本文整体表现良好，符合二类卷标准。中心明确，内容充实，语言通顺。建议在结构过渡和表达创新方面继续提升。'
    }
  }
})
</script>
