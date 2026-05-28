// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISettlementManager {
    event SettlementInitiated(bytes32 indexed executionId, address indexed agent, uint256 amount);
    event SettlementCompleted(bytes32 indexed executionId, uint256 netAmount, uint256 fee);
    event SettlementFailed(bytes32 indexed executionId, string reason);

    function initiate(bytes32 executionId, address agent, uint256 amount) external;
    function complete(bytes32 executionId) external;
    function getSettlement(bytes32 executionId) external view returns (uint256 amount, bool completed);
}