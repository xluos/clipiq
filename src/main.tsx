import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import './index.css';
import { AppProvider } from './AppContext.tsx';
import { ThemeProvider } from './components/theme-provider.tsx';
import { queryClient } from './queries/client.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="system" storageKey="app-ui-theme">
        <AppProvider>
          <App />
        </AppProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
