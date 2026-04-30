import React, { useState, useEffect } from 'react';
import { 
  ChevronDown, 
  ChevronUp, 
  Award, 
  BookOpen, 
  PenTool, 
  MessageSquare, 
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Quote,
  FileText
} from 'lucide-react';

// 模拟数据 - 实际使用时从API获取
const mockData = {
  title: "创造转化文化，兼收并蓄美德",
  totalScore: 46,
  grade: "三类卷中上段",
  essayType: "议论文",
  wordCount: 650,
  dimensions: {
    审题立意: { score: 12, full: 20, evaluation: "扣住了'创造转化文化'，但几乎忽略了'兼收并蓄美德'" },
    思辨深度: { score: 16, full: 30, evaluation: "有《黑神话：悟空》等新颖素材，但思辨展开不够深入" },
    结构布局: { score: 10, full: 20, evaluation: "卷面布局混乱，跨栏书写严重影响阅读" },
    语言表达: { score: 10, full: 15, evaluation: "病句与错别字频出，多处语病" },
    素材运用: { score: 12, full: 15, evaluation: "《黑神话：悟空》选材新颖，具有时代感" }
  },
  adjustments: {
    plus: [
      { reason: "素材新颖，《黑神话：悟空》具有时代感", points: 2 },
      { reason: "敢于质疑传统'死板保护'的观点", points: 1 }
    ],
    minus: [
      { reason: "审题偏差，漏掉'兼收并蓄美德'", points: -5 },
      { reason: "卷面结构混乱，跨栏书写", points: -4 },
      { reason: "多处语病和错别字", points: -2 }
    ]
  },
  rawScore: 60,
  adjustedScore: 52,
  gradingReason: "文章基本符合题意，立意尚可，材料选用新颖。但语言偶有语病，且卷面行文结构极度混乱，严重影响阅卷体验。综合来看，无法进入二类卷，属于典型的三类卷。",
  strengths: [
    "《黑神话：悟空》选材新颖，具有时代感",
    "敢于质疑传统'死板保护'的观点",
    "对文化创造性转化有一定思考"
  ],
  weaknesses: [
    "审题偏差，只写了一半题目",
    "卷面结构混乱，跨栏书写",
    "多处语病和错别字"
  ],
  suggestions: [
    "审题必须完整：遇到并列式题目，必须找到A与B之间的内在逻辑",
    "先构思再动笔：动笔前列好提纲，避免卷面混乱",
    "锤炼语言基本功：减少生造词和错别字"
  ],
  upgradePath: {
    toClass2: "审题完整 + 卷面整洁 + 减少语病",
    toClass1: "在二类卷基础上，思辨更加深入，语言更有文采"
  },
  revisions: [
    {
      category: "审题偏差",
      location: "第三段",
      original: "文化，其本身也不是一个一成不变的物品，一味的传承原汁原味，也早会产生对先人文化的错误理解",
      suggested: "文化，其本身也不是一个一成不变的物品。一味的传承原汁原味，不仅会产生对先人文化的错误理解，更会让文化失去与时代对话的能力。因此，我们既需要创造性转化，更需要兼收并蓄——以开放的心态吸纳外来文化的精华。",
      reason: "补充了'兼收并蓄'的论述，回应题目要求"
    },
    {
      category: "语病修正",
      location: "第二段",
      original: "也早会产生对先人文化的错误理解",
      suggested: "也更会产生对先人文化的错误理解",
      reason: "'早会'逻辑不通，改为'更'表达递进关系"
    },
    {
      category: "用词不当",
      location: "第三段",
      original: "建构同样可以是一种好的传承方式",
      suggested: "创新演绎同样可以是一种好的传承方式",
      reason: "'建构'过于学术化，'创新演绎'更通俗易懂"
    }
  ],
  oneSentenceSummary: "这是一篇具备一定现实思考和时代素材亮点的作文，但审题偏差、卷面混乱和语言瑕疵等硬伤使其只能停留在三类卷水平。",
  essayText: `文化，是一个民族的根与魂。在全球化浪潮席卷而来的今天，如何让传统文化焕发新生，是我们这一代青年必须思考的问题。

文化，其本身也不是一个一成不变的物品，一味的传承原汁原味，也早会产生对先人文化的错误理解。建构同样可以是一种好的传承方式。可以直止让文化成为"活"的文化，产生经济效益并促使人们主动了解。

《黑神话：悟空》的成功就是最好的例证。这款游戏以中国传统神话为背景，用现代游戏技术重新演绎，让全球玩家都感受到了中国文化的魅力。这种通暂本身就会带来文化的传播与传承。

因此，我们要勇于对传统文化进行创造性转化，让它在新时代绽放光彩。`,
  highlights: [
    { start: 96, end: 118, type: "error", note: "审题偏差，未谈兼收并蓄" },
    { start: 119, end: 131, type: "error", note: "'早会'应为'更'" },
    { start: 132, end: 148, type: "error", note: "'建构'用词不当" },
    { start: 149, end: 159, type: "error", note: "'直止'错别字" },
    { start: 276, end: 284, type: "error", note: "'通暂'应为'尝试'" },
    { start: 185, end: 211, type: "good", note: "《黑神话：悟空》选材新颖" }
  ]
};

