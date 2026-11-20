type Rule = { method: "GET" | "POST" | "DELETE"; path: RegExp };

const RULES: readonly Rule[] = [
  { method: "GET", path: /^\/auth\/api-keys$/ },
  { method: "POST", path: /^\/auth\/api-key$/ },
  { method: "GET", path: /^\/auth\/derive-api-key$/ },

  { method: "GET", path: /^\/deployed$/ },
  { method: "POST", path: /^\/submit$/ },
  { method: "GET", path: /^\/v1\/account\/transactions\/params$/ },
  { method: "GET", path: /^\/v1\/account\/transactions\/[A-Za-z0-9_-]{1,128}$/ },

  { method: "GET", path: /^\/tick-size$/ },
  { method: "GET", path: /^\/neg-risk$/ },
  { method: "GET", path: /^\/book$/ },
  { method: "GET", path: /^\/markets-by-token\/\d{1,100}$/ },
  { method: "GET", path: /^\/clob-markets\/0x[0-9a-fA-F]{64}$/ },

  { method: "GET", path: /^\/balance-allowance$/ },
  { method: "GET", path: /^\/balance-allowance\/update$/ },

  { method: "POST", path: /^\/order$/ },
  { method: "DELETE", path: /^\/order$/ },
  { method: "GET", path: /^\/data\/orders$/ },
];

// SDK paths never carry a query, dots or percent-escapes
const SAFE_PATH = /^\/[A-Za-z0-9/_-]*$/;

export function isSignablePath(method: string, rawPath: string, builderCode?: string): boolean {
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (!SAFE_PATH.test(path) || path.includes("//")) return false;

  if (method === "GET" && builderCode && path.startsWith("/fees/builder-fees/")) {
    return path.slice("/fees/builder-fees/".length).toLowerCase() === builderCode.toLowerCase();
  }

  return RULES.some((rule) => rule.method === method && rule.path.test(path));
}
