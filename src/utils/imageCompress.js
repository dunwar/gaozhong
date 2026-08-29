/**
 * 浏览器端图片压缩 — 手机拍照直传场景（修复"请求体过大"）
 * 长边缩至 maxDim（默认2000px），JPEG 重编码 q0.82。
 * 手机照片典型 3-8MB → 约 400-800KB，上传体积降 85%+，
 * 且 2000px 对 OCR/VL 识别绰绰有余（管线内部本就会再缩）。
 */
export function compressImageDataUrl(dataUrl, maxDim = 2000, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        // 无需缩放且体积已小 → 原样返回
        if (scale >= 1 && dataUrl.length < 700 * 1024) return resolve(dataUrl)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch (e) {
        resolve(dataUrl)  // 压缩失败不阻断上传
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}
