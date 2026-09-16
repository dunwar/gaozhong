// analytics.js — 业务事件埋点(百度统计 _trackEvent)
// 页面级 PV 由 index.html 统计脚本+路由 afterEach 覆盖, 这里只打业务事件
// 百度后台「事件分析」查看; 无统计脚本/失败时静默不影响功能
export function trackEvent(category, action, label, value) {
  try {
    if (typeof window !== 'undefined' && Array.isArray(window._hmt)) {
      window._hmt.push(['_trackEvent', category, action, label, value])
    }
  } catch (_) { /* 埋点失败静默 */ }
}

// ===== 约定的事件清单(新埋点请登记在此, 便于后台核对) =====
// essay    | submit_click        开始批改点击
// essay    | result_view         批改结果到达
// essay    | share_card          生成分享卡片
// paper    | demo_click          示例卷入口点击(首页/上传页 label 区分)
// paper    | demo_created        示例卷session创建成功
// paper    | demo_convert_click  demo确认页点击"注册"按钮
// growth   | register_success    注册成功(label: ref=邀请链接 / organic=自然)
// growth   | ref_link_copy       复制邀请链接
// monetize | pricing_view        充值页到达
