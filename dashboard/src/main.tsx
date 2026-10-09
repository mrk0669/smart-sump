import { Component, StrictMode } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/** Last line of defence: if a bug crashes the page, show a way out instead
 *  of a blank screen (especially in the phone app, where there's no reload
 *  button). */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Smart Sump crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-sm space-y-3 rounded-xl border border-line bg-surface p-5">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-ink-2">The page hit an unexpected error. Reloading usually fixes it.</p>
          <pre className="overflow-auto rounded bg-raised p-2 text-xs text-muted">{this.state.error.message}</pre>
          <button onClick={() => location.reload()}
            className="min-h-11 w-full rounded-lg bg-ink px-4 font-semibold text-page">Reload</button>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
