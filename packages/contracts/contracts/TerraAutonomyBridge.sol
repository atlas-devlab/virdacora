// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {TerraActGovernor} from "./TerraActGovernor.sol";

/// @notice A fixed 3-of-4 service may submit reversible proposals to civic governance.
/// @dev No execution or treasury authority. Deploy a new bridge to rotate operators.
contract TerraAutonomyBridge {
    bytes32 public constant DOMAIN = keccak256("TerraVoce/OpenAutonomy/v1");
    uint256 public constant QUORUM = 3;
    TerraActGovernor public immutable governor;
    mapping(address => bool) public operator;
    mapping(bytes32 => bool) public consumed;

    error InvalidOperators();
    error InvalidAction();
    error ExpiredCertificate();
    error InvalidQuorum();
    error AlreadySubmitted();

    event CertifiedProposal(bytes32 indexed jobId, bytes32 indexed digest, uint256 proposalId);

    constructor(address governor_, address[4] memory operators) {
        if (governor_ == address(0)) revert InvalidOperators();
        governor = TerraActGovernor(governor_);
        for (uint256 i; i < 4; ++i) {
            address signer = operators[i];
            if (signer == address(0) || operator[signer]) revert InvalidOperators();
            operator[signer] = true;
        }
    }

    function actionDigest(
        bytes32 jobId, uint64 validUntil, TerraActGovernor.ActionRequest calldata request
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN, block.chainid, address(this), address(governor), jobId, validUntil,
            request.regionId, request.evidenceHash, request.policyHash, request.actionHash,
            request.recipient, request.amount, request.riskTier, request.requestAutonomy,
            keccak256(bytes(request.metadataURI))
        ));
    }

    function submit(
        bytes32 jobId, uint64 validUntil, TerraActGovernor.ActionRequest calldata request,
        bytes[] calldata signatures
    ) external returns (uint256 proposalId) {
        if (jobId == bytes32(0) || !request.requestAutonomy ||
            request.riskTier != TerraActGovernor.RiskTier.Reversible) revert InvalidAction();
        if (block.timestamp > validUntil) revert ExpiredCertificate();
        if (consumed[jobId]) revert AlreadySubmitted();
        if (signatures.length < QUORUM || signatures.length > 4) revert InvalidQuorum();
        bytes32 digest = actionDigest(jobId, validUntil, request);
        bytes32 signedDigest = MessageHashUtils.toEthSignedMessageHash(digest);
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(signedDigest, signatures[i]);
            // Strict ordering also rejects duplicate identities.
            if (!operator[signer] || signer <= previous) revert InvalidQuorum();
            previous = signer;
        }
        consumed[jobId] = true;
        proposalId = governor.propose(request);
        emit CertifiedProposal(jobId, digest, proposalId);
    }
}
