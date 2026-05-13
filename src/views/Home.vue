<template>
  <div>
    <!-- Hero Section -->
    <section class="relative overflow-hidden bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950">
      <div class="absolute inset-0 opacity-20">
        <div class="absolute top-10 left-10 w-72 h-72 bg-blue-400 rounded-full blur-3xl"></div>
        <div class="absolute bottom-10 right-10 w-96 h-96 bg-indigo-500 rounded-full blur-3xl"></div>
      </div>
      <div class="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div class="text-center">
          <h1 class="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-4 tracking-tight">
            高中<span class="text-blue-400">在线</span>学习助手
          </h1>
          <p class="text-base sm:text-lg md:text-xl text-blue-200/80 mb-2 max-w-2xl mx-auto">
            不卖课、不培训。只做一件事——
          </p>
          <p class="text-sm sm:text-base md:text-lg text-blue-300/60 mb-10 max-w-2xl mx-auto">
            用 AI 帮你整理错题、分析薄弱点，让每一次练习都变成进步
          </p>
          
          <!-- Two CTAs -->
          <div class="flex flex-col sm:flex-row gap-4 justify-center">
            <router-link to="/upload" class="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-blue-600/30 hover:shadow-blue-500/40">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              ✏️ 作文批改
            </router-link>
            <router-link to="/paper/upload" class="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-emerald-600/30 hover:shadow-emerald-500/40">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              📄 错题上传
            </router-link>
          </div>
        </div>
      </div>
    </section>

    <!-- Features Grid -->
    <section class="py-16 md:py-24 bg-white">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12 md:mb-16">
          <span class="text-xs font-semibold tracking-widest text-blue-600 uppercase">两大核心模块</span>
          <h2 class="mt-2 text-2xl md:text-3xl font-bold text-gray-900">覆盖你的学习全流程</h2>
        </div>
        
        <!-- Module 1: 作文批改 -->
        <div class="mb-12 md:mb-16">
          <h3 class="text-lg font-semibold text-gray-500 mb-6 flex items-center gap-2">
            <span class="w-8 h-8 bg-blue-100 text-blue-700 rounded-lg flex items-center justify-center text-sm">✏️</span>
            作文批改
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
            <div class="group bg-slate-50 hover:bg-blue-50 rounded-2xl p-6 transition-all duration-300 hover:shadow-md">
              <div class="w-11 h-11 bg-blue-100 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <svg class="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
              </div>
              <h4 class="font-semibold text-gray-900 mb-1.5 text-sm md:text-base">AI 精准评分</h4>
              <p class="text-gray-500 text-sm leading-relaxed">基于高考评分标准，多维度评估作文水平</p>
            </div>
            <div class="group bg-slate-50 hover:bg-blue-50 rounded-2xl p-6 transition-all duration-300 hover:shadow-md">
              <div class="w-11 h-11 bg-indigo-100 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <svg class="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
              </div>
              <h4 class="font-semibold text-gray-900 mb-1.5 text-sm md:text-base">分项点评</h4>
              <p class="text-gray-500 text-sm leading-relaxed">内容、结构、语言分项分析，逐条可操作建议</p>
            </div>
            <div class="group bg-slate-50 hover:bg-blue-50 rounded-2xl p-6 transition-all duration-300 hover:shadow-md sm:col-span-2 lg:col-span-1">
              <div class="w-11 h-11 bg-violet-100 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <svg class="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              </div>
              <h4 class="font-semibold text-gray-900 mb-1.5 text-sm md:text-base">历史追踪</h4>
              <p class="text-gray-500 text-sm leading-relaxed">查看所有批改记录，追踪写作水平进步曲线</p>
            </div>
          </div>
        </div>

        <!-- Module 2: 错题整理 -->
        <div>
          <h3 class="text-lg font-semibold text-gray-500 mb-6 flex items-center gap-2">
            <span class="w-8 h-8 bg-emerald-100 text-emerald-700 rounded-lg flex items-center justify-center text-sm">📔</span>
            错题整理
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
            <div class="group bg-slate-50 hover:bg-emerald-50 rounded-2xl p-6 transition-all duration-300 hover:shadow-md">
              <div class="w-11 h-11 bg-emerald-100 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
              </div>
              <h4 class="font-semibold text-gray-900 mb-1.5 text-sm md:text-base">一键上传试卷</h4>
              <p class="text-gray-500 text-sm leading-relaxed">拍照上传已批改试卷，AI 自动识别错题并归类</p>
            </div>
            <div class="group bg-slate-50 hover:bg-emerald-50 rounded-2xl p-6 transition-all duration-300 hover:shadow-md">
              <div class="w-11 h-11 bg-teal-100 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <svg class="w-5 h-5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
              </div>
              <h4 class="font-semibold text-gray-900 mb-1.5 text-sm md:text-base">智能错题本</h4>
              <p class="text-gray-500 text-sm leading-relaxed">按试卷/时间/科目分组查看，每道错题含详细解析</p>
            </div>
            <div class="group bg-slate-50 hover:bg-emerald-50 rounded-2xl p-6 transition-all duration-300 hover:shadow-md sm:col-span-2 lg:col-span-1">
              <div class="w-11 h-11 bg-cyan-100 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <svg class="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>
              </div>
              <h4 class="font-semibold text-gray-900 mb-1.5 text-sm md:text-base">知识点地图</h4>
              <p class="text-gray-500 text-sm leading-relaxed">薄弱知识点自动汇总，针对性查漏补缺</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- How It Works -->
    <section class="py-16 md:py-24 bg-slate-50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12 md:mb-16">
          <span class="text-xs font-semibold tracking-widest text-blue-600 uppercase">三步上手</span>
          <h2 class="mt-2 text-2xl md:text-3xl font-bold text-gray-900">从试卷到错题本，只需 3 步</h2>
        </div>
        
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 md:gap-8">
          <div class="text-center group">
            <div class="w-14 h-14 bg-white border-2 border-blue-200 group-hover:border-blue-500 text-blue-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4 transition-all shadow-sm group-hover:shadow-md">1</div>
            <h3 class="font-semibold text-gray-900 mb-2 text-sm md:text-base">拍照上传</h3>
            <p class="text-gray-500 text-sm leading-relaxed">用手机拍下已批改的试卷或作文，一次可传多页</p>
          </div>
          
          <div class="text-center group">
            <div class="w-14 h-14 bg-white border-2 border-blue-200 group-hover:border-blue-500 text-blue-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4 transition-all shadow-sm group-hover:shadow-md">2</div>
            <h3 class="font-semibold text-gray-900 mb-2 text-sm md:text-base">AI 智能分析</h3>
            <p class="text-gray-500 text-sm leading-relaxed">AI 自动识别批改标记，精准判定错题，分析错误原因</p>
          </div>
          
          <div class="text-center group">
            <div class="w-14 h-14 bg-white border-2 border-blue-200 group-hover:border-blue-500 text-blue-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4 transition-all shadow-sm group-hover:shadow-md">3</div>
            <h3 class="font-semibold text-gray-900 mb-2 text-sm md:text-base">复习巩固</h3>
            <p class="text-gray-500 text-sm leading-relaxed">在错题本中按科目复习，查看知识点分析，针对性提升</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Bottom CTA -->
    <section class="py-16 md:py-20 bg-white">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 class="text-2xl md:text-3xl font-bold text-gray-900 mb-4">准备好整理你的错题了吗？</h2>
        <p class="text-gray-500 mb-8 text-sm md:text-base max-w-xl mx-auto">上传第一张试卷，让 AI 帮你把错题变成进步</p>
        <div class="flex flex-col sm:flex-row gap-4 justify-center">
          <router-link to="/paper/upload" class="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-emerald-600/30">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
            📄 上传试卷
          </router-link>
          <router-link to="/upload" class="inline-flex items-center justify-center gap-2 border-2 border-gray-300 hover:border-blue-400 text-gray-700 hover:text-blue-600 font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all">
            ✏️ 体验作文批改
          </router-link>
        </div>
      </div>
    </section>
  </div>
</template>
