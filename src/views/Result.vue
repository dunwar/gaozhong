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
        <div class="flex items-center justify-center gap-2 mb-4">
          <span v-if="result?.essayType" class="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm font-medium">
            {{ result.essayType }}
          </span>
          <span v-if="result?.wordCount" class="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">
            {{ result.wordCount }} 字
          </span>
        </div>
        
        <div class="inline-flex items-center justify-center w-32 h-32 bg-blue-100 rounded-full mb-4">
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

    <!-- 定档依据 -->
    <div v-if="result?.gradingReason" class="bg-amber-50 rounded-2xl p-6 mb-8 border border-amber-200">
      <h3 class="text-lg font-semibold text-amber-800 mb-2">📌 定档依据</h3>
      <p class="text-amber-900 leading-relaxed">{{ result.gradingReason }}</p>
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
        <div v-if="result?.strengths?.length" class="p-4 bg-green-50 rounded-lg">
          <h3 class="text-lg font-semibold text-green-800 mb-2">✨ 亮点</h3>
          <ul class="list-disc list-inside text-gray-700 space-y-1">
            <li v-for="(item, index) in result.strengths" :key="index">{{ item }}</li>
          </ul>
        </div>

        <div v-if="result?.weaknesses?.length" class="p-4 bg-red-50 rounded-lg">
          <h3 class="text-lg font-semibold text-red-800 mb-2">🔍 不足</h3>
          <ul class="list-disc list-inside text-gray-700 space-y-1">
            <li v-for="(item, index) in result.weaknesses" :key="index">{{ item }}</li>
          </ul>
        </div>

        <div v-if="result?.suggestions?.length" class="p-4 bg-blue-50 rounded-lg">
          <h3 class="text-lg font-semibold text-blue-800 mb-2">💡 改进建议</h3>
          <ul class="list-disc list-inside text-gray-700 space-y-1">
            <li v-for="(item, index) in result.suggestions" :key="index">{{ item }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 修改对照（v3 新增） -->
    <div v-if="result?.revisions?.length" class="bg-white rounded-2xl shadow-lg p-8 mb-8">
      <h2 class="text-xl font-bold text-gray-900 mb-2">📝 修改建议对照</h2>
      <p class="text-gray-500 text-sm mb-6">以下修改建议基于《说理与思辨》原则，可直接参考使用</p>
      
      <div class="space-y-6">
        <div 
          v-for="(rev, index) in result.revisions" 
          :key="index"
          class="border border-gray-200 rounded-xl overflow-hidden"
        >
          <!-- 位置标题 -->
          <div class="bg-gray-50 px-4 py-3 border-b border-gray-200">
            <span class="text-sm font-medium text-gray-700">
              📍 {{ rev.location || `修改 #${index + 1}` }}
            </span>
          </div>
          
          <div class="p-4 space-y-4">
            <!-- 原文 -->
            <div>
              <div class="text-xs font-medium text-red-600 mb-1">原文</div>
              <div class="bg-red-50 border-l-4 border-red-400 p-3 text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">
                {{ rev.original }}
              </div>
            </div>
            
            <!-- 箭头 -->
            <div class="flex justify-center">
              <svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
              </svg>
            </div>
            
            <!-- 修改后 -->
            <div>
              <div class="text-xs font-medium text-green-600 mb-1">修改后</div>
              <div class="bg-green-50 border-l-4 border-green-400 p-3 text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">
                {{ rev.suggested }}
              </div>
            </div>
            
            <!-- 修改理由 -->
            <div class="bg-blue-50 rounded-lg p-3">
              <div class="text-xs font-medium text-blue-600 mb-1">修改理由</div>
              <p class="text-blue-900 text-sm leading-relaxed">{{ rev.reason }}</p>
            </div>
          </div>
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
  result.value = history.state?.result || null
  
  if (!result.value) {
    result.value = {
      totalScore: 58,
      grade: '二类上',
      essayType: '议论文',
      wordCount: 850,
      dimensions: { '内容': 15, '结构': 14, '语言': 16, '创新': 13 },
      strengths: ['立意明确，中心思想突出', '语言表达流畅，用词准确', '结构完整，层次分明'],
      weaknesses: ['部分段落过渡不够自然', '个别语句表达略显平淡', '创新角度可以更加独特'],
      suggestions: ['增加过渡句，使段落衔接更流畅', '尝试使用更丰富的修辞手法', '多从不同角度思考问题'],
      overallComment: '本文整体表现良好，符合二类卷标准。',
      gradingReason: '文章基本符合题意，立意较深刻，各方面表现均衡，故归入二类卷。',
      revisions: [
        {
          location: '第二段开头',
          original: '我们要努力学习，这样才能成功。',
          suggested: '唯有在求知之路上孜孜不倦，方能在时代的浪潮中把握机遇，实现人生价值。',
          reason: '原句过于口语化，缺乏文采，建议用更凝练的语言提升表达层次。'
        }
      ]
    }
  }
})
</script>