// 维度颜色映射
const dimensionColors = {
  审题立意: "#8B4513",
  思辨深度: "#B22222", 
  结构布局: "#CD853F",
  语言表达: "#2E8B57",
  素材运用: "#4682B4"
};

// 进度条组件
const ProgressBar = ({ score, full, color, label }) => {
  const percentage = (score / full) * 100;
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm font-medium text-amber-900">{label}</span>
        <span className="text-sm font-bold" style={{ color }}>{score}/{full}</span>
      </div>
      <div className="h-2 bg-amber-100 rounded-full overflow-hidden">
        <div 
          className="h-full rounded-full transition-all duration-1000 ease-out"
          style={{ 
            width: `${percentage}%`, 
            backgroundColor: color,
            opacity: 0.8
          }}
        />
      </div>
    </div>
  );
};

// 可折叠面板组件
const CollapsiblePanel = ({ title, score, full, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const percentage = (score / full) * 100;
  
  return (
    <div className="border-b border-amber-200 last:border-b-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between py-4 px-2 hover:bg-amber-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-amber-900">{title}</span>
          <span className={`text-sm font-bold ${percentage >= 70 ? 'text-green-600' : percentage >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
            {score}/{full}
          </span>
        </div>
        {isOpen ? <ChevronUp className="w-5 h-5 text-amber-600" /> : <ChevronDown className="w-5 h-5 text-amber-400" />}
      </button>
      <div className={`overflow-hidden transition-all duration-300 ${isOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className="pb-4 px-2 text-amber-800 leading-relaxed">
          {children}
        </div>
      </div>
    </div>
  );
};

// 修改建议卡片
const RevisionCard = ({ revision, index }) => {
  return (
    <div className="bg-white/60 rounded-lg p-4 mb-3 border-l-4 border-red-400 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="bg-red-100 text-red-700 text-xs font-medium px-2 py-1 rounded">
          修改{index + 1}
        </span>
        <span className="text-sm text-amber-700">{revision.category}</span>
        <span className="text-xs text-amber-500">· {revision.location}</span>
      </div>
      
      <div className="space-y-2">
        <div className="bg-red-50 rounded p-2">
          <span className="text-xs text-red-600 font-medium">原文：</span>
          <p className="text-sm text-amber-900 mt-1 line-through opacity-70">{revision.original}</p>
        </div>
        
        <div className="bg-green-50 rounded p-2">
          <span className="text-xs text-green-600 font-medium">建议：</span>
          <p className="text-sm text-amber-900 mt-1">{revision.suggested}</p>
        </div>
        
        <p className="text-xs text-amber-600 italic">{revision.reason}</p>
      </div>
    </div>
  );
};

// 作文原文展示（带高亮）
const EssayDisplay = ({ text, highlights }) => {
  // 简单的文本高亮渲染
  const renderHighlightedText = () => {
    if (!highlights || highlights.length === 0) {
      return <p className="leading-loose text-amber-900 whitespace-pre-wrap">{text}</p>;
    }

    // 按位置排序
    const sortedHighlights = [...highlights].sort((a, b) => a.start - b.start);
    const parts = [];
    let lastEnd = 0;

    sortedHighlights.forEach((hl, idx) => {
      // 高亮前的普通文本
      if (hl.start > lastEnd) {
        parts.push(
          <span key={`text-${idx}`}>
            {text.slice(lastEnd, hl.start)}
          </span>
        );
      }
      
      // 高亮文本
      const bgColor = hl.type === 'error' ? 'bg-red-100' : 'bg-green-100';
      const textColor = hl.type === 'error' ? 'text-red-700' : 'text-green-700';
      const borderColor = hl.type === 'error' ? 'border-red-300' : 'border-green-300';
      
      parts.push(
        <span 
          key={`hl-${idx}`}
          className={`${bgColor} ${textColor} px-1 py-0.5 rounded border-b-2 ${borderColor} cursor-help relative group`}
          title={hl.note}
        >
          {text.slice(hl.start, hl.end)}
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
            {hl.note}
          </span>
        </span>
      );
      
      lastEnd = hl.end;
    });

    // 剩余文本
    if (lastEnd < text.length) {
      parts.push(<span key="text-end">{text.slice(lastEnd)}</span>);
    }

    return <p className="leading-loose text-amber-900 whitespace-pre-wrap">{parts}</p>;
  };

  return (
    <div className="bg-white/80 rounded-lg p-6 shadow-inner">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-amber-200">
        <FileText className="w-5 h-5 text-amber-600" />
        <span className="font-medium text-amber-900">作文原文</span>
        <div className="flex gap-3 ml-auto text-xs">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 bg-red-100 border-b-2 border-red-300 rounded"></span>
            <span className="text-amber-700">需修改</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 bg-green-100 border-b-2 border-green-300 rounded"></span>
            <span className="text-amber-700">亮点</span>
          </span>
        </div>
      </div>
      {renderHighlightedText()}
    </div>
  );
};

// 主组件
const EssayGradingResult = ({ data = mockData }) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50">
      {/* 纸张纹理背景 */}
      <div 
        className="fixed inset-0 opacity-30 pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100' height='100' filter='url(%23noise)' opacity='0.08'/%3E%3C/svg%3E")`
        }}
      />
      
      <div className="relative max-w-4xl mx-auto px-4 py-8">
        {/* 页面标题 */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-amber-900 mb-2" style={{ fontFamily: 'Georgia, serif' }}>
            作文批改结果
          </h1>
          <p className="text-amber-700 text-lg">{data.title}</p>
        </div>

        {/* 总分和档位卡片 */}
        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <div className="bg-gradient-to-br from-red-700 to-red-800 rounded-2xl p-6 text-white shadow-lg">
            <div className="flex items-center gap-3 mb-2">
              <Award className="w-6 h-6" />
              <span className="text-red-100">最终得分</span>
            </div>
            <div className="text-5xl font-bold">{data.totalScore}<span className="text-2xl text-red-200">/70</span></div>
          </div>
          
          <div className="bg-white/80 backdrop-blur rounded-2xl p-6 shadow-lg border border-amber-200">
            <div className="flex items-center gap-3 mb-2">
              <BookOpen className="w-6 h-6 text-amber-600" />
              <span className="text-amber-700">档位评定</span>
            </div>
            <div className="text-3xl font-bold text-amber-900">{data.grade}</div>
            <div className="text-sm text-amber-600 mt-1">{data.essayType} · {data.wordCount}字</div>
          </div>
        </div>

        {/* 五维得分 */}
        <div className="bg-white/70 backdrop-blur rounded-2xl p-6 shadow-lg border border-amber-200 mb-6">
          <h2 className="text-lg font-bold text-amber-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            分项得分
          </h2>
          {Object.entries(data.dimensions).map(([key, value]) => (
            <ProgressBar 
              key={key}
              label={key}
              score={value.score}
              full={value.full}
              color={dimensionColors[key]}
            />
          ))}
        </div>

        {/* 加减分项 */}
        <div className="bg-white/70 backdrop-blur rounded-2xl p-6 shadow-lg border border-amber-200 mb-6">
          <h2 className="text-lg font-bold text-amber-900 mb-4 flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            加减分项
          </h2>
          <div className="space-y-2">
            {data.adjustments.plus.map((item, idx) => (
              <div key={`plus-${idx}`} className="flex items-center gap-2 text-green-700">
                <CheckCircle2 className="w-4 h-4" />
                <span className="text-sm">{item.reason}</span>
                <span className="text-sm font-bold ml-auto">+{item.points}分</span>
              </div>
            ))}
            {data.adjustments.minus.map((item, idx) => (
              <div key={`minus-${idx}`} className="flex items-center gap-2 text-red-600">
                <XCircle className="w-4 h-4" />
                <span className="text-sm">{item.reason}</span>
                <span className="text-sm font-bold ml-auto">{item.points}分</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-amber-200 text-sm text-amber-700">
            <span>维度得分：{data.rawScore}分 → 调整后：{data.adjustedScore}分 → 换算70分制：{data.totalScore}分</span>
          </div>
        </div>

        {/* 分维度详细点评 */}
        <div className="bg-white/70 backdrop-blur rounded-2xl shadow-lg border border-amber-200 mb-6 overflow-hidden">
          <div className="p-4 border-b border-amber-200">
            <h2 className="text-lg font-bold text-amber-900 flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              分维度详细点评
            </h2>
          </div>
          {Object.entries(data.dimensions).map(([key, value]) => (
            <CollapsiblePanel 
              key={key}
              title={key}
              score={value.score}
              full={value.full}
            >
              {value.evaluation}
            </CollapsiblePanel>
          ))}
        </div>

        {/* 阅卷总结 */}
        <div className="bg-white/70 backdrop-blur rounded-2xl p-6 shadow-lg border border-amber-200 mb-6">
          <h2 className="text-lg font-bold text-amber-900 mb-4 flex items-center gap-2">
            <PenTool className="w-5 h-5" />
            阅卷总结
          </h2>
          
          <div className="mb-4">
            <h3 className="font-medium text-amber-800 mb-2">定档理由</h3>
            <p className="text-sm text-amber-700 leading-relaxed">{data.gradingReason}</p>
          </div>

          <div className="mb-4">
            <h3 className="font-medium text-amber-800 mb-2">升格路径</h3>
            <div className="space-y-1 text-sm">
              <p className="text-amber-700"><span className="font-medium">进入二类卷：</span>{data.upgradePath.toClass2}</p>
              <p className="text-amber-700"><span className="font-medium">进入一类卷：</span>{data.upgradePath.toClass1}</p>
            </div>
          </div>

          <div>
            <h3 className="font-medium text-amber-800 mb-2">具体建议</h3>
            <ul className="space-y-1">
              {data.suggestions.map((s, i) => (
                <li key={i} className="text-sm text-amber-700 flex items-start gap-2">
                  <span className="text-amber-500 mt-1">•</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 具体修改建议 */}
        <div className="bg-white/70 backdrop-blur rounded-2xl p-6 shadow-lg border border-amber-200 mb-6">
          <h2 className="text-lg font-bold text-amber-900 mb-4 flex items-center gap-2">
            <Quote className="w-5 h-5" />
            具体修改建议
          </h2>
          {data.revisions.map((revision, index) => (
            <RevisionCard key={index} revision={revision} index={index} />
          ))}
        </div>

        {/* 一句话总结 */}
        <div className="bg-amber-100/80 rounded-2xl p-6 border-l-4 border-amber-500 mb-6">
          <p className="text-amber-900 italic leading-relaxed">"{data.oneSentenceSummary}"</p>
        </div>

        {/* 作文原文 */}
        <EssayDisplay text={data.essayText} highlights={data.highlights} />

        {/* 页脚 */}
        <div className="text-center mt-8 text-sm text-amber-500">
          <p>Powered by gaozhong.online AI 作文批改</p>
        </div>
      </div>
    </div>
  );
};

export default EssayGradingResult;