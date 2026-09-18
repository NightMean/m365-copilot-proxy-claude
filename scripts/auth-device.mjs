#!/usr/bin/env node
import {
  getTokenForScope,
  loginDeviceCode,
  loginDeviceCodeForScopes,
} from "../packages/core/dist/index.mjs";

const EXTRA_SCOPES = [
  ["Power Platform", ["https://api.powerplatform.com/.default"]],
  ["Power Platform environment discovery", ["https://api.bap.microsoft.com/.default"]],
];

function showDevicePrompt(prompt) {
  process.stdout.write(
    `\nOpen ${prompt.verificationUri} on this computer or another device.\n` +
      `Enter this temporary code: ${prompt.userCode}\n` +
      "Complete Microsoft sign-in/MFA there. Do not paste the code or credentials into chat.\n\n",
  );
}

process.stdout.write(
  "Starting Microsoft device-code authentication. No password or MFA value is read or stored by this process.\n",
);

await loginDeviceCode(showDevicePrompt);

// Do not let the normal visible-browser fallback open from this device-code-only
// command. Try the cached refresh state first, then issue another device code only
// if Microsoft requires a separate interaction for that resource.
const previousInteractive = process.env.M365_INTERACTIVE_LOGIN;
process.env.M365_INTERACTIVE_LOGIN = "0";
try {
  for (const [label, scopes] of EXTRA_SCOPES) {
    process.stdout.write(`Checking ${label} permission...\n`);
    const token = await getTokenForScope(scopes);
    if (!token) await loginDeviceCodeForScopes(scopes, showDevicePrompt);
  }
} finally {
  if (previousInteractive === undefined) delete process.env.M365_INTERACTIVE_LOGIN;
  else process.env.M365_INTERACTIVE_LOGIN = previousInteractive;
}

process.stdout.write("Microsoft device-code authentication completed successfully.\n");
