#!/usr/bin/env node
// magpie 手机接入 (magpie-mobile-access) — 把本机 magpie 网关引导式暴露给手机/其它设备。
//
// 两种用法：
//   node wizard.mjs            引导模式：一步一检，每步告诉你点什么、等什么
//   node wizard.mjs --doctor   体检模式：只读检查，什么都不改
//   node wizard.mjs --teardown 撤除模式：只撤 tailscale serve（key 和共享在 UI 里关）
//
// 它自己几乎不写任何东西：唯一的写动作是 `tailscale serve --bg ...`（先问）。
// 局域网共享和网关密钥只在 magpie 界面里引导用户操作，向导绝不改 magpie 的
// 配置文件——改了会和运行中的 magpie 打架，也不是用户该被代理掉的决定。

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import readline from "node:readline/promises"

const MAGPIE = process.env.MAGPIE_URL || "http://127.0.0.1:3425"
const XFF = "X-Forwarded-For: 203.0.113.7" // 让 magpie 按「来自其它机器」的规则应答
const MODE = process.argv[2] ?? ""

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`
const warn = (s) => `\x1b[33m●\x1b[0m ${s}`
const step = (n, t) => console.log(`\n\x1b[1m── 步骤 ${n} · ${t} ──\x1b[0m`)

async function ask(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = await rl.question(text)
  rl.close()
  return a.trim()
}

function sh(cmd, args, timeoutMs = 15000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true })
  return { code: r.status, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") }
}

function openBrowser(url) {
  if (process.platform === "win32") spawnSync("cmd.exe", ["/c", "start", "", url], { windowsHide: true })
  else if (process.platform === "darwin") spawnSync("open", [url])
  else spawnSync("xdg-open", [url])
}

// ---- 各项检测 -----------------------------------------------------------

function findTailscale() {
  if (process.env.TAILSCALE_CLI && existsSync(process.env.TAILSCALE_CLI)) return process.env.TAILSCALE_CLI
  const w = sh("where", ["tailscale"])
  const first = w.out.split(/\r?\n/).find((l) => l.trim())
  if (first) return first.trim()
  for (const p of ["D:\\Tailscale\\Program\\tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe"]) {
    if (existsSync(p)) return p
  }
  return null
}

async function fetch_(url, headers = {}, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, text: await res.text() }
  } catch (e) {
    return { status: 0, text: String(e?.cause?.code ?? e?.message ?? e) }
  }
}

function readGatewayKey() {
  const p = join(homedir(), ".config", "magpie", "caller-keys.json")
  try {
    const keys = JSON.parse(readFileSync(p, "utf8"))
    const k = (Array.isArray(keys) ? keys : []).find((k) => k?.lan && k?.secret)
    return k ? { name: k.name ?? "", secret: k.secret } : null
  } catch {
    return null
  }
}

function selfDns(ts) {
  const r = sh(ts, ["status", "--json"], 10000)
  try {
    const d = JSON.parse(r.out)
    return String(d?.Self?.DNSName ?? "").replace(/\.$/, "") || null
  } catch {
    return null
  }
}

function serveConfigured(ts) {
  const r = sh(ts, ["serve", "status"], 10000)
  // configured output looks like:
  //   https://<machine>.ts.net (tailnet only)
  //   |-- / proxy http://127.0.0.1:3425
  // ("No serve config" otherwise)
  const configured = !/no serve config/i.test(r.out) && /proxy/i.test(r.out)
  return { configured, out: r.out.trim() }
}

// ---- 步骤实现 -----------------------------------------------------------

async function stepPreflight(fix) {
  step(0, "前置体检")
  const out = { magpie: false, ts: null, dns: null }

  const m = await fetch_(`${MAGPIE}/v1/models`)
  if (m.status === 200) {
    console.log(ok(`magpie 网关在 ${MAGPIE} 正常应答`))
    out.magpie = true
  } else {
    console.log(bad(`magpie 网关不在 ${MAGPIE}（status ${m.status}）——先启动 magpie 桌面端`))
    if (!fix) return out
    await ask("启动好 magpie 后按回车重查，或直接 Ctrl-C 退出 > ")
    return stepPreflight(fix)
  }

  const ts = findTailscale()
  if (!ts) {
    console.log(bad("没找到 tailscale 命令。安装（需要你确认，向导不代装）："))
    console.log(dim("    winget install tailscale.tailscale    （装完重跑本向导）"))
    return out
  }
  out.ts = ts
  console.log(ok(`tailscale CLI: ${ts}`))

  const dns = selfDns(ts)
  if (!dns) {
    console.log(bad("tailscale 未登录。运行以下命令后在弹出的浏览器里登录你的账号："))
    console.log(dim(`    "${ts}" login`))
    if (!fix) return out
    await ask("登录完成后按回车继续 > ")
    return stepPreflight(fix)
  }
  out.dns = dns
  console.log(ok(`本机 tailnet 域名: ${dns}`))
  return out
}

// magpie 授权侧：局域网共享 + 网关密钥。
// 用带 X-Forwarded-For 的本机请求探测 magpie 对「外来调用」的策略：
//   403 = 共享没开；401 = 共享开着但 key 缺失/无效；200 = 全就绪。
async function stepMagpieAuth(fix) {
  step(1, "magpie 授权侧（局域网共享 + 网关密钥）")
  const probe = await fetch_(`${MAGPIE}/v1/models`, { "X-Forwarded-For": "203.0.113.7" })

  if (probe.status === 403) {
    console.log(bad("局域网共享没开。在 magpie 界面里："))
    console.log(dim("    设置 → 网络与共享 → 局域网共享 → 打开"))
    if (!fix) return { sharing: false, key: null }
    await ask("打开后按回车重查 > ")
    return stepMagpieAuth(fix)
  }
  if (probe.status !== 401 && probe.status !== 200) {
    console.log(bad(`意外应答 status ${probe.status}：${probe.text.slice(0, 120)}`))
    return { sharing: false, key: null }
  }
  console.log(ok("局域网共享已开（外来请求进入鉴权检查）"))

  const key = readGatewayKey()
  if (!key) {
    console.log(bad("还没有可用的网关密钥。在 magpie 界面里："))
    console.log(dim("    网关 → 网关密钥 → 新建（名称随意；确认勾选「局域网共享可用」）"))
    if (!fix) return { sharing: true, key: null }
    await ask("建好后按回车重查 > ")
    return stepMagpieAuth(fix)
  }
  console.log(ok(`网关密钥「${key.name}」存在且已启用局域网`))

  const withKey = await fetch_(`${MAGPIE}/v1/models`, { "X-Forwarded-For": "203.0.113.7", Authorization: `Bearer ${key.secret}` })
  if (withKey.status === 200) {
    console.log(ok("带 key 的「外来」请求被 magpie 接受 —— 授权侧就绪"))
  } else {
    console.log(bad(`带 key 仍被拒（status ${withKey.status}）——检查密钥是否勾了局域网共享可用`))
    return { sharing: true, key: null }
  }
  return { sharing: true, key }
}

// tailscale serve 层：把 magpie 挂到 tailnet 的 HTTPS 地址上。
async function stepServe(fix, ts, dns) {
  step(2, "Tailscale serve 隧道")
  const cur = serveConfigured(ts)
  if (cur.configured) {
    console.log(ok("serve 已配置："))
    console.log(dim("    " + cur.out.split(/\r?\n/).join("\n    ")))
    return true
  }
  console.log(warn("serve 还没配置"))

  if (!fix) return false
  const go = await ask(`要把 magpie 挂上 tailnet 吗？将执行：\n  ${dim(`"${ts}" serve --bg ${MAGPIE}`)}\n回车确认 / 输入 n 跳过 > `)
  if (go.toLowerCase() === "n") return false

  // 先跑 --bg（正确形态）。超时/没配上时，最常见的原因是 tailnet 没启用 Serve
  // 功能——此时裸形式会立刻打印启用链接（注意：裸形式在 serve 已启用的机器上
  // 会进入前台模式并被 Ctrl-C 回滚，所以它只在 --bg 失败后作为 URL 探针使用，
  // 绝不用它来配置）。
  const r = sh(ts, ["serve", "--bg", MAGPIE], 60000)
  if (serveConfigured(ts).configured) {
    console.log(ok("serve 配置成功（撤销：tailscale serve reset）"))
    return true
  }

  const probe = sh(ts, ["serve", MAGPIE.replace(/^https?:\/\//, "")], 12000)
  const enableUrl = /https:\/\/login\.tailscale\.com\/\S+/.exec(probe.out)?.[0]
  if (enableUrl) {
    console.log(warn("tailnet 还没启用 Serve 功能（网页开关，一次性的）"))
    console.log(dim(`    ${enableUrl}`))
    openBrowser(enableUrl)
    console.log(dim("已在浏览器打开；登录你的 Tailscale 账号并点启用。"))
    await ask("启用后按回车继续 > ")
    return stepServe(fix, ts, dns)
  }

  console.log(bad(`serve 没配上（exit ${r.code}）${r.err ? "：" + r.err.slice(0, 150) : ""}`))
  console.log(dim("    手动执行试试：" + `"${ts}" serve --bg ${MAGPIE}`))
  return false
}

async function stepE2E(dns, key) {
  step(3, "端到端验证（走 tailnet HTTPS）")
  if (!dns || !key) return false
  const base = `https://${dns}`
  let res
  for (let i = 1; i <= 3; i++) {
    res = await fetch_(`${base}/v1/models`, { Authorization: `Bearer ${key.secret}` }, 20000)
    if (res.status === 200) break
    await new Promise((r) => setTimeout(r, 3000)) // 首次访问要现场签证书
  }
  if (res.status !== 200) {
    console.log(bad(`经隧道访问失败（status ${res.status}）：${res.text.slice(0, 120)}`))
    return false
  }
  console.log(ok(`https://${base.replace("https://", "")}/v1/models → 200`))

  const models = JSON.parse(res.text).data.map((m) => m.id)
  const chosen = await pickModel(models)
  console.log(ok("隧道链路全通（TLS + 网关 key + magpie 授权）"))
  return { models, chosen }
}

async function pickModel(models) {
  console.log(dim(`    模型清单 ${models.length} 个，常用的前几个：`))
  for (const id of models.slice(0, 8)) console.log(dim(`      ${id}`))
  const a = await ask("手机默认用哪个模型？（回车 = 清单里第一个）> ")
  return models.includes(a) ? a : models[0]
}

function handout(dns, key, model) {
  step(4, "手机侧配置（抄这三行）")
  console.log(`
  接口地址:  https://${dns}/v1
  API 密钥:  ${key.secret}
  模型 ID:   ${model}

  手机侧：配置填进 DSHgo（手机本地运行）的自定义模型接口；手机需装 Tailscale
  并登录同一账号（本机 tailnet 域名 ${dns}）。
  WiFi / 4G 都可用；同 WiFi 也可以改填局域网共享页显示的 http://<内网IP>:3425/v1。
  该密钥能花你所有订阅的额度——别截图外传。
`)
  console.log(dim("  撤除：tailscale serve reset（隧道）+ 网关界面删密钥 + 关局域网共享"))
}

// ---- 模式入口 -----------------------------------------------------------

async function doctor() {
  console.log("magpie 手机接入 · 体检（只读）\n")
  const pre = await stepPreflight(false)
  if (!pre.magpie) return
  const auth = await stepMagpieAuth(false)
  let serveOk = false
  if (pre.ts) serveOk = await stepServe(false, pre.ts, pre.dns)
  let tunnelOk = false
  if (serveOk && auth.key && pre.dns) {
    const r = await fetch_(`https://${pre.dns}/v1/models`, { Authorization: `Bearer ${auth.key.secret}` }, 20000)
    tunnelOk = r.status === 200
    console.log(tunnelOk ? ok(`隧道 ${pre.dns} → 200`) : bad(`隧道 ${pre.dns} → ${r.status}`))
  }
  console.log("\n汇总：")
  console.log(`  magpie 运行      ${pre.magpie ? "✓" : "✗"}`)
  console.log(`  tailscale 登录   ${pre.dns ? "✓" : "✗"}`)
  console.log(`  局域网共享       ${auth.sharing ? "✓" : "✗"}`)
  console.log(`  网关密钥         ${auth.key ? "✓" : "✗"}`)
  console.log(`  serve 隧道       ${serveOk ? "✓" : "✗"}`)
  console.log(`  端到端           ${tunnelOk ? "✓" : "✗"}`)
  if (!tunnelOk) console.log(dim("\n  哪项 ✗ 就跑 node wizard.mjs，向导会从那一步带你走。"))
}

async function teardown() {
  const ts = findTailscale()
  if (!ts) return console.log(bad("没找到 tailscale，无事可撤"))
  const r = sh(ts, ["serve", "reset"], 15000)
  console.log(r.code === 0 ? ok("tailscale serve 已撤") : bad(`serve reset 失败：${r.err.slice(0, 120)}`))
  console.log(dim("剩余两步在 magpie 界面手动关：网关密钥删除、局域网共享关闭。"))
}

async function guided() {
  console.log("magpie 远程接入向导 —— 把本机网关安全地交给你的手机\n")
  const pre = await stepPreflight(true)
  if (!pre.magpie || !pre.ts || !pre.dns) {
    console.log("\n" + bad("前置条件不满足，向导停在这里。处理完重跑。"))
    return
  }
  const auth = await stepMagpieAuth(true)
  if (!auth.sharing || !auth.key) {
    console.log("\n" + bad("magpie 授权侧没配齐，向导停在这里。"))
    return
  }
  const serveOk = await stepServe(true, pre.ts, pre.dns)
  if (!serveOk) {
    console.log("\n" + warn("没有隧道也能用：手机和本机同 WiFi 时，直接填局域网共享页显示的地址。"))
    handoutLAN(auth)
    return
  }
  const e2e = await stepE2E(pre.dns, auth.key)
  if (!e2e) {
    console.log("\n" + bad("端到端没通，按上面的提示排查后重跑 node wizard.mjs"))
    return
  }
  handout(pre.dns, auth.key, e2e.chosen)
}

function handoutLAN(auth) {
  console.log(`
  同 WiFi 场景配置（抄这三行，内网 IP 以 magpie 共享页显示的为准）：

  接口地址:  http://<本机内网IP>:3425/v1
  API 密钥:  ${auth.key.secret}
  模型 ID:   在 ${MAGPIE}/v1/models 里挑
`)
}

if (MODE === "--doctor") await doctor()
else if (MODE === "--teardown") await teardown()
else await guided()
