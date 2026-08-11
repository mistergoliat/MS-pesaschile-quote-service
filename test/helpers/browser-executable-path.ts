import fs from "node:fs";
import path from "node:path";

const CANDIDATE_BROWSER_PATHS = [
  process.env.QUOTE_PDF_EXECUTABLE_PATH,
  path.resolve(
    "C:/Users/Goli/Pesas Chile/MS/MS-pesaschile-quote-service/.tmp-puppeteer/chrome/win64-151.0.7922.77/chrome-win64/chrome.exe"
  ),
  path.resolve(
    "C:/Users/Goli/Pesas Chile/MS/MS-pesaschile-quote-service/.tmp-puppeteer/chrome-headless-shell/win64-151.0.7922.77/chrome-headless-shell-win64/chrome-headless-shell.exe"
  ),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].filter((value): value is string => typeof value === "string" && value.length > 0);

export function resolveTestBrowserExecutablePath(): string | undefined {
  return CANDIDATE_BROWSER_PATHS.find((candidate) => fs.existsSync(candidate));
}
