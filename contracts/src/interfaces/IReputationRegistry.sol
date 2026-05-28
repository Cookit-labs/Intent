// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReputationRegistry {
    event ReputationUpdated(address indexed agent, int256 delta, uint256 newScore);
    event ReputationSlashed(address indexed agent, uint256 amount, string reason);

    function getScore(address agent) external view returns (uint256);
    function updateScore(address agent, int256 delta) external;
    function slash(address agent, uint256 amount, string calldata reason) external;
    function getRank(address agent) external view returns (uint256);
}