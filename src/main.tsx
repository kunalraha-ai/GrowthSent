import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || import.meta.env.MODE,
    // This browser SDK must not attach authenticated user data by default.
    sendDefaultPii: false,
    // Request breadcrumbs can include query values entered into the product.
    // Keep error capture, but exclude request bodies and URLs from telemetry.
    beforeBreadcrumb: (breadcrumb) => (
      breadcrumb.category === "fetch" || breadcrumb.category === "xhr" ? null : breadcrumb
    ),
    beforeSend: (event) => {
      delete event.user;
      delete event.request;
      return event;
    },
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<p role="alert">Something went wrong. Please reload the page.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
