import http from "node:http";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chromium } from "playwright";

const PORT=Number(process.env.PORT||3000);
const BASE=(process.env.PUBLIC_BASE_URL||"").replace(/\/$/,"");
const SECRET=process.env.ADMIN_BRIDGE_TOKEN;
const APPROVAL=process.env.OAUTH_APPROVAL_CODE;
const EMAIL=process.env.OCTOPUS_EMAIL;
const PASSWORD=process.env.OCTOPUS_PASSWORD;
const ORGANIZATION=process.env.OCTOPUS_ORGANIZATION_NAME||"SpeedyCleans";
const SCOPES=["octopus:read","octopus:write","octopus:financial"];
if(!BASE||!SECRET||!APPROVAL||!EMAIL||!PASSWORD) throw new Error("Missing required bridge configuration");

const b64=v=>Buffer.from(v).toString("base64url");
const unb64=v=>Buffer.from(v,"base64url").toString();
function sign(payload){const body=b64(JSON.stringify(payload));const sig=createHmac("sha256",SECRET).update(body).digest("base64url");return body+"."+sig}
function verify(token,type){const [body,sig]=String(token||"").split(".");if(!body||!sig)throw Error("invalid token");const expected=createHmac("sha256",SECRET).update(body).digest();const actual=Buffer.from(sig,"base64url");if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error("invalid token");const p=JSON.parse(unb64(body));if(p.type!==type||p.exp<Date.now()||p.aud!==BASE)throw Error("expired or invalid token");return p}
const sha256=v=>createHash("sha256").update(v).digest("base64url");
async function body(req){let s="";for await(const c of req)s+=c;return s}
function json(res,status,value,headers={}){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store",...headers});res.end(JSON.stringify(value))}
function html(res,status,value){res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(value)}
function escape(v){return String(v||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

async function selectOrganization(page){
  await page.waitForTimeout(2000);
  for(const select of await page.locator("select").all()){
    const options=await select.locator("option").allTextContents();
    const match=options.find(v=>v.toLowerCase().includes(ORGANIZATION.toLowerCase()));
    if(match){await select.selectOption({label:match.trim()});const submit=page.locator('button[type="submit"],input[type="submit"]').first();if(await submit.isVisible().catch(()=>false))await submit.click();else await page.keyboard.press("Enter");await page.waitForTimeout(3000);return}
  }
  const choice=page.getByText(ORGANIZATION,{exact:false}).first();
  if(!(await choice.isVisible().catch(()=>false)))throw Error("Organization selection failed");
  await choice.click();await page.locator('button[type="submit"],input[type="submit"]').first().click().catch(()=>page.keyboard.press("Enter"));await page.waitForTimeout(3000);
}
async function login(page){
  await page.goto("https://admin.octopuspro.com/login",{waitUntil:"domcontentloaded",timeout:60000});
  await page.locator('input[type="email"],input[name="email"],input[name="username"],#email').first().fill(EMAIL);
  await page.locator('input[type="password"],input[name="password"],#password').first().fill(PASSWORD);
  await page.locator('button[type="submit"],input[type="submit"]').first().click();await page.waitForTimeout(4000);
  if(page.url().toLowerCase().includes("checkuserinmulticompanies"))await selectOrganization(page);
  if(page.url().toLowerCase().includes("/login"))throw Error("OctopusPro login failed");
}
async function withPage(fn){const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await login(page);return await fn(page)}finally{await browser.close()}}

const tools=[
 {name:"octopus_login_health",description:"Verify administrator login without changing data.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:"get_booking_page",description:"Read an OctopusPro booking using its exact admin URL.",inputSchema:{type:"object",properties:{booking_url:{type:"string"}},required:["booking_url"],additionalProperties:false},annotations:{readOnlyHint:true}}
];
async function callTool(name,args){
 if(name==="octopus_login_health")return withPage(async page=>({authenticated:true,organization:ORGANIZATION,url:page.url()}));
 if(name==="get_booking_page"){const url=String(args?.booking_url||"");if(!url.startsWith("https://admin.octopuspro.com/"))throw Error("Only OctopusPro admin URLs allowed");return withPage(async page=>{await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});await page.waitForTimeout(3500);return{url:page.url(),title:await page.title(),text:(await page.locator("body").innerText()).slice(0,20000)}})}
 throw Error("Unknown tool");
}

const protectedMetadata={resource:BASE,authorization_servers:[BASE],scopes_supported:SCOPES,resource_documentation:BASE+"/docs"};
const authMetadata={issuer:BASE,authorization_response_iss_parameter_supported:true,authorization_endpoint:BASE+"/authorize",token_endpoint:BASE+"/token",registration_endpoint:BASE+"/register",token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],scopes_supported:SCOPES};

