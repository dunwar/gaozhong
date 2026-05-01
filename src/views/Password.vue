<template>
  <div class="max-w-md mx-auto px-4 sm:px-6 lg:px-8 py-16">
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">
        {{ mustChange ? '请修改密码' : '修改密码' }}
      </h1>
      <p class="text-gray-600">
        {{ mustChange ? '首次登录需要修改默认密码' : '输入旧密码和新密码以更新' }}
      </p>
    </div>

    <div class="bg-white rounded-2xl shadow-lg p-8">
      <!-- 错误提示 -->
      <div v-if="error" class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
        {{ error }}
      </div>
      <!-- 成功提示 -->
      <div v-if="success" class="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
        {{ success }}
      </div>

      <form @submit.prevent="handleSubmit" class="space-y-5">
        <!-- 旧密码（非强制模式） -->
        <div v-if="!mustChange">
          <label class="block text-sm font-medium text-gray-700 mb-2">旧密码</label>
          <input
            v-model="oldPassword"
            type="password"
            required
            autocomplete="current-password"
            placeholder="输入旧密码"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 新密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">新密码</label>
          <input
            v-model="newPassword"
            type="password"
            required
            autocomplete="new-password"
            placeholder="至少6位"
            minlength="6"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 确认新密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">确认新密码</label>
          <input
            v-model="confirmPassword"
            type="password"
            required
            autocomplete="new-password"
            placeholder="再次输入新密码"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
          />
        </div>

        <!-- 提交 -->
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {{ loading ? '提交中...' : '确认修改' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { authStore, authFetch } from '../utils/authStore.js'

const router = useRouter()

const mustChange = computed(() => authStore.mustChangePassword)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref(null)
const success = ref(null)

async function handleSubmit() {
  error.value = null
  success.value = null

  if (newPassword.value.length < 6) {
    error.value = '新密码长度不能少于6位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }

  loading.value = true
  try {
    const res = await authFetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldPassword: mustChange.value ? undefined : oldPassword.value,
        newPassword: newPassword.value
      })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '修改失败')

    // 更新 authStore 中的 mustChangePassword 标记
    if (authStore.user) {
      authStore.user.mustChangePassword = false
    }

    success.value = '密码修改成功！'

    if (mustChange.value) {
      // 强制改密完成，跳转到首页
      setTimeout(() => router.replace('/'), 1000)
    } else {
      setTimeout(() => success.value = null, 3000)
      oldPassword.value = ''
    }
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}
</script>
