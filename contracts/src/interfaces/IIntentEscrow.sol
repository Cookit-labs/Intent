// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIntentEscrow {
    event IntentDeposited(bytes32 indexed intentId, address indexed user, uint256 amount);
    event IntentReleased(bytes32 indexed intentId, address indexed agent, uint256 amount);
    event IntentCancelled(bytes32 indexed intentId, address indexed user, uint256 refund);

    function deposit(bytes32 intentId, uint256 amount) external;
    function release(bytes32 intentId, address agent, uint256 amount) external;
    function cancel(bytes32 intentId) external;
    function getBalance(bytes32 intentId) external view returns (uint256);
}