<template>
  <div>
    <!-- Hero Section -->
    <section class="bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-32">
        <div class="text-center">
          <h1 class="text-4xl md:text-6xl font-bold text-gray-900 mb-6">
            AI 驱动的高中学业<span class="text-blue-600">诊断平台</span>
          </h1>
          <p class="text-xl md:text-2xl text-gray-600 mb-8 max-w-3xl mx-auto">
            不卖课、不培训。只做一件事：<br/>
            用 AI 帮你分析作业和试卷，精准定位薄弱点
          </p>
          <router-link 
            to="/upload" 
            class="inline-block bg-blue-600 hover:bg-blue-700 text-white text-lg font-medium px-8 py-4 rounded-xl transition-all shadow-lg hover:shadow-xl"
          >
            开始作文批改 →
          </router-link>
        </div>
      </div>
    </section>

    <!-- Features Section -->
    <section class="py-20 bg-white">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 class="text-3xl font-bold text-center text-gray-900 mb-16">核心优势</h2>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <!-- Feature 1 -->
          <div class="bg-gray-50 rounded-2xl p-8 text-center hover:shadow-lg transition-shadow">
            <div class="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path>
              </svg>
            </div>
            <h3 class="text-xl font-semibold text-gray-900 mb-3">AI 精准分析</h3>
            <p class="text-gray-600">基于高考评分标准，智能分析学生作业，精准定位知识薄弱点</p>
          </div>

          <!-- Feature 2 -->
          <div class="bg-gray-50 rounded-2xl p-8 text-center hover:shadow-lg transition-shadow">
            <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
              </svg>
            </div>
            <h3 class="text-xl font-semibold text-gray-900 mb-3">快速反馈</h3>
            <p class="text-gray-600">上传即批改，几秒钟内获得详细评分和改进建议，无需等待</p>
          </div>

          <!-- Feature 3 -->
          <div class="bg-gray-50 rounded-2xl p-8 text-center hover:shadow-lg transition-shadow">
            <div class="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
              </svg>
            </div>
            <h3 class="text-xl font-semibold text-gray-900 mb-3">个性化建议</h3>
            <p class="text-gray-600">根据每个学生的具体情况，提供针对性的学习建议和提升方案</p>
          </div>
        </div>
      </div>
    </section>

    <!-- How It Works -->
    <section class="py-20 bg-gray-50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 class="text-3xl font-bold text-center text-gray-900 mb-16">使用流程</h2>
        
        <div class="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div class="text-center">
            <div class="w-12 h-12 bg-blue-600 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">1</div>
            <h3 class="text-lg font-semibold text-gray-900 mb-2">上传作业</h3>
            <p class="text-gray-600 text-sm">拍照或扫描上传作文、试卷</p>
          </div>
          
          <div class="text-center">
            <div class="w-12 h-12 bg-blue-600 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">2</div>
            <h3 class="text-lg font-semibold text-gray-900 mb-2">AI 分析</h3>
            <p class="text-gray-600 text-sm">AI 根据高考标准智能批改</p>
          </div>
          
          <div class="text-center">
            <div class="w-12 h-12 bg-blue-600 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">3</div>
            <h3 class="text-lg font-semibold text-gray-900 mb-2">查看报告</h3>
            <p class="text-gray-600 text-sm">获取详细评分和改进建议</p>
          </div>
          
          <div class="text-center">
            <div class="w-12 h-12 bg-blue-600 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">4</div>
            <h3 class="text-lg font-semibold text-gray-900 mb-2">精准提升</h3>
            <p class="text-gray-600 text-sm">根据建议有针对性练习</p>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA Section -->
    <section class="py-20 bg-blue-600">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 class="text-3xl font-bold text-white mb-6">准备好开始了吗？</h2>
        <p class="text-xl text-blue-100 mb-8">上传你的第一篇作文，获取 AI 专业批改</p>
        <router-link 
          to="/upload" 
          class="inline-block bg-white text-blue-600 font-semibold px-8 py-4 rounded-xl hover:bg-gray-100 transition-all"
        >
          立即体验
        </router-link>
      </div>
    </section>
  </div>
</template>
