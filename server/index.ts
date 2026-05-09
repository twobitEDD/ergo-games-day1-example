import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { createDay1App } from "./app";
import { loadDay1Env } from "./env";

loadDay1Env();

const port = Number(process.env.DAY1_API_PORT ?? 4010);
const app = createDay1App();
const clientDistDir = resolve(process.cwd(), "dist");
const clientIndexPath = resolve(clientDistDir, "index.html");
const shouldServeClient = existsSync(clientIndexPath);

if (shouldServeClient) {
  app.use("/", express.static(clientDistDir));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(clientIndexPath);
  });
}

app.listen(port, () => {
  console.log(`[day1-api] listening on http://localhost:${port}`);
  console.log(`[day1-api] health readiness -> http://localhost:${port}/api/health/readiness`);
  if (shouldServeClient) {
    console.log(`[day1-web] serving static client from ${clientDistDir}`);
  } else {
    console.log("[day1-web] dist/index.html not found; API-only mode");
  }
});
