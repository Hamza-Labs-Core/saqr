import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from 'react-router';
import type { Route } from './.react-router/types/src/+types/root.js';

export async function loader({ context }: Route.LoaderArgs) {
  const env = (context as { cloudflare?: { env?: Record<string, string> } })
    ?.cloudflare?.env;
  return {
    syncServerUrl: env?.SYNC_SERVER_URL ?? '',
    adminServerUrl: env?.ADMIN_SERVER_URL ?? '',
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  let envScript = '';
  try {
    // useLoaderData is only available when a loader is present and has resolved
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const data = useLoaderData<typeof loader>();
    if (data) {
      envScript = `window.__ENV=${JSON.stringify({
        SYNC_SERVER_URL: data.syncServerUrl,
        ADMIN_SERVER_URL: data.adminServerUrl,
      })};`;
    }
  } catch {
    // Layout renders before loader during error boundaries — skip
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Saqr — Multi-agent management platform. Control your AI coding agents from anywhere." />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Meta />
        <Links />
      </head>
      <body>
        {envScript && (
          <script dangerouslySetInnerHTML={{ __html: envScript }} />
        )}
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}
