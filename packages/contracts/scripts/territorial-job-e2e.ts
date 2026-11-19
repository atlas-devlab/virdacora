// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { buildApp, MemoryObservationStore } from "@terravoce/oracle";
import {
  deliverResult, importerObservations, loadDataset, prepareCase, replay,
  reviewTerritorialDelivery, sameAssessment, TerritorialReviewError, windowAt,
  type TerritorialReviewErrorCode
} from "@terravoce/environmental-case";
import { network } from "hardhat";
import type {
  MockStablecoin, TerraActGovernor, TerraAutonomyBridge, TerraCivicRegistry,
  TerraEvidenceRegistry, TerraPolicyRegistry, TerraResultEscrow, TerraTreasury
} from "../types/ethers-contracts/index.js";

// This executable uses one ephemeral Hardhat network and three separate sets of
// contracts. Every civic identity, certificate signer and reviewer is simulated.
// No external RPC, real payment, model training or physical intervention is used.
const datasetFolder = resolve("../../docs/datasets/usgs-willamette");
const policySource = await readFile(resolve("../../policies/usgs-data-review-v1.terra"), "utf8");
const archiveNames = ["continuous.json", "station.json", "manifest.json"] as const;
const originalArchive = await Promise.all(archiveNames.map((name) => readFile(resolve(datasetFolder, name), "utf8")));
const dataset = await loadDataset(datasetFolder);
const spec = prepareCase(dataset, policySource);
const expectedResult = deliverResult(dataset, spec);
assert.equal(spec.requestedAmount, 10);
assert.equal(spec.asset, "TEST");
assert.equal(spec.action, "DATA_REVIEW");
assert.equal(expectedResult.ecologicalImprovementVerified, false);

const outputFolder = resolve(process.env.VIRDACORA_TERRITORIAL_OUTPUT ?? "../../outputs/territorial-job");
await mkdir(dirname(outputFolder), { recursive: true });
// EEXIST is intentionally fatal, including for an empty existing directory.
await mkdir(outputFolder);
async function save(folder: string, name: string, value: unknown) {
  await writeFile(resolve(folder, name), JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item, 2) + "\n", { flag: "wx" });
}
await save(outputFolder, "case.json", spec);
await save(outputFolder, "expected-result.json", expectedResult);

const imported = importerObservations(windowAt(dataset, spec.origin));
const app = buildApp({ store: new MemoryObservationStore(), policySource,
  adminToken: "territorial-local-admin", oracleToken: "territorial-local-oracle",
  now: () => new Date(spec.origin) });

type Scenario = "positive" | "altered_delivery" | "insufficient_delivery";
type TransactionEvidence = { stage: string; hash: string; blockNumber: number };
type Stage = { stage: string; [key: string]: unknown };
interface BalanceSnapshot {
  treasury: string;
  escrow: string;
  executor: string;
  totalSupply: string;
  unitDecimals: 6;
  simulationBudget: "10 TEST";
}
interface OnChainCommitments {
  caseHash: string;
  submittedResultHash: string;
  proposalId: string;
  deadline: string;
  regionId: string;
  evidenceHash: string;
  policyHash: string;
  actionHash: string;
  amount: string;
  recipient: string;
  executor: string;
  scientificReviewer: string;
  communityReviewer: string;
  proposalExecuted: true;
  bothChambersApproved: true;
  scientificApproved: boolean;
  communityApproved: boolean;
}
type CustomErrorContract = {
  interface: {
    getError(name: string): { selector: string } | null;
    parseError(data: string): { name: string } | null;
  };
};

