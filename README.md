# CFGoodNet

This project was bootstrapped with [create-ts-node](https://www.npmjs.com/package/create-ts-node).

## 配置文件

项目运行时读取 `config/config.yml`。

- 首次启动时如果文件不存在，会自动在 `config/` 目录生成：
	- `config/config.yml`
	- `config/mitm-cert.pem`
	- `config/mitm-key.pem`

可参考下面完整示例：

```yaml
server:
	listen: 3000

# 命中 cfProxy 规则时，会将目标 URL 拼接到该地址后转发
# 例如 cfProxy: http://example.com/ 时，访问 https://a.com 会转发到
# http://example.com/https://a.com/
cfProxy: http://test.com/

httpProxy:
	host: 127.0.0.1
	port: 7897
	# 可选，格式为 "username:password"
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

- `server.listen`: 本地代理服务监听端口，默认 `3000`。
- `cfProxy`: 可选，必须是合法 URL。用于 `cfProxy` 动作的上游地址。
- `httpProxy.host`: 可选，`httpProxy` 动作使用的代理主机。
- `httpProxy.port`: 可选，`httpProxy` 动作使用的代理端口。
- `httpProxy.auth`: 可选，格式 `username:password`，会自动转为 `Proxy-Authorization: Basic ...`。
- `rules`: 规则列表，按顺序匹配，命中第一条即生效。

### 规则语法

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

### 配置模板

模板 1: 广告拦截 + 其余直连（最稳妥的起步配置）

```yaml
server:
	listen: 3000

cfProxy:

httpProxy:
	host:
	port:
	auth:

rules:
	- DOMAIN,ad.com,REJECT
	- DOMAIN-SUFFIX,doubleclick.net,REJECT
	- DOMAIN-KEYWORD,ads,REJECT
	- MATCH,DIRECT
```

说明:

- 该模板不依赖上游代理，适合先验证本地代理是否工作正常。
- 后续如需走上游代理，可把规则中的 `DIRECT` 改为 `httpProxy` 或 `cfProxy`，并补全对应字段。

## Available scripts

```sh
# Run project in dev mode with automatic restarts on changes
pnpm dev
# Run tests, linter, type checker and check code formatting
pnpm test
# Format code using prettier
pnpm format
# Build project for production
pnpm build
# Clean all build artefacts
pnpm clean
# Run project in production mode
pnpm start
# Automatically fix linting and formatting issues
pnpm fix
```
