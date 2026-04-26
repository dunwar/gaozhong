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

      <div class="border-t border-gray-800 mt-8 pt-8 text-center text-sm text-gray-400">
        <p>&copy; {{ new Date().getFullYear() }} gaozhong.online 高中在线. All rights reserved.</p>
      </div>
    </div>
  </footer>
</template>
