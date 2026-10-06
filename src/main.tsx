import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
const poolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)),
};
const highlighterOptions = {
  theme: { light: "github-light", dark: "github-dark" },
};
import ReactDOM from "react-dom/client";
import { IntlProvider } from "use-intl";
import messages from "../config/i18n/en/webapp.json";
import { App } from "./App";
import "./ui.css";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pierre 1.4.1 can leave the initial diff blank during StrictMode's ref remount.
// Keep the production-equivalent mount lifecycle in development as well.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <IntlProvider locale="en" messages={messages} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}>
    <TooltipProvider>
      <WorkerPoolContextProvider
        poolOptions={poolOptions}
        highlighterOptions={highlighterOptions}
      >
        <App />
      </WorkerPoolContextProvider>
    </TooltipProvider>
  </IntlProvider>,
);
