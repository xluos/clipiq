import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, FileText } from "lucide-react";
import { formatTime } from "@/lib/utils";

export function ReportScreen() {
  const { setCurrentScreen, reportByProject, activeProjectId, projects, nodes } = useApp();
  
  const project = projects.find(p => p.id === activeProjectId);
  const report = reportByProject[activeProjectId || ""];

  if (!project || !report) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B]">
        <FileText className="w-16 h-16 text-slate-300 dark:text-slate-700 mb-4" />
        <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-300">暂无项目或报告数据</h2>
        <p className="text-sm text-slate-500 mt-2">请先完成视频分析以生成报告</p>
        <Button className="mt-6" onClick={() => setCurrentScreen("home")}>
          返回首页
        </Button>
      </div>
    );
  }

  const keyNodes = nodes.filter(n => n.tags.includes('key_moment') || n.tags.includes('emotion_turn'));

  return (
    <div className="flex-1 flex h-full bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      {/* Report Sidebar */}
      <div className="w-56 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] flex flex-col pt-4">
        <div className="px-4 pb-4 flex items-center space-x-2 border-b border-slate-200 dark:border-slate-800">
          <Button variant="ghost" size="icon" onClick={() => setCurrentScreen("workspace")} className="w-8 h-8 -ml-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <span className="font-semibold text-slate-800 dark:text-slate-200 text-sm truncate">返回工作台</span>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          <button className="w-full text-left px-3 py-2 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 rounded-md text-sm font-medium">整体摘要</button>
          <button className="w-full text-left px-3 py-2 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50 rounded-md text-sm">结构拆解</button>
          <button className="w-full text-left px-3 py-2 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50 rounded-md text-sm">情感曲线</button>
          <button className="w-full text-left px-3 py-2 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50 rounded-md text-sm">节奏分析</button>
          <button className="w-full text-left px-3 py-2 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50 rounded-md text-sm">剪辑风格</button>
          <button className="w-full text-left px-3 py-2 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50 rounded-md text-sm">构图特点</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-8 md:px-12 flex relative">
        <div className="flex-1 max-w-4xl space-y-10 pb-20">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">总结报告</h1>
            <Button className="bg-blue-600 hover:bg-blue-700 text-white border-0">
              <Download className="w-4 h-4 mr-2" />
              导出报告
            </Button>
          </div>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-blue-500 pl-3">整体摘要</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm">
              {report.summary}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-blue-500 pl-3">结构拆解</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-6">
              <div className="flex flex-col space-y-2">
                <div className="flex h-12 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 text-xs font-medium relative">
                  <div className="w-[10%] bg-slate-100 dark:bg-slate-800 flex items-center justify-center border-r border-slate-200 dark:border-slate-700" title="开头引子">开头引子</div>
                  <div className="w-[30%] bg-blue-50 dark:bg-blue-900/40 flex items-center justify-center border-r border-blue-100 dark:border-blue-800/50 text-blue-700 dark:text-blue-300" title="发展">发展</div>
                  <div className="w-[15%] bg-amber-50 dark:bg-amber-900/40 flex items-center justify-center border-r border-amber-100 dark:border-amber-800/50 text-amber-700 dark:text-amber-500" title="转折">转折</div>
                  <div className="w-[35%] bg-purple-50 dark:bg-purple-900/40 flex items-center justify-center border-r border-purple-100 dark:border-purple-800/50 text-purple-700 dark:text-purple-300" title="高潮">高潮</div>
                  <div className="w-[10%] bg-emerald-50 dark:bg-emerald-900/40 flex items-center justify-center text-emerald-700 dark:text-emerald-300" title="结尾">结尾</div>
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 font-mono px-1">
                  <span>0:00</span>
                  <span>{formatTime(project.durationSec)}</span>
                </div>
              </div>
            </div>
          </section>
          
          <section className="space-y-4">
             <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-blue-500 pl-3">核心洞察</h2>
             <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm">
                <ul className="space-y-2 list-disc list-inside marker:text-blue-500">
                  {report.takeaways.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
             </div>
          </section>

        </div>

        {/* Right Sidebar for Nodes */}
        <div className="w-72 ml-8 space-y-4 sticky top-8 self-start hidden lg:block">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200/80 uppercase tracking-widest pl-1">重点节点</h2>
          <div className="space-y-3">
            {keyNodes.slice(0,4).map(node => (
              <div key={node.id} className="flex gap-3 group items-center bg-white dark:bg-transparent p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 transition border border-slate-100 dark:border-transparent">
                <div className="w-20 h-12 bg-slate-100 dark:bg-slate-800 rounded relative shrink-0 overflow-hidden" 
                     style={{
                       backgroundImage: `url(${project?.localVideoPath})`,
                       backgroundPosition: 'center',
                       backgroundSize: 'cover'
                     }}>
                  <div className="absolute inset-0 bg-black/10 dark:bg-black/20 group-hover:bg-transparent transition-colors flex flex-col justify-end">
                    <span className="text-[9px] bg-black/60 text-white px-1 leading-tight w-fit m-0.5 rounded shadow-sm">
                      {formatTime(node.startSec)}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-200 line-clamp-2 leading-snug">{node.title}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
