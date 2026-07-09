const forbiddenPatterns = [
  /(可以|能够|已经|基本|明确)确诊|确诊(为|是)/,
  /多数为良性/,
  /恶性风险较(高|低)/,
  /通常建议穿刺/,
  /需要穿刺/,
  /需要手术/,
  /需要复查/,
  /\d+\s*(天|周|个月|月|年)后复查/
];

export function assertSafeText(text: string) {
  const hit = forbiddenPatterns.find((pattern) => pattern.test(text));
  if (hit) {
    throw new Error(`Unsafe medical wording detected: ${hit.source}`);
  }
}
