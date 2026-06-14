import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ZkProvider } from "./zk/provider";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ZkProvider>
      <App />
    </ZkProvider>
  </React.StrictMode>
);
