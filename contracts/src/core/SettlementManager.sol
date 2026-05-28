// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISettlementManager.sol";

/// @title SettlementManager
/// @notice Coordinates USDC settlement between escrow and winning agent
contract SettlementManager is ISettlementManager {
    // TODO: UUPS upgradeable + AccessControl
    // Protocol fee: 10 bps (0.1%)

    uint256 public constant PROTOCOL_FEE_BPS = 10;
    address public feeRecipient;

    struct SettlementEntry {
        address agent;
        uint256 amount;
        bool completed;
    }

    mapping(bytes32 => SettlementEntry) private _settlements;

    constructor(address _feeRecipient) {
        feeRecipient = _feeRecipient;
    }

    function initiate(bytes32 executionId, address agent, uint256 amount) external override {
        // TODO: validate caller role, store settlement entry
        _settlements[executionId] = SettlementEntry(agent, amount, false);
        emit SettlementInitiated(executionId, agent, amount);
    }

    function complete(bytes32 executionId) external override {
        SettlementEntry storage s = _settlements[executionId];
        require(!s.completed, "already settled");
        // TODO: calculate fee, transfer USDC to agent and feeRecipient
        uint256 fee = (s.amount * PROTOCOL_FEE_BPS) / 10000;
        uint256 net = s.amount - fee;
        s.completed = true;
        emit SettlementCompleted(executionId, net, fee);
    }

    function getSettlement(bytes32 executionId) external view override returns (uint256 amount, bool completed) {
        SettlementEntry storage s = _settlements[executionId];
        return (s.amount, s.completed);
    }
}