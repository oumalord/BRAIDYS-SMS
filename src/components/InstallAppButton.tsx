import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import { Button, Modal } from './ui';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isAppInstalled() {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || standaloneNavigator.standalone === true;
}

function InstallAppButton({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isAppInstalled);
  const [showInstructions, setShowInstructions] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!installEvent) {
      setShowInstructions(true);
      return;
    }
    setInstalling(true);
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      if (choice.outcome === 'accepted') setInstalled(true);
      setInstallEvent(null);
    } finally {
      setInstalling(false);
    }
  };

  if (installed) return null;

  const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);

  return <>
    <Button variant="secondary" size={compact ? 'sm' : 'md'} className={className} onClick={() => void install()} disabled={installing}>
      <Download size={15} aria-hidden="true" />{installing ? 'Opening…' : compact ? 'Install' : 'Install App'}
    </Button>
    {showInstructions && <Modal title="Install BRAIDY SALON" onClose={() => setShowInstructions(false)} footer={<Button onClick={() => setShowInstructions(false)}>Done</Button>}>
      {isIOS ? <div className="space-y-3 pb-5 text-sm text-[#6E6E73]"><p>Install BRAIDY SALON from Safari:</p><p className="flex items-center gap-2"><Share size={16} aria-hidden="true" />Tap Share, choose <strong className="text-[#1D1D1F]">Add to Home Screen</strong>, then tap Add.</p></div> : <div className="space-y-3 pb-5 text-sm text-[#6E6E73]"><p>Open your browser menu and choose <strong className="text-[#1D1D1F]">Install BRAIDY SALON</strong> or <strong className="text-[#1D1D1F]">Add to Home screen</strong>.</p><p>If the option is missing, open this page in Chrome or Edge and try again.</p></div>}
    </Modal>}
  </>;
}

export default InstallAppButton;