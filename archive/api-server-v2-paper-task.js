/**
 * 新流水线 v2：VL 统一分析（原图 + 红笔图联动）
 * 替换 executePaperTask 函数
 */

async function executePaperTaskV2(task) {
  const { id, input } = task;
  try {
    paperTasks.get(id).status = 'processing';

    // ===== 阶段 1：预处理所有页面 =====
    const totalPages = input.images.length;
    const allWrongQuestions = [];

    for (let i = 0; i < input.images.length; i++) {
      const img = input.images[i];
      if (!img.startsWith('data:image')) continue;

      paperTasks.get(id).progress = {
        stage: 'preprocess',
        message: `预处理第 ${i + 1}/${totalPages} 页 (OCR+笔迹分离)…`,
        current: i + 1, total: totalPages
      };

      // 调用预处理服务获取原图 + 红笔分离图
      let preprocessResult = null;
      try {
        preprocessResult = await preprocessImage(img);
      } catch (err) {
        log('warn', '预处理失败', { taskId: id, page: i + 1, error: err.message });
        continue;
      }

      if (!preprocessResult || !preprocessResult.red_marks) {
        log('warn', '预处理无红笔分离图', { taskId: id, page: i + 1 });
        continue;
      }

      // ===== 阶段 2：VL 统一分析（原图 + 红笔图）=====
      paperTasks.get(id).progress = {
        stage: 'analyze-vl',
        message: `AI 正在分析第 ${i + 1}/${totalPages} 页错题…`,
        current: i + 1, total: totalPages
      };

      const wrongQuestions = await analyzePaperWithVL(
        preprocessResult.corrected || img,
        preprocessResult.red_marks,
        i + 1
      );

      log('info', 'VL 统一分析完成', {
        taskId: id, page: i + 1,
        wrongCount: wrongQuestions.length,
        questions: wrongQuestions.map(q => `Q${q.questionNumber}`)
      });

      allWrongQuestions.push(...wrongQuestions);
    }

    if (allWrongQuestions.length === 0) {
      log('info', '未检测到错题', { taskId: id });
      updatePaperSession(id, { status: 'done', errorCount: 0, totalQuestions: 0, correctCount: 0 });
      paperTasks.get(id).status = 'done';
      paperTasks.get(id).result = { subject: input.subject, sessionId: id, totalQuestions: 0, correctCount: 0, totalErrors: 0, pipeline: 'v2-unified-vl' };
      paperTasks.get(id).progress = { stage: 'done', message: '未检测到错题 ✅' };
      return;
    }

    // ===== 阶段 3：过滤无题干题目（如纯听力题）=====
    const MIN_QUESTION_LENGTH = 8;
    const analyzedWrong = allWrongQuestions.filter(q => {
      const text = q.questionText || '';
      const hasContent = text.replace(/[0-9\.\、\s\n]/g, '').length >= MIN_QUESTION_LENGTH;
      if (!hasContent) {
        log('info', '跳过无题干错题', { taskId: id, q: q.questionNumber, textLen: text.length });
        const errorId = crypto.randomUUID().slice(0, 8);
        saveErrorProblem({
          id: errorId, userId: input.userId, subject: input.subject,
          topic: `第${q.questionNumber}题（${q.questionType || '听力'}）`,
          questionText: '(无题干，听力题)',
          questionType: q.questionType || '听力',
          answerOptions: JSON.stringify(q.options || []),
          wrongAnswer: q.studentAnswer || '',
          correctAnswer: q.correctAnswer || '',
          errorType: '听力题无题干',
          correctSolution: '该题为听力题，无文字题干，无法自动分析。请自行复习听力原文。',
          difficulty: 0,
          knowledgeExplanation: '{}',
          gradingEvidence: q.mark || '',
          aiRaw: JSON.stringify({ skipped: true, reason: 'listening_no_text', original: q }),
          notes: '听力题自动跳过',
          sessionId: id, paperIndex: q.pageIndex || 1, status: 'done',
          createdAt: Date.now()
        });
      }
      return hasContent;
    });

    const skippedCount = allWrongQuestions.length - analyzedWrong.length;
    log('info', '题干过滤完成', { taskId: id, total: allWrongQuestions.length, analyzed: analyzedWrong.length, skipped: skippedCount });

    // ===== 阶段 4：DeepSeek 深度分析 =====
    let analysisResults = [];
    if (analyzedWrong.length > 0) {
      paperTasks.get(id).progress = {
        stage: 'analyze-deepseek',
        message: `AI 正在分析 ${analyzedWrong.length} 道错题…`,
        total: analyzedWrong.length
      };

      const errorList = analyzedWrong.map(q => ({
        questionNumber: q.questionNumber,
        questionType: q.questionType || '选择题',
        questionText: q.questionText || '',
        options: q.options || [],
        studentAnswer: q.studentAnswer || '',
        correctAnswer: q.correctAnswer || '',
        gradingMark: q.mark || '',
        redInkContent: q.mark || '',
        confidence: 'high'
      }));

      analysisResults = await analyzeErrors(input.subject, errorList);
    }

    // ===== 保存结果到数据库 =====
    let savedCount = 0;
    for (let i = 0; i < analyzedWrong.length; i++) {
      const q = analyzedWrong[i];
      const analysis = analysisResults.find(a => a.questionNumber === q.questionNumber) || {};
      const errorId = crypto.randomUUID().slice(0, 8);

      const knowledgeCards = analysis.knowledgeCards || [];
      const knowledgeExplJson = JSON.stringify(
        knowledgeCards.reduce((acc, c) => {
          acc[c.concept] = `${c.explanation}\n本题用法：${c.inThisProblem || ''}`;
          return acc;
        }, {})
      );

      saveErrorProblem({
        id: errorId, userId: input.userId, subject: input.subject,
        topic: `第${q.questionNumber}题（${q.questionType || '选择题'}）`,
        questionText: q.questionText || '',
        questionType: q.questionType || '',
        answerOptions: JSON.stringify(q.options || []),
        wrongAnswer: q.studentAnswer || '',
        correctAnswer: q.correctAnswer || (analysis.correctAnswer || ''),
        errorType: analysis.errorType || '未知',
        correctSolution: analysis.solution || analysis.correctSolution || '',
        difficulty: analysis.difficulty || 3,
        knowledgeExplanation: knowledgeExplJson,
        gradingEvidence: q.mark || '',
        aiRaw: JSON.stringify({
          vl: { questionNumber: q.questionNumber, mark: q.mark, studentAnswer: q.studentAnswer },
          analysis: { diagnosis: analysis.diagnosis, solution: analysis.solution, mnemonic: analysis.mnemonic, knowledgeCards }
        }),
        notes: analysis.mnemonic || '',
        sessionId: id, paperIndex: q.pageIndex || 1, status: 'done',
        createdAt: Date.now()
      });

      const kps = analysis.knowledgePoints || [];
      const matchedKpIds = [];
      for (const kpName of kps) {
        const matches = searchKnowledgePoints(kpName, input.subject);
        if (matches.length > 0) matchedKpIds.push(matches[0].id);
      }
      if (matchedKpIds.length > 0) saveErrorKnowledgeTags(errorId, matchedKpIds);
      savedCount++;
    }

    const totalQuestions = allWrongQuestions.length + (skippedCount > 0 ? skippedCount : 0);
    const correctCount = 0; // 只保存错题

    updatePaperSession(sessionId, {
      status: 'done',
      errorCount: savedCount,
      totalQuestions,
      correctCount,
      aiRaw: JSON.stringify({ pipeline: 'v2-unified-vl', allWrongQuestions, analyzedWrong, analysisResults })
    });

    paperTasks.get(id).status = 'done';
    paperTasks.get(id).result = {
      subject: input.subject,
      sessionId: id,
      totalQuestions,
      correctCount,
      totalErrors: savedCount,
      skippedNoText: skippedCount,
      pipeline: 'v2-unified-vl',
      errors: analysisResults.slice(0, 50)
    };
    paperTasks.get(id).progress = {
      stage: 'done',
      message: `${totalQuestions} 题 ❌${savedCount}${skippedCount > 0 ? ` (${skippedCount}题听力跳过)` : ''} | VL 精准识别`
    };

    log('info', '新流水线 v2 完成', {
      taskId: id, subject: input.subject,
      total: totalQuestions, errors: savedCount, skipped: skippedCount,
      pipeline: 'v2-unified-vl'
    });

  } catch (err) {
    log('error', '整卷分析失败', { taskId: id, error: err.message, stack: err.stack?.substring(0, 300) });
    paperTasks.get(id).status = 'failed';
    paperTasks.get(id).error = err.message;
    paperTasks.get(id).progress = { stage: 'failed', message: err.message };
    try { updatePaperSession(id, { status: 'failed' }); } catch (_) {}
  }
}
