# CFGoodNet

CFGoodNet 是一个本地 MITM 代理，支持基于规则的上游转发。

## 构建产物

项目会打包成单文件运行：

- `dist/app.cjs`
- `dist/app.cjs.map`（调试用 Source Map）

常用命令：

```sh
pnpm build
pnpm start
pnpm dev
```

## 配置文件

运行时配置文件：`config/config.yml`

首次启动时，如果不存在会自动生成：

- `config/config.yml`
- `config/mitm-cert.pem`
- `config/mitm-key.pem`

示例：

```yaml
server:
  listen: 3000

cfProxy: http://test.com/

# 可选：覆盖 cfProxy 的连接目标 IP
# 支持域名 / IPv4 / IPv6
cfGoodIp: freeyx.cloudflare88.eu.org

httpProxy:
  host: 127.0.0.1
  port: 7897
  # 可选，格式："username:password"
  auth:

rules:
  - DOMAIN,ad.com,REJECT
  - DOMAIN-SUFFIX,google.com,cfProxy
  - DOMAIN-KEYWORD,youtube,httpProxy
  - DOMAIN-WILDCARD,*.google.com,cfProxy
  - DOMAIN-REGEX,^abc.*com,DIRECT
  - MATCH,DIRECT
```

### 字段说明

- `server.listen`: 本地代理监听端口，默认 `3000`
- `cfProxy`: `cfProxy` 动作使用的上游 URL
- `cfGoodIp`: 可选，覆盖 `cfProxy` 的实际 TCP 连接目标
- `httpProxy.host`: `httpProxy` 动作使用的代理主机
- `httpProxy.port`: `httpProxy` 动作使用的代理端口
- `httpProxy.auth`: 可选，`username:password`，会自动转成 `Proxy-Authorization`
- `rules`: 规则列表，按顺序匹配，命中第一条即生效

## 规则语法

规则格式：

- 普通规则：`TYPE,PATTERN,ACTION`
- 兜底规则：`MATCH,ACTION`

支持的 `TYPE`：

- `DOMAIN`: 完全匹配域名。例：`DOMAIN,api.example.com,DIRECT`
- `DOMAIN-SUFFIX`: 后缀匹配。例：`DOMAIN-SUFFIX,example.com,cfProxy`
- `DOMAIN-KEYWORD`: 子串匹配。例：`DOMAIN-KEYWORD,google,httpProxy`
- `DOMAIN-WILDCARD`: 通配符匹配（`*`/`?`）。例：`DOMAIN-WILDCARD,*.example.com,DIRECT`
- `DOMAIN-REGEX`: 正则匹配。例：`DOMAIN-REGEX,^api\d+\.example\.com$,DIRECT`
- `MATCH`: 匹配全部，通常放最后作为兜底。

支持的 `ACTION`：

- `REJECT`: 拒绝请求（返回 403）
- `cfProxy`: 通过 `cfProxy` 上游转发
- `httpProxy`: 通过 `httpProxy.host:port` 转发
- `DIRECT`: 直连目标地址

### 常见注意事项

- `rules` 按顺序生效，建议把更具体的规则放前面，把 `MATCH,...` 放最后。
- `httpProxy` 动作只有在 `httpProxy.host` 和 `httpProxy.port` 都配置时才会生效，否则自动回退 `DIRECT`。
- `cfProxy` 动作只有在 `cfProxy` 配置为合法 URL 时才会生效，否则自动回退 `DIRECT`。
- 本项目会进行 MITM，浏览器如提示证书错误，需要信任 `config/mitm-cert.pem`，或仅在开发调试时使用浏览器忽略证书错误参数。

## cfGoodIp 行为说明

当配置了 `cfGoodIp`：

- 启动阶段：
  - 若是 IP（v4/v6），直接使用该 IP
  - 若是域名，启动时解析一次并使用解析结果
  - 会打印日志：`[proxy] cfGoodIp: <ip>`

- 命中 `cfProxy` 时：
  - `Host` / TLS `SNI` 仍然使用 `cfProxy` 的域名
  - 但 TCP 实际连接会改为 `cfGoodIp` 指定（或解析得到）的 IP
  - HTTP(S) 与 WebSocket 都会应用该策略

若 `cfGoodIp` 未配置或解析失败，则回退为 `cfProxy` 的默认 DNS 解析。

## HTTP 转发说明

当规则命中 `cfProxy` 时，HTTP/HTTPS 目标会映射为 cfProxy 路径：

- `https://target` -> `https://cfProxy/.../https://target...`
- `http://target` -> `https://cfProxy/.../http://target...`（当 `cfProxy` 为 `https://`）

`cfProxy` 协议映射：

- `http://cfProxy` -> 上游 `http://cfProxy`
- `https://cfProxy` -> 上游 `https://cfProxy`


## WebSocket 转发说明

当规则命中 `cfProxy` 时，WebSocket 目标会映射为 cfProxy 路径：

- `wss://target` -> `wss://cfProxy/.../https://target...`
- `ws://target` -> `wss://cfProxy/.../http://target...`（当 `cfProxy` 为 `https://`）

`cfProxy` 协议映射：

- `http://cfProxy` -> 上游 `ws://cfProxy`
- `https://cfProxy` -> 上游 `wss://cfProxy`

## 日志格式

代理日志格式：

```text
[PORXY] <action> <proxyRul>
<url>
```

示例：

```text
[PORXY] DOMAIN-KEYWORD,youtube,httpProxy localhost
http://xxx

[PORXY] DOMAIN-KEYWORD,youtube,httpProxy https://cfprox.com/
http://xxx
```

每一行会按当前终端宽度截断，避免超出一行。

## 证书信任

项目会进行 HTTPS MITM。

如需浏览器正常访问 HTTPS，请将 `config/mitm-cert.pem` 导入系统/浏览器信任证书。

## 脚本说明

```sh
# 构建单文件产物
pnpm build

# 运行生产产物
pnpm start

# 开发模式（打包 watch + 应用 watch）
pnpm dev

# 测试 / 修复 / 格式化 / 清理
pnpm test
pnpm fix
pnpm format
pnpm clean
```
