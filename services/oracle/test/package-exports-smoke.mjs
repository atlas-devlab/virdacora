// Run after build, and unchanged inside the pnpm-deployed Linux image.
import assert from "node:assert/strict";

const application = await import("@terravoce/oracle/application");
const domain = await import("@terravoce/oracle/domain");
assert.equal(typeof application.createOracleUseCases, "function");
assert.equal(typeof application.createEvidenceReader, "function");
assert.equal(typeof domain.analyzeEvidence, "function");
assert.equal(domain.valueForAnalysis({ metric: "water.oxygen.mg_l", value: 6_000, unit: "\u00b5g/L" }), 6);
for (const module of [application, domain]) {
  assert.equal("buildApp" in module, false);
  assert.equal("MemoryObservationStore" in module, false);
  assert.equal("PostgresObservationStore" in module, false);
}
const reader = application.createEvidenceReader({
  async getEvidenceReceipt() { throw new Error("unused synthetic read"); },
  async listEvidenceReceipts(assessmentId) { return { assessmentId, receiptIds: [] }; }
});
assert.deepEqual(Object.keys(reader).sort(), ["getEvidenceReceipt", "listEvidenceReceipts"]);
assert.equal(Object.isFrozen(reader), true);
process.stdout.write(JSON.stringify({ application: true, domain: true, readCapability: true,
  unchangedUnitInterpretation: true }) + "\n");
