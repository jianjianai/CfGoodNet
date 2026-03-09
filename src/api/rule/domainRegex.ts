// 正则表达式匹配
export function DOMAINRegexRulecreater(pattern: string|null): (urlString: string) => boolean {
  if (!pattern) {
    return () => false;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // invalid regex -> never match
    re = /$^/;
  }
  return (urlString: string) => {
    try {
      const hostname = new URL(urlString).hostname;
      return re.test(hostname);
    } catch {
      return false;
    }
  };
}
