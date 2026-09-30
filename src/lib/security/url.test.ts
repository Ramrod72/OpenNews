import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl } from "./url";

describe("assertPublicHttpUrl", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(assertPublicHttpUrl("ftp://8.8.8.8/file")).rejects.toThrow();
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("javascript:alert(1)")).rejects.toThrow();
  });

  it("rejects loopback addresses", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://localhost/")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[::1]/")).rejects.toThrow();
  });

  it("rejects RFC1918 private ranges", async () => {
    await expect(assertPublicHttpUrl("http://10.0.0.5/")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://172.16.0.5/")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://192.168.1.1/")).rejects.toThrow();
  });

  it("rejects the cloud metadata link-local address", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
  });

  it("rejects CGNAT range", async () => {
    await expect(assertPublicHttpUrl("http://100.64.0.1/")).rejects.toThrow();
  });

  it("accepts a literal public IP address", async () => {
    await expect(assertPublicHttpUrl("http://8.8.8.8/feed.xml")).resolves.toBeInstanceOf(URL);
  });

  it("rejects malformed URLs", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow();
  });

  it("rejects a URL with embedded credentials (userinfo), even against an otherwise-public IP", async () => {
    await expect(assertPublicHttpUrl("http://user:pass@8.8.8.8/feed.xml")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://trusted-looking@8.8.8.8/feed.xml")).rejects.toThrow();
  });
});
