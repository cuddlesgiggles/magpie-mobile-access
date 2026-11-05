# magpie 手机接入

<p align="center">
  <img src="logo.png" width="128" alt="magpie 手机接入 logo">
</p>

**magpie-mobile-access** —— 把本机 magpie 网关（127.0.0.1:3425）安全地暴露给手机/其它设备的引导向导，为手机本地运行的 **DSHgo** 准备。
覆盖完整链路：magpie 局域网共享 + 网关密钥 + Tailscale serve 隧道 + 端到端验证。

> 图标取自 Tailscale 的公共 favicon（256×256）。Tailscale 名称与标识归 Tailscale Inc.
> 所有；本工具为个人本地工具，与 Tailscale 无关联。

零依赖，Node ≥ 20。**除一条 `tailscale serve` 命令（先问再执行）外零写入**——
局域网共享和网关密钥只在 magpie 界面里引导你点，向导绝不改 magpie 配置文件。

## 用法

```sh
node wizard.mjs            # 引导模式：一步一检，从卡住的那步带你走
node wizard.mjs --doctor   # 体检模式：只读，六项检查，汇总哪些 ✓ 哪些 ✗
node wizard.mjs --teardown # 撤除模式：撤 tailscale serve（key/共享在界面里关）
```

环境变量：

- `TAILSCALE_CLI` — 指定 tailscale 可执行文件位置（找不到命令时向导提示安装，不代装）
- `MAGPIE_URL` — magpie 网关地址（默认 `http://127.0.0.1:3425`，改过端口的用它）

## 平台范围

**在 Windows 上完整验证。** macOS/Linux 的代码路径已写（浏览器打开用 `open`/`xdg-open`，
tailscale 走 PATH），但**未经真机验证**——跑出问题欢迎提 issue 附输出。

## 引导模式走什么路

```
步骤 0  前置体检     magpie 在跑？tailscale 装了且登录？本机 tailnet 域名？
步骤 1  magpie 授权  局域网共享开着？网关密钥存在且勾了局域网？
        └ 用带 X-Forwarded-For 的本机请求探测 magpie 对外来调用的策略：
          403=共享没开（引导你去开） / 401=缺 key（引导你去建） / 200=就绪
步骤 2  serve 隧道   没配就先问你，再跑 tailscale serve --bg http://127.0.0.1:3425
        └ tailnet 没启用 Serve 功能时：自动打开启用网页，等你点完，重试
步骤 3  端到端验证   https://<机器名>.ts.net/v1/models 带 key 必须回 200
        └ 首次访问现场签证书，向导自动重试三次；顺带让你挑手机默认模型
步骤 4  产出三行     接口地址 / API 密钥 / 模型 ID，手机直接抄
```

每步不绿就停在那一步：告诉你在哪个界面点什么，等你按回车后重查。

## 产出（手机侧）

```
接口地址:  https://<本机tailnet域名>/v1     ← 随时随地；同 WiFi 也可填共享页的内网地址
API 密钥:  sk-magpie-key-…                   ← PC magpie「网关 → 网关密钥」里建的
模型 ID:   <向导里选的那个>                  ← 完整清单在 /v1/models
```

手机侧：三行配置填进 **DSHgo**（手机本地运行）的自定义模型接口。前提：手机装
Tailscale 并登录同一 tailnet 账号。其它支持自定义 OpenAI 兼容接口的客户端同样适用，
只是本工具只对 DSHgo 做过实测。

## 安全边界

- 网关密钥 = 能花你所有订阅额度的凭据。存于 PC 的 `~/.config/magpie/caller-keys.json`；
  手机端保存进手机自己的配置。别截图外传。
- 隧道只对本 tailnet 设备可见（`serve status` 显示 tailnet only）；magpie 的
  401/403 门禁照常工作：无 key 的外来请求一律被拒。
- 全部可逆：`tailscale serve reset` + 界面里删密钥/关共享。不动注册表、服务、防火墙。

## 本机验证记录

2026-11-06：doctor 六项全绿；引导模式跑通全链路（models 200 + 隧道），
产出三行与手工配置一致。期间修掉一处 serve 状态解析错误（状态输出两行分开
含 `https://` 与 `proxy`，原正则单行匹配不上）。
