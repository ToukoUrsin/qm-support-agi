// Signed call to local QM core as the admin: node hack/core.ts METHOD /v1/path [json-body]
// Reads CORE_SIGNING_SECRET from hack/secrets.env (never printed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCoreText } from "../plugins/chassis/src/core-client.ts";

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "secrets.env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const [method = "GET", path = "/v1/admin/mcp-servers", body] = process.argv.slice(2);
const r = await fetchCoreText({
  origin: process.env.CORE_URL ?? "http://localhost:8081",
  secret: env.CORE_SIGNING_SECRET,
  method: method as "GET",
  path,
  ...(body ? { body } : {}),
  headers: { "x-admin-actor": process.env.QM_ADMIN ?? "touko@acme" },
});
console.log(r.status, r.text);
