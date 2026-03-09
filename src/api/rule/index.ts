import type { Outbound } from "../outbound/types.js";
import { configYaml } from "../../config.js";
import { outbounds } from "../outbound/index.js";

import { DOMAINRulecreater } from "./domain.js";
import { DOMAINSuffixRulecreater } from "./domainSuffix.js";
import { DOMAINKeywordRulecreater } from "./domainKeyword.js";
import { DOMAINWildcardRulecreater } from "./domainWildcard.js";
import { DOMAINRegexRulecreater } from "./domainRegex.js";
import { MATCHRulecreater } from "./match.js";


type RuleFunction = (URL: string) => boolean;
type RuleFunctionCreater = (pattern: string|null) => RuleFunction;
const ruleFunctionCreaters: Record<string, RuleFunctionCreater> = {
    "DOMAIN": DOMAINRulecreater,
    "DOMAIN-SUFFIX": DOMAINSuffixRulecreater,
    "DOMAIN-KEYWORD": DOMAINKeywordRulecreater,
    "DOMAIN-WILDCARD": DOMAINWildcardRulecreater,
    "DOMAIN-REGEX": DOMAINRegexRulecreater,
    "MATCH": MATCHRulecreater
};

export type Rule = {
    type: string;
    pattern: string|null;
    action: string;
    ruleFunction: RuleFunction;
    actionOutbound: Outbound;
}

/**
 * 将单行规则文本解析为结构化的 Rule 对象。
 *
 * 配置中的 `configYaml.rules` 期望是以逗号分隔的字符串。通常为三
 * 个字段：`<type>,<pattern>,<action>`；其中 pattern 可在特定类型（如
 * `MATCH`）下省略。额外的字段会被忽略。函数会验证语法，查找对应的
 * 匹配函数创建器和出站处理器，并返回可用于运行时匹配的完整 `Rule`
 * 记录。如果输入格式错误、类型不可识别或动作不存在，则会在控制台
 * 警告并返回 `null`。
 *
 * @param ruleText - 来自配置的原始规则文本（例如："DOMAIN-SUFFIX,example.com,DIRECT" 或 "MATCH,cfProxy"）
 * @returns 解析成功时返回 `Rule` 对象，否则返回 `null`。
 */
function createRuleFromText(ruleText: string): Rule | null {
    ruleText = ruleText.trim();
    const parts = ruleText.split(",").map(part => part.trim());
    if (parts.length < 2) {
        console.warn(`Invalid rule: ${ruleText}`);
        return null;
    }
    const type = parts[0] as string;

    // MATCH 规则特殊：只需要提供动作，模式可以省略。
    // 例如 `MATCH,cfProxy` 表示所有 URL 都使用 cfProxy。
    let pattern = null;
    let action: string;
    if (parts.length === 2) {
        action = parts[1] as string;
    } else {
        pattern = parts[1] as string;
        action = parts[2] as string;
    }

    const ruleFunctionCreater = ruleFunctionCreaters[type || ""];
    if (!ruleFunctionCreater) {
        console.warn(`Unsupported rule type: ${type} in rule: ${ruleText}`);
        return null;
    }
    const actionOutbound = outbounds[action as keyof typeof outbounds];
    if (!actionOutbound) {
        console.warn(`Unsupported action: ${action} in rule: ${ruleText}`);
        return null;
    }
    return {
        type,
        pattern,
        action,
        ruleFunction: ruleFunctionCreater(pattern),
        actionOutbound: actionOutbound
    };
}

const rawRules = (configYaml.rules || []).map(createRuleFromText).filter((v: Rule | null)=> v !== null) as Rule[];

/**
 * 根据目标 URL 找到第一条匹配的规则。
 *
 * 遍历已经解析好的 `rawRules` 列表，依次调用每条规则的
 * `ruleFunction`。首次返回 `true` 的规则会立即返回给调用者，
 * 如果没有任何规则匹配，则返回 `null`。
 *
 * @param url - 待匹配的完整 URL 字符串。
 * @returns 命中的 `Rule` 对象或 `null`。
 */
export function matchRule(url: string): Rule | null {
    for (const rule of rawRules) {
        if (rule.ruleFunction(url)) {
            return rule;
        }
    }
    return null;
}