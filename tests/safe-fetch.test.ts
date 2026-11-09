import { describe, expect, it } from "vitest";
import { isPrivateAddress, safeFetch } from "@/lib/net/safe-fetch";

describe("media URL guard (SSRF)", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "151.101.1.140", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it("refuses localhost, private IPs and non-http schemes before any request is made", async () => {
    await expect(safeFetch("http://localhost:3000/x.jpg", { maxBytes: 1000 })).rejects.toThrow(/private host/);
    await expect(safeFetch("http://169.254.169.254/latest/meta-data", { maxBytes: 1000 })).rejects.toThrow(/private or reserved/);
    await expect(safeFetch("file:///etc/passwd", { maxBytes: 1000 })).rejects.toThrow(/Only http/);
  });
});
