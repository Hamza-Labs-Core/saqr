import React, { useState, useEffect, useCallback } from "react";
import { LoginPage } from "./pages/Login.js";
import { ServerListPage } from "./pages/ServerList.js";
import { TerminalPage } from "./pages/Terminal.js";

export type Route =
  | { page: "login" }
  | { page: "servers" }
  | { page: "terminal"; serverId: string; sessionId: string };

/**
 * Simple hash-router for the desktop app.
 *
 * - #/login       → Device-code auth
 * - #/servers     → Server list (default when authenticated)
 * - #/terminal/:serverId/:sessionId → Terminal view
 *
 * Also handles saqr://auth/callback?token=... deep link via URL query params.
 */
function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("terminal/")) {
    const parts = hash.split("/");
    if (parts.length >= 3) {
      return { page: "terminal", serverId: parts[1], sessionId: parts[2] };
    }
  }
  if (hash === "login") return { page: "login" };
  return { page: "servers" };
}

/**
 * Check for deep link auth callback token in URL query params.
 * Tauri translates saqr://auth/callback?token=XYZ into the webview URL.
 */
function checkDeepLinkAuth(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token) {
      // Clean the URL to remove the token from the address bar
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      return token;
    }
  } catch {
    // Not in a browser context
  }
  return null;
}

export function navigate(route: Route): void {
  switch (route.page) {
    case "login":
      window.location.hash = "#/login";
      break;
    case "servers":
      window.location.hash = "#/servers";
      break;
    case "terminal":
      window.location.hash = `#/terminal/${route.serverId}/${route.sessionId}`;
      break;
  }
}

export function App(): React.ReactElement {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Handle deep link auth callback (saqr://auth/callback?token=...)
  useEffect(() => {
    const deepLinkToken = checkDeepLinkAuth();
    if (deepLinkToken) {
      storeToken(deepLinkToken);
      navigate({ page: "servers" });
    }
  }, []);

  // Check auth state on mount
  const token = getStoredToken();
  const effectiveRoute = !token && route.page !== "login"
    ? { page: "login" as const }
    : route;

  const handleLogin = useCallback((accessToken: string) => {
    storeToken(accessToken);
    navigate({ page: "servers" });
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    navigate({ page: "login" });
  }, []);

  const handleSelectSession = useCallback((serverId: string, sessionId: string) => {
    navigate({ page: "terminal", serverId, sessionId });
  }, []);

  const handleBack = useCallback(() => {
    navigate({ page: "servers" });
  }, []);

  switch (effectiveRoute.page) {
    case "login":
      return <LoginPage onLogin={handleLogin} />;
    case "servers":
      return <ServerListPage onSelectSession={handleSelectSession} onLogout={handleLogout} />;
    case "terminal":
      return (
        <TerminalPage
          serverId={effectiveRoute.serverId}
          sessionId={effectiveRoute.sessionId}
          onBack={handleBack}
        />
      );
  }
}

// Token persistence
const TOKEN_KEY = "saqr_access_token";

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Tauri secure storage fallback would go here
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // noop
  }
}
