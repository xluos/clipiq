import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { ModelInputMode } from "../types";

export function SettingsScreen() {
  const { providers, setProviders, activeProviderId } = useApp();
  
  const currentProvider = providers.find(p => p.id === activeProviderId) || providers[0];
  
  const [baseUrl, setBaseUrl] = useState(currentProvider.baseUrl);
  const [apiKey, setApiKey] = useState(currentProvider.apiKeyRef);
  const [model, setModel] = useState(currentProvider.model);
  const [inputMode, setInputMode] = useState<ModelInputMode>(currentProvider.inputMode);
  
  const [isTesting, setIsTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState<boolean | null>(null);

  const handleSave = () => {
    setProviders(prev => prev.map(p => 
      p.id === currentProvider.id ? { ...p, baseUrl, apiKeyRef: apiKey, model, inputMode } : p
    ));
    // Provide some feedback
  };

  const handleTest = () => {
    setIsTesting(true);
    setTestSuccess(null);
    // Simulate network delay
    setTimeout(() => {
      setIsTesting(false);
      setTestSuccess(true);
    }, 1500);
  };

  return (
    <div className="flex-1 flex h-full">
      <main className="flex-1 flex bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
        {/* Settings sub-sidebar from the image, but let's just make it a simple list as shown */}
        <div className="w-48 border-r border-slate-200 dark:border-slate-800/50 bg-white dark:bg-[#0E0E10] p-4 space-y-1 overflow-y-auto hidden md:block">
           <div className="text-xs font-bold text-slate-500 uppercase tracking-widest pl-3 mt-2 mb-4">设置</div>
           <button className="w-full text-left px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 text-sm font-medium">模型配置</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm">本地依赖</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm">默认分析</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm">项目数据</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm mt-8 border border-slate-200 dark:border-slate-800">打赏开发者</button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 md:p-12">
          <div className="max-w-3xl space-y-8">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Model Configuration</h2>
            
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="p-6 md:p-8 space-y-6">
                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">Provider 管理</Label>
                  <div className="flex gap-2">
                     <Select value="default" onValueChange={() => {}}>
                      <SelectTrigger className="w-[200px] bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">示例 OpenAI 兼容 (Qwen)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" className="border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10]">新增</Button>
                  </div>
                </div>

                <div className="h-px bg-slate-200 dark:bg-slate-800/50" />
                
                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">API Base URL</Label>
                  <Input 
                    value={baseUrl} 
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 font-mono text-sm max-w-md"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                
                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">API Key</Label>
                  <Input 
                    type="password"
                    value={apiKey} 
                    onChange={(e) => setApiKey(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 font-mono text-sm max-w-md"
                    placeholder="sk-..."
                  />
                </div>

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">模型名</Label>
                  <Input 
                    value={model} 
                    onChange={(e) => setModel(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 font-mono text-sm max-w-[200px]"
                    placeholder="gpt-4o"
                  />
                </div>

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">输入模式</Label>
                  <Select value={inputMode} onValueChange={(v) => setInputMode(v as ModelInputMode)}>
                    <SelectTrigger className="w-[200px] bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                      <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动选择</SelectItem>
                      <SelectItem value="direct_video">直接视频上传</SelectItem>
                      <SelectItem value="keyframe_sequence">抽帧序列</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

              </div>

              <div className="p-4 bg-slate-50 dark:bg-[#0A0A0B] border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <Button variant="secondary" onClick={handleTest} disabled={isTesting || !baseUrl || !model} className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900">
                    <CheckCircle2 className="w-4 h-4 mr-2 text-slate-400 flex-none" />
                    {isTesting ? "Testing..." : "测试连接"}
                  </Button>
                  {testSuccess === true && (
                    <span className="text-sm text-emerald-600 dark:text-emerald-500 flex items-center">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2" />
                      连接成功
                    </span>
                  )}
                </div>
                
                <div className="space-x-3">
                  <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700 text-white border border-blue-700">保存设置</Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
