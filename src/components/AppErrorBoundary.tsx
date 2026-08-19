import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Card } from './ui';

export default class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('SafiGroom UI error', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="min-h-screen bg-[#071a3d] flex items-center justify-center p-6"><Card className="max-w-md p-8 text-center"><h1 className="text-xl font-semibold">SafiGroom could not load this page</h1><p className="text-sm text-[#6E6E73] mt-2">Refresh the page or sign out and log in again.</p><Button className="mt-5" onClick={() => window.location.reload()}>Refresh</Button></Card></div>;
  }
}