// Accept only a decoded custom revert from the expected contract ABI. A network
// failure, assertion failure or arbitrary exception cannot satisfy this check.
async function requireCustomError(action: () => Promise<unknown>, contract: CustomErrorContract, name: string) {
  const fragment = contract.interface.getError(name);
  assert.ok(fragment, `Missing expected ABI error ${name}`);
  function revertData(value: unknown, depth = 0): string[] {
    if (depth > 6) return [];
    if (typeof value === "string") return /^0x[0-9a-f]+$/i.test(value) ? [value] : [];
    if (value === null || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return ["data", "error", "info", "cause", "value"].flatMap((key) => revertData(record[key], depth + 1));
  }
  await assert.rejects(action, (error: unknown) => revertData(error).some((data) => {
    if (data.slice(0, 10).toLowerCase() !== fragment.selector.toLowerCase()) return false;
    return contract.interface.parseError(data)?.name === name;
  }), `Expected decoded ${name}`);
  return { name, selector: fragment.selector };
}

function candidateFor(scenario: Scenario) {
  const { resultHash: _originalHash, ...core } = structuredClone(expectedResult);
  if (scenario === "altered_delivery") {
    core.targetRecord.value += 1;
    core.absoluteErrorMgL = Math.abs(core.predictionMgL - core.targetRecord.value);
    core.persistenceAbsoluteErrorMgL = Math.abs(core.persistenceMgL - core.targetRecord.value);
  }
  const candidate: Record<string, unknown> = core;
  if (scenario === "insufficient_delivery") {
    delete candidate.targetRecord;
    delete candidate.persistenceMgL;
    delete candidate.absoluteErrorMgL;
    delete candidate.persistenceAbsoluteErrorMgL;
  }
  const resultHash = sha256Hex(`environmental-result-v1:${canonicalJson(candidate)}`);
  return { ...candidate, resultHash };
}

try {
  const registration = await app.inject({ method: "POST", url: "/v1/sensors",
    headers: { "x-admin-token": "territorial-local-admin" }, payload: {
      sensorId: "usgs-http-importer-14211720", regionId: spec.regionId,
      publicKeyDerBase64: imported.publicKeyDerBase64,
      label: "Ephemeral local importer signature; not a USGS sensor signature"
    } });
  assert.equal(registration.statusCode, 201, registration.body);
  for (const entry of imported.observations) {
    const response = await app.inject({ method: "POST", url: "/v1/observations", payload: entry.observation });
    assert.equal(response.statusCode, 202, response.body);
  }
  const response = await app.inject({ method: "POST", url: "/v1/assessments/run",
    headers: { "x-oracle-token": "territorial-local-oracle" }, payload: {
      regionId: spec.regionId, metric: "water.oxygen.mg_l", forecastHorizonHours: 1,
      requestedAction: spec.action, requestedAmount: spec.requestedAmount, asset: spec.asset
    } });
  assert.equal(response.statusCode, 201, response.body);
  const oracle = response.json();
  assert.equal(oracle.decision.allowed, true);
  assert.equal(oracle.actionDraft.policyHash, spec.policyHash);
  sameAssessment(oracle.assessment, spec.assessment);
  await save(outputFolder, "oracle-assessment.json", {
    assessment: oracle.assessment, decision: oracle.decision,
    importerSignature: "ephemeral local importer; not USGS or sensor authentication"
  });

  const { ethers, networkHelpers } = await network.create();
  const signers = await ethers.getSigners();
  function signerAt(index: number) {
    const signer = signers[index];
    assert.ok(signer, `Missing local fixture signer ${index}`);
    return signer;
  }
  // Return already-checked bindings so nested async reviewers never capture
  // array elements whose existence depends on control-flow narrowing.
  const admin = signerAt(0), oracle2 = signerAt(1), replica3 = signerAt(2), replica4 = signerAt(3);
  const community = signerAt(4), youth = signerAt(5), executor = signerAt(6), scientist = signerAt(7);
  const operators = [admin, oracle2, replica3, replica4];
  const day = 86400, unit = 1_000_000n, amount = 10n * unit;
  const regionId = ethers.id(spec.regionId), caseURI = `urn:terravoce:case:${spec.caseHash}`;
  const results = [];

  for (const scenario of ["positive", "altered_delivery", "insufficient_delivery"] as const) {
    const folder = resolve(outputFolder, scenario);
    await mkdir(folder);
    const transactions: TransactionEvidence[] = [];
    const stages: Stage[] = [];
    const reviews: Record<string, unknown>[] = [];
    async function mined(stage: string, transaction: Promise<{
      wait(): Promise<{ hash: string; blockNumber: number } | null>;
    }>) {
      const receipt = await (await transaction).wait();
      assert.ok(receipt, `Missing ${stage} receipt`);
      const evidence = { stage, hash: receipt.hash, blockNumber: receipt.blockNumber };
      transactions.push(evidence);
      return evidence;
    }

    const token: MockStablecoin = await ethers.deployContract("MockStablecoin");
    const evidence: TerraEvidenceRegistry = await ethers.deployContract("TerraEvidenceRegistry", [2, 0, admin.address]);
    const policies: TerraPolicyRegistry = await ethers.deployContract("TerraPolicyRegistry", [0, admin.address]);
    const civic: TerraCivicRegistry = await ethers.deployContract("TerraCivicRegistry", [0, admin.address]);
    const treasury: TerraTreasury = await ethers.deployContract("TerraTreasury", [await token.getAddress(), 7 * day, amount, 0, admin.address]);
    const governor: TerraActGovernor = await ethers.deployContract("TerraActGovernor", [await evidence.getAddress(), await policies.getAddress(),
      await civic.getAddress(), await treasury.getAddress(), 10000, 10000, 3 * day, day, 5 * day, amount, 0, admin.address]);
    await mined("treasury-governor-bound", treasury.getFunction("setGovernor")(await governor.getAddress()));
    await mined("fixed-simulation-budget", token.getFunction("mint")(await treasury.getAddress(), amount));
    const escrow: TerraResultEscrow = await ethers.deployContract("TerraResultEscrow", [await governor.getAddress(), {
      caseHash: spec.caseHash, regionId, evidenceHash: spec.assessment.evidenceHash, policyHash: spec.policyHash,
      amount, executor: executor.address, scientificReviewer: scientist.address, communityReviewer: community.address
    }]);
    const escrowAddress: string = await escrow.getAddress(), treasuryAddress: string = await treasury.getAddress();
    await mined("policy-activated", policies.getFunction("activatePolicy")(spec.policyHash, spec.policySourceHash, regionId,
      spec.challengeSeconds, [ethers.id(spec.action)], [escrowAddress], [amount], `urn:terravoce:policy:${spec.policyHash}`));
    await mined("community-registered", civic.getFunction("registerMember")(regionId, 0, community.address,
      ethers.id(`simulated-${scenario}-community`)));
    await mined("youth-registered", civic.getFunction("registerMember")(regionId, 1, youth.address,
      ethers.id(`simulated-${scenario}-youth`)));
    await mined("second-oracle-role", evidence.getFunction("grantRole")(await evidence.getFunction("ORACLE_ROLE")(), oracle2.address));
    for (const [index, signer] of [admin, oracle2].entries()) {
      await mined(`evidence-attestation-${index + 1}`, evidence.connect(signer).getFunction("attestEvidence")(
        spec.assessment.evidenceHash, regionId, sha256Hex(canonicalJson(spec)),
        Math.floor(Date.parse(spec.origin) / 1000), 1, caseURI));
    }
    const bridge: TerraAutonomyBridge = await ethers.deployContract("TerraAutonomyBridge", [await governor.getAddress(), operators.map((s) => s.address)]);
    await mined("bridge-authorized", governor.getFunction("grantRole")(
      await governor.getFunction("AUTOMATION_ROLE")(), await bridge.getAddress()));
    const request = { regionId, evidenceHash: spec.assessment.evidenceHash, policyHash: spec.policyHash,
      actionHash: ethers.id(spec.action), recipient: escrowAddress, amount, riskTier: 0,
      requestAutonomy: true, metadataURI: caseURI };
    const validUntil = (await networkHelpers.time.latest()) + 3600;
    const digest = await bridge.getFunction("actionDigest")(spec.caseHash, validUntil, request);
    const participating = operators.slice(0, 3).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    const signatures = await Promise.all(participating.map((s) => s.signMessage(ethers.getBytes(digest))));
    await mined("bridge-proposal", bridge.getFunction("submit")(spec.caseHash, validUntil, request, signatures));
    const proposalId = await governor.getFunction("proposalCount")() as bigint;
    assert.equal(proposalId, 1n);
    await mined("case-bound", escrow.getFunction("bindProposal")(proposalId));
    const boundDeadline = await escrow.getFunction("deadline")() as bigint;
    stages.push({ stage: "premature-governance-rejected", error: await requireCustomError(
      () => governor.getFunction("execute")(proposalId), governor, "ProposalNotReady") });
    await mined("community-challenge", governor.connect(community).getFunction("challenge")(proposalId));
    await mined("community-approval-vote", governor.connect(community).getFunction("castVote")(proposalId, 0, true));

    if (scenario === "positive") {
      // Advance an explicitly restored counterfactual to the end of voting. This
      // proves missing youth consent blocks execution, rather than only proving
      // the ordinary voting-time gate. Restore before the youth casts its vote.
      const snapshot = await ethers.provider.send("evm_snapshot", []);
      const communityOnly: TerraActGovernor.ProposalStructOutput = await governor.getFunction("getProposal")(proposalId);
      assert.equal(communityOnly.communityFor, 1n);
      assert.equal(communityOnly.youthFor, 0n);
      await networkHelpers.time.increaseTo(communityOnly.votingEndsAt + 1n);
      assert.equal(await governor.getFunction("proposalState")(proposalId), 4n);
      const error = await requireCustomError(() => governor.getFunction("execute")(proposalId), governor, "ProposalNotReady");
      assert.equal(await token.getFunction("balanceOf")(executor.address), 0n);
      assert.equal(await token.getFunction("balanceOf")(escrowAddress), 0n);
      assert.equal(await ethers.provider.send("evm_revert", [snapshot]), true);
      stages.push({ stage: "community-only-rejected-after-voting-before-youth-vote", error,
        missingYouthConsent: true, counterfactualSnapshotRestored: true });
    }
    await mined("youth-approval-vote", governor.connect(youth).getFunction("castVote")(proposalId, 1, true));
    const votedProposal = await governor.getFunction("getProposal")(proposalId);
    await networkHelpers.time.increaseTo(votedProposal.votingEndsAt + 1n);
    await mined("civic-execution-to-escrow", governor.getFunction("execute")(proposalId));

    async function balances(): Promise<BalanceSnapshot> {
      const [treasuryBalance, escrowBalance, executorBalance, supply] = await Promise.all([
        token.getFunction("balanceOf")(treasuryAddress), token.getFunction("balanceOf")(escrowAddress),
        token.getFunction("balanceOf")(executor.address), token.getFunction("totalSupply")()
      ]);
      assert.equal(supply, amount);
      assert.equal(treasuryBalance + escrowBalance + executorBalance, amount);
      return { treasury: treasuryBalance.toString(), escrow: escrowBalance.toString(), executor: executorBalance.toString(),
        totalSupply: supply.toString(), unitDecimals: 6, simulationBudget: "10 TEST" };
    }
    const fundedBalances: BalanceSnapshot = await balances();
    assert.deepEqual([fundedBalances.treasury, fundedBalances.escrow, fundedBalances.executor], ["0", amount.toString(), "0"]);
    stages.push({ stage: "funded-with-both-chambers", balances: fundedBalances });
    stages.push({ stage: "payment-without-reviews-rejected", error: await requireCustomError(
      () => escrow.getFunction("release")(), escrow, "NotVerified") });

    const candidate = candidateFor(scenario);
    await save(folder, "candidate.json", candidate);
    await mined("executor-delivery-submitted", escrow.connect(executor).getFunction("submitResult")(
      candidate.resultHash, `urn:terravoce:result:${candidate.resultHash}`));

    // Query the actual funded proposal, immutable terms, deadline and submitted
    // hash separately for every review, then repeat immediately before approval.
    async function onChainCommitments(): Promise<OnChainCommitments> {
      const terms = await escrow.getFunction("terms")();
      const boundId = await escrow.getFunction("proposalId")();
      const proposal = await governor.getFunction("getProposal")(boundId);
      const deadline = await escrow.getFunction("deadline")();
      const submittedResultHash = await escrow.getFunction("resultHash")();
      assert.equal(terms.caseHash, spec.caseHash);
      assert.equal(terms.regionId, regionId);
      assert.equal(terms.evidenceHash, spec.assessment.evidenceHash);
      assert.equal(terms.policyHash, spec.policyHash);
      assert.equal(terms.amount, amount);
      assert.equal(terms.executor, executor.address);
      assert.equal(terms.scientificReviewer, scientist.address);
      assert.equal(terms.communityReviewer, community.address);
      assert.equal(await escrow.getFunction("governor")(), await governor.getAddress());
      assert.equal(await escrow.getFunction("treasury")(), treasuryAddress);
      assert.equal(await escrow.getFunction("token")(), await token.getAddress());
      assert.equal(boundId, proposalId);
      assert.equal(deadline, boundDeadline);
      assert.ok(BigInt(await networkHelpers.time.latest()) < deadline);
      assert.equal(proposal.regionId, regionId);
      assert.equal(proposal.evidenceHash, terms.evidenceHash);
      assert.equal(proposal.policyHash, terms.policyHash);
      assert.equal(proposal.actionHash, ethers.id("DATA_REVIEW"));
      assert.equal(proposal.amount, terms.amount);
      assert.equal(proposal.recipient, escrowAddress);
      assert.equal(proposal.metadataURI, caseURI);
      assert.equal(proposal.riskTier, 0n);
      assert.equal(proposal.challenged, true);
      assert.equal(proposal.executed, true);
      assert.equal(proposal.communityEligible, 1n);
      assert.equal(proposal.youthEligible, 1n);
      assert.equal(proposal.communityFor, 1n);
      assert.equal(proposal.youthFor, 1n);
      assert.equal(await governor.getFunction("proposalState")(boundId), 5n);
      assert.equal(submittedResultHash, candidate.resultHash);
      assert.equal(await escrow.getFunction("resultURI")(), `urn:terravoce:result:${candidate.resultHash}`);
      assert.equal(await escrow.getFunction("settled")(), false);
      assert.equal(await escrow.getFunction("refunded")(), false);
      assert.equal(await token.getFunction("balanceOf")(escrowAddress), amount);
      assert.equal(await token.getFunction("balanceOf")(executor.address), 0n);
      return { caseHash: terms.caseHash as string, submittedResultHash: submittedResultHash as string,
        proposalId: boundId.toString(), deadline: deadline.toString(), regionId, evidenceHash: terms.evidenceHash as string,
        policyHash: terms.policyHash as string, actionHash: proposal.actionHash as string, amount: amount.toString(),
        recipient: escrowAddress, executor: terms.executor as string,
        scientificReviewer: terms.scientificReviewer as string, communityReviewer: terms.communityReviewer as string,
        proposalExecuted: true, bothChambersApproved: true,
        scientificApproved: await escrow.getFunction("scientificApproved")() as boolean,
        communityApproved: await escrow.getFunction("communityApproved")() as boolean };
    }
    async function rejectedReview(reviewer: string, sourceFolder: string, expectedCode: TerritorialReviewErrorCode) {
      const chain: OnChainCommitments = await onChainCommitments();
      let reason = "";
      await assert.rejects(() => reviewTerritorialDelivery({ datasetFolder: sourceFolder, policySource, committedCase: spec,
        fundedCaseHash: chain.caseHash, submittedResultHash: chain.submittedResultHash, candidate }), (error: unknown) => {
        assert.ok(error instanceof TerritorialReviewError);
        assert.equal(error.code, expectedCode);
        reason = error.message;
        return true;
      });
      const record = { reviewer, verified: false, errorCode: expectedCode, reason, onChain: chain,
        approvalTransactionSent: false, scope: "simulated reviewer; reproducibility against committed archived USGS data" };
      reviews.push(record);
      return record;
    }

    if (scenario === "positive") {
      for (const [reviewer, signer] of [["scientific", scientist], ["community", community]] as const) {
        const chain: OnChainCommitments = await onChainCommitments();
        const verdict = await reviewTerritorialDelivery({ datasetFolder, policySource, committedCase: spec,
          fundedCaseHash: chain.caseHash, submittedResultHash: chain.submittedResultHash, candidate });
        assert.equal(verdict.verified, true);
        assert.equal(verdict.archiveReloaded, true);
        const beforeApproval = await onChainCommitments();
        assert.deepEqual(beforeApproval, chain);
        assert.equal(verdict.caseHash, beforeApproval.caseHash);
        assert.equal(verdict.resultHash, beforeApproval.submittedResultHash);
        const approval = await mined(`${reviewer}-delivery-approved`, escrow.connect(signer).getFunction("approveResult")(verdict.resultHash));
        reviews.push({ reviewer, ...verdict, onChain: beforeApproval, approvalTransactionSent: true, transaction: approval });
        if (reviewer === "scientific") stages.push({ stage: "single-review-payment-rejected", error: await requireCustomError(
          () => escrow.getFunction("release")(), escrow, "NotVerified") });
      }
      await mined("verified-delivery-paid", escrow.getFunction("release")());
      stages.push({ stage: "duplicate-payment-rejected", error: await requireCustomError(
        () => escrow.getFunction("release")(), escrow, "NotVerified") });
      assert.equal((await escrow.queryFilter(escrow.filters.ResultReviewed())).length, 2);
      assert.equal((await escrow.queryFilter(escrow.filters.DeliveryPaid())).length, 1);
      assert.equal(await escrow.getFunction("refunded")(), false);
    } else {
      if (scenario === "altered_delivery") {
        const tamperedFolder = resolve(folder, "altered-archive-copy");
        await mkdir(tamperedFolder);
        for (const [index, name] of archiveNames.entries()) {
          const content = originalArchive[index];
          assert.ok(content !== undefined);
          await writeFile(resolve(tamperedFolder, name), name === "continuous.json" ? content + " " : content, { flag: "wx" });
        }
        await rejectedReview("scientific-source-integrity-check", tamperedFolder, "SOURCE_INTEGRITY_FAILED");
        stages.push({ stage: "altered-raw-bytes-rejected", originalManifestRetained: true, sourceDatasetUnchanged: true });
      }
      await rejectedReview("scientific", datasetFolder, "DELIVERY_NOT_REPRODUCED");
      await rejectedReview("community", datasetFolder, "DELIVERY_NOT_REPRODUCED");
      assert.equal(await escrow.getFunction("scientificApproved")(), false);
      assert.equal(await escrow.getFunction("communityApproved")(), false);
      stages.push({ stage: "invalid-delivery-payment-rejected", error: await requireCustomError(
        () => escrow.getFunction("release")(), escrow, "NotVerified") });
      await mined("community-rejection-refund", escrow.connect(community).getFunction("refund")());
      stages.push({ stage: "payment-after-refund-rejected", error: await requireCustomError(
        () => escrow.getFunction("release")(), escrow, "NotVerified") });
      assert.equal((await escrow.queryFilter(escrow.filters.ResultReviewed())).length, 0);
      assert.equal((await escrow.queryFilter(escrow.filters.DeliveryPaid())).length, 0);
      assert.equal((await escrow.queryFilter(escrow.filters.CaseRefunded())).length, 1);
      assert.equal(await escrow.getFunction("refunded")(), true);
    }
    const finalBalances = await balances();
    assert.deepEqual([finalBalances.treasury, finalBalances.escrow, finalBalances.executor],
      scenario === "positive" ? ["0", "0", amount.toString()] : [amount.toString(), "0", "0"]);
    assert.equal(await escrow.getFunction("settled")(), true);
    const summary = { scenario, caseHash: spec.caseHash, submittedResultHash: candidate.resultHash,
      outcome: scenario === "positive" ? "verified-review-paid" : "invalid-delivery-rejected-and-refunded",
      contracts: { token: await token.getAddress(), treasury: treasuryAddress, governor: await governor.getAddress(),
        escrow: escrowAddress, bridge: await bridge.getAddress() },
      identities: { mode: "local simulated identities controlled by one process", community: community.address,
        youth: youth.address, executor: executor.address, scientificReviewer: scientist.address },
      governance: { communityVote: true, youthVote: true, challengeExercised: true },
      funding: { budget: "10 TEST", actualMockSymbol: "TUSD", value: "none", paymentBasis: "complete reproducible DATA_REVIEW delivery" },
      fundedBalances, finalBalances, reviews, stages, transactions };
    await save(folder, "reviews.json", reviews);
    await save(folder, "stages.json", stages);
    await save(folder, "balances.json", { funded: fundedBalances, final: finalBalances });
    await save(folder, "transactions.json", transactions);
    await save(folder, "scenario.json", summary);
    results.push(summary);
  }

  const finalArchive = await Promise.all(archiveNames.map((name) => readFile(resolve(datasetFolder, name), "utf8")));
  assert.deepEqual(finalArchive, originalArchive, "Pinned source bytes must remain unchanged");
  const { rows: _rows, ...scientificReplay } = replay(dataset);
  const report = { version: "territorial-job-local-v1", caseHash: spec.caseHash,
    mission: "distributed environmental evidence, bounded intervention funding, and decision rights for affected communities and youth",
    workDelivered: "reproducible review of real archived USGS oxygen data",
    source: { stationId: dataset.manifest.stationId, periodStart: dataset.manifest.start, periodEnd: dataset.manifest.end,
      sourceHash: dataset.manifest.sourceHash, manifestHash: spec.datasetManifestHash,
      archiveBytesUnchanged: true, liveRetrievalPerformed: false },
    limits: { identitiesAndReviews: "simulated; not independent people", consensus: "3-of-4 local signature fixture; ABCI not launched",
      network: "one ephemeral Hardhat network; transaction hashes have no public explorer", funding: "valueless local mock tokens",
      physicalPilot: "not performed", ecologicalImprovementVerified: false,
      prediction: "retrospective finalized archive; not live forecasting or field validation" },
    scientificResult: { predictionMgL: expectedResult.predictionMgL, observedMgL: expectedResult.targetRecord.value,
      persistenceMgL: expectedResult.persistenceMgL, absoluteErrorMgL: expectedResult.absoluteErrorMgL,
      persistenceAbsoluteErrorMgL: expectedResult.persistenceAbsoluteErrorMgL,
      compensationRequiresFavourableForecast: false, replay: scientificReplay },
    scenarios: results };
  await save(outputFolder, "territorial-job-report.json", report);
  console.log(JSON.stringify({ completed: true, caseHash: spec.caseHash, outputFolder,
    scenarios: results.map(({ scenario, outcome, finalBalances }) => ({ scenario, outcome, finalBalances })) }, null, 2));
} finally {
  await app.close();
}
