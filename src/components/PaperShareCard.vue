<template>
  <div class="pshare-overlay" @click.self="$emit('close')">
    <div class="pshare-modal">
      <button class="pshare-close" @click="$emit('close')" aria-label="关闭">×</button>
      <h3 class="pshare-title">试卷学情分享卡片</h3>
      <p class="pshare-sub">只含题量统计，不含题目内容与学生信息</p>

      <div class="pshare-canvas-wrap">
        <img v-if="cardUrl" :src="cardUrl" alt="试卷学情报告卡片" class="pshare-image" />
        <div v-else class="pshare-loading">正在生成卡片…</div>
      </div>

      <div class="pshare-actions">
        <p class="pshare-tip">📱 长按上方图片可保存 / 发到家长群</p>
        <button v-if="cardUrl" class="pshare-download" @click="download">保存到相册</button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 试卷学情分享卡 (2026-10-20): 家长视角的社交货币 — 科目+错题数+订正纸卖点+二维码
// 隐私: 不含题目文字/学生姓名/学校, 只有统计数字
import { ref, onMounted } from 'vue'
import QRCode from 'qrcode'
import { authStore, authFetch } from '../utils/authStore.js'
import { trackEvent } from '../utils/analytics.js'

const props = defineProps({
  subject: { type: String, default: '' },
  totalQuestions: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
})
defineEmits(['close'])

const cardUrl = ref('')
const W = 750
const H = 960

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

const subjectLabelMap = {
  english: '英语', chinese: '语文', math: '数学',
  physics: '物理', chemistry: '化学', biology: '生物',
  history: '历史', geography: '地理', politics: '政治',
}
function subjectLabel() {
  return subjectLabelMap[props.subject] || props.subject || '试卷'
}

async function drawCard(qrImg) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
  canvas.width = W
  canvas.height = H

  // ── 头部: 绿色渐变(与作文卡蓝色区分) ──
  const head = ctx.createLinearGradient(0, 0, W, 200)
  head.addColorStop(0, '#14532D')
  head.addColorStop(1, '#16A34A')
  ctx.fillStyle = head
  ctx.fillRect(0, 0, W, 200)
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.font = `bold 40px ${FONT}`
  ctx.fillText('gaozhong.online', W / 2, 72)
  ctx.font = `26px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillText('高中生的 AI 学习管家', W / 2, 116)
  ctx.font = `20px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.fillText('试卷拍照 · 自动整理错题 · 一键打印订正纸', W / 2, 162)

  // ── 主体: 白底 ──
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 200, W, H - 200 - 180)

  ctx.fillStyle = '#16A34A'
  ctx.font = `bold 24px ${FONT}`
  ctx.fillText('— AI 试卷错题整理报告 —', W / 2, 268)

  // 科目徽章
  const label = subjectLabel()
  ctx.font = `bold 30px ${FONT}`
  const bw = ctx.measureText(label).width + 64
  roundRect(ctx, (W - bw) / 2, 300, bw, 60, 30)
  ctx.fillStyle = '#F0FDF4'
  ctx.fill()
  ctx.strokeStyle = '#BBF7D0'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = '#15803D'
  ctx.fillText(label, W / 2, 340)

  // 两个大数字: 总题数 / 错题数
  const rowY = 470
  const colW = W / 2
  ctx.textAlign = 'center'
  ctx.fillStyle = '#1D2129'
  ctx.font = `bold 96px ${FONT}`
  ctx.fillText(String(props.totalQuestions), colW / 2, rowY)
  ctx.fillStyle = '#DC2626'
  ctx.fillText(String(props.errorCount), colW + colW / 2, rowY)
  ctx.font = `24px ${FONT}`
  ctx.fillStyle = '#6B7280'
  ctx.fillText('题目总数', colW / 2, rowY + 46)
  ctx.fillStyle = '#DC2626'
  ctx.fillText('待订正错题', colW + colW / 2, rowY + 46)

  // 错题占比说明
  const pct = props.totalQuestions > 0 ? Math.round(props.errorCount * 100 / props.totalQuestions) : 0
  ctx.fillStyle = '#4E5561'
  ctx.font = `26px ${FONT}`
  ctx.fillText(`错题占比约 ${pct}% · 薄弱点已自动归位`, W / 2, rowY + 120)

  // 订正纸卖点卡
  const bx = 60, bw2 = W - 120, by2 = rowY + 160, bh2 = 150
  roundRect(ctx, bx, by2, bw2, bh2, 16)
  ctx.fillStyle = '#F5F7FA'
  ctx.fill()
  ctx.textAlign = 'left'
  ctx.fillStyle = '#15803D'
  ctx.font = `bold 26px ${FONT}`
  ctx.fillText('✓ 错题已自动整理成册', bx + 32, by2 + 52)
  ctx.fillStyle = '#4E5561'
  ctx.font = `24px ${FONT}`
  ctx.fillText('✓ 一键生成打印版订正纸，不用手抄', bx + 32, by2 + 100)
  ctx.textAlign = 'center'

  // ── 底部: 文案 + 二维码 ──
  const fH = 180
  const by = H - fH
  ctx.fillStyle = '#0B1C3A'
  ctx.fillRect(0, by, W, fH)
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = `bold 30px ${FONT}`
  ctx.fillText('考后 10 分钟', 56, by + 66)
  ctx.fillText('错题本 + 订正纸自动搞定', 56, by + 110)
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = `22px ${FONT}`
  ctx.fillText('扫码免费体验 · gaozhong.online', 56, by + 150)
  ctx.textAlign = 'center'
  if (qrImg) {
    const qrSize = 124
    const qrX = W - 56 - qrSize
    const qrY = by + (fH - qrSize) / 2
    ctx.fillStyle = '#FFFFFF'
    roundRect(ctx, qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 10)
    ctx.fill()
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize)
  }

  cardUrl.value = canvas.toDataURL('image/png')
}

