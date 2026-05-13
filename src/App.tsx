import { useApp } from './AppContext';
import { HomeScreen } from './screens/HomeScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UrlPullScreen } from './screens/UrlPullScreen';
import { PrepareScreen } from './screens/PrepareScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { WorkspaceScreen } from './screens/WorkspaceScreen';
import { ReportScreen } from './screens/ReportScreen';
import { AnimatePresence, motion } from 'motion/react';
import { TitleBar } from './components/TitleBar';
import { YtDlpUpdateToast } from './components/YtDlpUpdateToast';
import { ConfirmDialogProvider } from './components/ConfirmDialog';

export default function App() {
  const { currentScreen } = useApp();

  return (
    <ConfirmDialogProvider>
      <div className="h-screen w-screen bg-slate-50 dark:bg-[#0A0A0B] text-slate-900 dark:text-slate-200 overflow-hidden font-sans flex flex-col">
        <TitleBar />
        <div className="flex-1 min-h-0 relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentScreen}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 flex flex-col"
            >
              {currentScreen === 'home' && <HomeScreen />}
              {currentScreen === 'settings' && <SettingsScreen />}
              {currentScreen === 'url_pull' && <UrlPullScreen />}
              {currentScreen === 'prepare' && <PrepareScreen />}
              {currentScreen === 'progress' && <ProgressScreen />}
              {currentScreen === 'workspace' && <WorkspaceScreen />}
              {currentScreen === 'report' && <ReportScreen />}
            </motion.div>
          </AnimatePresence>
        </div>
        <YtDlpUpdateToast />
      </div>
    </ConfirmDialogProvider>
  );
}
