import { Bell, ChartLine, FileText, Gauge, LogOut, Monitor, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { LoginScreen } from "./components/Login";
import { Banner } from "./components/ui";
import { ago, rssiBars } from "./lib/format";
import { SumpProvider, useNow, useSump, type Login } from "./lib/sump";
import { useTheme, type Theme } from "./lib/theme";
import { Alarms } from "./pages/Alarms";
import { Overview } from "./pages/Overview";
import { Settings } from "./pages/Settings";

// The chart pages pull in the charting library (~half the code), so they load
// only when opened. The Overview page stays quick on a phone over mine WiFi.
const Trends = lazy(() => import("./pages/Trends").then((m) => ({ default: m.Trends })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));

const LOGIN_KEY = "smartsump.login";
const STALE_MS = 10_000; // "last update" turns red after 10 s without telemetry

const PAGES = [
  { id: "overview", label: "Overview", Icon: Gauge, Page: Overview },
  { id: "trends", label: "Trends", Icon: ChartLine, Page: Trends },
  { id: "alarms", label: "Alarms", Icon: Bell, Page: Alarms },
  { id: "settings", label: "Settings", Icon: SlidersHorizontal, Page: Settings },
  { id: "reports", label: "Reports", Icon: FileText, Page: Reports },
] as const;
type PageId = (typeof PAGES)[number]["id"];

function readLogin(): Login | null {
  try {
    const raw = localStorage.getItem(LOGIN_KEY) ?? sessionStorage.getItem(LOGIN_KEY);
    return raw ? (JSON.parse(raw) as Login) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [login, setLogin] = useState<Login | null>(readLogin);
  const [authError, setAuthError] = useState<string | null>(null);

  const forget = () => {
    try {
      localStorage.removeItem(LOGIN_KEY);
      sessionStorage.removeItem(LOGIN_KEY);
    } catch {
      /* ignore */
    }
  };
  const onAuthFailed = useCallback((message: string) => {
    forget();
    setAuthError(message);
    setLogin(null);
  }, []);

  if (!login)
    return (
      <LoginScreen
        error={authError}
        onLogin={(l, remember) => {
          try {
            (remember ? localStorage : sessionStorage).setItem(LOGIN_KEY, JSON.stringify(l));
          } catch {
            /* private mode: works for this visit only */
          }
          setAuthError(null);
          setLogin(l);
        }}
      />
    );

  return (
    <SumpProvider login={login} onAuthFailed={onAuthFailed}>
      <Shell onLogout={() => (forget(), setLogin(null))} />
    </SumpProvider>
  );
}

function usePage(): [PageId, (p: PageId) => void] {
  const read = () => {
    const h = location.hash.slice(1);
    return (PAGES.some((p) => p.id === h) ? h : "overview") as PageId;
  };
  const [page, setPage] = useState<PageId>(read);
  useEffect(() => {
    const on = () => setPage(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return [page, (p) => (location.hash = p)];
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { conn, devices, device, select } = useSump();
  const [page, setPage] = usePage();
  const [theme, setTheme] = useTheme();
  const now = useNow();
  const Page = PAGES.find((p) => p.id === page)!.Page;

  const t = device?.telemetry;
  const online = device?.status === "online";
  const age = device?.lastMsgAt ? now - device.lastMsgAt : null;
  const stale = age == null || age > STALE_MS;
  const alarmCount = t?.alarms.length ?? 0;
  const nextTheme: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = { system: Monitor, light: Sun, dark: Moon }[theme];

  return (
    <div className="min-h-dvh pb-20 md:pb-6">
      <header className="no-print sticky top-0 z-10 border-b border-line bg-page/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <div className="mr-auto">
            <div className="text-lg leading-tight font-bold">Smart Sump</div>
            {devices.length > 1 ? (
              <select
                value={device?.key}
                onChange={(e) => select(e.target.value)}
                className="rounded border border-line bg-raised text-sm text-ink-2"
                aria-label="Device"
              >
                {devices.map((d) => (
                  <option key={d.key} value={d.key}>{d.key}</option>
                ))}
              </select>
            ) : (
              <div className="text-sm text-ink-2">{device?.key ?? "no device yet"}</div>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <span className={`size-2.5 rounded-full ${online ? "bg-good" : device ? "bg-crit" : "bg-muted"}`} />
              {online ? "Online" : device ? "Offline" : "—"}
            </span>
            <SignalBars bars={online ? rssiBars(t?.rssi) : 0} rssi={t?.rssi} />
            <span className={stale ? "font-semibold text-crit" : "text-ink-2"}>
              {age == null ? "no data" : `updated ${ago(age)}`}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button onClick={() => setTheme(nextTheme[theme])} className="rounded-lg p-2 text-ink-2 hover:bg-grid"
              aria-label={`Theme: ${theme}. Change`} title={`Theme: ${theme}`}>
              <ThemeIcon className="size-5" />
            </button>
            <button onClick={onLogout} className="rounded-lg p-2 text-ink-2 hover:bg-grid" aria-label="Sign out" title="Sign out">
              <LogOut className="size-5" />
            </button>
          </div>
        </div>

        {/* tabs (desktop) */}
        <nav className="mx-auto hidden max-w-6xl gap-1 px-4 md:flex" aria-label="Pages">
          {PAGES.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}
              className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${
                page === id ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>
              <Icon className="size-4" /> {label}
              {id === "alarms" && alarmCount > 0 && <Count n={alarmCount} />}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 p-4">
        {conn !== "connected" && (
          <Banner severity="warning">
            {conn === "connecting" ? "Connecting to the broker…" : "Connection to the broker lost. Reconnecting…"}
          </Banner>
        )}
        {conn === "connected" && !device && (
          <Banner severity="info">
            Connected to the broker. Waiting for a device… (is the simulator or the ESP32 running?)
          </Banner>
        )}
        <Suspense fallback={<p className="py-8 text-center text-ink-2">Loading…</p>}>
          <Page />
        </Suspense>
      </main>

      {/* bottom bar (phones): big thumb-sized targets */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 border-t border-line bg-page pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Pages">
        {PAGES.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}
            className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold ${
              page === id ? "text-ink" : "text-muted"}`}>
            <Icon className="size-5" />
            {label}
            {id === "alarms" && alarmCount > 0 && (
              <span className="absolute top-1.5 left-1/2 ml-2"><Count n={alarmCount} /></span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-crit px-1.5 text-xs leading-5 font-bold text-white">{n}</span>;
}

function SignalBars({ bars, rssi }: { bars: number; rssi?: number }) {
  return (
    <span className="inline-flex items-end gap-0.5" title={rssi != null ? `WiFi ${rssi} dBm` : "WiFi signal"}
      aria-label={`WiFi signal ${bars} of 4`}>
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={`w-1 rounded-sm ${b <= bars ? "bg-ink" : "bg-grid"}`} style={{ height: 4 + b * 3 }} />
      ))}
    </span>
  );
}
