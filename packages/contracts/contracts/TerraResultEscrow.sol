// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TerraActGovernor} from "./TerraActGovernor.sol";
import {TerraTreasury} from "./TerraTreasury.sol";

/// @notice One precommitted data-review case. Civic approval funds escrow;
/// two fixed distinct reviewers authorize delivery payment. No ecological claims.
/// @dev Hashes bind public artifacts, not their physical truth. Reviewers are a trust boundary.
contract TerraResultEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Terms {
        bytes32 caseHash;
        bytes32 regionId;
        bytes32 evidenceHash;
        bytes32 policyHash;
        uint96 amount;
        address executor;
        address scientificReviewer;
        address communityReviewer;
    }
    TerraActGovernor public immutable governor;
    IERC20 public immutable token;
    address public immutable treasury;
    Terms public terms;
    uint256 public proposalId;
    uint64 public deadline;
    bytes32 public resultHash;
    string public resultURI;
    bool public scientificApproved;
    bool public communityApproved;
    bool public settled;
    bool public refunded;

    error InvalidTerms();
    error InvalidProposal();
    error NotFunded();
    error InvalidResult();
    error NotReviewer();
    error ReviewUnavailable();
    error NotVerified();
    error RefundUnavailable();
    event CaseBound(bytes32 indexed caseHash, uint256 indexed proposalId, uint64 deadline);
    event ResultSubmitted(bytes32 indexed caseHash, bytes32 indexed resultHash, string uri);
    event ResultReviewed(bytes32 indexed caseHash, bytes32 indexed resultHash, address indexed reviewer);
    event DeliveryPaid(bytes32 indexed caseHash, bytes32 indexed resultHash, address indexed executor, uint256 amount);
    event CaseRefunded(bytes32 indexed caseHash, address indexed caller);

    constructor(address governor_, Terms memory terms_) {
        if (governor_ == address(0) || terms_.caseHash == bytes32(0) || terms_.regionId == bytes32(0) ||
            terms_.evidenceHash == bytes32(0) || terms_.policyHash == bytes32(0) || terms_.amount == 0 ||
            terms_.executor == address(0) || terms_.scientificReviewer == address(0) ||
            terms_.communityReviewer == address(0) || terms_.executor == terms_.scientificReviewer ||
            terms_.executor == terms_.communityReviewer || terms_.scientificReviewer == terms_.communityReviewer) revert InvalidTerms();
        governor = TerraActGovernor(governor_);
        treasury = address(governor.treasury());
        token = TerraTreasury(treasury).fundingToken();
        terms = terms_;
    }

    /// @dev Anyone may bind the one proposal satisfying all immutable case commitments.
    function bindProposal(uint256 id) external {
        if (proposalId != 0) revert InvalidProposal();
        TerraActGovernor.Proposal memory p = governor.getProposal(id);
        if (p.recipient != address(this) || p.regionId != terms.regionId ||
            p.evidenceHash != terms.evidenceHash || p.policyHash != terms.policyHash ||
            p.actionHash != keccak256("DATA_REVIEW") || p.amount != terms.amount ||
            p.riskTier != TerraActGovernor.RiskTier.Reversible ||
            keccak256(bytes(p.metadataURI)) != keccak256(abi.encodePacked("urn:terravoce:case:", _hex(terms.caseHash)))) revert InvalidProposal();
        proposalId = id;
        deadline = uint64(block.timestamp) + 30 days;
        emit CaseBound(terms.caseHash, id, deadline);
    }

    function submitResult(bytes32 hash, string calldata uri) external {
        _funded();
        if (msg.sender != terms.executor || resultHash != bytes32(0) || hash == bytes32(0) ||
            bytes(uri).length == 0 || settled || block.timestamp >= deadline) revert InvalidResult();
        resultHash = hash;
        resultURI = uri;
        emit ResultSubmitted(terms.caseHash, hash, uri);
    }

    function approveResult(bytes32 hash) external {
        _funded();
        if (settled || block.timestamp >= deadline || hash == bytes32(0) || hash != resultHash) revert ReviewUnavailable();
        if (msg.sender == terms.scientificReviewer) {
            if (scientificApproved) revert ReviewUnavailable();
            scientificApproved = true;
        } else if (msg.sender == terms.communityReviewer) {
            if (communityApproved) revert ReviewUnavailable();
            communityApproved = true;
        } else revert NotReviewer();
        emit ResultReviewed(terms.caseHash, hash, msg.sender);
    }

    function release() external nonReentrant {
        _funded();
        if (settled || block.timestamp >= deadline || !scientificApproved || !communityApproved) revert NotVerified();
        settled = true;
        token.safeTransfer(terms.executor, terms.amount);
        emit DeliveryPaid(terms.caseHash, resultHash, terms.executor, terms.amount);
    }

    /// @notice A reviewer may reject, a Governor guardian may cancel, or anyone may refund on expiry.
    /// Payment rejection is terminal; replacing result hashes/reviewers requires a new civic proposal.
    function refund() external nonReentrant {
        _funded();
        if (settled || (block.timestamp < deadline && msg.sender != terms.scientificReviewer &&
            msg.sender != terms.communityReviewer && !governor.hasRole(governor.GUARDIAN_ROLE(), msg.sender))) revert RefundUnavailable();
        settled = true;
        refunded = true;
        token.safeTransfer(treasury, terms.amount);
        emit CaseRefunded(terms.caseHash, msg.sender);
    }

    function _funded() private view {
        if (proposalId == 0 || governor.proposalState(proposalId) != TerraActGovernor.ProposalState.Executed) revert NotFunded();
    }

    function _hex(bytes32 value) private pure returns (string memory) {
        bytes memory output = new bytes(66);
        output[0] = "0"; output[1] = "x";
        bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < 32; ++i) {
            output[2 + i * 2] = digits[uint8(value[i]) >> 4];
            output[3 + i * 2] = digits[uint8(value[i]) & 15];
        }
        return string(output);
    }
}
