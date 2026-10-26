import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/silkscreen/400.css";
import "@phosphor-icons/web/regular/style.css";
import "@phosphor-icons/web/bold/style.css";
import "@phosphor-icons/web/fill/style.css";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The companion window loads the same page. In a plain browser, `?companion` previews it against the mock backend. */
async function boot() {
  const inTauri = "__TAURI_INTERNALS__" in window;
  const companion = inTauri ? getCurrentWindow().label === "companion" : new URLSearchParams(location.search).has("companion");
  if (import.meta.env.DEV && !inTauri) {
    const mock = await import("./dev/mockBackend");
    mock.installMock();
    if (companion) await mock.startSome();
  }
  const Root = companion ? (await import("./companion/Companion")).Companion : (await import("./App")).default;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

void boot();
