import test from "node:test";
import assert from "node:assert/strict";
import { createGraphitiLogger } from "../dist/logging.js";

function makeSink(withDebug = true) {
  const records = [];
  const sink = {
    info: (message) => records.push({ level: "info", message }),
    warn: (message) => records.push({ level: "warn", message }),
    error: (message) => records.push({ level: "error", message }),
  };
  if (withDebug) sink.debug = (message) => records.push({ level: "debug", message });
  return { sink, records };
}

test("log level suppresses lower-priority events without hiding errors", () => {
  const { sink, records } = makeSink();
  const logger = createGraphitiLogger(sink, {
    logOperations: true,
    logLevel: "warn",
    logContent: true,
  });

  logger.debug("debug_event", { n: 1 });
  logger.info("info_event", { n: 2 });
  logger.warn("warn_event", { n: 3 });
  logger.error("error_event", { n: 4 });

  assert.deepEqual(
    records.map((record) => record.level),
    ["warn", "error"],
  );
});

test("logOperations=false keeps warnings and errors but silences normal operation noise", () => {
  const { sink, records } = makeSink();
  const logger = createGraphitiLogger(sink, {
    logOperations: false,
    logLevel: "debug",
    logContent: true,
  });

  logger.debug("buffered");
  logger.info("queued");
  logger.debugContent("capture_payload", {}, { body: "secret" });
  logger.warn("recall_failed");
  logger.error("capture_failed");

  assert.deepEqual(
    records.map((record) => record.level),
    ["warn", "error"],
  );
});

test("content logging requires logOperations + debug level + logContent and is journald-visible", () => {
  const noContent = makeSink();
  createGraphitiLogger(noContent.sink, {
    logOperations: true,
    logLevel: "debug",
    logContent: false,
  }).debugContent("capture_payload", {}, { body: "secret" });
  assert.equal(noContent.records.length, 0);

  const infoOnly = makeSink();
  createGraphitiLogger(infoOnly.sink, {
    logOperations: true,
    logLevel: "info",
    logContent: true,
  }).debugContent("capture_payload", {}, { body: "secret" });
  assert.equal(infoOnly.records.length, 0);

  const operationsOff = makeSink();
  createGraphitiLogger(operationsOff.sink, {
    logOperations: false,
    logLevel: "debug",
    logContent: true,
  }).debugContent("capture_payload", {}, { body: "secret" });
  assert.equal(operationsOff.records.length, 0);

  const enabled = makeSink();
  createGraphitiLogger(enabled.sink, {
    logOperations: true,
    logLevel: "debug",
    logContent: true,
  }).debugContent("capture_payload", { agentId: "main" }, { body: "first\nsecond" });

  assert.equal(enabled.records.length, 1);
  assert.equal(enabled.records[0].level, "info");
  assert.match(enabled.records[0].message, /event=capture_payload/);
  assert.match(enabled.records[0].message, /body="first\\nsecond"/);
  assert.equal(enabled.records[0].message.includes("first\nsecond"), false);
});

test("debug falls back to info when the host logger lacks a debug method", () => {
  const { sink, records } = makeSink(false);
  const logger = createGraphitiLogger(sink, {
    logOperations: true,
    logLevel: "debug",
    logContent: false,
  });

  logger.debug("diagnostic", { agentId: "main" });
  assert.equal(records.length, 1);
  assert.equal(records[0].level, "info");
});
