root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
p=root+'packages/core/src/adapters/retry.ts'; s=open(p).read()
old='''export function isTextProviderFallbackError(error: unknown): boolean {
  if (isStopOrAbortError(error)) {
    return false;
  }'''
new='''/**
 * A provider's input filter refusing the text it was sent. Alibaba answers
 * `400 data_inspection_failed: "Input text data may contain inappropriate
 * content."` to a history chapter about genocide, and a 400 used to be final:
 * a paid fast-tier book failed at 62% with a fallback writer configured that
 * runs a different filter. For text the other provider is the answer.
 */
export function isProviderContentFilterError(error: unknown): boolean {
  return collectErrorDescriptors(error).some(
    (descriptor) =>
      (descriptor.code !== undefined && /data_inspection_failed|content_filter/i.test(descriptor.code)) ||
      descriptor.messages.some((message) =>
        /data_inspection_failed|inappropriate content|content management policy|content_filter/i.test(message)
      )
  );
}

export function isTextProviderFallbackError(error: unknown): boolean {
  if (isStopOrAbortError(error)) {
    return false;
  }
  if (isProviderContentFilterError(error)) {
    return true;
  }'''
assert old in s; s=s.replace(old,new,1); open(p,'w').write(s)
p=root+'packages/core/src/adapters/retry.test.ts'; s=open(p).read()
old='''describe("isTextProviderFallbackError", () => {'''
new='''describe("isTextProviderFallbackError", () => {
  it("falls back when a provider's input filter refuses the chapter", () => {
    // Alibaba, verbatim, on a history chapter about genocide (composed-13-fast).
    const refused = new Error(
      '400 data: {"error":{"code":"data_inspection_failed","param":null,"message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}}'
    );
    expect(isTextProviderFallbackError(refused)).toBe(true);
    expect(isTextProviderFallbackError(new ProviderHttpError("bad request", { status: 400 }))).toBe(false);
  });
'''
assert old in s; s=s.replace(old,new,1); open(p,'w').write(s)
print("content-filter fallback patch applied")
