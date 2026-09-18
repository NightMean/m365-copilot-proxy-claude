#!/usr/bin/env node
import {
  getTokenForScope,
  loginInteractive,
  loginInteractiveForScopes,
} from "../packages/core/dist/index.mjs";

const EXTRA_SCOPES = [
  ["Power Platform", ["https://api.powerplatform.com/.default"]],
  ["Power Platform environment discovery", ["https://api.bap.microsoft.com/.default"]],
];

process.stdout.write(
  "A Microsoft browser window will open. Enter your university password and complete MFA only on Microsoft's page.\n" +
    "No password or MFA seed is stored by this setup. The private MSAL token cache is saved locally.\n\n",
);

await loginInteractive();

for (const [label, scopes] of EXTRA_SCOPES) {
  process.stdout.write(`Checking ${label} permission...\n`);
  let token = await getTokenForScope(scopes);
  if (!token) token = await loginInteractiveForScopes(scopes);
  if (!token) throw new Error(`Could not obtain ${label} permission`);
}

process.stdout.write("Microsoft authentication completed successfully. No password file was created.\n");
