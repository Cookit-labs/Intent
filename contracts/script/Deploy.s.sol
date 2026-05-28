// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TODO: import "forge-std/Script.sol";
import "../src/core/IntentEscrow.sol";
import "../src/core/ReputationRegistry.sol";
import "../src/core/AgentRegistry.sol";
import "../src/core/SettlementManager.sol";
import "../src/core/ExecutionValidator.sol";

/// @notice Full deployment script
/// Usage: forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast
contract DeployScript {
    function run() external {
        // TODO: vm.startBroadcast(privateKey)
        address deployer = msg.sender;

        // 1. Deploy settlement manager
        SettlementManager settlement = new SettlementManager(deployer);

        // 2. Deploy escrow with USDC address
        address usdc = vm.envAddress("USDC_ADDRESS");
        IntentEscrow escrow = new IntentEscrow(usdc);

        // 3. Deploy registries
        ReputationRegistry reputation = new ReputationRegistry();
        AgentRegistry agents = new AgentRegistry();
        ExecutionValidator validator = new ExecutionValidator();

        // TODO: vm.stopBroadcast()
        // TODO: write deployed addresses to deployments/

        // Silence unused var warnings
        _ = settlement;
        _ = escrow;
        _ = reputation;
        _ = agents;
        _ = validator;
    }
}