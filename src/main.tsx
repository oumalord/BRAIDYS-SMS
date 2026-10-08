import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import './index.css';

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        void navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <AppErrorBoundary><App /></AppErrorBoundary>
    </StrictMode>
);
