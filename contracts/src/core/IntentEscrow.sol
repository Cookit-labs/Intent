// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TODO: import OZ once foundry install is run
// import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
// import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
// import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/IIntentEscrow.sol";

/// @title IntentEscrow
/// @notice Holds USDC deposits during competition window; releases to winning agent
/// @dev UUPS upgradeable, AccessControl gated
contract IntentEscrow is IIntentEscrow {
    // TODO: implement
    // Roles: OPERATOR_ROLE, SETTLER_ROLE
    // State: mapping(bytes32 => EscrowEntry) escrows
    // EscrowEntry: { address user, uint256 amount, bool released, bool cancelled }

    address public immutable usdc;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function deposit(bytes32 intentId, uint256 amount) external override {
        // TODO: transferFrom USDC, store entry, emit event
        emit IntentDeposited(intentId, msg.sender, amount);
    }

    function release(bytes32 intentId, address agent, uint256 amount) external override {
        // TODO: validate caller role, transfer USDC to agent, emit event
        emit IntentReleased(intentId, agent, amount);
    }

    function cancel(bytes32 intentId) external override {
        // TODO: validate caller, refund user, emit event
        emit IntentCancelled(intentId, msg.sender, 0);
    }

    function getBalance(bytes32 intentId) external view override returns (uint256) {
        // TODO: return escrow balance
        return 0;
    }
}