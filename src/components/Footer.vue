<template>
  <footer class="bg-gray-900 text-white">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <!-- Brand -->
        <div>
          <h3 class="text-lg font-semibold mb-4">高中在线</h3>
          <p class="text-gray-400 text-sm">AI 驱动的高中学业诊断平台<br/>用人工智能帮助高中生精准提升学业能力</p>
        </div>

        <!-- Quick Links -->
        <div>
          <h3 class="text-lg font-semibold mb-4">快速链接</h3>
          <ul class="space-y-2 text-sm text-gray-400">
            <li><router-link to="/" class="hover:text-white">首页</router-link></li>
            <li><router-link to="/upload" class="hover:text-white">作文批改</router-link></li>
          </ul>
        </div>

        <!-- Contact -->
        <div>
          <h3 class="text-lg font-semibold mb-4">联系我们</h3>
          <p class="text-gray-400 text-sm">邮箱: contact@gaozhong.online</p>
        </div>
      </div>

      <div class="border-t border-gray-800 mt-8 pt-6 text-center">
        <p class="text-sm text-gray-400">&copy; {{ new Date().getFullYear() }} gaozhong.online 高中在线. All rights reserved.</p>
        <!-- 备案信息（合规要求：首页页脚展示） -->
        <div class="mt-3 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-8 text-xs text-gray-500">
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer"
             class="inline-flex items-center gap-1.5 hover:text-gray-300 transition-colors">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            沪ICP备2026018498号-1
          </a>
          <a href="https://beian.mps.gov.cn/#/query/webSearch?code=31010402336795" target="_blank" rel="noopener noreferrer"
             class="inline-flex items-center gap-1.5 hover:text-gray-300 transition-colors">
            <!-- 公安徽标（红盾金星，内联SVG，不依赖外链图片） -->
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2L4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" fill="#c0392b"/>
              <polygon points="12,8.3 13.06,11.04 16,11.2 13.71,13.06 14.47,15.9 12,14.3 9.53,15.9 10.29,13.06 8,11.2 10.94,11.04" fill="#f1c40f"/>
            </svg>
            沪公网安备31010402336795号
          </a>
        </div>
      </div>
    </div>
  </footer>
</template>
