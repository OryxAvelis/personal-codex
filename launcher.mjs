import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const address = "http://127.0.0.1:4317";

function serverIsReady() {
  return new Promise((resolve) => {
    const request = http.get(`${address}/api/bootstrap`, { timeout: 700 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await serverIsReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

if (!(await serverIsReady())) {
  const server = spawn(process.execPath, [path.join(appDirectory, "server.mjs")], {
    cwd: appDirectory,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  server.unref();
}

if (!(await waitForServer())) {
  console.error("Personal Codex could not start. Please open this file again.");
  process.exitCode = 1;
} else if (process.platform === "win32") {
  const browser = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", address], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  browser.unref();
} else {
  console.log(address);
}