const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,BASE);
 if(u.pathname==="/health")return json(res,200,{ok:true,oauth:true});
 if(u.pathname==="/.well-known/oauth-protected-resource"||u.pathname==="/.well-known/oauth-protected-resource/mcp")return json(res,200,protectedMetadata);
 if(u.pathname==="/.well-known/oauth-authorization-server")return json(res,200,authMetadata);
 if(u.pathname==="/docs")return html(res,200,"<h1>SpeedyCleans OctopusPro Admin</h1><p>Private single-owner MCP connector.</p>");
 if(u.pathname==="/register"&&req.method==="POST"){const data=JSON.parse(await body(req)||"{}");const registered={...data,client_id:"cgpt_"+randomBytes(18).toString("base64url"),client_id_issued_at:Math.floor(Date.now()/1000),redirect_uris:data.redirect_uris||[],token_endpoint_auth_method:data.token_endpoint_auth_method||"none",grant_types:data.grant_types||["authorization_code","refresh_token"],response_types:data.response_types||["code"],scope:data.scope||SCOPES.join(" ")};console.log("OAuth client registered",{redirectCount:registered.redirect_uris.length,grant_types:registered.grant_types,response_types:registered.response_types,token_endpoint_auth_method:registered.token_endpoint_auth_method});return json(res,201,registered)}
 if(u.pathname==="/authorize"&&req.method==="GET"){
   const q=Object.fromEntries(u.searchParams);if(q.response_type!=="code"||q.code_challenge_method!=="S256"||!q.redirect_uri||!q.client_id||!q.code_challenge)return json(res,400,{error:"invalid_request"});
   const hidden=Object.entries(q).map(([k,v])=>'<input type="hidden" name="'+escape(k)+'" value="'+escape(v)+'">').join("");
   return html(res,200,'<!doctype html><meta name="viewport" content="width=device-width"><title>Authorize SpeedyCleans</title><style>body{font:16px system-ui;max-width:520px;margin:50px auto;padding:24px}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:8px 0}button{background:#111;color:white;border:0}</style><h1>Authorize OctopusPro Admin</h1><p>Grants ChatGPT read and approved write access to SpeedyCleans OctopusPro.</p><form method="post" action="/authorize">'+hidden+'<label>Owner approval code</label><input name="approval_code" type="password" required autocomplete="one-time-code"><button>Authorize</button></form>');
 }
 if(u.pathname==="/authorize"&&req.method==="POST"){
   const f=Object.fromEntries(new URLSearchParams(await body(req)));if(f.approval_code!==APPROVAL)return html(res,403,"Authorization denied.");
   const code=sign({type:"code",aud:BASE,exp:Date.now()+300000,client_id:f.client_id,redirect_uri:f.redirect_uri,challenge:f.code_challenge,scope:f.scope||"octopus:read octopus:write octopus:financial",resource:f.resource||BASE,nonce:randomBytes(8).toString("hex")});
   const out=new URL(f.redirect_uri);out.searchParams.set("code",code);if(f.state)out.searchParams.set("state",f.state);out.searchParams.set("iss",BASE);return res.writeHead(302,{location:out.toString(),"cache-control":"no-store"}).end();
 }
 if(u.pathname==="/token"&&req.method==="POST"){
   const f=Object.fromEntries(new URLSearchParams(await body(req)));
   try{
    if(f.grant_type==="authorization_code"){const p=verify(f.code,"code");if(p.client_id!==f.client_id||p.redirect_uri!==f.redirect_uri||sha256(f.code_verifier)!==p.challenge||p.resource!==(f.resource||BASE))throw Error("invalid grant");const access=sign({type:"access",aud:BASE,exp:Date.now()+3600000,scope:p.scope});const refresh=sign({type:"refresh",aud:BASE,exp:Date.now()+2592000000,scope:p.scope,client_id:p.client_id});return json(res,200,{access_token:access,token_type:"Bearer",expires_in:3600,refresh_token:refresh,scope:p.scope})}
    if(f.grant_type==="refresh_token"){const p=verify(f.refresh_token,"refresh");if(p.client_id!==f.client_id)throw Error("invalid client");const access=sign({type:"access",aud:BASE,exp:Date.now()+3600000,scope:p.scope});return json(res,200,{access_token:access,token_type:"Bearer",expires_in:3600,refresh_token:f.refresh_token,scope:p.scope})}
   }catch{return json(res,400,{error:"invalid_grant"})}
   return json(res,400,{error:"unsupported_grant_type"});
 }
 if(u.pathname!=="/mcp"||req.method!=="POST")return json(res,404,{error:"not_found"});
 const rawRpc=await body(req);
 if(!rawRpc.length){res.writeHead(204,{"cache-control":"no-store"});return res.end()}
 let rpc;try{rpc=JSON.parse(rawRpc)}catch{console.warn("Invalid MCP JSON",{length:rawRpc.length,contentType:req.headers["content-type"],accept:req.headers.accept,prefix:rawRpc.slice(0,160)});return json(res,400,{error:"invalid_json"})}
 const base={jsonrpc:"2.0",id:rpc.id};
 try{
  if(rpc.method==="initialize")return json(res,200,{...base,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"speedycleans-octopus-admin",version:"0.3.0"},instructions:"Tool metadata is public for discovery. Every tool call requires an authorized SpeedyCleans OAuth token."}});
  if(rpc.method==="notifications/initialized"){res.writeHead(204);return res.end()}
  if(rpc.method==="tools/list")return json(res,200,{...base,result:{tools}});
  if(rpc.method==="tools/call"){
   try{verify(String(req.headers.authorization||"").replace(/^Bearer\s+/i,""),"access")}catch{return json(res,401,{error:"unauthorized"},{"www-authenticate":'Bearer resource_metadata="'+BASE+'/.well-known/oauth-protected-resource", scope="octopus:read octopus:write octopus:financial"'})}
   const result=await callTool(rpc.params?.name,rpc.params?.arguments||{});return json(res,200,{...base,result:{content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result}})
  }
  return json(res,200,{...base,error:{code:-32601,message:"Method not found"}});
 }catch(e){return json(res,200,{...base,result:{isError:true,content:[{type:"text",text:e.message}]}})}
});
server.listen(PORT,"0.0.0.0",()=>console.log("Octopus admin OAuth MCP listening on "+PORT));