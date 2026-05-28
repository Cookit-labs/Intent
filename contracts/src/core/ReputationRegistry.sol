// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IReputationRegistry.sol";

/// @title ReputationRegistry
/// @notice Stores and updates on-chain agent reputation scores
contract ReputationRegistry is IReputationRegistry {
    // TODO: UUPS upgradeable + AccessControl
    // Roles: VALIDATOR_ROLE (can update scores), SLASHER_ROLE
    // State: mapping(address => uint256) scores
    // Initial score: 1000 points

    uint256 public constant INITIAL_SCORE = 1000;

    mapping(address => uint256) private _scores;

    function getScore(address agent) external view override returns (uint256) {
        uint256 s = _scores[agent];
        return s == 0 ? INITIAL_SCORE : s;
    }

    function updateScore(address agent, int256 delta) external override {
        // TODO: AccessControl — VALIDATOR_ROLE only
        uint256 current = this.getScore(agent);
        if (delta < 0 && uint256(-delta) > current) {
            _scores[agent] = 0;
        } else {
            _scores[agent] = uint256(int256(current) + delta);
        }
        emit ReputationUpdated(agent, delta, _scores[agent]);
    }

    function slash(address agent, uint256 amount, string calldata reason) external override {
        // TODO: AccessControl — SLASHER_ROLE only
        uint256 current = this.getScore(agent);
        _scores[agent] = amount >= current ? 0 : current - amount;
        emit ReputationSlashed(agent, amount, reason);
    }

    function getRank(address agent) external view override returns (uint256) {
        // TODO: implement rank calculation (requires sorted storage or off-chain indexing)
        return 0;
    }
}