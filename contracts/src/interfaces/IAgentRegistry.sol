// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentRegistry {
    event AgentRegistered(address indexed agent, string name, string strategyType);
    event AgentDeregistered(address indexed agent);
    event AgentSuspended(address indexed agent, string reason);

    function register(string calldata name, string calldata strategyType) external payable;
    function deregister() external;
    function isRegistered(address agent) external view returns (bool);
    function getAgent(address agent) external view returns (string memory name, string memory strategyType, bool active);
}