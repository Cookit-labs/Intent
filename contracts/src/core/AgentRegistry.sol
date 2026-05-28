// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IAgentRegistry.sol";

/// @title AgentRegistry
/// @notice Manages agent registration, capabilities, and stake requirements
contract AgentRegistry is IAgentRegistry {
    // TODO: UUPS upgradeable + AccessControl
    // Minimum stake: 100 USDC

    struct AgentInfo {
        string name;
        string strategyType;
        bool active;
        uint256 registeredAt;
    }

    uint256 public constant MIN_STAKE = 100e6; // 100 USDC

    mapping(address => AgentInfo) private _agents;

    function register(string calldata name, string calldata strategyType) external payable override {
        // TODO: require MIN_STAKE deposit in USDC, store agent info
        _agents[msg.sender] = AgentInfo(name, strategyType, true, block.timestamp);
        emit AgentRegistered(msg.sender, name, strategyType);
    }

    function deregister() external override {
        // TODO: validate registered, return stake, mark inactive
        _agents[msg.sender].active = false;
        emit AgentDeregistered(msg.sender);
    }

    function isRegistered(address agent) external view override returns (bool) {
        return _agents[agent].active;
    }

    function getAgent(address agent)
        external
        view
        override
        returns (string memory name, string memory strategyType, bool active)
    {
        AgentInfo storage info = _agents[agent];
        return (info.name, info.strategyType, info.active);
    }
}