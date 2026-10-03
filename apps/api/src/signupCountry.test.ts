import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupSignupCountry } from "./signupCountry.js";
const lookup = vi.hoisted(() => vi.fn());
vi.mock("geoip-lite", () => ({ default: { lookup } }));

describe("signup country lookup", () => {
  beforeEach(() => lookup.mockReset());
  it.each(["", "garbage", "127.0.0.1", "10.1.2.3", "192.168.1.2", "172.16.0.1", "100.64.1.2", "203.0.113.4", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1"])(
    "leaves non-public IP %s unknown", async (ip) => {
      expect(await lookupSignupCountry(ip)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    }
  );
  it.each(["8.8.8.8", "2001:4860:4860::8888", "::ffff:8.8.8.8"])("looks up public IP %s locally", async (ip) => {
    lookup.mockReturnValue({ country: "US" });
    expect(await lookupSignupCountry(ip)).toBe("US");
    expect(lookup).toHaveBeenCalledWith(ip.replace("::ffff:", ""));
  });
  it.each([null, { country: "" }, { country: "USA" }])("falls back for missing or invalid data %j", async (result) => {
    lookup.mockReturnValue(result);
    expect(await lookupSignupCountry("8.8.8.8")).toBeNull();
  });
});
