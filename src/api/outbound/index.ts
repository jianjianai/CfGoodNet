import type { ProxyAction } from "../../config.js";
import type { Outbound } from "./types.js";
import { REJECToutbound } from "./reject.js";
import { DIRECToutbound } from "./direct.js";
import { httpProxyOutbound } from "./httpProxy.js";
import { cfProxyOutbound } from "./cfProxy.js";

// 将所有出站处理按 action 组织成字典，proxy-handler 只需要查表即可
export const outbounds: Record<ProxyAction, Outbound> = {
  REJECT: REJECToutbound,
  DIRECT: DIRECToutbound,
  httpProxy: httpProxyOutbound,
  cfProxy: cfProxyOutbound,
};