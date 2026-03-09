// 通配符匹配（* 和 ?）
export function DOMAINWildcardRulecreater(pattern: string|null): (urlString: string) => boolean {
  if (!pattern) {
    return () => false;
  }
  const normalized = pattern.trim().toLowerCase();
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  const re = new RegExp(`^${regexBody}$`, "i");
  return (urlString: string) => {
    try {
      const hostname = new URL(urlString).hostname.toLowerCase();
      return re.test(hostname);
    } catch {
      return false;
    }
  };
}
