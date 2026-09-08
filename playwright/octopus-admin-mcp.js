import http from "node:http";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.ADMIN_BRIDGE_TOKEN;
const EMAIL = process.env.OCTOPUS_EMAIL;
const PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION = process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

if (!TOKEN || !EMAIL || !PASSWORD) throw new Error("Missing required admin bridge environment variables");

async function selectOrganization(page) {
  await page.waitForTimeout(2000);
  for (const select of await page.locator("select").all()) {
    const options = await select.locator("option").allTextContents();
    const match = options.find(v => v.toLowerCase().includes(ORGANIZATION.toLowerCase()));
    if (match) {
      await select.selectOption({ label: match.trim() });
      const submit = page.locator('button[type="submit"],input[type="submit"]').first();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
      return;
    }
  }
  const choice = page.getByText(ORGANIZATION, { exact: false }).first();
  if (!(await choice.isVisible().catch(() => false))) throw new Error("Organization selection failed");
  await choice.click();
  await page.locator('button[type="submit"],input[type="submit"]').first().click().catch(() => page.keyboard.press("Enter"));
  await page.waitForTimeout(3000);
}

async function login(page) {
  await page.goto("https://admin.octopuspro.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator('input[type="email"],input[name="email"],input[name="username"],#email').first().fill(EMAIL);
  await page.locator('input[type="password"],input[name="password"],#password').first().fill(PASSWORD);
  await page.locator('button[type="submit"],input[type="submit"]').first().click();
  await page.waitForTimeout(4000);
  if (page.url().toLowerCase().includes("checkuserinmulticompanies")) await selectOrganization(page);
  if (page.url().toLowerCase().includes("/login")) throw new Error("OctopusPro login failed");
}

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

const tools = [
  {
    name: "octopus_login_health",
    description: "Verify the private bridge can authenticate to the SpeedyCleans OctopusPro administrator account. Makes no changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_booking_page",
    description: "Read an OctopusPro booking page by its exact admin URL. Makes no changes.",
    inputSchema: {
      type: "object",
      properties: { booking_url: { type: "string", description: "Exact https://admin.octopuspro.com booking URL" } },
      required: ["booking_url"],
      additionalProperties: false
    }
  }
];

async function callTool(name, args) {
  if (name === "octopus_login_health") {
    return withPage(async page => ({ authenticated: true, organization: ORGANIZATION, url: page.url() }));
  }
  if (name === "get_booking_page") {
    const url = String(args?.booking_url || "");
    if (!url.startsWith("https://admin.octopuspro.com/")) throw new Error("Only OctopusPro admin URLs are allowed");
    return withPage(async page => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3500);
      return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 20000) };
    });
  }
  throw new Error("Unknown tool");
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/mcp") return send(res, 404, { error: "not found" });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let rpc;
  try { rpc = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid json" }); }
  const base = { jsonrpc: "2.0", id: rpc.id };
  try {
    if (rpc.method === "initialize") return send(res, 200, { ...base, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "speedycleans-octopus-admin", version: "0.1.0" } } });
    if (rpc.method === "notifications/initialized") return send(res, 202, {});
    if (rpc.method === "tools/list") return send(res, 200, { ...base, result: { tools } });
    if (rpc.method === "tools/call") {
      const result = await callTool(rpc.params?.name, rpc.params?.arguments || {});
      return send(res, 200, { ...base, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
    }
    return send(res, 200, { ...base, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    return send(res, 200, { ...base, error: { code: -32000, message: error.message } });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Octopus admin bridge listening on ${PORT}`));
