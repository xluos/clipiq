import { useApp } from './AppContext';
import { HomeScreen } from './screens/HomeScreen';
import { SettingsScreen } from './screens/SettingsScreen';
// UrlPullScreen 已合并到 HomeScreen composer
import { ProgressScreen } from './screens/ProgressScreen';
import { WorkspaceScreen } from './screens/WorkspaceScreen';
import { ReportScreen } from './screens/ReportScreen';
import { VideoScreen } from './screens/VideoScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { AccountScreen } from './screens/AccountScreen';
import { StudioScreen } from './screens/StudioScreen';
import { DiagnosticsScreen } from './screens/DiagnosticsScreen';
import { AnimatePresence, motion } from 'motion/react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { YtDlpUpdateToast } from './components/YtDlpUpdateToast';
import { ConfirmDialogProvider } from './components/ConfirmDialog';

export default function App() {
  const { currentLocation } = useApp();
  // 用于 AnimatePresence key — module + screen 唯一标识
  const routeKey = currentLocation.module === 'settings' || currentLocation.module === 'diagnostics'
    ? currentLocation.module
    : `${currentLocation.module}:${currentLocation.screen}`;

  return (
    <ConfirmDialogProvider>
      <div className="h-screen w-screen bg-slate-50 dark:bg-[#0A0A0B] text-slate-900 dark:text-slate-200 overflow-hidden font-sans flex flex-col">
        <TitleBar />
        <div className="flex-1 min-h-0 flex">
          <Sidebar />
          <div className="flex-1 min-w-0 relative">
            <AnimatePresence mode="wait">
              <motion.div
                key={routeKey}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 flex flex-col"
              >
                {currentLocation.module === 'analysis' && currentLocation.screen === 'home' && <HomeScreen />}
                {currentLocation.module === 'analysis' && currentLocation.screen === 'url_pull' && <HomeScreen />}
                {currentLocation.module === 'analysis' && currentLocation.screen === 'progress' && <ProgressScreen />}
                {currentLocation.module === 'analysis' && currentLocation.screen === 'workspace' && <WorkspaceScreen />}
                {currentLocation.module === 'analysis' && currentLocation.screen === 'report' && <ReportScreen />}
                {currentLocation.module === 'video' && <VideoScreen />}
                {currentLocation.module === 'library' && <LibraryScreen />}
                {currentLocation.module === 'account' && <AccountScreen />}
                {currentLocation.module === 'studio' && <StudioScreen />}
                {currentLocation.module === 'settings' && <SettingsScreen />}
                {currentLocation.module === 'diagnostics' && <DiagnosticsScreen />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <YtDlpUpdateToast />
      </div>
    </ConfirmDialogProvider>
  );
}
