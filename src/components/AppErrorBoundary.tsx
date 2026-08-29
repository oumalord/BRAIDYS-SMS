import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Card } from './ui';

export default class AppErrorBoundary extends Component<{ children: ReactNode; onRecover?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('SafiGroom UI error', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="flex min-h-[50vh] items-center justify-center p-6"><Card className="max-w-md p-8 text-center"><h1 className="text-xl font-semibold">This page needs to be reloaded</h1><p className="mt-2 text-sm text-[#6E6E73]">Your saved work is still on this device. Try the page again or return to the dashboard.</p><div className="mt-5 flex justify-center gap-2"><Button variant="secondary" onClick={() => this.setState({ error: null })}>Try again</Button>{this.props.onRecover && <Button onClick={this.props.onRecover}>Dashboard</Button>}</div></Card></div>;
  }
}
