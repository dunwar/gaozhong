<template>
  <div class="max-w-md mx-auto px-4 sm:px-6 lg:px-8 py-16">
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">登录</h1>
      <p class="text-gray-600">登录以查看您的批改历史和管理作文</p>
    </div>

    <div class="bg-white rounded-2xl shadow-lg p-8">
      <!-- 错误提示 -->
      <div v-if="error" class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
        {{ error }}
      </div>

      <form @submit.prevent="handleLogin" class="space-y-5">
        <!-- 邮箱 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">邮箱</label>
          <input
            v-model="email"
            type="email"
            required
            autocomplete="email"
            placeholder="your@email.com"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">密码</label>
          <input
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            placeholder="输入密码"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 提交 -->
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <!-- 注册引导 -->
      <div class="mt-6 text-center text-sm text-gray-500">
        还没有账号？
        <router-link to="/register" class="text-blue-600 hover:text-blue-700 font-medium">立即注册</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { authStore } from '../utils/authStore.js'

const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref(null)

async function handleLogin() {
  error.value = null
  loading.value = true
  try {
    await authStore.login(email.value, password.value)
    // 跳转：需改密码 → 密码页；否则 → 原目标页或首页
    const redirect = route.query.redirect || '/'
    if (authStore.mustChangePassword) {
      router.replace(redirect === '/' ? '/password' : redirect)
    } else {
      router.replace(redirect)
    }
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}
</script>
