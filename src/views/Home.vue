<template>
  <div>
    <!-- Hero Section -->
    <section class="relative overflow-hidden bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950">
      <div class="absolute inset-0 opacity-20">
        <div class="absolute top-10 left-10 w-72 h-72 bg-blue-400 rounded-full blur-3xl"></div>
        <div class="absolute bottom-10 right-10 w-96 h-96 bg-indigo-500 rounded-full blur-3xl"></div>
      </div>
      <div class="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div class="text-center">
          <span class="inline-flex items-center gap-1.5 bg-white/10 border border-white/15 text-blue-200 text-xs sm:text-sm font-medium px-3.5 py-1.5 rounded-full mb-6">
            📍 专为上海高中生打造 · 上海高考评分口径
          </span>
          <h1 class="text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-4 tracking-tight leading-tight">
            作文批得<span class="text-blue-400">比学校细</span>，<br class="sm:hidden">错题<span class="text-emerald-400">不用自己抄</span>
          </h1>
          <p class="text-sm sm:text-base md:text-lg text-blue-200/80 mb-2 max-w-2xl mx-auto">
            每周作文 AI 细批：70 分制四维评分 + 逐句标注 + 升格建议
          </p>
          <p class="text-sm sm:text-base md:text-lg text-blue-200/80 mb-8 max-w-2xl mx-auto">
            考后试卷拍张照：错题本 + 可打印订正纸自动生成
          </p>

          <!-- Two CTAs -->
          <div class="flex flex-col sm:flex-row gap-4 justify-center">
            <router-link to="/upload" class="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-blue-600/30 hover:shadow-blue-500/40">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              免费批改第一篇作文
            </router-link>
            <router-link to="/paper/upload" class="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-emerald-600/30 hover:shadow-emerald-500/40">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              拍卷子整错题
            </router-link>
          </div>
          <p class="mt-5 text-xs sm:text-sm text-blue-300/50">新用户免费体验 · 手机拍照即用 · 无需下载 App</p>
        </div>
      </div>
    </section>

    <!-- ═══ 演示一：同一篇作文，两种批改 ═══ -->
    <section class="py-16 md:py-24 bg-white">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-10 md:mb-14">
          <span class="text-xs font-semibold tracking-widest text-blue-600 uppercase">亮点一 · 作文批改</span>
          <h2 class="mt-2 text-2xl md:text-3xl font-bold text-gray-900">同一篇作文，学校批了 2 行，AI 批了 37 处</h2>
          <p class="mt-3 text-gray-500 text-sm md:text-base max-w-xl mx-auto">学校老师没时间逐句改——AI 按 20 年阅卷经验标准，把每一处可提升的地方都指出来</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-8 items-stretch">
          <!-- 左：学校批改 -->
          <div class="rounded-2xl border-2 border-gray-200 bg-gray-50 p-5 sm:p-6 flex flex-col">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-semibold text-gray-400 bg-gray-100 px-2.5 py-1 rounded-md">🏫 学校老师批改</span>
            </div>
            <!-- 卷面 mock -->
            <div class="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 font-serif text-[13px] sm:text-sm text-gray-700 leading-7 flex-1">
              <p class="mb-1">技术的发展改变着生活的方方面面。有人说，技术让生活更便利；也有人说，技术让人变得懒惰……</p>
              <p class="mb-1">我认为技术本身并无好坏，关键在于人如何使用技术<mark class="bg-red-100 text-red-500 px-0.5 rounded no-underline">。论证不够充分</mark>，第三段例子重复。</p>
              <p>总之，我们要做技术的主人，而不是奴隶。</p>
            </div>
            <div class="mt-4 flex items-end justify-between">
              <div>
                <p class="text-gray-400 text-xs mb-1">评语全文</p>
                <p class="text-gray-600 text-sm leading-6">“立意尚可，论证不够充分，注意卷面。”</p>
              </div>
              <div class="text-right shrink-0 ml-4">
                <span class="font-bold text-3xl text-red-500 font-serif">52</span>
                <span class="text-gray-400 text-sm">/70</span>
              </div>
            </div>
            <p class="mt-3 text-center text-xs text-gray-400">批改用时约 40 秒 · 共 2 处批注</p>
          </div>

          <!-- 右：AI 批改 -->
          <div class="rounded-2xl border-2 border-blue-300 bg-blue-50/50 p-5 sm:p-6 flex flex-col relative overflow-hidden shadow-lg shadow-blue-100">
            <span class="absolute top-3 right-3 bg-blue-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full">本产品</span>
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-semibold text-blue-700 bg-blue-100 px-2.5 py-1 rounded-md">🤖 AI 细批 · 上海高考 70 分制</span>
            </div>
            <!-- 四维评分条 -->
            <div class="bg-white rounded-xl border border-blue-100 p-4 space-y-2.5 mb-3">
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-500 w-16 shrink-0">审题立意</span>
                <div class="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden"><div class="h-full bg-blue-500 rounded-full" style="width:80%"></div></div>
                <span class="text-xs font-semibold text-gray-700 w-11 text-right">16/20</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-500 w-16 shrink-0">思辨深度</span>
                <div class="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden"><div class="h-full bg-blue-500 rounded-full" style="width:65%"></div></div>
                <span class="text-xs font-semibold text-gray-700 w-11 text-right">13/20</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-500 w-16 shrink-0">结构布局</span>
                <div class="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden"><div class="h-full bg-blue-500 rounded-full" style="width:80%"></div></div>
                <span class="text-xs font-semibold text-gray-700 w-11 text-right">16/20</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-500 w-16 shrink-0">语言表达</span>
                <div class="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden"><div class="h-full bg-blue-500 rounded-full" style="width:75%"></div></div>
                <span class="text-xs font-semibold text-gray-700 w-11 text-right">15/20</span>
              </div>
            </div>
            <!-- 逐句标注 mock -->
            <div class="bg-white rounded-xl border border-blue-100 p-4 font-serif text-[13px] sm:text-sm text-gray-700 leading-7 flex-1">
              <p class="mb-2 text-xs text-gray-400 font-sans">逐句标注（节选 3/37 处）：</p>
              <p class="mb-1">第三段“技术的<span class="bg-amber-100 border-b-2 border-amber-400">发展必然</span>带来便利”——<span class="text-amber-600">“必然”过于绝对</span>，反例：技术性失业。建议改为“往往”。</p>
              <p class="mb-1">第四段缺少<span class="bg-amber-100 border-b-2 border-amber-400">过渡句</span>，<span class="text-amber-600">从“便利”跳到“懒惰”缺乏衔接</span>。</p>
              <p>结尾<span class="bg-amber-100 border-b-2 border-amber-400">“总之”</span>收束仓促，<span class="text-amber-600">可升格为对“使用者自觉”的展望</span>。</p>
            </div>
            <div class="mt-4 flex items-end justify-between">
              <div class="text-xs text-gray-500 leading-5">
                <p>✓ 四维明细评分</p>
                <p>✓ 37 处逐句标注 · 升格建议</p>
                <p>✓ 不改变你的立意，只让表达更有力</p>
              </div>
              <div class="text-right shrink-0 ml-4">
                <span class="font-bold text-3xl text-blue-600 font-serif">60</span>
                <span class="text-gray-400 text-sm">/70</span>
              </div>
            </div>
            <p class="mt-3 text-center text-xs text-blue-400">逐句批注 · 升格示范 · 可反复修改重批</p>
          </div>
        </div>

        <div class="text-center mt-8">
          <router-link to="/upload" class="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-blue-600/30">
            免费批改第一篇 →
          </router-link>
        </div>
      </div>
    </section>

    <!-- ═══ 演示二：错题三格 ═══ -->
    <section class="py-16 md:py-24 bg-slate-50">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-10 md:mb-14">
          <span class="text-xs font-semibold tracking-widest text-emerald-600 uppercase">亮点二 · 错题整理</span>
          <h2 class="mt-2 text-2xl md:text-3xl font-bold text-gray-900">拍张照，错题本和订正纸自动生成</h2>
          <p class="mt-3 text-gray-500 text-sm md:text-base max-w-xl mx-auto">不抄一道题——已批改的试卷拍照上传，AI 识别错题，直接打印出学校要检查的订正纸</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6 items-stretch">
          <!-- 格1：试卷照片 -->
          <div class="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col">
            <span class="self-start text-xs font-semibold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-md mb-4">① 拍照上传</span>
            <!-- 试卷 mock -->
            <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex-1 rotate-[-1deg]">
              <p class="text-[10px] text-gray-400 text-center mb-3 border-b border-dashed border-gray-200 pb-2">英语期末考试 · 第 3 页</p>
              <div class="space-y-2 text-[11px] leading-5 text-gray-600 font-serif">
                <p class="flex gap-2"><span>43. The HR department decided to cancel the yoga course, as it was clear from…</span></p>
                <p class="text-red-500 -mt-1 ml-1">✗ <span class="text-red-400">B</span></p>
                <p class="flex gap-2"><span>44. By the time the rescue team arrived, most villagers ___ relocated…</span></p>
                <p class="text-red-500 -mt-1 ml-1">✗ <span class="text-red-400">C</span></p>
                <p class="flex gap-2"><span>45. ___ he often writes to his former teacher…</span></p>
                <p class="text-green-500 -mt-1 ml-1">✓ <span class="text-red-400">A</span></p>
              </div>
            </div>
            <p class="mt-3 text-xs text-gray-400 text-center">已批改的试卷（含红笔批改）</p>
          </div>

          <!-- 格2：错题本 -->
          <div class="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col">
            <span class="self-start text-xs font-semibold text-emerald-700 bg-emerald-100 px-2.5 py-1 rounded-md mb-4">② AI 识别错题</span>
            <!-- 错题本 mock -->
            <div class="bg-slate-900 rounded-xl p-4 flex-1 space-y-2.5">
              <div class="bg-slate-800 rounded-lg p-3">
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="w-5 h-5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded flex items-center justify-center">✗</span>
                  <span class="text-white text-xs font-semibold">Q43 · 词汇辨析</span>
                  <span class="ml-auto text-[9px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">待订正</span>
                </div>
                <p class="text-gray-400 text-[10px] leading-4 line-clamp-2">The HR department decided to cancel the yoga course…</p>
                <div class="flex gap-1.5 mt-2">
                  <span class="text-[9px] text-blue-300 bg-blue-400/10 px-1.5 py-0.5 rounded">#cancel</span>
                  <span class="text-[9px] text-blue-300 bg-blue-400/10 px-1.5 py-0.5 rounded">#词汇</span>
                </div>
              </div>
              <div class="bg-slate-800 rounded-lg p-3">
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="w-5 h-5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded flex items-center justify-center">✗</span>
                  <span class="text-white text-xs font-semibold">Q44 · 时态语态</span>
                  <span class="ml-auto text-[9px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">待订正</span>
                </div>
                <div class="flex gap-1.5 mt-2">
                  <span class="text-[9px] text-blue-300 bg-blue-400/10 px-1.5 py-0.5 rounded">#过去完成时</span>
                </div>
              </div>
              <div class="bg-slate-800/50 rounded-lg p-3 border border-dashed border-slate-700">
                <p class="text-slate-400 text-[10px]">本周 13 错 · 已订正 8 · 薄弱点：词汇辨析</p>
              </div>
            </div>
            <p class="mt-3 text-xs text-gray-400 text-center">错题自动归类 + 知识点标签</p>
          </div>

          <!-- 格3：订正纸 -->
          <div class="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col">
            <span class="self-start text-xs font-semibold text-gray-600 bg-gray-100 px-2.5 py-1 rounded-md mb-4">③ 打印订正纸</span>
            <!-- 订正纸 mock -->
            <div class="bg-white rounded-xl border border-gray-300 shadow-sm p-4 flex-1">
              <p class="text-[10px] text-gray-500 text-center mb-2 pb-1.5 border-b border-gray-200">错题订正 · 2026-09 月考（英语）</p>
              <div class="space-y-3 text-[10px]">
                <div>
                  <p class="text-gray-700 font-serif leading-4">43. The HR department decided to cancel the yoga course… <span class="text-gray-400">(词汇辨析)</span></p>
                  <p class="text-gray-300">订正：＿＿＿＿＿＿＿＿＿＿＿＿</p>
                  <p class="text-gray-300">错因：□审题 □知识 □粗心 □其他</p>
                </div>
                <div class="border-t border-dashed border-gray-200 pt-2">
                  <p class="text-gray-700 font-serif leading-4">44. By the time the rescue team arrived… <span class="text-gray-400">(时态)</span></p>
                  <p class="text-gray-300">订正：＿＿＿＿＿＿＿＿＿＿＿＿</p>
                  <p class="text-gray-300">错因：□审题 □知识 □粗心 □其他</p>
                </div>
              </div>
            </div>
            <p class="mt-3 text-xs text-gray-400 text-center">直接打印 · 承接学校检查</p>
          </div>
        </div>

        <div class="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs sm:text-sm text-gray-500">
          <span>✓ 考前一键生成「错题重做卷」</span>
          <span>✓ 每题带原题截图，不用抄题</span>
          <span class="text-gray-400">目前支持英语 · 语文/数学即将开放</span>
        </div>
        <div class="text-center mt-8">
          <router-link to="/paper/upload" class="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-emerald-600/30">
            上传第一份试卷 →
          </router-link>
        </div>
      </div>
    </section>

    <!-- How It Works -->
    <section class="py-16 md:py-24 bg-white">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12 md:mb-16">
          <span class="text-xs font-semibold tracking-widest text-blue-600 uppercase">三步上手</span>
          <h2 class="mt-2 text-2xl md:text-3xl font-bold text-gray-900">从拍照到进步，只需 3 步</h2>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 md:gap-8">
          <div class="text-center group">
            <div class="w-14 h-14 bg-white border-2 border-blue-200 group-hover:border-blue-500 text-blue-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4 transition-all shadow-sm group-hover:shadow-md">1</div>
            <h3 class="font-semibold text-gray-900 mb-2 text-sm md:text-base">拍照上传</h3>
            <p class="text-gray-500 text-sm leading-relaxed">手机拍下作文或已批改试卷，一次可传多页，拍照倾斜也能自动矫正</p>
          </div>

          <div class="text-center group">
            <div class="w-14 h-14 bg-white border-2 border-blue-200 group-hover:border-blue-500 text-blue-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4 transition-all shadow-sm group-hover:shadow-md">2</div>
            <h3 class="font-semibold text-gray-900 mb-2 text-sm md:text-base">AI 智能分析</h3>
            <p class="text-gray-500 text-sm leading-relaxed">作文逐句细批；试卷识别批改痕迹，错题判定你只需花 1 分钟确认</p>
          </div>

          <div class="text-center group">
            <div class="w-14 h-14 bg-white border-2 border-blue-200 group-hover:border-blue-500 text-blue-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4 transition-all shadow-sm group-hover:shadow-md">3</div>
            <h3 class="font-semibold text-gray-900 mb-2 text-sm md:text-base">复习巩固</h3>
            <p class="text-gray-500 text-sm leading-relaxed">错题订正打勾追踪掌握度，考前一键生成重做卷，作文看进步曲线</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Bottom CTA -->
    <section class="py-16 md:py-20 bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 class="text-2xl md:text-3xl font-bold text-white mb-4">开学第一个月，把方法跑顺</h2>
        <p class="text-blue-200/70 mb-8 text-sm md:text-base max-w-xl mx-auto">第一次月考后，让每一份试卷都留下来——不抄题，不白错</p>
        <div class="flex flex-col sm:flex-row gap-4 justify-center">
          <router-link to="/upload" class="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-blue-600/30">
            ✏️ 免费批改第一篇作文
          </router-link>
          <router-link to="/paper/upload" class="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3.5 rounded-2xl text-sm sm:text-base transition-all shadow-lg shadow-emerald-600/30">
            📄 上传试卷整错题
          </router-link>
        </div>
      </div>
    </section>
  </div>
</template>
