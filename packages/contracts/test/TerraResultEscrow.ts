import { expect } from "chai";
import { network } from "hardhat";

describe("TerraResultEscrow delivery settlement", function () {
  async function fixture() {
    const { ethers, networkHelpers } = await network.create();
    const [admin, oracle, community, youth, executor, scientist, outsider] = await ethers.getSigners();
    const token = await ethers.deployContract("MockStablecoin");
    const evidence = await ethers.deployContract("TerraEvidenceRegistry", [2, 0, admin.address]);
    const policy = await ethers.deployContract("TerraPolicyRegistry", [0, admin.address]);
    const civic = await ethers.deployContract("TerraCivicRegistry", [0, admin.address]);
    const amount = 10000000n, regionId = ethers.id("US-USGS-14211720"), caseHash = ethers.id("case");
    const treasury = await ethers.deployContract("TerraTreasury", [await token.getAddress(), 604800, 3n * amount, 0, admin.address]);
    const governor = await ethers.deployContract("TerraActGovernor", [await evidence.getAddress(), await policy.getAddress(),
      await civic.getAddress(), await treasury.getAddress(), 10000, 10000, 100, 100, 100, amount, 0, admin.address]);
    await treasury.setGovernor(await governor.getAddress());
    await token.mint(await treasury.getAddress(), 3n * amount);
    const terms = { caseHash, regionId, evidenceHash: ethers.id("evidence"), policyHash: ethers.id("policy"),
      amount, executor: executor.address, scientificReviewer: scientist.address, communityReviewer: community.address };
    const escrow = await ethers.deployContract("TerraResultEscrow", [await governor.getAddress(), terms]);
    await policy.activatePolicy(terms.policyHash, ethers.id("source"), regionId, 100,
      [ethers.id("DATA_REVIEW")], [await escrow.getAddress()], [amount], "urn:policy");
    await civic.registerMember(regionId, 0, community.address, ethers.id("community"));
    await civic.registerMember(regionId, 1, youth.address, ethers.id("youth"));
    await evidence.grantRole(await evidence.ORACLE_ROLE(), oracle.address);
    const observed = await networkHelpers.time.latest();
    for (const signer of [admin, oracle]) {
      await evidence.connect(signer).attestEvidence(terms.evidenceHash, regionId, ethers.id("metadata"), observed, 1, "urn:evidence");
    }
    const request = { regionId, evidenceHash: terms.evidenceHash, policyHash: terms.policyHash,
      actionHash: ethers.id("DATA_REVIEW"), recipient: await escrow.getAddress(), amount,
      riskTier: 0, requestAutonomy: true, metadataURI: `urn:terravoce:case:${caseHash}` };
    async function propose() { await governor.propose(request); await escrow.bindProposal(1); }
    async function fund() { await propose(); await networkHelpers.time.increase(101); await governor.execute(1); }
    const resultHash = ethers.id("verified-report");
    async function submit() { await escrow.connect(executor).submitResult(resultHash, `urn:result:${resultHash}`); }
    return { ethers, networkHelpers, admin, community, youth, executor, scientist, outsider,
      token, treasury, governor, escrow, terms, request, resultHash, amount, propose, fund, submit };
  }
  it("rejects executor self-review and duplicate reviewer identities", async function () {
    const f = await fixture();
    await expect(f.ethers.deployContract("TerraResultEscrow", [await f.governor.getAddress(),
      { ...f.terms, scientificReviewer: f.executor.address }])).to.be.revertedWithCustomError(f.escrow, "InvalidTerms");
    await expect(f.ethers.deployContract("TerraResultEscrow", [await f.governor.getAddress(),
      { ...f.terms, scientificReviewer: f.community.address }])).to.be.revertedWithCustomError(f.escrow, "InvalidTerms");
  });
  it("does not accept direct token transfers as civic authorization", async function () {
    const f = await fixture();
    await f.token.mint(await f.escrow.getAddress(), f.amount);
    await expect(f.submit()).to.be.revertedWithCustomError(f.escrow, "NotFunded");
    await f.propose();
    await expect(f.submit()).to.be.revertedWithCustomError(f.escrow, "NotFunded");
  });
  for (const mismatch of ["metadataURI", "policyHash", "actionHash", "amount"] as const) {
    it(`rejects a governed proposal with mismatched ${mismatch}`, async function () {
      const f = await fixture();
      const changed = { ...f.request, requestAutonomy: false, [mismatch]: mismatch === "amount" ? f.amount + 1n :
        mismatch === "metadataURI" ? "urn:terravoce:case:other" : f.ethers.id("other") };
      await f.governor.connect(f.community).propose(changed);
      await expect(f.escrow.bindProposal(1)).to.be.revertedWithCustomError(f.escrow, "InvalidProposal");
    });
  }
  it("requires both civic chambers after a challenge and preserves a youth rejection", async function () {
    const f = await fixture();
    await f.propose();
    await f.governor.connect(f.community).challenge(1);
    await f.governor.connect(f.community).castVote(1, 0, true);
    await f.governor.connect(f.youth).castVote(1, 1, false);
    await f.networkHelpers.time.increase(101);
    await expect(f.governor.execute(1)).to.be.revertedWithCustomError(f.governor, "ProposalNotReady");
    await expect(f.submit()).to.be.revertedWithCustomError(f.escrow, "NotFunded");
    expect(await f.token.balanceOf(f.executor.address)).to.equal(0n);
  });
  it("binds only once, fixes the result, and pays only after two distinct matching reviews", async function () {
    const f = await fixture();
    await f.fund();
    await expect(f.escrow.bindProposal(1)).to.be.revertedWithCustomError(f.escrow, "InvalidProposal");
    await expect(f.escrow.release()).to.be.revertedWithCustomError(f.escrow, "NotVerified");
    await expect(f.escrow.connect(f.outsider).submitResult(f.resultHash, "urn:result")).to.be.revertedWithCustomError(f.escrow, "InvalidResult");
    await f.submit();
    await expect(f.submit()).to.be.revertedWithCustomError(f.escrow, "InvalidResult");
    await expect(f.escrow.connect(f.outsider).approveResult(f.resultHash)).to.be.revertedWithCustomError(f.escrow, "NotReviewer");
    await expect(f.escrow.connect(f.executor).approveResult(f.resultHash)).to.be.revertedWithCustomError(f.escrow, "NotReviewer");
    await expect(f.escrow.connect(f.scientist).approveResult(f.ethers.id("other"))).to.be.revertedWithCustomError(f.escrow, "ReviewUnavailable");
    await f.escrow.connect(f.scientist).approveResult(f.resultHash);
    await expect(f.escrow.connect(f.scientist).approveResult(f.resultHash)).to.be.revertedWithCustomError(f.escrow, "ReviewUnavailable");
    await expect(f.escrow.release()).to.be.revertedWithCustomError(f.escrow, "NotVerified");
    expect(await f.token.balanceOf(f.executor.address)).to.equal(0n);
    await f.escrow.connect(f.community).approveResult(f.resultHash);
    await expect(f.escrow.release()).to.emit(f.escrow, "DeliveryPaid").withArgs(f.terms.caseHash, f.resultHash, f.executor.address, f.amount);
    expect(await f.token.balanceOf(f.executor.address)).to.equal(f.amount);
    await expect(f.escrow.release()).to.be.revertedWithCustomError(f.escrow, "NotVerified");
    await expect(f.escrow.refund()).to.be.revertedWithCustomError(f.escrow, "RefundUnavailable");
  });
  it("returns rejected delivery funds to treasury and cannot later pay", async function () {
    const f = await fixture();
    await f.fund(); await f.submit();
    await f.escrow.connect(f.scientist).approveResult(f.resultHash);
    await expect(f.escrow.connect(f.outsider).refund()).to.be.revertedWithCustomError(f.escrow, "RefundUnavailable");
    await f.escrow.connect(f.community).refund();
    expect(await f.token.balanceOf(await f.treasury.getAddress())).to.equal(3n * f.amount);
    expect(await f.escrow.refunded()).to.equal(true);
    await expect(f.escrow.connect(f.community).approveResult(f.resultHash)).to.be.revertedWithCustomError(f.escrow, "ReviewUnavailable");
    await expect(f.escrow.release()).to.be.revertedWithCustomError(f.escrow, "NotVerified");
  });
  it("allows guardian cancellation and expiry refunds without an executor", async function () {
    const first = await fixture();
    await first.fund();
    await first.escrow.connect(first.admin).refund();
    expect(await first.escrow.refunded()).to.equal(true);
    const f = await fixture(); await f.fund();
    await f.networkHelpers.time.increaseTo(await f.escrow.deadline());
    await expect(f.submit()).to.be.revertedWithCustomError(f.escrow, "InvalidResult");
    await f.escrow.connect(f.outsider).refund();
    expect(await f.token.balanceOf(await f.treasury.getAddress())).to.equal(3n * f.amount);
  });
});
