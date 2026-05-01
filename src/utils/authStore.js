/**
 * authStore — Vue 3 reactive + localStorage 轻量认证
 *
 * 用法:
 *   import { authStore, authFetch } from './utils/authStore.js'
 *   authStore.login(email, password)
 *   const res = await authFetch('/api/history')
 *
 * 特性:
 * - token 持久化到 localStorage（页面刷新不丢）
 * - authStore.user / authStore.token 是响应式的
 * - authFetch 自动附加 Bearer token
 * - 登录态恢复：应用启动时从 localStorage 恢复 + 验证 token 有效性
 */

import { reactive } from 'vue'

const API_BASE = '' // 同源，Nginx 反向代理
const STORAGE_KEY = 'gaozhong_auth'

// ========== 内部辅助 ==========

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveToStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

function clearStorage() {
  localStorage.removeItem(STORAGE_KEY)
}

// ========== 响应式 Store ==========

export const authStore = reactive({
  token: loadFromStorage().token || null,
  user: loadFromStorage().user || null,
  loading: false,
  error: null,

  /** 是否已登录 */
  get isLoggedIn() {
    return !!this.token && !!this.user
  },

  /** 是否需要修改密码 */
  get mustChangePassword() {
    return this.user?.mustChangePassword === true
  },

  // ======== 注册 ========
  async register({ email, password, nickname, region, grade, school }) {
    this.loading = true
    this.error = null
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, nickname, region, grade, school })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '注册失败')
      this.token = data.token
      this.user = data.user
      saveToStorage({ token: data.token, user: data.user })
      return data
    } catch (err) {
      this.error = err.message
      throw err
    } finally {
      this.loading = false
    }
  },

  // ======== 登录 ========
  async login(email, password) {
    this.loading = true
    this.error = null
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '登录失败')
      this.token = data.token
      this.user = data.user
      saveToStorage({ token: data.token, user: data.user })
      return data
    } catch (err) {
      this.error = err.message
      throw err
    } finally {
      this.loading = false
    }
  },

  // ======== 退出 ========
  logout() {
    this.token = null
    this.user = null
    clearStorage()
  },

  // ======== 刷新用户信息 ========
  async refreshUser() {
    if (!this.token) return
    try {
      const res = await authFetch('/auth/me')
      if (res.ok) {
        const data = await res.json()
        this.user = data.user
        saveToStorage({ token: this.token, user: data.user })
      } else {
        // token 无效，清除登录态
        this.logout()
      }
    } catch {
      // 网络错误不处理，保留当前状态
    }
  },

  // ======== 验证当前 token 是否有效 ========
  async verify() {
    if (!this.token) return false
    try {
      const res = await authFetch('/auth/me')
      return res.ok
    } catch {
      return false
    }
  }
})

// ========== 带认证的 fetch 封装 ==========

/**
 * authFetch — 自动附加 Authorization header 的 fetch
 * 用法与原生 fetch 相同，只对同源请求自动加 token
 */
export function authFetch(url, options = {}) {
  const headers = { ...options.headers }
  if (authStore.token) {
    headers['Authorization'] = `Bearer ${authStore.token}`
  }
  return fetch(url, { ...options, headers })
}

// ========== 启动时恢复登录态 ==========

let restored = false

export async function restoreAuth() {
  if (restored) return
  restored = true

  const stored = loadFromStorage()
  if (!stored.token || !stored.user) return

  authStore.token = stored.token
  authStore.user = stored.user

  // 异步验证 token 有效性
  const valid = await authStore.verify()
  if (!valid) {
    authStore.logout()
  }
}
