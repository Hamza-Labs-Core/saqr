import { createRequestHandler } from "react-router";
import * as serverBuild from "./build/server/index.js";

const requestHandler = createRequestHandler(serverBuild, "production");

export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
};
