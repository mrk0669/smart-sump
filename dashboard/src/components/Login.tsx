import { LogIn } from "lucide-react";
import { useState } from "react";
import type { Login } from "../lib/sump";
import { Banner, Button } from "./ui";

export const defaultBrokerUrl = () => `ws://${location.hostname || "localhost"}:9001`;

/** Operators sign in with the broker's MQTT login, so the password is never
 *  baked into the web page itself. */
export function LoginScreen({ error, onLogin }: {
  error: string | null;
  onLogin: (login: Login, remember: boolean) => void;
}) {
  const [url, setUrl] = useState(defaultBrokerUrl());
  const [username, setUsername] = useState("smartsump");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  const input = "mt-1 block w-full min-h-11 rounded-lg border border-line bg-raised px-3 text-ink";
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onLogin({ url: url.trim(), username: username.trim(), password }, remember);
        }}
      >
        <div>
          <h1 className="text-2xl font-bold">Smart Sump</h1>
          <p className="text-ink-2">Sign in with the site's MQTT login.</p>
        </div>
        {error && <Banner severity="critical">{error}</Banner>}
        <label className="block text-sm font-medium">
          Username
          <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="block text-sm font-medium">
          Password
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" required autoFocus />
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-2">Broker address</summary>
          <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Broker WebSocket URL" />
          <p className="mt-1 text-muted">MQTT over WebSocket, normally port 9001 on the same computer as this page.</p>
        </details>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember me on this device
        </label>
        <Button tone="primary" type="submit" className="w-full">
          <LogIn className="size-4" /> Connect
        </Button>
      </form>
    </main>
  );
}
