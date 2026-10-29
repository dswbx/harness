import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/outfit";
import "@fontsource-variable/montserrat";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { App } from "./App";
import { initAppearance } from "./appearance/appearance";

// Every window (main and View windows) boots through this entry, so the theme applies everywhere.
initAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
