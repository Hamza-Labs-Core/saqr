/**
 * React Router server entry for Cloudflare Workers.
 *
 * This file is the server-side rendering entry point. Cloudflare Workers
 * invokes this handler for each incoming request. It uses React Router's
 * server runtime to render the app and return the HTML response.
 */
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  // @ts-expect-error virtual module provided by React Router build
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
};