function download() {
  if (!cardUrl.value) return
  const a = document.createElement('a')
  a.href = cardUrl.value
  a.download = `${subjectLabel()}学情报告.png`
  a.click()
}

onMounted(async () => {
  trackEvent('paper', 'share_card')
  // 二维码: 登录用户用邀请链接(裂变), 否则站点首页
  let qrTarget = 'https://gaozhong.online'
  if (authStore.isLoggedIn) {
    try {
      const res = await authFetch('/api/referral/me')
      const data = await res.json()
      if (data.success && data.inviteUrl) qrTarget = data.inviteUrl
    } catch (_) { /* 用默认 */ }
  }
  let qrImg = null
  try {
    const dataUrl = await QRCode.toDataURL(qrTarget, { width: 248, margin: 1, color: { dark: '#0B1C3A', light: '#FFFFFF' } })
    qrImg = new Image()
    await new Promise((resolve, reject) => {
      qrImg.onload = resolve
      qrImg.onerror = reject
      qrImg.src = dataUrl
    })
  } catch (_) { qrImg = null }
  drawCard(qrImg)
})
</script>

<style scoped>
.pshare-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.72);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.pshare-modal {
  position: relative;
  background: #fff;
  border-radius: 16px;
  width: 100%;
  max-width: 420px;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  padding: 20px 20px 16px;
}
.pshare-close {
  position: absolute;
  top: 8px;
  right: 12px;
  border: none;
  background: none;
  font-size: 28px;
  color: #9aa4b2;
  cursor: pointer;
  line-height: 1;
}
.pshare-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: #1d2129;
  text-align: center;
}
.pshare-sub {
  margin: 4px 0 12px;
  font-size: 12px;
  color: #6b7280;
  text-align: center;
}
.pshare-canvas-wrap {
  overflow-y: auto;
  border-radius: 12px;
  background: #f5f7fa;
}
.pshare-image {
  display: block;
  width: 100%;
  height: auto;
}
.pshare-loading {
  padding: 60px 0;
  text-align: center;
  color: #6b7280;
  font-size: 14px;
}
.pshare-actions {
  margin-top: 12px;
  text-align: center;
}
.pshare-tip {
  margin: 0 0 8px;
  font-size: 12px;
  color: #6b7280;
}
.pshare-download {
  width: 100%;
  padding: 11px 0;
  border: none;
  border-radius: 10px;
  background: var(--color-primary, #16a34a);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
.pshare-download:hover {
  opacity: 0.9;
}
</style>
