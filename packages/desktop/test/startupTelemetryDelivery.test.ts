import { expect, it, vi } from "vitest";
import { wrapStartupReporterRequest } from "../src/main/startupTelemetryDelivery.js";

it("does not treat HTTP 500 as receipt and retries only startup reports", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 500 })
    .mockResolvedValue({ ok: true, status: 200 });
  const acknowledged = vi.fn();
  const request = wrapStartupReporterRequest(send, { acknowledged, delay: async () => {} });
  await request({}, { events: [{ properties: { startup_event_id: "stable-id" } }] });
  expect(send).toHaveBeenCalledTimes(2);
  expect(acknowledged).toHaveBeenCalledWith(["stable-id"], "http_received");
  expect(send.mock.calls[0]?.[1]).toBe(send.mock.calls[1]?.[1]);
  await request({}, { events: [{ name: "unrelated" }] });
  expect(send).toHaveBeenCalledTimes(3);
});

it("bounds failures without starting a migration or claiming success", async () => {
  const send = vi.fn().mockRejectedValue(new Error("offline"));
  const acknowledged = vi.fn();
  const request = wrapStartupReporterRequest(send, { acknowledged, delay: async () => {} });
  await request({}, { events: [{ properties: { startup_event_id: "failed-id" } }] });
  expect(send).toHaveBeenCalledTimes(3);
  expect(acknowledged).toHaveBeenCalledWith(["failed-id"], "unconfirmed");
});

it("drops every ARMS batch while telemetry is opted out", async () => {
  const send = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const acknowledged = vi.fn();
  let enabled = false;
  const request = wrapStartupReporterRequest(send, {
    acknowledged,
    delay: async () => {},
    isEnabled: () => enabled,
  });

  await request({}, { events: [{ properties: { startup_event_id: "opted-out" } }] });
  expect(send).not.toHaveBeenCalled();
  expect(acknowledged).not.toHaveBeenCalled();

  enabled = true;
  await request({}, { events: [{ properties: { startup_event_id: "enabled" } }] });
  expect(send).toHaveBeenCalledTimes(1);
  expect(acknowledged).toHaveBeenCalledWith(["enabled"], "http_received");
});
