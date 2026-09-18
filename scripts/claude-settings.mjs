#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [action, stateDir] = process.argv.slice(2);
if (action !== "clean-legacy" || !stateDir) {
  console.error("Usage: claude-settings.mjs clean-legacy <state-dir>");
  process.exit(2);
}

const settingsPath = process.env.CLAUDE_SETTINGS_FILE
  ?? path.join(os.homedir(), ".claude", "settings.json");
if (!fs.existsSync(settingsPath)) process.exit(0);

let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (error) {
  console.error(`Claude settings are not valid JSON: ${error.message}`);
  process.exit(1);
}

let changed = false;
const env = settings.env && typeof settings.env === "object" ? { ...settings.env } : null;
const baseUrl = typeof env?.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(baseUrl)) {
  for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) {
    if (key in env) {
      delete env[key];
      changed = true;
    }
  }
  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
}
if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.includes("m365-claude-key")) {
  delete settings.apiKeyHelper;
  changed = true;
}

if (!changed) process.exit(0);
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const backupPath = path.join(stateDir, `claude-settings-backup-${Date.now()}.json`);
fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
fs.chmodSync(backupPath, 0o600);
const temporaryPath = `${settingsPath}.m365-${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, settingsPath);
console.error(`Removed legacy localhost proxy fields from Claude settings (backup: ${backupPath}).`);
