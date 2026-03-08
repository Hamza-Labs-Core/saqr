/**
 * React Router client entry — hydrates the server-rendered HTML.
 *
 * This file runs in the browser after the initial server render.
 * It hydrates the React tree, enabling client-side interactivity.
 */
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
