<template>
  <div class="share-overlay" @click.self="$emit('close')">
    <div class="share-modal">
      <button class="share-close" @click="$emit('close')" aria-label="关闭">×</button>
      <h3 class="share-title">批改分享卡片</h3>
      <p class="share-sub">卡片只含得分与评语，不展示作文原文</p>

      <div class="share-canvas-wrap">
        <img v-if="cardUrl" :src="cardUrl" alt="作文批改分享卡片" class="share-image" />
        <div v-else class="share-loading">正在生成卡片…</div>
      </div>

      <div class="share-actions">
        <p class="share-tip">📱 长按上方图片可保存 / 发给朋友</p>
        <button v-if="cardUrl" class="share-download" @click="download">保存到相册</button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 作文批改分享卡片 — canvas 生成图片, 只含得分/五维/一句话总评, 不含作文全文(隐私)
import { ref, onMounted } from 'vue'

const props = defineProps({
  result: { type: Object, required: true }
})
defineEmits(['close'])

const cardUrl = ref('')

const W = 750

// 文本换行: 返回逐行数组, 最多 maxLines 行, 末行超出加省略号
function wrapText(ctx, text, x, maxWidth, maxLines) {
  const lines = []
  let line = ''
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; continue }
    const test = line + ch
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = ch
      if (lines.length === maxLines) {
        // 已到行数上限: 末行截断加省略号
        let last = lines[maxLines - 1]
        while (ctx.measureText(last + '…').width > maxWidth && last.length > 1) last = last.slice(0, -1)
        lines[maxLines - 1] = last + '…'
        return lines
      }
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, maxLines)
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawCard() {
  const r = props.result || {}
  const dims = r.dimensions || {}
  const dimKeys = Object.keys(dims)
  const dimCount = Math.min(dimKeys.length, 5)
  const summary = r.oneSentenceSummary || ''

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

  // 先量出总评实际行数, 据此计算卡片总高(块高 = 标题42 + 行数*40 + 下留白28)
  ctx.font = `26px ${FONT}`
  const summaryLines = summary ? wrapText(ctx, summary, 0, W - 120 - 64, 3) : []
  const summaryH = summaryLines.length ? 30 + 50 + summaryLines.length * 40 + 28 : 0

  // 高度 = 头部175 + 主体上区430 + 五维区(标题+条目) + 总评区 + 底部120
  const dimBlockH = dimCount > 0 ? 60 + dimCount * 66 + 30 : 0
  const H = 175 + 430 + dimBlockH + summaryH + 120
  canvas.width = W
  canvas.height = H

  // ── 头部: 深蓝渐变 ──
  const head = ctx.createLinearGradient(0, 0, W, 175)
  head.addColorStop(0, '#003FB0')
  head.addColorStop(1, '#0052D9')
  ctx.fillStyle = head
  ctx.fillRect(0, 0, W, 175)
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.font = `bold 40px ${FONT}`
  ctx.fillText('gaozhong.online', W / 2, 68)
  ctx.font = `26px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillText('高中生的 AI 学习管家', W / 2, 112)
  ctx.font = `20px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.fillText('作文每周细批 · 比学校老师更细', W / 2, 155)

  // ── 主体: 白底 ──
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 175, W, H - 175 - 120)
  let y = 175

  // 小标签
  y += 52
  ctx.fillStyle = '#0052D9'
  ctx.font = `bold 24px ${FONT}`
  ctx.fillText('— AI 作文批改报告 —', W / 2, y)

  // 作文标题(最多2行)
  y += 46
  ctx.fillStyle = '#1D2129'
  ctx.font = `bold 34px ${FONT}`
  const titleLines = wrapText(ctx, r.title || '我的作文', 0, W - 120, 2)
  for (const line of titleLines) { ctx.fillText(line, W / 2, y); y += 46 }

  // 类型 · 字数
  y += 10
  ctx.fillStyle = '#6B7280'
  ctx.font = `24px ${FONT}`
  const meta = [r.essayType, r.wordCount ? `${r.wordCount} 字` : ''].filter(Boolean).join(' · ')
  ctx.fillText(meta || '上海卷 · 70分制', W / 2, y)

  // 大得分
  y += 100
  const scoreStr = String(r.totalScore ?? 0)
  ctx.fillStyle = '#0052D9'
  ctx.font = `bold 130px ${FONT}`
  const scoreW = ctx.measureText(scoreStr).width
  ctx.font = `36px ${FONT}`
  const maxW = ctx.measureText(' / 70').width
  ctx.textAlign = 'left'
  ctx.font = `bold 130px ${FONT}`
  ctx.fillText(scoreStr, (W - scoreW - maxW) / 2, y)
  ctx.fillStyle = '#9AA4B2'
  ctx.font = `36px ${FONT}`
  ctx.fillText(' / 70', (W - scoreW - maxW) / 2 + scoreW, y - 12)
  ctx.textAlign = 'center'

  // 档位徽章
  y += 44
  const grade = r.grade || ''
  if (grade) {
    ctx.font = `bold 28px ${FONT}`
    const gw = ctx.measureText(grade).width + 60
    roundRect(ctx, (W - gw) / 2, y, gw, 56, 28)
    ctx.fillStyle = '#EAF1FF'
    ctx.fill()
    ctx.fillStyle = '#0052D9'
    ctx.fillText(grade, W / 2, y + 38)
  }

  // ── 五维得分 ──
  y += 110
  if (dimCount > 0) {
    ctx.textAlign = 'left'
    ctx.fillStyle = '#1D2129'
    ctx.font = `bold 28px ${FONT}`
    ctx.fillText('五维得分', 70, y)
    y += 44
    for (let i = 0; i < dimCount; i++) {
      const key = dimKeys[i]
      const dim = dims[key]
      const barX = 70, barW = W - 140
      // 名称
      ctx.fillStyle = '#4E5561'
      ctx.font = `26px ${FONT}`
      ctx.fillText(key, barX, y + 18)
      // 分数
      ctx.fillStyle = '#1D2129'
      ctx.font = `bold 26px ${FONT}`
      const scoreText = `${dim.score}/${dim.full}`
      ctx.fillText(scoreText, barX + barW - ctx.measureText(scoreText).width, y + 18)
      // 轨道
      const trackY = y + 36
      roundRect(ctx, barX, trackY, barW, 14, 7)
      ctx.fillStyle = '#E5EAF3'
      ctx.fill()
      // 进度
      const pct = dim.full ? Math.max(0.03, dim.score / dim.full) : 0
      roundRect(ctx, barX, trackY, barW * pct, 14, 7)
      ctx.fillStyle = '#0052D9'
      ctx.fill()
      y += 66
    }
    y += 6
    ctx.textAlign = 'center'
  }

  // ── 一句话总评 ──
  if (summaryLines.length) {
    y += 30
    const boxX = 60, boxW = W - 120
    const boxH = 50 + summaryLines.length * 40
    roundRect(ctx, boxX, y, boxW, boxH, 16)
    ctx.fillStyle = '#F5F7FA'
    ctx.fill()
    ctx.fillStyle = '#4E5561'
    ctx.textAlign = 'left'
    ctx.font = `bold 24px ${FONT}`
    ctx.fillText('一句话总评', boxX + 32, y + 42)
    ctx.font = `26px ${FONT}`
    summaryLines.forEach((line, i) => ctx.fillText(line, boxX + 32, y + 82 + i * 40))
    ctx.textAlign = 'center'
  }

  // ── 底部 ──
  const by = H - 120
  ctx.fillStyle = '#0B1C3A'
  ctx.fillRect(0, by, W, 120)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = `bold 28px ${FONT}`
  ctx.fillText('作文每周细批 × 试卷考后秒变错题本', W / 2, by + 50)
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = `24px ${FONT}`
  ctx.fillText('gaozhong.online · 长按保存分享', W / 2, by + 90)

  cardUrl.value = canvas.toDataURL('image/png')
}

function download() {
  if (!cardUrl.value) return
  const a = document.createElement('a')
  a.href = cardUrl.value
  a.download = `作文批改报告-${props.result?.totalScore ?? ''}分.png`
  a.click()
}

onMounted(drawCard)
</script>

<style scoped>
.share-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.72);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.share-modal {
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
.share-close {
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
.share-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: #1d2129;
  text-align: center;
}
.share-sub {
  margin: 4px 0 12px;
  font-size: 12px;
  color: #6b7280;
  text-align: center;
}
.share-canvas-wrap {
  overflow-y: auto;
  border-radius: 12px;
  background: #f5f7fa;
}
.share-image {
  display: block;
  width: 100%;
  height: auto;
}
.share-loading {
  padding: 60px 0;
  text-align: center;
  color: #6b7280;
  font-size: 14px;
}
.share-actions {
  margin-top: 12px;
  text-align: center;
}
.share-tip {
  margin: 0 0 8px;
  font-size: 12px;
  color: #6b7280;
}
.share-download {
  width: 100%;
  padding: 11px 0;
  border: none;
  border-radius: 10px;
  background: var(--color-primary, #0052d9);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
.share-download:hover {
  opacity: 0.9;
}
</style>
