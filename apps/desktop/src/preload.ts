import { contextBridge } from "electron";

type DesktopInjectedConnection = {
  baseUrl: string;
  token?: string;
};

const connection = readInjectedConnection();
if (connection) {
  const current = readStoredConnection();
  const shouldReplace =
    process.env.OAH_DESKTOP_FORCE_CONNECTION === "1" ||
    !current?.baseUrl?.trim() ||
    shouldRefreshStoredConnection(current, connection);
  if (shouldReplace) {
    window.localStorage.setItem("oah.web.connection", JSON.stringify(connection));
  }
}

contextBridge.exposeInMainWorld("oahDesktop", {
  kind: "desktop",
  connection: connection ? { baseUrl: connection.baseUrl } : null
});

function readInjectedConnection(): DesktopInjectedConnection | null {
  const raw = process.env.OAH_DESKTOP_CONNECTION_JSON;
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as DesktopInjectedConnection;
    if (!parsed.baseUrl?.trim()) {
      return null;
    }
    return {
      baseUrl: parsed.baseUrl,
      ...(parsed.token?.trim() ? { token: parsed.token } : {})
    };
  } catch {
    return null;
  }
}

function readStoredConnection(): DesktopInjectedConnection | null {
  const raw = window.localStorage.getItem("oah.web.connection");
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as DesktopInjectedConnection;
  } catch {
    return null;
  }
}

function shouldRefreshStoredConnection(
  current: DesktopInjectedConnection,
  injected: DesktopInjectedConnection
): boolean {
  return current.baseUrl === injected.baseUrl && current.token !== injected.token;
}
